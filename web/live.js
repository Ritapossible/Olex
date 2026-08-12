/**
 * The landing page's live network dashboard.
 *
 * Talks to the public Aleo API directly from the browser - verified to send
 * Access-Control-Allow-Origin: *, so no proxy or backend is involved. Every
 * number on this page is live chain data; nothing here is seeded or faked.
 *
 * This is the only page that polls. The playground, catalog and install pages
 * are static once rendered, which is why the connection pill and the poll loop
 * both live here rather than in core.js.
 */

import {
  $, activeNet, api, clockTime, compactNumber, currentGeneration, groupDigits,
  initChrome, paintFooterNetwork, relTime, setConn, StaleResponse,
  TILE_DIGIT_LIMIT,
} from "./core.js";

const POLL_MS = 15_000;
const FEED_SIZE = 12;

/* ── sparkline: seconds between blocks, single series ─────────────────── */
/* One series, so no legend box - the caption names it. Hover shows values,
   which is why only the endpoint carries a direct label.
   Plotting block interval rather than transaction count: Aleo blocks are
   usually empty on testnet and often sparse on mainnet, so a tx series is a
   flat zero line that reads as a broken chart. Interval always varies and is
   the number an operator actually reads. */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Seconds between consecutive blocks, oldest first. One fewer than blocks. */
function blockIntervals(blocks) {
  const out = [];
  for (let i = 1; i < blocks.length; i++) {
    const dt = blocks[i].timestamp - blocks[i - 1].timestamp;
    if (dt > 0 && dt < 3600) out.push({ height: blocks[i].height, seconds: dt });
  }
  return out;
}

export function renderSpark(blocks) {
  const svg = $("spark");
  if (!svg) return;
  svg.textContent = "";
  const series = blockIntervals(blocks);
  if (series.length < 2) return;

  const W = 320, H = 56, PAD = 4;
  const points = series.map((s) => s.seconds);
  // Scale from zero so bar height stays proportional to the value.
  const max = Math.max(...points, 1);
  const min = 0;

  const x = (i) => PAD + (i * (W - PAD * 2)) / (points.length - 1);
  const y = (v) => H - PAD - ((v - min) / (max - min || 1)) * (H - PAD * 2);

  // hairline baseline, recessive
  const base = document.createElementNS(SVG_NS, "line");
  base.setAttribute("x1", 0); base.setAttribute("x2", W);
  base.setAttribute("y1", H - PAD); base.setAttribute("y2", H - PAD);
  base.setAttribute("stroke", "var(--axis)");
  base.setAttribute("stroke-width", "1");
  svg.appendChild(base);

  // area wash at ~10%
  const areaPath = points.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join("") +
    `L${x(points.length - 1)},${H - PAD}L${x(0)},${H - PAD}Z`;
  const area = document.createElementNS(SVG_NS, "path");
  area.setAttribute("d", areaPath);
  area.setAttribute("fill", "var(--series-1)");
  area.setAttribute("opacity", "0.10");
  svg.appendChild(area);

  // 2px line, round join/cap
  const line = document.createElementNS(SVG_NS, "path");
  line.setAttribute("d", points.map((v, i) => `${i ? "L" : "M"}${x(i)},${y(v)}`).join(""));
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "var(--series-1)");
  line.setAttribute("stroke-width", "2");
  line.setAttribute("stroke-linejoin", "round");
  line.setAttribute("stroke-linecap", "round");
  svg.appendChild(line);

  // endpoint marker: >=8px, 2px surface ring
  const last = points.length - 1;
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", x(last)); dot.setAttribute("cy", y(points[last]));
  dot.setAttribute("r", "4");
  dot.setAttribute("fill", "var(--series-1)");
  dot.setAttribute("stroke", "var(--surface-1)");
  dot.setAttribute("stroke-width", "2");
  svg.appendChild(dot);

  /* Hover layer - invisible wide hit bands, tooltip via native title.
     Clamped to the viewBox on both sides. A band is centred on its point and
     is one band wide, so the first and last ones reach half a band past the
     ends; .spark is overflow:visible (the endpoint dot's ring needs it), so
     those two painted outside the SVG's own box and widened the page. That
     was the source of a 6px horizontal overflow on a 390px viewport, and it
     grew as the series got shorter - with three points a band is a third of
     the chart wide. Clamping costs the outer half-bands a little hover area
     and nothing else. */
  points.forEach((v, i) => {
    const hit = document.createElementNS(SVG_NS, "rect");
    const bandW = (W - PAD * 2) / points.length;
    const left = Math.max(0, x(i) - bandW / 2);
    const right = Math.min(W, x(i) + bandW / 2);
    hit.setAttribute("x", left);
    hit.setAttribute("y", 0);
    hit.setAttribute("width", Math.max(0, right - left));
    hit.setAttribute("height", H);
    hit.setAttribute("fill", "transparent");
    const title = document.createElementNS(SVG_NS, "title");
    title.textContent = `Block ${groupDigits(series[i].height)} · ${v}s after previous`;
    hit.appendChild(title);
    svg.appendChild(hit);
  });
}

/* ── live state ───────────────────────────────────────────────────────── */

let feed = [];         // newest first

/* Set once the page is being torn down, so an in-flight poll cancelled by the
   navigation is not reported as an outage. pagehide rather than beforeunload:
   it fires for the back/forward cache too, where beforeunload does not. */
let leaving = false;
window.addEventListener("pagehide", () => { leaving = true; });

function paintFeed(newHeights = new Set()) {
  const body = $("feed-body");
  if (!body || !feed.length) return;

  body.textContent = "";
  for (const b of feed) {
    const tr = document.createElement("tr");
    if (newHeights.has(b.height)) tr.className = "row-new";

    const h = document.createElement("td");
    const link = document.createElement("a");
    link.href = `${activeNet().explorer}/block/${b.height}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = groupDigits(b.height);
    link.className = "feed-link";
    h.appendChild(link);

    const t = document.createElement("td");
    t.className = "ink-2";
    t.textContent = `${clockTime(b.timestamp)} · ${relTime(b.timestamp)}`;

    const x = document.createElement("td");
    x.className = "num";
    x.textContent = b.txs;

    const hash = document.createElement("td");
    hash.className = "hash";
    hash.textContent = b.hash ? `${b.hash.slice(0, 14)}...${b.hash.slice(-6)}` : "-";

    tr.append(h, t, x, hash);
    body.appendChild(tr);
  }
}

function readBlock(block) {
  const meta = block?.header?.metadata ?? {};
  return {
    height: Number(meta.height ?? 0),
    timestamp: Number(meta.timestamp ?? 0),
    round: Number(meta.round ?? 0),
    proofTarget: Number(meta.proof_target ?? 0),
    // The digits exactly as the API sent them. proof_target is a u64, so it can
    // exceed what a double represents exactly - mainnet already runs to 14
    // digits and the ceiling is 16. The Number above is fine for deciding
    // magnitude, but a figure the tile presents as exact has to come from the
    // response rather than from a round-trip that might have altered it.
    proofTargetRaw: meta.proof_target == null ? "" : String(meta.proof_target),
    txs: Array.isArray(block?.transactions) ? block.transactions.length : 0,
    hash: block?.block_hash ?? "",
  };
}

function paintStats(b) {
  $("hero-height").textContent = groupDigits(b.height);
  $("hero-status").textContent = `updated ${relTime(b.timestamp)}`;
  $("stat-round").textContent = groupDigits(b.round);
  $("stat-round-sub").textContent = `block ${groupDigits(b.height)}`;
  $("stat-txs").textContent = b.txs;

  // Aleo produces blocks on a schedule whether or not anyone submitted a
  // transaction, so this tile reads 0 for long stretches on both networks. On
  // its own that is indistinguishable from a broken reader, so say how many the
  // recent window carried - a real zero and a stuck one then look different.
  const windowTxs = feed.reduce((sum, blk) => sum + (blk.txs ?? 0), 0);
  $("stat-txs-sub").textContent = feed.length
    ? windowTxs === 0
      ? `none in the last ${feed.length} blocks`
      : `${groupDigits(windowTxs)} in the last ${feed.length} blocks`
    : "current block";
  const proofEl = $("stat-proof");
  const proofSub = $("stat-proof-sub");
  if (!b.proofTarget) {
    proofEl.textContent = "-";
    proofEl.removeAttribute("title");
    proofSub.textContent = "difficulty for provers";
  } else {
    const digits = b.proofTargetRaw || String(b.proofTarget);
    const exact = groupDigits(digits);
    const long = digits.length > TILE_DIGIT_LIMIT;
    proofEl.textContent = long ? compactNumber(b.proofTarget) : exact;
    // The headline is rounded when compacted, so the exact figure has to remain
    // reachable - in the sub-line for sighted readers, and as a title for the
    // hover case. Screen readers get the exact number either way: the sub-line
    // is real text in the tile, not a decoration.
    proofSub.textContent = long ? exact : "difficulty for provers";
    if (long) proofEl.title = `${exact} - difficulty for provers`;
    else proofEl.removeAttribute("title");
  }

  // Average over the feed, not the gap between the last two polls: polling is
  // slower than block production, so a poll-to-poll delta overstates the
  // interval and only appears after the second poll. The feed has real history.
  const intervals = blockIntervals([...feed].reverse());
  if (intervals.length) {
    const mean = intervals.reduce((s, i) => s + i.seconds, 0) / intervals.length;
    $("stat-time").textContent = `${mean.toFixed(1)}s`;
    $("stat-time-sub").textContent = `mean of last ${intervals.length} blocks`;
  } else {
    $("stat-time").textContent = "-";
    $("stat-time-sub").textContent = clockTime(b.timestamp);
  }
}

/**
 * Backfill the feed on first load so the sparkline has history immediately.
 *
 * Each block is painted the moment it lands rather than after all twelve
 * settle: the previous Promise.all meant one slow request held the whole table
 * on "Loading blocks...", and a total failure left that message up forever with
 * nothing retrying behind it. Now the tip row is already on screen from the
 * caller, rows fill in progressively, and a wholesale failure reports itself.
 */
async function bootstrapFeed(tipHeight) {
  const issuedAt = currentGeneration();
  const heights = [];
  for (let i = 0; i < FEED_SIZE; i++) heights.push(tipHeight - i);

  let landed = 0;

  await Promise.all(
    heights.map((h) =>
      api(`/block/${h}`)
        .then((raw) => {
          if (issuedAt !== currentGeneration()) return;
          const block = readBlock(raw);
          if (!block.height) return;
          if (feed.some((b) => b.height === block.height)) return;

          landed++;
          feed = [...feed, block].sort((a, b) => b.height - a.height).slice(0, FEED_SIZE);
          paintFeed();
          if (feed.length > 1) renderSpark([...feed].reverse());
          /* Two tiles are derived from the feed rather than from the tip -
             block time is a mean over it, and the transaction sub-line counts
             across it - so they have to be repainted as it fills. Without this
             they hold their feed-of-one values ("-", "current block") for the
             whole backfill while the table underneath already shows a dozen
             blocks, which reads as two broken tiles on a working page.
             feed[0] is the tip: the array is kept sorted newest-first. */
          paintStats(feed[0]);
        })
        .catch(() => {
          /* One missing block must not empty the table. A stale response is
             swallowed here too: the switch has already reset the feed. */
        }),
    ),
  );

  // A switch during the backfill makes every conclusion below wrong: the empty
  // feed is the new network's, not a failure of this one, and writing either
  // message here would clobber the "Loading ..." row the switch just put up.
  // The individual responses are already discarded as StaleResponse; this
  // covers the summary that runs after they settle.
  if (issuedAt !== currentGeneration()) return;

  // Nothing arrived and the caller had no tip to seed: say so instead of
  // leaving a skeleton row that reads as a hung page.
  if (!feed.length) {
    showFeedMessage("Could not load recent blocks. Retrying...");
    return;
  }

  // History failed but the seeded tip is real. Keep the row and note the gap
  // underneath it - replacing a genuine block with a status line loses data.
  // Don't promise a retry: the interval polls with first=false, which only
  // prepends newer tips. Backfill runs again solely from the Refresh button.
  if (landed === 0 && feed.length === 1) {
    appendFeedNote("Earlier blocks unavailable - press Refresh to try again.");
  }
}

/** Build a full-width status row. */
function noteRow(message) {
  const tr = document.createElement("tr");
  tr.className = "skeleton-row";
  const td = document.createElement("td");
  td.colSpan = 4;
  td.textContent = message;
  tr.appendChild(td);
  return tr;
}

/** Replace the feed body with a single explanatory row. */
function showFeedMessage(message) {
  const body = $("feed-body");
  if (!body) return;
  body.textContent = "";
  body.appendChild(noteRow(message));
}

/** Add a status row beneath the existing rows, leaving real data in place. */
function appendFeedNote(message) {
  $("feed-body")?.appendChild(noteRow(message));
}

/**
 * Move the dashboard to another network.
 *
 * Everything derived from the old chain is dropped rather than left to be
 * overwritten: mainnet is at ~20.9M blocks and testnet at ~18.6M, so a stale
 * row or sparkline point would not merely be out of date, it would be from a
 * different chain. core.js has already reassigned the network and bumped the
 * generation - which invalidates every in-flight request - by the time this
 * runs, so all that is left here is clearing the old chain's paint.
 */
function onNetworkChange() {
  const net = activeNet();

  feed = [];
  $("spark").textContent = "";
  paintNetworkLabels();

  for (const id of ["stat-round", "stat-txs", "stat-proof", "stat-time"]) {
    $(id).textContent = "-";
  }
  // The sub-lines carry chain-specific numbers too - "block 18,600,431", "none
  // in the last 12 blocks" - so clearing only the headline values would leave
  // testnet figures sitting under mainnet ones. They are re-derived on the
  // first paint; until then they read as pending rather than as stale fact.
  for (const id of ["stat-round-sub", "stat-txs-sub", "stat-time-sub"]) {
    $(id).textContent = "-";
  }
  $("hero-height").textContent = "-";
  $("hero-status").textContent = `reading ${net.name}...`;
  setConn("connecting", `Connecting to ${net.name}...`);
  showFeedMessage(`Loading ${net.name} blocks...`);

  tick(true);
}

/** Repaint every piece of copy that names the network. */
function paintNetworkLabels() {
  const label = $("hero-fig-label");
  if (label) label.textContent = `Aleo ${activeNet().name} block height`;
  paintFooterNetwork();
}

async function tick(first = false) {
  const net = activeNet();
  try {
    const block = readBlock(await api("/block/latest"));
    if (!block.height) throw new Error("no height in block response");

    setConn("live", `Live · ${net.name}`);

    if (first) {
      paintStats(block);

      // Seed the tip so the table shows a real row immediately; the backfill
      // then fills history in behind it rather than gating the first paint.
      if (!feed.length) {
        feed = [block];
        paintFeed();
      }

      const issuedAt = currentGeneration();
      await bootstrapFeed(block.height);
      // The backfill is the one await long enough for a switch to land inside
      // it. `block` belongs to the network we started on, so repainting stats
      // from it now would put the old chain's height under the new label.
      if (issuedAt !== currentGeneration()) return;
      paintStats(block);   // feed now has history, so block time can resolve
      return;
    }

    if (!feed.length || block.height > feed[0].height) {
      const known = new Set(feed.map((b) => b.height));
      feed = [block, ...feed.filter((b) => b.height !== block.height)].slice(0, FEED_SIZE);
      paintFeed(known.has(block.height) ? new Set() : new Set([block.height]));
      renderSpark([...feed].reverse());
    }

    paintStats(block);
  } catch (err) {
    // A response discarded by a network switch is not a failure - the switch
    // already started a fresh poll, and reporting "connection lost" here would
    // flash an error on a network that is about to paint normally.
    if (err instanceof StaleResponse) return;
    // Same for a request the browser cancelled because the page is going away.
    // Every nav entry is a cross-page link now, so leaving mid-poll is the
    // normal case rather than a rare one; reporting it would flash "Connection
    // lost" on the way out and log an error for a network that was fine.
    if (leaving) return;

    setConn("error", "Connection lost");
    // A failed poll must not leave the table claiming it is still loading.
    if (!feed.length) {
      showFeedMessage(`Could not reach the Aleo ${net.name} API. Retrying automatically...`);
      $("hero-status").textContent = "network unreachable";
    }

    /* A timeout is not a defect. api() aborts at the network's budget - 12s on
       testnet, 30s on mainnet - and the interval poll retries on its own, so a
       slow upstream is an expected, self-correcting condition. Logging it at
       error level made "the public API was slow for one request" and "the
       dashboard is broken" indistinguishable, in the console and in any tool
       reading it. The user-visible reporting is unchanged: the pill still reads
       "Connection lost" and the feed still says it is retrying. Anything else -
       a bad response shape, a thrown TypeError - is still an error. */
    if (err?.name === "AbortError" || err?.name === "TimeoutError") {
      console.warn(`[olex] poll timed out after ${net.timeout}ms on ${net.name}, retrying`);
    } else {
      console.error("[olex] poll failed:", err);
    }
  }
}

/* ── boot ─────────────────────────────────────────────────────────────── */

initChrome({
  // The sparkline is drawn with resolved theme colours, so it has to be
  // repainted when the theme changes - CSS alone cannot recolour it.
  onThemeChange: () => {
    if (feed.length) renderSpark([...feed].reverse());
  },
  onNetworkChange,
});

paintNetworkLabels();
$("refresh-feed").addEventListener("click", () => tick(true));

tick(true);
setInterval(() => tick(false), POLL_MS);

// Pause polling when the tab is hidden; resume immediately on return.
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) tick(false);
});
