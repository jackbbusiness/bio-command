"use strict";

/**
 * Pure formatting/math helpers with no DB/COLORS dependency — safe
 * to expose as a plain object rather than a factory.
 *
 * meanOf lives here rather than a dedicated stats file: it's a
 * single three-line utility (Journal and Protocols both depend on
 * it directly) and doesn't warrant its own module.
 */
(function (global) {
  function fmtMin(min) {
    const neg = min < 0;
    const a = Math.abs(Math.round(min));
    const h = Math.floor(a / 60);
    const m = a % 60;
    return (neg ? "-" : "") + h + ":" + String(m).padStart(2, "0");
  }

  function clamp01(x) { return Math.max(0, Math.min(1, x)); }

  function meanOf(arr) {
    if (!arr.length) return null;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.formatting = { fmtMin, clamp01, meanOf };
})(window);
