/**
 * Shared runtime for every Olex page.
 *
 * The site used to be one page and one 954-line script, so "shared" and
 * "page-specific" were the same file. Splitting the playground, the catalog and
 * the install guide onto their own pages made that untenable: each page loads
 * only its own feature module, and everything four pages need in common lives
 * here.
 *
 * What qualifies: the selected network (every page links to an explorer or
 * sends a `network` argument), the API client and its staleness guard, the
 * number formatters, and the top-bar chrome. What does not: anything that
 * touches an element only one page owns.
 */

import {
  initTheme,
  initMobileNav,
  initNetworkSwitch,
  NETWORKS,
  storedNetwork,
} from "./theme.js";

export { NETWORKS };

/* The selected network. Every request and every explorer link reads through
   this, so a switch cannot leave one of them pointing at the other chain.
   Exposed as a call rather than a live binding: `import { net }` would give
   each module a snapshot-looking identifier that silently changes underfoot,
   and a function makes "this is read fresh, every time" explicit at the call
   site. */
let net = NETWORKS[storedNetwork()];

export const activeNet = () => net;

/* ── tiny helpers ─────────────────────────────────────────────────────── */

export const $ = (id) => document.getElementById(id);
export const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/**
 * A short form for numbers too wide to sit in a stat tile.
 *
 * Mainnet's proof target runs to 14 digits - 18,258,960,714,393 when probed on
 * 2026-08-09; it drifts a little every block but not in length.
 * Grouped, that is 170px of text in a 135px box on a 375px phone and 246px in a
 * 219px box on a 1440px desktop - over at every width except 768px, because the
 * tile is a quarter of the grid rather than a share of the viewport, so a wider
 * screen does not mean a wider tile. Shrinking the type enough to fit would have
 * taken it below the other tiles and broken the row's shared scale.
 *
 * So the headline carries the magnitude and the exact figure moves to the
 * sub-line beneath it, where it measures 93px at 11px and 105px at 12.5px -
 * inside the box everywhere. Nothing is lost: both numbers are on screen, in the
 * order they get read in. Testnet's 9-digit target is under the threshold and
 * stays exact in the headline, unchanged.
 */
const UNITS = [
  { at: 1e12, suffix: "T" },
  { at: 1e9, suffix: "B" },
  { at: 1e6, suffix: "M" },
];

export function compactNumber(n) {
  for (const { at, suffix } of UNITS) {
    if (n >= at) {
      // Two decimals keeps 17.43T distinguishable from 17.40T; the target moves
      // by fractions of a percent between blocks and a bare "17T" would look
      // frozen when it is not.
      return `${(n / at).toFixed(2)}${suffix}`;
    }
  }
  return groupDigits(n);
}

/**
 * Longest exact figure the tile can hold, in digits.
 *
 * Measured with all-9s, the widest decimals in this face, against the narrowest
 * tile - 135px at 375px. Ten digits fit with 9px to spare; eleven are 2px over.
 * The desktop tile is wider (219px) and takes twelve, but the limit has to hold
 * at the tightest width or the number overflows on a phone, so it is 10.
 */
export const TILE_DIGIT_LIMIT = 10;

export const relTime = (unixSeconds) => {
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - Number(unixSeconds)));
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  return `${Math.floor(delta / 3600)}h ago`;
};

export const clockTime = (unixSeconds) =>
  new Date(Number(unixSeconds) * 1000).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

/* ── the API client ───────────────────────────────────────────────────── */

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

export const currentGeneration = () => generation;

/** Thrown when a response outlived the network it was requested for. */
export class StaleResponse extends Error {
  constructor() {
    super("superseded by a network switch");
    this.name = "StaleResponse";
  }
}

export async function api(path, { timeout = net.timeout } = {}) {
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

/* ── shared chrome ────────────────────────────────────────────────────── */

/**
 * The connection pill.
 *
 * Only the landing page carries one - it is the only page that polls, and a
 * pill reading "Live" on a static page would be claiming something it is not
 * measuring. Every other page omits the element, so this is a no-op there
 * rather than a guard at each call site.
 */
export function setConn(state, label) {
  const pill = $("conn-pill");
  if (!pill) return;
  pill.dataset.state = state;
  const text = $("conn-label");
  if (text) text.textContent = label;
  // On a narrow screen the pill collapses to a bare dot, so the text is no
  // longer readable. Mirror it into the accessible name, which stays.
  pill.setAttribute("aria-label", `Connection: ${label}`);
}

/** The one piece of network-dependent copy every page carries. */
export function paintFooterNetwork() {
  const foot = $("foot-network");
  if (foot) foot.textContent = `Data: public Provable API · ${net.name}`;
}

/**
 * Wire the top bar and the footer, and route network changes back to the page.
 *
 * Every page calls this exactly once. The network switch is the reason it is
 * shared rather than copied: `net` lives in this module, so the reassignment
 * and the generation bump have to happen here, before the page's own handler
 * runs and starts issuing requests against the new chain.
 *
 * @param onThemeChange   for anything drawn with resolved theme colours.
 * @param onNetworkChange called after `net` has already moved, so a handler can
 *                        clear the old chain's data and refetch.
 */
export function initChrome({ onThemeChange, onNetworkChange } = {}) {
  initTheme(onThemeChange);
  initMobileNav();

  initNetworkSwitch((name) => {
    if (!NETWORKS[name] || name === net.name) return;
    net = NETWORKS[name];
    generation++;
    paintFooterNetwork();
    onNetworkChange?.(name);
  });

  paintFooterNetwork();
}
