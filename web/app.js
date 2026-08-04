/**
 * Olex dashboard.
 *
 * Talks to the public Aleo API directly from the browser — verified to send
 * Access-Control-Allow-Origin: *, so no proxy or backend is involved. Every
 * number on this page is live chain data; nothing here is seeded or faked.
 */

const API = "https://api.explorer.provable.com/v1/testnet";
const EXPLORER = "https://testnet.aleoscan.io";
const POLL_MS = 15_000;
const FEED_SIZE = 12;

/* ── tiny helpers ─────────────────────────────────────────────────────── */

const $ = (id) => document.getElementById(id);
const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

async function api(path, { timeout = 12_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`${API}${path}`, { signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`${res.status} — ${text.slice(0, 160)}`);
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timer);
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
}

/* ── sparkline: seconds between blocks, single series ─────────────────── */
/* One series, so no legend box — the caption names it. Hover shows values,
   which is why only the endpoint carries a direct label.
   Plotting block interval rather than transaction count: testnet blocks are
   usually empty, so a tx series is a flat zero line that reads as a broken
   chart. Interval always varies and is the number an operator actually reads. */

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

  // hover layer — invisible wide hit bands, tooltip via native title
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
    link.href = `${EXPLORER}/block/${b.height}`;
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
    hash.textContent = b.hash ? `${b.hash.slice(0, 14)}…${b.hash.slice(-6)}` : "—";

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
  $("stat-proof").textContent = b.proofTarget ? groupDigits(b.proofTarget) : "—";

  // Average over the feed, not the gap between the last two polls: polling is
  // slower than block production, so a poll-to-poll delta overstates the
  // interval and only appears after the second poll. The feed has real history.
  const intervals = blockIntervals([...feed].reverse());
  if (intervals.length) {
    const mean = intervals.reduce((s, i) => s + i.seconds, 0) / intervals.length;
    $("stat-time").textContent = `${mean.toFixed(1)}s`;
    $("stat-time-sub").textContent = `mean of last ${intervals.length} blocks`;
  } else {
    $("stat-time").textContent = "—";
    $("stat-time-sub").textContent = clockTime(b.timestamp);
  }
}

/** Backfill the feed on first load so the sparkline has history immediately. */
async function bootstrapFeed(tipHeight) {
  const heights = [];
  for (let i = 0; i < FEED_SIZE; i++) heights.push(tipHeight - i);

  const blocks = await Promise.all(
    heights.map((h) =>
      api(`/block/${h}`).then(readBlock).catch(() => null),
    ),
  );

  feed = blocks.filter(Boolean).sort((a, b) => b.height - a.height);
  paintFeed();
  renderSpark([...feed].reverse());
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

async function tick(first = false) {
  try {
    const block = readBlock(await api("/block/latest"));
    if (!block.height) throw new Error("no height in block response");

    setConn("live", "Live · testnet");

    if (first) {
      paintStats(block);
      lastTimestamp = block.timestamp;
      await bootstrapFeed(block.height);
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
    setConn("error", "Connection lost");
    // A failed poll must not leave the table claiming it is still loading.
    if (!feed.length) {
      showFeedMessage("Could not reach the Aleo API. Retrying automatically…");
      $("hero-status").textContent = "network unreachable";
    }
    console.error("[olex] poll failed:", err);
  }
}

/* ── playground ───────────────────────────────────────────────────────── */

const SAMPLE_ADDRESS = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";

const TOOLS = {
  status: {
    fields: [],
    example: {},
    run: async () => {
      const b = readBlock(await api("/block/latest"));
      return [
        `**Aleo testnet — online**`,
        ``,
        `Latest block:  ${groupDigits(b.height)}`,
        `Block hash:    ${b.hash}`,
        `Round:         ${groupDigits(b.round)}`,
        `Block time:    ${new Date(b.timestamp * 1000).toISOString()}`,
        `Proof target:  ${groupDigits(b.proofTarget)}`,
        `Transactions:  ${b.txs}`,
      ].join("\n");
    },
  },

  balance: {
    fields: [
      { name: "address", label: "Aleo address", placeholder: "aleo1…", note: "63 characters, starts with aleo1" },
    ],
    example: { address: SAMPLE_ADDRESS },
    run: async ({ address }) => {
      const addr = (address || "").trim();
      if (!/^aleo1[023456789acdefghjklmnpqrstuvwxyz]{58}$/.test(addr)) {
        throw new Error(
          `"${addr.slice(0, 24)}…" is not a valid Aleo address.\nAddresses start with 'aleo1' and are 63 characters long.`,
        );
      }
      const raw = await api(`/program/credits.aleo/mapping/account/${addr}`);
      const micro = parseTypedInt(raw);
      if (micro === null) {
        return [
          addr,
          ``,
          `Public balance: 0 credits`,
          ``,
          `No entry in the credits.aleo/account mapping. This address has never`,
          `held public credits on testnet. It may still hold PRIVATE balances in`,
          `encrypted records — those cannot be read without the view key.`,
        ].join("\n");
      }
      return [
        addr,
        ``,
        `Public balance: ${microToCredits(micro)} credits`,
        `                ${groupDigits(micro)} microcredits`,
        ``,
        `Private record balances are not included — they are encrypted on-chain.`,
      ].join("\n");
    },
  },

  program: {
    fields: [
      { name: "program_id", label: "Program ID", placeholder: "credits.aleo", note: "lowercase, ends in .aleo" },
    ],
    example: { program_id: "credits.aleo" },
    run: async ({ program_id }) => {
      const id = (program_id || "").trim();
      if (!/^[a-z][a-z0-9_]*\.aleo$/.test(id)) {
        throw new Error(`"${id}" is not a valid program ID.\nExample: credits.aleo`);
      }
      const src = await api(`/program/${id}`);
      const text = (typeof src === "string" ? src : JSON.stringify(src, null, 2))
        .replace(/^"|"$/g, "").replace(/\\n/g, "\n");
      let mappings = [];
      try { mappings = await api(`/program/${id}/mappings`); } catch { /* optional */ }
      const head = mappings.length ? `Mappings: ${mappings.join(", ")}\n\n` : "";
      return head + (text.length > 4000 ? `${text.slice(0, 4000)}\n\n… (truncated)` : text);
    },
  },

  mapping: {
    fields: [
      { name: "program_id", label: "Program ID", placeholder: "credits.aleo" },
      { name: "mapping_name", label: "Mapping", placeholder: "account" },
      { name: "key", label: "Key", placeholder: "aleo1…" },
    ],
    example: { program_id: "credits.aleo", mapping_name: "account", key: SAMPLE_ADDRESS },
    run: async ({ program_id, mapping_name, key }) => {
      const raw = await api(
        `/program/${program_id.trim()}/mapping/${encodeURIComponent(mapping_name.trim())}/${encodeURIComponent(key.trim())}`,
      );
      const value = raw === null || String(raw) === "null"
        ? "(no value set for this key)"
        : String(raw).replace(/^"|"$/g, "");
      return `${program_id} / ${mapping_name} / ${key}\n\nValue: ${value}`;
    },
  },

  block: {
    fields: [
      { name: "height", label: "Block height", placeholder: "leave empty for latest", note: "optional" },
    ],
    example: {},
    run: async ({ height }) => {
      const h = (height || "").trim();
      const b = readBlock(await api(h ? `/block/${h}` : "/block/latest"));
      return [
        `Block ${groupDigits(b.height)}`,
        ``,
        `Hash:         ${b.hash}`,
        `Round:        ${groupDigits(b.round)}`,
        `Timestamp:    ${new Date(b.timestamp * 1000).toISOString()}`,
        `Transactions: ${b.txs}`,
      ].join("\n");
    },
  },

  convert: {
    fields: [
      { name: "amount", label: "Amount", placeholder: "1.5" },
      { name: "from", label: "From unit", type: "select", options: ["credits", "microcredits"] },
    ],
    example: { amount: "1.5", from: "credits" },
    run: async ({ amount, from }) => {
      const text = (amount || "").trim();
      if (from === "credits") {
        if (!/^-?\d+(\.\d{1,6})?$/.test(text)) {
          throw new Error(`"${text}" is not a valid credit amount (max 6 decimal places).`);
        }
        const [whole = "0", frac = ""] = text.replace(/^-/, "").split(".");
        const micro = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0"));
        const signed = text.startsWith("-") ? -micro : micro;
        return `${text} credits = ${groupDigits(signed)} microcredits`;
      }
      const clean = text.replace(/[_,]/g, "");
      if (!/^-?\d+$/.test(clean)) {
        throw new Error(`"${text}" is not a whole number.\nMicrocredits are indivisible.`);
      }
      return `${groupDigits(clean)} microcredits = ${microToCredits(BigInt(clean))} credits`;
    },
  },
};

const CATALOG = [
  ["olex_network_status", "Latest height, hash, round, timestamp and proof target for the network.", "read"],
  ["olex_get_balance", "Public credits balance for an address, read from the credits.aleo account mapping.", "read"],
  ["olex_get_program", "Deployed Aleo instruction source for any program ID, plus its mappings.", "read"],
  ["olex_get_mapping_value", "A single key from any program's on-chain mapping — Aleo's public storage.", "read"],
  ["olex_get_block", "Any block by height, or the chain tip, with its transaction list.", "read"],
  ["olex_get_transaction", "A transaction by ID, with its transitions and how many inputs were private.", "read"],
  ["olex_convert_credits", "Exact bigint conversion between credits and microcredits.", "util"],
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

async function runTool(event) {
  event?.preventDefault();
  const out = $("play-out");
  const timing = $("play-timing");
  const btn = $("play-run");

  out.classList.remove("is-error");
  out.textContent = "Running…";
  timing.textContent = "";
  btn.disabled = true;

  const started = performance.now();
  try {
    const text = await TOOLS[activeTool].run(readForm());
    out.textContent = text;
    timing.textContent = `${Math.round(performance.now() - started)} ms`;
  } catch (err) {
    out.classList.add("is-error");
    out.textContent = `Error\n\n${err.message}`;
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
  $("play-out").textContent = "Press Run tool to execute against Aleo testnet.";
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
    t.className = "card-tag";
    t.textContent = tag === "read" ? "read-only · no keys" : "local · no network";

    card.append(n, d, t);
    wrap.appendChild(card);
  }
}

/* ── theme toggle ─────────────────────────────────────────────────────── */

function initTheme() {
  // localStorage throws in Safari private mode and in sandboxed iframes;
  // the theme is a nicety and must never take the page down with it.
  let saved = null;
  try { saved = localStorage.getItem("olex-theme"); } catch { /* ignore */ }
  if (saved === "light" || saved === "dark") document.documentElement.dataset.theme = saved;

  $("theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("olex-theme", next); } catch { /* ignore */ }
    $("theme-toggle").setAttribute(
      "aria-label",
      next === "light" ? "Switch to dark mode" : "Switch to light mode",
    );
    if (feed.length) renderSpark([...feed].reverse());
  });
}

/* ── boot ─────────────────────────────────────────────────────────────── */

function boot() {
  initTheme();
  renderCatalog();
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
