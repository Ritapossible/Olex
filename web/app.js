/**
 * Olex dashboard.
 *
 * Talks to the public Aleo API directly from the browser - verified to send
 * Access-Control-Allow-Origin: *, so no proxy or backend is involved. Every
 * number on this page is live chain data; nothing here is seeded or faked.
 */

import { initTheme, initMobileNav, initNetworkSwitch, NETWORKS, storedNetwork } from "./theme.js";

/* The selected network. Every request and every explorer link reads through
   this, so a switch cannot leave one of them pointing at the other chain. */
let net = NETWORKS[storedNetwork()];
const POLL_MS = 15_000;
const FEED_SIZE = 12;

/* ── tiny helpers ─────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * GET a path on the active network.
 *
 * The generation guard exists because a switch cannot cancel a request that is
 * already in flight. Without it, a testnet response landing after the user
 * moved to mainnet would paint testnet heights under a Mainnet label - the
 * exact confusion the switch is meant to remove. Each response is checked
 * against the generation it was issued under and dropped if that has moved on.
 */
let generation = 0;

async function api(path, { timeout = net.timeout } = {}) {
  const issuedAt = generation;
  const base = net.api;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${base}${path}`, { signal: ctrl.signal });
    const text = await res.text();
    if (issuedAt !== generation) throw new StaleResponse();
    if (!res.ok) throw new Error(`${res.status} - ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timer);
  }
}

/** Thrown when a response outlived the network it was requested for. */
class StaleResponse extends Error {
  constructor() {
    super("superseded by a network switch");
    this.name = "StaleResponse";
  }
}


/** Strip an Aleo type suffix: "538849u64" -> 538849n. null for absent. */
function parseTypedInt(raw) {
  if (raw === null || raw === undefined) return null;
  const t = String(raw).trim().replace(/^"|"$/g, "");
  if (!t || t === "null") return null;
  const m = t.match(/^(\d+)(?:u8|u16|u32|u64|u128|i8|i16|i32|i64|i128|field|group|scalar)?$/);
  return m ? BigInt(m[1]) : null;
}

function microToCredits(micro) {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

const relTime = (unixSeconds) => {
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - Number(unixSeconds)));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
};

const clockTime = (unixSeconds) =>
  new Date(Number(unixSeconds) * 1000).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

/* ── connection pill ──────────────────────────────────────────────────── */

function setConn(state, label) {
  const pill = $("conn-pill");
  pill.dataset.state = state;
  $("conn-label").textContent = label;
  // On a narrow screen the pill collapses to a bare dot, so the text is no
  // longer readable. Mirror it into the accessible name, which stays.
  pill.setAttribute("aria-label", `Connection: ${label}`);
}

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

function renderSpark(blocks) {
  const svg = $("spark");
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

  // hover layer - invisible wide hit bands, tooltip via native title
  points.forEach((v, i) => {
    const hit = document.createElementNS(SVG_NS, "rect");
    const bandW = (W - PAD * 2) / points.length;
    hit.setAttribute("x", x(i) - bandW / 2);
    hit.setAttribute("y", 0);
    hit.setAttribute("width", bandW);
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
let lastTimestamp = null;

function paintFeed(newHeights = new Set()) {
  const body = $("feed-body");
  if (!feed.length) return;

  body.textContent = "";
  for (const b of feed) {
    const tr = document.createElement("tr");
    if (newHeights.has(b.height)) tr.className = "row-new";

    const h = document.createElement("td");
    const link = document.createElement("a");
    link.href = `${net.explorer}/block/${b.height}`;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = groupDigits(b.height);
    link.style.color = "var(--series-1)";
    link.style.textDecoration = "none";
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
  $("stat-proof").textContent = b.proofTarget ? groupDigits(b.proofTarget) : "-";

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
  const issuedAt = generation;
  const heights = [];
  for (let i = 0; i < FEED_SIZE; i++) heights.push(tipHeight - i);

  let landed = 0;

  await Promise.all(
    heights.map((h) =>
      api(`/block/${h}`)
        .then((raw) => {
          if (issuedAt !== generation) return;
          const block = readBlock(raw);
          if (!block.height) return;
          if (feed.some((b) => b.height === block.height)) return;

          landed++;
          feed = [...feed, block].sort((a, b) => b.height - a.height).slice(0, FEED_SIZE);
          paintFeed();
          if (feed.length > 1) renderSpark([...feed].reverse());
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
  if (issuedAt !== generation) return;

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

/** Replace the feed body with a single explanatory row. */
function showFeedMessage(message) {
  const body = $("feed-body");
  body.textContent = "";
  const tr = document.createElement("tr");
  tr.className = "skeleton-row";
  const td = document.createElement("td");
  td.colSpan = 4;
  td.textContent = message;
  tr.appendChild(td);
  body.appendChild(tr);
}

/** Add a status row beneath the existing rows, leaving real data in place. */
function appendFeedNote(message) {
  const body = $("feed-body");
  const tr = document.createElement("tr");
  tr.className = "skeleton-row";
  const td = document.createElement("td");
  td.colSpan = 4;
  td.textContent = message;
  tr.appendChild(td);
  body.appendChild(tr);
}

/**
 * Move the dashboard to another network.
 *
 * Everything derived from the old chain is dropped rather than left to be
 * overwritten: mainnet is at ~20.9M blocks and testnet at ~18.6M, so a stale
 * row or sparkline point would not merely be out of date, it would be from a
 * different chain. Bumping the generation invalidates in-flight requests, and
 * the labels are repainted immediately so the header never disagrees with the
 * switch while the first request is still open.
 */
function switchNetwork(name) {
  if (!NETWORKS[name] || name === net.name) return;

  net = NETWORKS[name];
  generation++;

  feed = [];
  lastTimestamp = null;
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
  if (label) label.textContent = `Aleo ${net.name} block height`;
  const foot = $("foot-network");
  if (foot) foot.textContent = `Data: public Provable API · ${net.name}`;
}

async function tick(first = false) {
  try {
    const block = readBlock(await api("/block/latest"));
    if (!block.height) throw new Error("no height in block response");

    setConn("live", `Live · ${net.name}`);

    if (first) {
      paintStats(block);
      lastTimestamp = block.timestamp;

      // Seed the tip so the table shows a real row immediately; the backfill
      // then fills history in behind it rather than gating the first paint.
      if (!feed.length) {
        feed = [block];
        paintFeed();
      }

      const issuedAt = generation;
      await bootstrapFeed(block.height);
      // The backfill is the one await long enough for a switch to land inside
      // it. `block` belongs to the network we started on, so repainting stats
      // from it now would put the old chain's height under the new label.
      if (issuedAt !== generation) return;
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
    lastTimestamp = block.timestamp;
  } catch (err) {
    // A response discarded by a network switch is not a failure - the switch
    // already started a fresh poll, and reporting "connection lost" here would
    // flash an error on a network that is about to paint normally.
    if (err instanceof StaleResponse) return;

    setConn("error", "Connection lost");
    // A failed poll must not leave the table claiming it is still loading.
    if (!feed.length) {
      showFeedMessage(`Could not reach the Aleo ${net.name} API. Retrying automatically...`);
      $("hero-status").textContent = "network unreachable";
    }
    console.error("[olex] poll failed:", err);
  }
}

/* ── playground ───────────────────────────────────────────────────────── */

const SAMPLE_ADDRESS = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

/**
 * Call the real Olex MCP server through the HTTP bridge.
 *
 * /api/mcp opens a genuine MCP session server-side and dispatches a real
 * tools/call, so what runs here is the same code an editor gets over stdio.
 * The playground deliberately does NOT reimplement tool logic in the browser:
 * that drifts from the server (it already had convert_credits' schema wrong)
 * and means the hosted demo never exercises the product.
 */
const BRIDGE = "/api/mcp";

async function mcp(tool, args = {}) {
  let res;
  try {
    res = await fetch(BRIDGE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, arguments: args }),
    });
  } catch {
    throw new Error(
      "Could not reach the Olex server.\nCheck your connection and try again.",
    );
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      payload?.error ?? `Server returned HTTP ${res.status}.`,
    );
  }

  const text = (payload?.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n")
    .trim();

  // A tool-reported failure (bad address, unknown block) arrives as a normal
  // 200 with isError set - surface it as an error without hiding the detail.
  if (payload?.isError) throw new Error(text || "The tool reported an error.");
  return { text: text || "(the tool returned no output)", ms: payload?.elapsedMs };
}

/* These two are pure local computation - unit conversion and resolving a type
   annotation - so they have no network parameter to set. Every other tool on
   this surface reads the chain and takes one. Sending `network` to a tool whose
   schema has no such field is exactly the kind of thing that comes back as a
   raw -32602, so the set is explicit rather than inferred. */
const LOCAL_TOOLS = new Set(["olex_convert_credits", "olex_check_visibility"]);

/** Drop keys the user left blank so optional fields stay absent. */
function compact(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const s = typeof v === "string" ? v.trim() : v;
    if (s !== "" && s !== undefined && s !== null) out[k] = s;
  }
  return out;
}

const TOOLS = {
  status: {
    tool: "olex_network_status",
    fields: [],
    example: {},
    args: () => ({}),
  },

  balance: {
    fields: [
      { name: "address", label: "Aleo address", placeholder: "aleo1...", note: "63 characters, starts with aleo1" },
    ],
    example: { address: SAMPLE_ADDRESS },
    tool: "olex_get_balance",
    args: ({ address }) => compact({ address }),
  },

  program: {
    fields: [
      { name: "program_id", label: "Program ID", placeholder: "credits.aleo", note: "lowercase, ends in .aleo" },
    ],
    example: { program_id: "credits.aleo" },
    tool: "olex_get_program",
    args: ({ program_id }) => compact({ program_id }),
  },

  mapping: {
    fields: [
      { name: "program_id", label: "Program ID", placeholder: "credits.aleo" },
      { name: "mapping_name", label: "Mapping", placeholder: "account" },
      { name: "key", label: "Key", placeholder: "aleo1..." },
    ],
    example: { program_id: "credits.aleo", mapping_name: "account", key: SAMPLE_ADDRESS },
    tool: "olex_get_mapping_value",
    args: ({ program_id, mapping_name, key }) =>
      compact({ program_id, mapping_name, key }),
  },

  block: {
    fields: [
      { name: "height", label: "Block height", placeholder: "leave empty for latest", note: "optional", optional: true },
    ],
    example: {},
    tool: "olex_get_block",
    args: ({ height }) => {
      const h = (height ?? "").trim();
      if (!h) return {};
      // Number("abc") is NaN, which JSON-serialises to null and comes back as a
      // raw -32602 from the schema. Reject it here with a readable message.
      const n = Number(h);
      if (!Number.isInteger(n) || n < 0) {
        throw new Error("Block height must be a whole number, like 18537000.");
      }
      return { height: n };
    },
  },

  transaction: {
    fields: [
      { name: "transaction_id", label: "Transaction ID", placeholder: "at1...", note: "starts with at1" },
    ],
    example: { transaction_id: "at1fv877phzw8hwmaguyhlar7gk364vu6ychecgnafdzv8xgaqlwqrqm9m73w" },
    tool: "olex_get_transaction",
    args: ({ transaction_id }) => compact({ transaction_id }),
  },

  convert: {
    fields: [
      { name: "amount", label: "Amount", placeholder: "1.5" },
      { name: "from", label: "From unit", type: "select", options: ["credits", "microcredits"] },
    ],
    example: { amount: "1.5", from: "credits" },
    tool: "olex_convert_credits",
    args: ({ amount, from }) => compact({ amount, from }),
  },

  // The privacy tools below are the key-free half of the feature. Their
  // view-key counterparts (decryption, true balance) are deliberately absent:
  // a view key must never be typed into a hosted page, so those exist only in
  // the local stdio server and the bridge does not register them at all.
  analyze: {
    fields: [
      { name: "program_id", label: "Program ID", placeholder: "credits.aleo", note: "lowercase, ends in .aleo" },
      { name: "function_name", label: "Function", placeholder: "leave empty for the whole program", note: "optional", optional: true },
    ],
    example: { program_id: "credits.aleo" },
    tool: "olex_analyze_privacy",
    args: ({ program_id, function_name }) => compact({ program_id, function_name }),
  },

  txprivacy: {
    fields: [
      { name: "transaction_id", label: "Transaction ID", placeholder: "at1...", note: "starts with at1" },
    ],
    example: { transaction_id: "at1fv877phzw8hwmaguyhlar7gk364vu6ychecgnafdzv8xgaqlwqrqm9m73w" },
    tool: "olex_explain_transaction_privacy",
    args: ({ transaction_id }) => compact({ transaction_id }),
  },

  visibility: {
    fields: [
      { name: "type", label: "Type annotation", placeholder: "u64.private", note: "e.g. address.public, token.record" },
    ],
    example: { type: "u64.private" },
    tool: "olex_check_visibility",
    args: ({ type }) => compact({ type }),
  },
};

const CATALOG = [
  ["olex_network_status", "Latest height, hash, round, timestamp and proof target for the network.", "read"],
  ["olex_get_balance", "Public credits balance for an address, read from the credits.aleo account mapping.", "read"],
  ["olex_get_program", "Deployed Aleo instruction source for any program ID, plus its mappings.", "read"],
  ["olex_get_mapping_value", "A single key from any program's on-chain mapping - Aleo's public storage.", "read"],
  ["olex_get_block", "Any block by height, or the chain tip, with its transaction list.", "read"],
  ["olex_get_transaction", "A transaction by ID, with its transitions and how many inputs were private.", "read"],
  ["olex_convert_credits", "Exact bigint conversion between credits and microcredits.", "util"],
  ["olex_analyze_privacy", "Static analysis of where a program's private/public boundary really falls, including private inputs that leak into public mapping state.", "read"],
  ["olex_explain_transaction_privacy", "Value by value, what a real transaction exposed on-chain and what stayed encrypted.", "read"],
  ["olex_check_visibility", "What a type annotation like u64.private or credits.aleo/transfer_public.future actually means.", "util"],
  ["olex_decrypt_record", "Decrypt a record ciphertext with your view key - the one thing no block explorer can do. Pure local computation.", "key"],
  ["olex_true_balance", "Your real balance: public credits plus the private records you own. Reads the chain, then decrypts locally.", "key-net"],
  ["olex_view_key_address", "Confirm a view key is valid and show which account it unlocks. Pure local computation.", "key"],
];

let activeTool = "status";

function renderFields() {
  const spec = TOOLS[activeTool];
  const wrap = $("play-inputs");
  wrap.textContent = "";

  if (!spec.fields.length) {
    const p = document.createElement("p");
    p.className = "ink-3";
    p.style.fontSize = "13.5px";
    p.textContent = "This tool takes no input.";
    wrap.appendChild(p);
    return;
  }

  for (const f of spec.fields) {
    const div = document.createElement("div");
    div.className = "field";

    const label = document.createElement("label");
    label.textContent = f.label;
    label.htmlFor = `f-${f.name}`;
    div.appendChild(label);

    let input;
    if (f.type === "select") {
      input = document.createElement("select");
      for (const opt of f.options) {
        const o = document.createElement("option");
        o.value = o.textContent = opt;
        input.appendChild(o);
      }
    } else {
      input = document.createElement("input");
      input.type = "text";
      input.placeholder = f.placeholder ?? "";
      input.spellcheck = false;
    }
    input.id = `f-${f.name}`;
    input.name = f.name;
    div.appendChild(input);

    if (f.note) {
      const note = document.createElement("div");
      note.className = "field-note";
      note.textContent = f.note;
      div.appendChild(note);
    }
    wrap.appendChild(div);
  }
}

function readForm() {
  const out = {};
  for (const f of TOOLS[activeTool].fields) {
    const el = $(`f-${f.name}`);
    if (el) out[f.name] = el.value;
  }
  return out;
}

/**
 * Name the empty required fields, or return "" when the form is complete.
 *
 * Without this, `compact` strips a blank value and the key never reaches the
 * server, so Zod answers "Required at amount" as a raw -32602 - a protocol
 * error where the user only forgot to type something. Every field is required
 * unless the spec marks it optional, so a new field fails safe.
 */
function missingRequired(spec, values) {
  const gaps = spec.fields
    .filter((f) => !f.optional && !String(values[f.name] ?? "").trim())
    .map((f) => f.label);

  if (!gaps.length) return "";
  return gaps.length === 1
    ? `${gaps[0]} is required.`
    : `These fields are required: ${gaps.join(", ")}.`;
}

/**
 * Render a tiny safe subset of the markdown the MCP tools emit: `**bold**`
 * and `code`. The server output is live chain data, so everything is
 * HTML-escaped first and only then formatted - a `**` inside an address or
 * program source can never become a tag.
 */
function renderToolMarkdown(text) {
  const esc = text.replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
  return esc
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/`([^`]+)`/g, "<code>$1</code>");
}

async function runTool(event) {
  event?.preventDefault();
  const out = $("play-out");
  const timing = $("play-timing");
  const btn = $("play-run");

  out.classList.remove("is-error");
  out.textContent = "Running...";
  timing.textContent = "";
  btn.disabled = true;

  const spec = TOOLS[activeTool];
  const started = performance.now();
  try {
    const values = readForm();
    const gap = missingRequired(spec, values);
    if (gap) throw new Error(gap);

    // Run against whichever network the switch is on, so the playground and the
    // live section can never be reporting different chains at the same time.
    const args = spec.args(values);
    if (!LOCAL_TOOLS.has(spec.tool)) args.network = net.name;

    const { text, ms } = await mcp(spec.tool, args);
    out.innerHTML = renderToolMarkdown(text);
    timing.textContent = `${ms ?? Math.round(performance.now() - started)} ms`;
  } catch (err) {
    out.classList.add("is-error");
    out.innerHTML = renderToolMarkdown(`Error\n\n${err.message}`);
    timing.textContent = `${Math.round(performance.now() - started)} ms`;
  } finally {
    btn.disabled = false;
  }
}

function selectTool(name) {
  activeTool = name;
  for (const btn of document.querySelectorAll(".play-tool")) {
    const on = btn.dataset.tool === name;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", String(on));
  }
  renderFields();
  $("play-out").classList.remove("is-error");
  $("play-out").textContent =
    "Press Run tool to execute this tool on the Olex MCP server.";
  $("play-timing").textContent = "";
}

function fillExample() {
  const ex = TOOLS[activeTool].example;
  for (const [k, v] of Object.entries(ex)) {
    const el = $(`f-${k}`);
    if (el) el.value = v;
  }
  if (!Object.keys(ex).length) runTool();
}

/* A tool's tag answers two independent questions: does it need a view key, and
   does it reach the network. One combined label conflated them and got a tool
   wrong - olex_view_key_address was marked "local only" beside olex_true_balance,
   which makes three API calls. Keys and network are tracked separately now. */
const TAG_TEXT = {
  read: "read-only · no keys",
  util: "no keys · no network",
  key: "view key · stdio only",
  "key-net": "view key · stdio only · reads chain",
};

function renderCatalog() {
  const wrap = $("tool-cards");
  for (const [name, desc, tag] of CATALOG) {
    const card = document.createElement("article");
    card.className = "card";

    const n = document.createElement("div");
    n.className = "card-name";
    n.textContent = name;

    const d = document.createElement("p");
    d.className = "card-desc";
    d.textContent = desc;

    const t = document.createElement("span");
    t.className = tag === "key" || tag === "key-net" ? "card-tag is-key" : "card-tag";
    t.textContent = TAG_TEXT[tag] ?? TAG_TEXT.util;

    card.append(n, d, t);
    wrap.appendChild(card);
  }
}

/* ── install: one snippet per client ──────────────────────────────────── */

/* Every entry is the whole answer for one client: where the config lives, the
   exact block, and the one thing that trips people up. Three shapes exist in
   the wild and they are not interchangeable - most clients read `mcpServers`,
   VS Code reads `servers`, Zed reads `context_servers`, and Codex reads TOML.
   Getting that wrong fails silently with an empty tool list. */
const SERVER_PATH = "/abs/path/olex/dist/index.js";

const MCP_SERVERS_JSON = `{
  "mcpServers": {
    "olex": {
      "command": "node",
      "args": ["${SERVER_PATH}"],
      "env": { "OLEX_NETWORK": "testnet" }
    }
  }
}`;

const CLIENTS = [
  {
    id: "claude-code",
    name: "Claude Code",
    where: "One command, no file to edit.",
    code: `claude mcp add olex -- node ${SERVER_PATH}`,
    note: "Add --scope user to get it in every project. claude mcp list confirms it connected.",
  },
  {
    id: "cursor",
    name: "Cursor",
    where: "~/.cursor/mcp.json for every project, or .cursor/mcp.json for one.",
    code: MCP_SERVERS_JSON,
    note: "Settings -> Tools & MCP lists the server and its tools once it starts.",
  },
  {
    id: "vscode",
    name: "VS Code",
    where: ".vscode/mcp.json in the workspace, or MCP: Open User Configuration.",
    code: `{
  "servers": {
    "olex": {
      "type": "stdio",
      "command": "node",
      "args": ["${SERVER_PATH}"],
      "env": { "OLEX_NETWORK": "testnet" }
    }
  }
}`,
    note: "The key is servers, not mcpServers. VS Code will not read Cursor's shape.",
  },
  {
    id: "claude-desktop",
    name: "Claude Desktop",
    where: "macOS: ~/Library/Application Support/Claude/claude_desktop_config.json · Windows: %APPDATA%\\Claude\\claude_desktop_config.json",
    code: MCP_SERVERS_JSON,
    note: "Restart the app after editing. This is still stdio on your machine, so the view-key tools work here.",
  },
  {
    id: "windsurf",
    name: "Windsurf",
    where: "~/.codeium/windsurf/mcp_config.json",
    code: MCP_SERVERS_JSON,
    note: "Quit and reopen Windsurf. Closing the window alone does not reread the file.",
  },
  {
    id: "codex",
    name: "Codex CLI",
    where: "~/.codex/config.toml - TOML, and the key is snake_case.",
    code: `[mcp_servers.olex]
command = "node"
args = ["${SERVER_PATH}"]
env = { OLEX_NETWORK = "testnet" }`,
    note: `Or let the CLI write it: codex mcp add olex -- node ${SERVER_PATH}`,
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    where: "~/.gemini/settings.json",
    code: MCP_SERVERS_JSON,
    note: "Run /mcp inside the CLI to see the server and its tool count.",
  },
  {
    id: "zed",
    name: "Zed",
    where: "settings.json, via the zed: open settings action.",
    code: `{
  "context_servers": {
    "olex": {
      "command": "node",
      "args": ["${SERVER_PATH}"],
      "env": { "OLEX_NETWORK": "testnet" }
    }
  }
}`,
    note: "Zed keys MCP servers under context_servers, and speaks stdio only.",
  },
  {
    id: "cline",
    name: "Cline",
    where: "MCP Servers -> Configure MCP Servers, which opens cline_mcp_settings.json.",
    code: MCP_SERVERS_JSON,
    note: "Roo Code uses mcp_settings.json with the same block.",
  },
  {
    id: "other",
    name: "Any MCP client",
    where: "Anything that launches an MCP server over stdio.",
    code: MCP_SERVERS_JSON,
    note: "There is no port and no host to configure - the client spawns the process.",
  },
];

function selectClient(id) {
  const client = CLIENTS.find((c) => c.id === id) ?? CLIENTS[0];
  for (const btn of document.querySelectorAll(".client-tab")) {
    const on = btn.dataset.client === client.id;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-selected", String(on));
  }
  $("client-where").textContent = client.where;
  $("client-code").textContent = client.code;
  $("client-note").textContent = client.note;
}

function renderClients() {
  const tabs = $("client-tabs");
  if (!tabs) return;
  for (const client of CLIENTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "client-tab";
    btn.dataset.client = client.id;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", "false");
    btn.setAttribute("aria-controls", "client-panel");
    btn.textContent = client.name;
    btn.addEventListener("click", () => selectClient(client.id));
    tabs.appendChild(btn);
  }
  selectClient(CLIENTS[0].id);
}

/* ── boot ─────────────────────────────────────────────────────────────── */

function boot() {
  // The sparkline is drawn with resolved theme colours, so it has to be
  // repainted when the theme changes - CSS alone cannot recolour it.
  initTheme(() => {
    if (feed.length) renderSpark([...feed].reverse());
  });
  initMobileNav();
  initNetworkSwitch(switchNetwork);
  paintNetworkLabels();
  renderCatalog();
  renderClients();
  renderFields();

  for (const btn of document.querySelectorAll(".play-tool")) {
    btn.addEventListener("click", () => selectTool(btn.dataset.tool));
  }
  $("play-form").addEventListener("submit", runTool);
  $("play-example").addEventListener("click", fillExample);
  $("refresh-feed").addEventListener("click", () => tick(true));

  tick(true);
  setInterval(() => tick(false), POLL_MS);

  // Pause polling when the tab is hidden; resume immediately on return.
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) tick(false);
  });
}

boot();
