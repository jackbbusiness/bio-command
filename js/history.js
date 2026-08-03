"use strict";

/* ============================================================
   HISTORY MODE v2.2.1
   Read-only historical explorer across all existing DB modules.
   ============================================================ */

(() => {
  const historyModule = window.BioCommandHistory && window.BioCommandHistory.createHistoryModule
    ? window.BioCommandHistory.createHistoryModule({
        dayKey,
        fmtMin,
        bandColor,
        DB,
        showView
      })
    : null;

  if (historyModule) {
    historyModule.init();
  }
})();
