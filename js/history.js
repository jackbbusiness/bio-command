"use strict";

/* ============================================================
   HISTORY MODE v2.7
   Read-only historical explorer across all existing DB modules.

   getDB/getColors are accessors reading app.js's `DB`/`COLORS`
   bindings live, not a value captured once here -- a real bug the
   Phase 6 rewrite fixed: the previous boot shim passed a bare `DB`
   snapshot, so History would silently keep rendering pre-import/
   pre-cloud-sync data after `DB` was reassigned elsewhere in the app,
   since this file (a separate <script> tag) only re-evaluates once
   at load. dayKey/fmtMin/bandColor/showView/advisor/appendToken/
   bigMultiLine/wireChartTooltip are all top-level `const`/`function`
   bindings in app.js -- accessible here as bare identifiers because
   classic <script> tags share one global scope for `let`/`const`
   declarations even though those never become `window` properties.
   ============================================================ */

(() => {
  const historyModule = window.BioCommandHistory && window.BioCommandHistory.createHistoryModule
    ? window.BioCommandHistory.createHistoryModule({
        dayKey,
        fmtMin,
        bandColor,
        showView,
        escapeHtml: window.BioCommandShared.sanitize.escapeHtml,
        bigMultiLine,
        wireChartTooltip,
        advisor,
        appendToken,
        getDB: () => DB,
        getColors: () => COLORS
      })
    : null;

  if (historyModule) {
    historyModule.init();
  }
})();
