/**
 * Apply the stored theme before the first paint.
 *
 * The markup ships data-theme="dark" and theme.js corrects it to whatever the
 * visitor chose - but theme.js is a module, and modules are deferred, so that
 * correction lands only after the document has been parsed and painted. Anyone
 * who picked light therefore saw a dark frame on every load before it flipped.
 *
 * This runs as a classic, render-blocking script in <head>, ahead of the
 * stylesheet, so the attribute is already right the first time anything is
 * drawn.
 *
 * It stays a separate file rather than an inline block on purpose: vercel.json
 * sends script-src 'self' with no 'unsafe-inline', so an inline script would be
 * dropped in production while still working against scripts/serve-web.mjs - the
 * flash returning silently, only in the place nobody is watching.
 *
 * The "olex-theme" key and the localStorage guard are duplicated from theme.js
 * rather than imported, because importing would make this a module, and a
 * module is deferred - which is the whole problem. If the key changes, both
 * files change together.
 */
(function () {
  try {
    var saved = localStorage.getItem("olex-theme");
    if (saved === "light" || saved === "dark") {
      document.documentElement.dataset.theme = saved;
    }
  } catch (err) {
    /* localStorage throws in Safari private mode and in sandboxed iframes. The
       markup default stands, and theme.js makes the same allowance. */
  }
})();
