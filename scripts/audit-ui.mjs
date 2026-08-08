/**
 * Responsiveness + production audit.
 *
 * Measures real rendered layout in headless Chrome at seven viewports. The point
 * is to catch what eyeballing misses: horizontal overflow, under-sized touch
 * targets, clipped text, console errors, and failed network requests.
 */

import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";

const URL = process.env.AUDIT_URL ?? "http://127.0.0.1:8080/";
const OUT = "audit";
mkdirSync(OUT, { recursive: true });

const VIEWPORTS = [
  { name: "mobile-se",      width: 375,  height: 667,  mobile: true,  dpr: 2 },
  { name: "mobile-pro",     width: 390,  height: 844,  mobile: true,  dpr: 3 },
  { name: "mobile-large",   width: 430,  height: 932,  mobile: true,  dpr: 3 },
  { name: "tablet-port",    width: 768,  height: 1024, mobile: true,  dpr: 2 },
  { name: "tablet-land",    width: 1024, height: 768,  mobile: false, dpr: 2 },
  { name: "desktop",        width: 1440, height: 900,  mobile: false, dpr: 1 },
  { name: "desktop-wide",   width: 1920, height: 1080, mobile: false, dpr: 1 },
];

/** WCAG 2.5.8 minimum is 24px; Apple/Google guidance is 44/48px. */
const TOUCH_MIN = 44;

let problems = 0;
const note = (level, msg) => {
  if (level === "FAIL") problems++;
  console.log(`    [${level}] ${msg}`);
};

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

for (const vp of VIEWPORTS) {
  const page = await browser.newPage();
  const consoleErrors = [];
  const failedRequests = [];

  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 160));
  });
  page.on("requestfailed", (r) => {
    failedRequests.push(`${r.url().slice(0, 90)} - ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() >= 400) failedRequests.push(`${r.status()} ${r.url().slice(0, 90)}`);
  });

  await page.setViewport({
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.dpr,
    isMobile: vp.mobile,
    hasTouch: vp.mobile,
  });

  console.log(`\n  ${vp.name}  ${vp.width}x${vp.height}${vp.mobile ? " (touch)" : ""}`);

  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

  // Wait on the condition, not the clock. The dashboard bootstraps its feed
  // with 12 sequential API calls, so a fixed sleep either flakes when the
  // network is slow or wastes time when it is fast.
  let dataReady = true;
  try {
    await page.waitForFunction(
      () => {
        const hero = document.getElementById("hero-height")?.textContent?.trim() ?? "";
        const rows = document.querySelectorAll("#feed-body tr").length;
        const skeleton = document.querySelector("#feed-body .skeleton-row") !== null;
        return hero !== "" && hero !== "-" && rows > 1 && !skeleton;
      },
      { timeout: 30_000, polling: 250 },
    );
  } catch {
    dataReady = false;
  }
  // Let the sparkline finish its paint after the last block resolves.
  await new Promise((r) => setTimeout(r, 600));

  const report = await page.evaluate((TOUCH_MIN) => {
    const doc = document.documentElement;

    // 1. horizontal overflow - the single most common mobile defect
    const overflowX = doc.scrollWidth - doc.clientWidth;
    const offenders = [];
    if (overflowX > 1) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > doc.clientWidth + 1 || r.left < -1) {
          const style = getComputedStyle(el);
          // Elements inside a scroll container are legitimately wider.
          let inScroller = false;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const ov = getComputedStyle(p).overflowX;
            if (ov === "auto" || ov === "scroll") { inScroller = true; break; }
          }
          if (inScroller) continue;
          offenders.push({
            tag: el.tagName.toLowerCase(),
            cls: (el.className || "").toString().slice(0, 40),
            right: Math.round(r.right),
            width: Math.round(r.width),
            whiteSpace: style.whiteSpace,
          });
        }
      }
    }

    // 2. touch targets
    const small = [];
    for (const el of document.querySelectorAll("a, button, input, select, [role=tab]")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.height < TOUCH_MIN || r.width < TOUCH_MIN) {
        small.push({
          tag: el.tagName.toLowerCase(),
          label: (el.textContent || el.getAttribute("aria-label") || "").trim().slice(0, 28),
          w: Math.round(r.width),
          h: Math.round(r.height),
        });
      }
    }

    // 3. text clipped by its own box (scrollWidth exceeds clientWidth, no scroller)
    const clipped = [];
    for (const el of document.querySelectorAll("h1,h2,h3,p,td,th,.tile-value,.hero-value,.tool-name,.card-name")) {
      const style = getComputedStyle(el);
      if (style.overflow === "auto" || style.overflow === "scroll" ||
          style.overflowX === "auto" || style.overflowX === "scroll") continue;
      if (el.scrollWidth > el.clientWidth + 2 && style.overflow !== "visible") {
        clipped.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 30),
          text: (el.textContent || "").trim().slice(0, 30),
          scroll: el.scrollWidth,
          client: el.clientWidth,
        });
      }
    }

    // 4. font sizes that are too small to read on a phone
    const tinyText = [];
    for (const el of document.querySelectorAll("p, span, div, td, label, .tile-delta, .field-note")) {
      if (!el.textContent?.trim() || el.children.length > 0) continue;
      const px = parseFloat(getComputedStyle(el).fontSize);
      if (px > 0 && px < 11.5) {
        tinyText.push({ px, text: el.textContent.trim().slice(0, 26) });
      }
    }

    // 5. did live data actually paint?
    const hero = document.getElementById("hero-height")?.textContent?.trim() ?? "";
    const conn = document.getElementById("conn-pill")?.dataset.state ?? "?";
    const feedRows = document.querySelectorAll("#feed-body tr").length;
    const skeleton = document.querySelector("#feed-body .skeleton-row") !== null;
    const sparkPaths = document.querySelectorAll("#spark path").length;
    const cards = document.querySelectorAll("#tool-cards .card").length;

    // 6. layout sanity - is anything stacked on top of something else?
    const tiles = [...document.querySelectorAll(".tile")].map((t) => {
      const r = t.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) };
    });

    return {
      overflowX, offenders: offenders.slice(0, 6),
      small, clipped, tinyText: tinyText.slice(0, 5),
      hero, conn, feedRows, skeleton, sparkPaths, cards, tiles,
      docWidth: doc.clientWidth,
    };
  }, TOUCH_MIN);

  // ---- assertions -------------------------------------------------------
  if (!dataReady) {
    note("WARN", "live data did not settle within 30s - network slow, not a UI defect");
  }

  if (report.overflowX > 1) {
    note("FAIL", `horizontal overflow: ${report.overflowX}px past viewport`);
    for (const o of report.offenders) {
      console.log(`           ${o.tag}.${o.cls} right=${o.right} w=${o.width} ws=${o.whiteSpace}`);
    }
  } else {
    note("PASS", "no horizontal overflow");
  }

  if (vp.mobile) {
    if (report.small.length) {
      note("WARN", `${report.small.length} target(s) under ${TOUCH_MIN}px`);
      for (const s of report.small.slice(0, 5)) {
        console.log(`           <${s.tag}> "${s.label}" ${s.w}x${s.h}`);
      }
    } else {
      note("PASS", `all touch targets >= ${TOUCH_MIN}px`);
    }
  }

  if (report.clipped.length) {
    note("FAIL", `${report.clipped.length} element(s) clipping text`);
    for (const c of report.clipped.slice(0, 4)) {
      console.log(`           ${c.tag}.${c.cls} "${c.text}" ${c.scroll}>${c.client}`);
    }
  } else {
    note("PASS", "no clipped text");
  }

  if (report.tinyText.length) {
    note("WARN", `${report.tinyText.length} text node(s) under 11.5px`);
  }

  const heroOk = /^[\d,]+$/.test(report.hero);
  note(heroOk ? "PASS" : "FAIL", `hero height = "${report.hero}" (live: ${report.conn})`);

  const feedOk = report.feedRows > 1 && !report.skeleton;
  note(feedOk ? "PASS" : "FAIL", `feed rows = ${report.feedRows}${report.skeleton ? " (still skeleton!)" : ""}`);

  note(report.sparkPaths >= 2 ? "PASS" : "FAIL", `sparkline paths = ${report.sparkPaths}`);
  note(report.cards === 7 ? "PASS" : "FAIL", `tool cards = ${report.cards}/7`);

  if (report.tiles.length) {
    const widths = [...new Set(report.tiles.map((t) => t.w))];
    const rows = [...new Set(report.tiles.map((t) => t.top))].length;
    console.log(`    [info] tiles: ${report.tiles.length} across ${rows} row(s), width(s) ${widths.join("/")}`);
  }

  if (consoleErrors.length) {
    note("FAIL", `${consoleErrors.length} console error(s)`);
    for (const e of [...new Set(consoleErrors)].slice(0, 4)) console.log(`           ${e}`);
  } else {
    note("PASS", "no console errors");
  }

  const realFailures = failedRequests.filter((f) => !/favicon/i.test(f));
  if (realFailures.length) {
    note("FAIL", `${realFailures.length} failed request(s)`);
    for (const f of [...new Set(realFailures)].slice(0, 4)) console.log(`           ${f}`);
  } else {
    note("PASS", "no failed requests");
  }
  const favicon = failedRequests.filter((f) => /favicon/i.test(f));
  if (favicon.length) note("WARN", "favicon missing (404 in console)");

  await page.screenshot({ path: `${OUT}/${vp.name}.png`, fullPage: true });
  await page.close();
}

await browser.close();

console.log(`\n  ${problems === 0 ? "NO BLOCKING FAILURES" : `${problems} BLOCKING FAILURE(S)`}`);
console.log(`  screenshots -> ${OUT}/\n`);
process.exitCode = problems === 0 ? 0 : 1;
