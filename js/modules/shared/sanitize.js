"use strict";

/**
 * The one shared HTML-escaping helper. Every module that builds
 * markup via string concatenation (rather than DOM node creation)
 * must run any DB-sourced or otherwise untrusted string through
 * escapeHtml() before interpolating it — whether it lands in text
 * content or inside an attribute value (the same five-character
 * escape is safe in both contexts).
 *
 * This is not the preferred fix everywhere: where a single element's
 * content was being replaced wholesale via innerHTML (Journal's note
 * textarea being the clearest case), building that element with
 * document.createElement/.value/.textContent instead removes the
 * injection vector entirely rather than just neutralizing it.
 * escapeHtml() is for the many existing .map().join() list-rendering
 * patterns where switching to full DOM construction would be a much
 * larger, redesign-shaped change.
 */
(function (global) {
  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.sanitize = { escapeHtml };
})(window);
