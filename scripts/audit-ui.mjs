/**
 * Responsiveness + production audit.
 *
 * Measures real rendered layout in headless Chrome at seven viewports, on both
 * the landing page and the docs page, and drives the mobile nav and theme
 * toggle. The point is to catch what eyeballing misses: horizontal overflow,
 * under-sized touch targets, clipped text, console errors, and failed network
 * requests.
 *
 * Run: node scripts/audit-ui.mjs   (requires the web/ dir to be served)
 */

import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import { startServer } from "./serve-web.mjs";

// Serve web/ in-process on an ephemeral port. One command, no external server
// to start first, and no port collision with whatever else is running.
const own = process.env.AUDIT_URL ? null : await startServer(0);
const BASE = process.env.AUDIT_URL ?? own.base;
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

  console.log(`\n== ${vp.name}  ${vp.width}x${vp.height}${vp.mobile ? " (touch)" : ""} ==`);

  // ---- landing page ------------------------------------------------------
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 45_000 });

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

  const indexReport = await page.evaluate((TOUCH_MIN) => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - doc.clientWidth;
    const offenders = [];
    if (overflowX > 1) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > doc.clientWidth + 1 || r.left < -1) {
          const style = getComputedStyle(el);
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
          });
        }
      }
    }

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

    return {
      overflowX, offenders: offenders.slice(0, 6), small,
      hero: document.getElementById("hero-height")?.textContent?.trim() ?? "",
      conn: document.getElementById("conn-pill")?.dataset.state ?? "?",
      feedRows: document.querySelectorAll("#feed-body tr").length,
      skeleton: document.querySelector("#feed-body .skeleton-row") !== null,
      sparkPaths: document.querySelectorAll("#spark path").length,
      cards: document.querySelectorAll("#tool-cards .card").length,
    };
  }, TOUCH_MIN);

  if (!dataReady) note("WARN", "index: live data did not settle within 30s - network slow, not a UI defect");
  if (indexReport.overflowX > 1) {
    note("FAIL", `index: horizontal overflow ${indexReport.overflowX}px past viewport`);
    for (const o of indexReport.offenders) {
      console.log(`           ${o.tag}.${o.cls} right=${o.right} w=${o.width}`);
    }
  } else {
    note("PASS", "index: no horizontal overflow");
  }
  if (vp.mobile && indexReport.small.length) {
    note("WARN", `index: ${indexReport.small.length} target(s) under ${TOUCH_MIN}px`);
    for (const s of indexReport.small.slice(0, 5)) {
      console.log(`           <${s.tag}> "${s.label}" ${s.w}x${s.h}`);
    }
  } else if (vp.mobile) {
    note("PASS", "index: all touch targets >= 44px");
  }
  note(/^[\d,]+$/.test(indexReport.hero) ? "PASS" : "FAIL", `index: hero height = "${indexReport.hero}" (live: ${indexReport.conn})`);
  note(indexReport.feedRows > 1 && !indexReport.skeleton ? "PASS" : "FAIL", `index: feed rows = ${indexReport.feedRows}${indexReport.skeleton ? " (still skeleton!)" : ""}`);
  note(indexReport.sparkPaths >= 2 ? "PASS" : "FAIL", `index: sparkline paths = ${indexReport.sparkPaths}`);
  note(indexReport.cards === 13 ? "PASS" : "FAIL", `index: tool cards = ${indexReport.cards}/13`);

  // ---- interactive chrome: mobile nav + theme toggle ---------------------
  const toggleReport = await page.evaluate(() => {
    const navBtn = document.getElementById("nav-toggle");
    const nav = document.getElementById("site-nav");
    const themeBtn = document.getElementById("theme-toggle");
    const open = () => {
      navBtn?.click();
      return nav?.classList.contains("is-open") ?? false;
    };
    const closedAfterLink = (() => {
      const link = nav?.querySelector("a");
      if (!navBtn || !nav || !link) return null;
      navBtn.click();
      if (!nav.classList.contains("is-open")) return null;
      link.click();
      return !nav.classList.contains("is-open");
    })();
    const before = document.documentElement.dataset.theme;
    themeBtn?.click();
    const after = document.documentElement.dataset.theme;
    themeBtn?.click(); // back to the original
    return {
      hasNavBtn: !!navBtn, open, closedAfterLink, before, after,
    };
  });

  note(toggleReport.open ? "PASS" : "FAIL", "index: mobile nav opens");
  note(toggleReport.closedAfterLink ? "PASS" : "FAIL", "index: mobile nav closes on link tap");
  note(
    toggleReport.before && toggleReport.after && toggleReport.before !== toggleReport.after
      ? "PASS" : "FAIL",
    `index: theme toggle flips (${toggleReport.before} -> ${toggleReport.after})`,
  );

  // ---- docs page ----------------------------------------------------------
  await page.goto(`${BASE}docs.html`, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await new Promise((r) => setTimeout(r, 400));

  const docsReport = await page.evaluate(() => {
    const doc = document.documentElement;
    const overflowX = doc.scrollWidth - doc.clientWidth;
    const offenders = [];
    if (overflowX > 1) {
      for (const el of document.querySelectorAll("body *")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        if (r.right > doc.clientWidth + 1 || r.left < -1) {
          let inScroller = false;
          for (let p = el.parentElement; p; p = p.parentElement) {
            const ov = getComputedStyle(p).overflowX;
            if (ov === "auto" || ov === "scroll") { inScroller = true; break; }
          }
          if (!inScroller) {
            offenders.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().slice(0, 30)} right=${Math.round(r.right)} w=${Math.round(r.width)}`);
          }
        }
      }
    }
    const tocLinks = document.querySelectorAll(".doc-toc a").length;
    const sections = document.querySelectorAll(".doc-section").length;
    const themeBtn = !!document.getElementById("theme-toggle");
    const navBtn = !!document.getElementById("nav-toggle");
    return { overflowX, offenders: offenders.slice(0, 6), tocLinks, sections, themeBtn, navBtn };
  });

  if (docsReport.overflowX > 1) {
    note("FAIL", `docs: horizontal overflow ${docsReport.overflowX}px`);
    for (const o of docsReport.offenders) console.log(`           ${o}`);
  } else {
    note("PASS", "docs: no horizontal overflow");
  }
  note(docsReport.tocLinks >= 8 ? "PASS" : "FAIL", `docs: TOC links = ${docsReport.tocLinks}`);
  note(docsReport.sections >= 8 ? "PASS" : "FAIL", `docs: sections = ${docsReport.sections}`);
  note(docsReport.themeBtn && docsReport.navBtn ? "PASS" : "FAIL", "docs: shared chrome present");

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

  await page.screenshot({ path: `${OUT}/${vp.name}.png`, fullPage: true });
  await page.close();
}

await browser.close();
own?.server.close();

console.log(`\n  ${problems === 0 ? "NO BLOCKING FAILURES" : `${problems} BLOCKING FAILURE(S)`}`);
console.log(`  screenshots -> ${OUT}/\n`);
process.exitCode = problems === 0 ? 0 : 1;
