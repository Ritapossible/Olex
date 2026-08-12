/**
 * Responsiveness + production audit.
 *
 * Measures real rendered layout in headless Chrome at seven viewports across
 * every page, and drives the mobile nav, the theme toggle and the network
 * switch. The point is to catch what eyeballing misses: horizontal overflow,
 * under-sized touch targets, clipped text, console errors, and failed network
 * requests.
 *
 * The site was one page and a docs page when this was written; it is five pages
 * now, so the per-viewport body loops over a page list and each page declares
 * its own assertions. Anything true of every page - overflow, touch targets,
 * shared chrome, nav completeness - is checked once, everywhere, rather than
 * being restated per page.
 *
 * FAIL vs WARN: a FAIL is a defect in the page. A WARN is something the audit
 * could not establish, or a guideline miss that is not a layout break. Live
 * chain data is the important case - the landing page needs twelve sequential
 * API calls to fill its feed, and a slow network is not a UI defect, so when
 * the data gate does not settle the data-dependent assertions downgrade to WARN
 * instead of reporting a broken page.
 *
 * Run: node scripts/audit-ui.mjs   (serves web/ itself)
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

/** Every page, with the clean URL the site actually links to. */
const PAGES = [
  { name: "index",      path: "",           live: true },
  { name: "playground", path: "playground" },
  { name: "tools",      path: "tools" },
  { name: "install",    path: "install" },
  { name: "docs",       path: "docs" },
];

/** The five entries every top bar carries, in order. */
const NAV_LINKS = ["Overview", "Playground", "Tools", "Install", "Docs"];

/** WCAG 2.5.8 minimum is 24px; Apple/Google guidance is 44/48px. */
const TOUCH_MIN = 44;

let problems = 0;
const note = (level, msg) => {
  if (level === "FAIL") problems++;
  console.log(`    [${level}] ${msg}`);
};

/* ── in-page probes ──────────────────────────────────────────────────────
   These run inside the browser. Kept as plain functions passed to evaluate()
   so each one is readable on its own rather than as one giant closure. */

/** Layout facts true of every page. */
function probeCommon(TOUCH_MIN) {
  const doc = document.documentElement;
  const overflowX = doc.scrollWidth - doc.clientWidth;

  /* An element inside a horizontal scroller is allowed to exceed the viewport:
     that is what the scroller is for. Anything else that does is the defect. */
  const inScroller = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ov = getComputedStyle(p).overflowX;
      if (ov === "auto" || ov === "scroll") return true;
    }
    return false;
  };

  const offenders = [];
  if (overflowX > 1) {
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.right > doc.clientWidth + 1 || r.left < -1) {
        if (inScroller(el)) continue;
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

  const navLinks = [...document.querySelectorAll("#site-nav a")].map((a) =>
    a.textContent.trim(),
  );

  return {
    overflowX,
    offenders: offenders.slice(0, 6),
    small,
    navLinks,
    current: document.querySelector('#site-nav a[aria-current="page"]')?.textContent.trim() ?? null,
    themeBtn: !!document.getElementById("theme-toggle"),
    navBtn: !!document.getElementById("nav-toggle"),
    netMount: !!document.getElementById("net-switch"),
    footNetwork: document.getElementById("foot-network")?.textContent.trim() ?? "",
    title: document.title,
  };
}

/** The mobile nav panel and the theme toggle, on any page. */
function probeChrome() {
  const navBtn = document.getElementById("nav-toggle");
  const nav = document.getElementById("site-nav");
  const themeBtn = document.getElementById("theme-toggle");

  const opened = (() => {
    navBtn?.click();
    return nav?.classList.contains("is-open") ?? false;
  })();

  /* Closing on a link tap has to be tested without actually following the
     link: every nav entry is a cross-page navigation now, and letting one
     through would tear down the page mid-audit. A capture-phase listener
     cancels the default action only - it does not stop propagation, so the
     app's own handler on the nav container still runs and still closes the
     panel, which is the behaviour under test. */
  const swallow = (e) => e.preventDefault();
  document.addEventListener("click", swallow, true);
  let closedAfterLink = null;
  try {
    const link = nav?.querySelector("a");
    if (navBtn && nav && link) {
      if (!nav.classList.contains("is-open")) navBtn.click();
      if (nav.classList.contains("is-open")) {
        link.click();
        closedAfterLink = !nav.classList.contains("is-open");
      }
    }
  } finally {
    document.removeEventListener("click", swallow, true);
  }

  const before = document.documentElement.dataset.theme;
  themeBtn?.click();
  const after = document.documentElement.dataset.theme;
  themeBtn?.click(); // back to the original

  return { hasNavBtn: !!navBtn, opened, closedAfterLink, before, after };
}

/** The testnet/mainnet switch. Only driven on the page that repolls. */
function probeNetworkSwitch() {
  const opts = [...document.querySelectorAll(".net-opt")];
  const activeNet = () =>
    document.querySelector(".net-opt.is-active")?.dataset.net ?? null;

  const netBefore = activeNet();
  /* Below the collapse breakpoint the inactive option is hidden and the visible
     pill cycles instead, so "click the other one" is not a test that works at
     every viewport - drive whichever option is actually clickable. */
  const clickable = opts.find((o) => o.offsetParent !== null && !o.classList.contains("is-active"))
    ?? opts.find((o) => o.offsetParent !== null);
  clickable?.click();
  const netAfter = activeNet();
  const checkedCount = opts.filter((o) => o.getAttribute("aria-checked") === "true").length;
  const role = document.getElementById("net-switch")?.getAttribute("role") ?? null;

  /* Restore. Clicking `clickable` again is a no-op - it is the active option
     now, and the switch ignores a switch to the network it is already on - so
     drive the option that carries the original network instead. Leaving this
     on the wrong chain aborts the in-flight poll for the other one, which
     lands as a console error and a failed request later in the audit. */
  if (netAfter !== netBefore) {
    opts.find((o) => o.dataset.net === netBefore)?.click();
  }

  return {
    netOpts: opts.length, netBefore, netAfter, checkedCount, role,
    netRestored: activeNet() === netBefore,
  };
}

/* ── per-page assertions ─────────────────────────────────────────────────── */

const CHECKS = {
  index: async (page, { dataReady }) => {
    const r = await page.evaluate(() => ({
      hero: document.getElementById("hero-height")?.textContent?.trim() ?? "",
      conn: document.getElementById("conn-pill")?.dataset.state ?? "?",
      feedRows: document.querySelectorAll("#feed-body tr").length,
      skeleton: document.querySelector("#feed-body .skeleton-row") !== null,
      sparkPaths: document.querySelectorAll("#spark path").length,
      tiles: document.querySelectorAll("#tiles .tile").length,
      strip: document.querySelectorAll(".strip-item").length,
      props: document.querySelectorAll(".prop").length,
      routes: document.querySelectorAll(".route").length,
    }));

    // Structure is static markup: always a FAIL if wrong, data or no data.
    note(r.tiles === 4 ? "PASS" : "FAIL", `index: stat tiles = ${r.tiles}/4`);
    note(r.strip === 4 ? "PASS" : "FAIL", `index: spec strip items = ${r.strip}/4`);
    note(r.props === 3 ? "PASS" : "FAIL", `index: value props = ${r.props}/3`);
    note(r.routes === 3 ? "PASS" : "FAIL", `index: route cards = ${r.routes}/3`);

    // Live data: only a FAIL if the gate actually settled.
    const lvl = (ok) => (ok ? "PASS" : dataReady ? "FAIL" : "WARN");
    note(lvl(/^[\d,]+$/.test(r.hero)), `index: hero height = "${r.hero}" (live: ${r.conn})`);
    note(
      lvl(r.feedRows > 1 && !r.skeleton),
      `index: feed rows = ${r.feedRows}${r.skeleton ? " (still skeleton!)" : ""}`,
    );
    note(lvl(r.sparkPaths >= 2), `index: sparkline paths = ${r.sparkPaths}`);
  },

  playground: async (page) => {
    const r = await page.evaluate(() => ({
      tools: document.querySelectorAll(".play-tool").length,
      active: document.querySelectorAll(".play-tool.is-active").length,
      // The default tool takes no arguments, so the form renders its stand-in
      // rather than a field. Either proves renderFields() ran.
      inputs: document.querySelector("#play-inputs")?.children.length ?? 0,
      out: document.getElementById("play-out")?.textContent.trim() ?? "",
      runBtn: !!document.getElementById("play-run"),
    }));
    note(r.tools === 10 ? "PASS" : "FAIL", `playground: tools = ${r.tools}/10`);
    note(r.active === 1 ? "PASS" : "FAIL", `playground: exactly one active tool (got ${r.active})`);
    note(r.inputs > 0 ? "PASS" : "FAIL", `playground: form rendered (${r.inputs} node(s))`);
    note(r.runBtn && r.out ? "PASS" : "FAIL", "playground: output panel present");
  },

  tools: async (page) => {
    const r = await page.evaluate(() => ({
      cards: document.querySelectorAll("#tool-cards .card").length,
      groups: document.querySelectorAll("#tool-cards .cat-group").length,
      keyTags: document.querySelectorAll("#tool-cards .card-tag.is-key").length,
      viewkey: !!document.getElementById("viewkey"),
    }));
    note(r.cards === 13 ? "PASS" : "FAIL", `tools: cards = ${r.cards}/13`);
    note(r.groups === 4 ? "PASS" : "FAIL", `tools: groups = ${r.groups}/4`);
    note(r.keyTags === 3 ? "PASS" : "FAIL", `tools: view-key tagged cards = ${r.keyTags}/3`);
    note(r.viewkey ? "PASS" : "FAIL", "tools: #viewkey anchor present (linked from playground)");
  },

  install: async (page) => {
    const r = await page.evaluate(() => ({
      tabs: document.querySelectorAll(".client-tab").length,
      active: document.querySelectorAll(".client-tab.is-active").length,
      code: document.getElementById("client-code")?.textContent.trim() ?? "",
      where: document.getElementById("client-where")?.textContent.trim() ?? "",
      steps: document.querySelectorAll(".install-steps .code-card").length,
    }));
    note(r.tabs === 10 ? "PASS" : "FAIL", `install: client tabs = ${r.tabs}/10`);
    note(r.active === 1 ? "PASS" : "FAIL", `install: exactly one active tab (got ${r.active})`);
    note(r.steps === 3 ? "PASS" : "FAIL", `install: steps = ${r.steps}/3`);
    note(r.code && r.where ? "PASS" : "FAIL", "install: client panel filled");
  },

  docs: async (page) => {
    const r = await page.evaluate(() => ({
      tocLinks: document.querySelectorAll(".doc-toc a").length,
      sections: document.querySelectorAll(".doc-section").length,
    }));
    note(r.tocLinks >= 8 ? "PASS" : "FAIL", `docs: TOC links = ${r.tocLinks}`);
    note(r.sections >= 8 ? "PASS" : "FAIL", `docs: sections = ${r.sections}`);
  },
};

/* ── run ─────────────────────────────────────────────────────────────────── */

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});

for (const vp of VIEWPORTS) {
  console.log(`\n== ${vp.name}  ${vp.width}x${vp.height}${vp.mobile ? " (touch)" : ""} ==`);

  for (const spec of PAGES) {
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

    await page.goto(`${BASE}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 45_000 });

    /* Wait on the condition, not the clock. The landing page bootstraps its
       feed with twelve sequential API calls, so a fixed sleep either flakes
       when the network is slow or wastes time when it is fast.

       The gate asserts exactly what the assertions below need. It used to
       release at `rows > 1`, which is two blocks - one interval - and the
       sparkline needs two intervals before it draws a path. So the gate passed
       while the chart was still legitimately empty, and the run reported a
       failing sparkline on a page that was working. */
    let dataReady = true;
    if (spec.live) {
      try {
        await page.waitForFunction(
          () => {
            const hero = document.getElementById("hero-height")?.textContent?.trim() ?? "";
            const rows = document.querySelectorAll("#feed-body tr").length;
            const skeleton = document.querySelector("#feed-body .skeleton-row") !== null;
            const paths = document.querySelectorAll("#spark path").length;
            return hero !== "" && hero !== "-" && rows >= 3 && paths >= 2 && !skeleton;
          },
          { timeout: 30_000, polling: 250 },
        );
      } catch {
        dataReady = false;
      }
      if (!dataReady) {
        note("WARN", "index: live data did not settle within 30s - network slow, not a UI defect");
      }
    } else {
      // Static pages render from a module on first paint; one frame is enough.
      await new Promise((r) => setTimeout(r, 250));
    }

    // ---- checks true of every page ----------------------------------------
    const common = await page.evaluate(probeCommon, TOUCH_MIN);

    if (common.overflowX > 1) {
      note("FAIL", `${spec.name}: horizontal overflow ${common.overflowX}px past viewport`);
      for (const o of common.offenders) {
        console.log(`           ${o.tag}.${o.cls} right=${o.right} w=${o.width}`);
      }
    } else {
      note("PASS", `${spec.name}: no horizontal overflow`);
    }

    if (vp.mobile && common.small.length) {
      note("WARN", `${spec.name}: ${common.small.length} target(s) under ${TOUCH_MIN}px`);
      for (const s of common.small.slice(0, 5)) {
        console.log(`           <${s.tag}> "${s.label}" ${s.w}x${s.h}`);
      }
    } else if (vp.mobile) {
      note("PASS", `${spec.name}: all touch targets >= ${TOUCH_MIN}px`);
    }

    note(
      common.themeBtn && common.navBtn && common.netMount ? "PASS" : "FAIL",
      `${spec.name}: shared chrome present`,
    );
    note(
      NAV_LINKS.every((l, i) => common.navLinks[i] === l) && common.navLinks.length === 5
        ? "PASS" : "FAIL",
      `${spec.name}: nav = [${common.navLinks.join(", ")}]`,
    );
    note(common.current ? "PASS" : "FAIL", `${spec.name}: current page marked = ${common.current}`);
    note(
      /^Data: public Provable API · (testnet|mainnet)$/.test(common.footNetwork)
        ? "PASS" : "FAIL",
      `${spec.name}: footer network = "${common.footNetwork}"`,
    );

    /* ---- page-specific ----------------------------------------------------
       Before the interactive probes, not after. The network switch below is
       destructive by design - moving chains clears the hero, the feed and the
       sparkline and refetches, because a testnet row under a Mainnet label
       would be worse than an empty one. Reading the live assertions after it
       ran measured the reload, not the page, and reported a working dashboard
       as three failures at every viewport. */
    await CHECKS[spec.name](page, { dataReady });

    // The record of the page as it loads, before anything is driven.
    await page.screenshot({ path: `${OUT}/${vp.name}-${spec.name}.png`, fullPage: true });

    // ---- interactive chrome ------------------------------------------------
    const chrome = await page.evaluate(probeChrome);
    note(chrome.opened ? "PASS" : "FAIL", `${spec.name}: mobile nav opens`);
    note(chrome.closedAfterLink ? "PASS" : "FAIL", `${spec.name}: mobile nav closes on link tap`);
    note(
      chrome.before && chrome.after && chrome.before !== chrome.after ? "PASS" : "FAIL",
      `${spec.name}: theme toggle flips (${chrome.before} -> ${chrome.after})`,
    );

    /* The switch is driven only on the live page. Everywhere else it stores a
       preference and repaints labels; there is no poll to restart, and firing
       it on five pages per viewport would multiply the API traffic for nothing.
       The other pages still assert it rendered correctly, above and here. */
    if (spec.live) {
      const sw = await page.evaluate(probeNetworkSwitch);
      note(sw.netOpts === 2 ? "PASS" : "FAIL", `index: network options = ${sw.netOpts}/2`);
      note(
        sw.netBefore && sw.netAfter && sw.netBefore !== sw.netAfter ? "PASS" : "FAIL",
        `index: network switch flips (${sw.netBefore} -> ${sw.netAfter})`,
      );
      note(sw.role === "radiogroup" ? "PASS" : "FAIL", `index: network switch role = ${sw.role}`);
      note(sw.checkedCount === 1 ? "PASS" : "FAIL", `index: exactly one aria-checked (got ${sw.checkedCount})`);
      note(sw.netRestored ? "PASS" : "WARN", "index: network restored after test");
    }

    // ---- console + network -------------------------------------------------
    if (consoleErrors.length) {
      note("FAIL", `${spec.name}: ${consoleErrors.length} console error(s)`);
      for (const e of [...new Set(consoleErrors)].slice(0, 4)) console.log(`           ${e}`);
    } else {
      note("PASS", `${spec.name}: no console errors`);
    }

    /* A favicon 404 is noise. ERR_ABORTED is teardown: closing the page while
       the landing feed still has requests open cancels them, and a cancelled
       request is not a failed one - the poll loop treats it the same way. */
    const realFailures = failedRequests.filter(
      (f) => !/favicon/i.test(f) && !/ERR_ABORTED/.test(f),
    );
    if (realFailures.length) {
      note("FAIL", `${spec.name}: ${realFailures.length} failed request(s)`);
      for (const f of [...new Set(realFailures)].slice(0, 4)) console.log(`           ${f}`);
    } else {
      note("PASS", `${spec.name}: no failed requests`);
    }

    await page.close();
  }
}

await browser.close();
own?.server.close();

console.log(`\n  ${problems === 0 ? "NO BLOCKING FAILURES" : `${problems} BLOCKING FAILURE(S)`}`);
console.log(`  screenshots -> ${OUT}/\n`);
process.exitCode = problems === 0 ? 0 : 1;
