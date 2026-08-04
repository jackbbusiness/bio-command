"use strict";

/**
 * Pure date helpers with no DB/COLORS dependency — safe to expose as
 * a plain object rather than a factory.
 */
(function (global) {
  function dayKey(d) {
    const dt = d || new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const day = String(dt.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function weekdayBit(date) {
    const d = date.getDay(); // 0 Sun .. 6 Sat
    return d === 0 ? 6 : d - 1; // Mon=0 .. Sun=6
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.dates = { dayKey, weekdayBit };
})(window);
