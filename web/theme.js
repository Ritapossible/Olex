/**
 * Shared page chrome: the theme toggle and the mobile navigation panel.
 *
 * Both the dashboard and the docs page carry the same top bar, so this lives in
 * one module instead of being copied into each and drifting apart.
 */

const STORE_KEY = "olex-theme";

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
