/**
 * The tool catalog page.
 *
 * On the old single-page site this was a flat wall of thirteen cards, which
 * made the one distinction that actually matters - which tools can touch a view
 * key - just another line of small text on card nine. With a page to itself the
 * catalog is grouped, and the view-key group carries the boundary as a heading
 * rather than as a tag.
 */

import { $, initChrome } from "./core.js";

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

/**
 * Groups, in reading order.
 *
 * `note` is the group's own caveat. The view-key group is the reason this
 * structure exists: those three tools are absent from the hosted bridge
 * entirely, and saying so once above the group is clearer than repeating it
 * inside three cards.
 */
const GROUPS = [
  {
    id: "chain",
    title: "Chain reads",
    blurb: "Public state, straight from the Provable API. No keys involved.",
    tools: [
      ["olex_network_status", "Latest height, hash, round, timestamp and proof target for the network.", "read"],
      ["olex_get_balance", "Public credits balance for an address, read from the credits.aleo account mapping.", "read"],
      ["olex_get_program", "Deployed Aleo instruction source for any program ID, plus its mappings.", "read"],
      ["olex_get_mapping_value", "A single key from any program's on-chain mapping - Aleo's public storage.", "read"],
      ["olex_get_block", "Any block by height, or the chain tip, with its transaction list.", "read"],
      ["olex_get_transaction", "A transaction by ID, with its transitions and how many inputs were private.", "read"],
    ],
  },
  {
    id: "privacy",
    title: "Privacy analysis",
    blurb:
      "Static analysis of where the private/public boundary really falls. This is the part a block explorer cannot do for you.",
    tools: [
      ["olex_analyze_privacy", "Static analysis of where a program's private/public boundary really falls, including private inputs that leak into public mapping state.", "read"],
      ["olex_explain_transaction_privacy", "Value by value, what a real transaction exposed on-chain and what stayed encrypted.", "read"],
    ],
  },
  {
    id: "utils",
    title: "Utilities",
    blurb: "Pure local computation. No network call, no keys.",
    tools: [
      ["olex_convert_credits", "Exact bigint conversion between credits and microcredits.", "util"],
      ["olex_check_visibility", "What a type annotation like u64.private or credits.aleo/transfer_public.future actually means.", "util"],
    ],
  },
  {
    id: "viewkey",
    title: "View key tools",
    blurb:
      "Registered only by the local stdio server. The hosted bridge does not expose these at all, and asking it for one returns 404 - a view key should never be typed into a web page.",
    tools: [
      ["olex_decrypt_record", "Decrypt a record ciphertext with your view key - the one thing no block explorer can do. Pure local computation.", "key"],
      ["olex_true_balance", "Your real balance: public credits plus the private records you own. Reads the chain, then decrypts locally.", "key-net"],
      ["olex_view_key_address", "Confirm a view key is valid and show which account it unlocks. Pure local computation.", "key"],
    ],
  },
];

function card([name, desc, tag]) {
  const el = document.createElement("article");
  el.className = "card";

  const n = document.createElement("div");
  n.className = "card-name";
  n.textContent = name;

  const d = document.createElement("p");
  d.className = "card-desc";
  d.textContent = desc;

  const t = document.createElement("span");
  t.className = tag === "key" || tag === "key-net" ? "card-tag is-key" : "card-tag";
  t.textContent = TAG_TEXT[tag] ?? TAG_TEXT.util;

  el.append(n, d, t);
  return el;
}

function renderCatalog() {
  const wrap = $("tool-cards");
  if (!wrap) return;

  for (const group of GROUPS) {
    const section = document.createElement("section");
    section.className = "cat-group";
    section.id = group.id;

    const head = document.createElement("div");
    head.className = "cat-head";

    const h = document.createElement("h2");
    h.textContent = group.title;

    const count = document.createElement("span");
    count.className = "cat-count ink-3";
    count.textContent = `${group.tools.length} ${group.tools.length === 1 ? "tool" : "tools"}`;

    head.append(h, count);

    const blurb = document.createElement("p");
    blurb.className = "cat-blurb ink-2";
    blurb.textContent = group.blurb;

    const cards = document.createElement("div");
    cards.className = "cards";
    for (const tool of group.tools) cards.appendChild(card(tool));

    section.append(head, blurb, cards);
    wrap.appendChild(section);
  }
}

/* ── boot ─────────────────────────────────────────────────────────────── */

initChrome();
renderCatalog();
