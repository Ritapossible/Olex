/**
 * Docs page behaviour: shared chrome, plus a table of contents that tracks
 * where the reader actually is.
 */

import { initTheme, initMobileNav, initNetworkSwitch, storedNetwork } from "./theme.js";

/**
 * Mark the section currently being read in the table of contents.
 *
 * IntersectionObserver rather than a scroll handler: no listener firing on every
 * frame, and the browser does the geometry. The top margin matches the sticky
 * bar so a section counts as current once it clears the chrome, not when it
 * technically enters the viewport underneath it.
 */
function initScrollSpy() {
  const links = [...document.querySelectorAll(".doc-toc a")];
  if (!links.length) return;

  const byId = new Map();
  for (const link of links) {
    const id = link.getAttribute("href")?.replace(/^#/, "");
    const section = id && document.getElementById(id);
    if (section) byId.set(section, link);
  }
  if (!byId.size) return;

  const mark = (link) => {
    for (const other of links) other.classList.toggle("is-current", other === link);
  };

  // Reduced motion means no smooth scroll, so a click should read as instant
  // feedback rather than waiting for the observer to catch up.
  for (const link of links) {
    link.addEventListener("click", () => mark(link));
  }

  const visible = new Set();

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      }

      // Topmost visible section wins. Several are on screen at once in a long
      // document, and the one the reader is in is the highest of them.
      if (!visible.size) return;
      const top = [...visible].sort(
        (a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top,
      )[0];
      const link = byId.get(top);
      if (link) mark(link);
    },
    { rootMargin: "-92px 0px -55% 0px", threshold: 0 },
  );

  for (const section of byId.keys()) observer.observe(section);
}

/**
 * Point the docs at whichever network the reader picked.
 *
 * The install snippets are the reason this matters. Someone reading on mainnet
 * and pasting a config that pins OLEX_NETWORK to testnet gets a server on the
 * wrong chain, and nothing in the snippet would tell them why. The switch is
 * shared with the dashboard through localStorage, so a choice made on either
 * page holds on the other.
 *
 * Text swaps only - no element is added or removed, so the reader's scroll
 * position and the table of contents stay put.
 *
 * Deliberately not swapped: the "Default network" badge and the OLEX_NETWORK
 * row in the env table. Those state what the server does when you set nothing
 * (src/lib/network.ts falls back to testnet), which is true no matter what the
 * reader has selected here. Following the switch would turn them into a lie.
 */
function paintNetwork(name) {
  for (const el of document.querySelectorAll("[data-net-name]")) {
    el.textContent = name;
  }
  const foot = document.getElementById("foot-network");
  if (foot) foot.textContent = `Data: public Provable API · ${name}`;
}

initTheme();
initMobileNav();
initScrollSpy();
paintNetwork(storedNetwork());
initNetworkSwitch(paintNetwork);
