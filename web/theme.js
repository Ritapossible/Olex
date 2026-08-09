/**
 * Shared page chrome: the theme toggle and the mobile navigation panel.
 *
 * Both the dashboard and the docs page carry the same top bar, so this lives in
 * one module instead of being copied into each and drifting apart.
 */

const STORE_KEY = "olex-theme";
const NET_KEY = "olex-network";

/**
 * The two networks, mirroring src/lib/network.ts.
 *
 * Duplicated rather than imported because the browser cannot read the compiled
 * TypeScript, and a build step purely to share two URLs would cost more than it
 * saves. If an endpoint moves, both files change together.
 *
 * `timeout` differs per network on purpose: a cold mainnet request was measured
 * at 19.3s against a 12s budget, which surfaced as "connection lost" on a
 * network that was in fact fine. Testnet has never needed more than a couple of
 * seconds, and keeping its budget short means a genuine outage still reports
 * itself quickly instead of hanging for half a minute.
 */
export const NETWORKS = {
  testnet: {
    name: "testnet",
    label: "Testnet",
    api: "https://api.explorer.provable.com/v1/testnet",
    explorer: "https://testnet.aleoscan.io",
    timeout: 12_000,
  },
  mainnet: {
    name: "mainnet",
    label: "Mainnet",
    api: "https://api.explorer.provable.com/v1/mainnet",
    explorer: "https://aleoscan.io",
    timeout: 30_000,
  },
};


/* localStorage throws in Safari private mode and in sandboxed iframes. The
   theme is a nicety and must never take the page down with it. */
function readStored() {
  try {
    return localStorage.getItem(STORE_KEY);
  } catch {
    return null;
  }
}

function writeStored(value) {
  try {
    localStorage.setItem(STORE_KEY, value);
  } catch {
    /* ignore */
  }
}

/**
 * The chosen network, defaulting to testnet.
 *
 * Testnet is the default on a first visit for the same reason the server
 * defaults to it: reading mainnet should be a choice someone made, not a state
 * they arrived in. An unrecognised stored value falls back rather than throwing,
 * so a stale or hand-edited key cannot break the page.
 */
export function storedNetwork() {
  let saved = null;
  try {
    saved = localStorage.getItem(NET_KEY);
  } catch {
    /* ignore */
  }
  return NETWORKS[saved] ? saved : "testnet";
}


/**
 * Describe the action, not the state.
 *
 * The button is icon-only, so its accessible name is the only thing a screen
 * reader has to go on. aria-pressed carries the current state separately.
 */
function label(button, theme) {
  const next = theme === "light" ? "dark" : "light";
  button.setAttribute("aria-label", `Switch to ${next} mode`);
  button.setAttribute("title", `Switch to ${next} mode`);
  button.setAttribute("aria-pressed", String(theme === "light"));
}

/** @param onChange called with the new theme, for anything that must repaint. */
export function initTheme(onChange) {
  const saved = readStored();
  if (saved === "light" || saved === "dark") {
    document.documentElement.dataset.theme = saved;
  }

  const button = document.getElementById("theme-toggle");
  if (!button) return;

  label(button, document.documentElement.dataset.theme);

  button.addEventListener("click", () => {
    const next =
      document.documentElement.dataset.theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    writeStored(next);
    label(button, next);
    onChange?.(next);
  });
}

/**
 * The testnet/mainnet switch.
 *
 * Built as two radio-style buttons rather than one toggle: a toggle can show
 * which state is active but never what the other state is, and "which chain am
 * I looking at" is not a question to answer by inference. Both names stay on
 * screen, and the active one is marked by aria-checked, a filled background and
 * a weight change - never by hue alone.
 *
 * Rendered from script rather than written into both pages, so the two top bars
 * cannot drift apart.
 *
 * @param onChange called with the new network name when the user switches.
 *                 Absent on pages with nothing live to repaint.
 */
export function initNetworkSwitch(onChange) {
  const mount = document.getElementById("net-switch");
  if (!mount) return storedNetwork();

  let active = storedNetwork();

  mount.setAttribute("role", "radiogroup");

  const buttons = Object.values(NETWORKS).map((net) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "net-opt";
    btn.dataset.net = net.name;
    btn.setAttribute("role", "radio");
    btn.textContent = net.label;
    mount.appendChild(btn);
    return btn;
  });

  const paint = () => {
    for (const btn of buttons) {
      const on = btn.dataset.net === active;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-checked", String(on));
      // Only the active option is a tab stop; arrow keys move within the group.
      // A roving tabindex is what a radiogroup is expected to do, and it keeps
      // the switch to one stop rather than two on the way to the theme button.
      btn.tabIndex = on ? 0 : -1;
    }
  };

  const select = (name, focus = false) => {
    if (!NETWORKS[name] || name === active) return;
    active = name;
    try {
      localStorage.setItem(NET_KEY, name);
    } catch {
      /* ignore - the switch still works for this page view */
    }
    paint();
    if (focus) buttons.find((b) => b.dataset.net === name)?.focus();
    onChange?.(name);
  };

  /* Under ~380px the stylesheet hides the inactive option, because the full
     switch competes with the brand for width. That would leave a control that
     cannot change anything - clicking the active option is a no-op - so when
     collapsed the visible pill cycles to the next network instead. The CSS
     breakpoint and this query have to stay in step; both are 380px. */
  const collapsed = window.matchMedia("(max-width: 380px)");

  const names = Object.keys(NETWORKS);
  const advance = () =>
    select(names[(names.indexOf(active) + 1) % names.length]);

  const describe = () => {
    // Collapsed, the group shows one name and no longer explains itself, so the
    // accessible name has to carry the action rather than just the label.
    mount.setAttribute(
      "aria-label",
      collapsed.matches ? "Aleo network - activate to switch" : "Aleo network",
    );
  };
  describe();
  collapsed.addEventListener("change", describe);

  buttons.forEach((btn, i) => {
    btn.addEventListener("click", () => {
      if (collapsed.matches && btn.dataset.net === active) return advance();
      select(btn.dataset.net);
    });
    btn.addEventListener("keydown", (event) => {
      const back = event.key === "ArrowLeft" || event.key === "ArrowUp";
      const fwd = event.key === "ArrowRight" || event.key === "ArrowDown";
      if (!back && !fwd) return;
      event.preventDefault();
      const next = buttons[(i + (fwd ? 1 : -1) + buttons.length) % buttons.length];
      select(next.dataset.net, true);
    });
  });

  paint();
  return active;
}

/**
 * The narrow-screen menu.
 *
 * Below 960px the inline nav has nowhere to sit, and hiding it outright left
 * every section unreachable on a phone. This turns it into a panel the toggle
 * opens, which keeps the bar one row tall.
 */
export function initMobileNav() {
  const button = document.getElementById("nav-toggle");
  const nav = document.getElementById("site-nav");
  if (!button || !nav) return;

  const setOpen = (open) => {
    nav.classList.toggle("is-open", open);
    button.classList.toggle("is-open", open);
    button.setAttribute("aria-expanded", String(open));
    button.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };

  setOpen(false);

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    setOpen(!nav.classList.contains("is-open"));
  });

  // A tapped link scrolls the page behind an open panel, so close it first.
  nav.addEventListener("click", (event) => {
    if (event.target.closest("a")) setOpen(false);
  });

  document.addEventListener("click", (event) => {
    if (!nav.classList.contains("is-open")) return;
    if (nav.contains(event.target) || button.contains(event.target)) return;
    setOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!nav.classList.contains("is-open")) return;
    setOpen(false);
    button.focus();
  });

  // Widening past the breakpoint must not leave a stale open panel behind.
  const wide = window.matchMedia("(min-width: 961px)");
  wide.addEventListener("change", (event) => {
    if (event.matches) setOpen(false);
  });
}
