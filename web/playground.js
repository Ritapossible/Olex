/**
 * The playground page.
 *
 * Every tool here runs on the real Olex MCP server through the HTTP bridge -
 * nothing is reimplemented in the browser. The tool specs below describe the
 * form to draw and how to turn its values into arguments; they deliberately do
 * not describe what a tool does, because that is the server's job.
 */

import { $, activeNet, initChrome } from "./core.js";

const SAMPLE_ADDRESS = "aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px";
const SAMPLE_TX = "at1fv877phzw8hwmaguyhlar7gk364vu6ychecgnafdzv8xgaqlwqrqm9m73w";

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
    example: { transaction_id: SAMPLE_TX },
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
    example: { transaction_id: SAMPLE_TX },
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

let activeTool = "status";

function renderFields() {
  const spec = TOOLS[activeTool];
  const wrap = $("play-inputs");
  wrap.textContent = "";

  if (!spec.fields.length) {
    const p = document.createElement("p");
    p.className = "ink-3 field-empty";
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
    // landing page's live section can never be reporting different chains.
    const args = spec.args(values);
    if (!LOCAL_TOOLS.has(spec.tool)) args.network = activeNet().name;

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

/* ── boot ─────────────────────────────────────────────────────────────── */

initChrome();

renderFields();

for (const btn of document.querySelectorAll(".play-tool")) {
  btn.addEventListener("click", () => selectTool(btn.dataset.tool));
}
$("play-form").addEventListener("submit", runTool);
$("play-example").addEventListener("click", fillExample);
