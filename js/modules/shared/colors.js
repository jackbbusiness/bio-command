"use strict";

/**
 * Not one of the four originally planned shared files, but "Color
 * helpers" was explicitly called out as a likely candidate.
 *
 * hexToRgba/readColors are pure (color/CSS in, string out) and are
 * exposed directly. bandColor/bandName read the *current* COLORS
 * palette, which is reassigned on every theme toggle — so this is a
 * small factory (createColorHelpers({ getColors })) rather than a
 * plain object, matching the accessor pattern used everywhere else
 * mutable state crosses a module boundary.
 */
(function (global) {
  function hexToRgba(hex, a) {
    const h = hex.replace("#", "");
    const n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    return {
      red:   cs.getPropertyValue("--red").trim(),
      amber: cs.getPropertyValue("--amber").trim(),
      green: cs.getPropertyValue("--green").trim(),
      cyan:  cs.getPropertyValue("--cyan").trim(),
      dim:   cs.getPropertyValue("--text-3").trim(),
      sleepDeep: cs.getPropertyValue("--sleep-deep").trim(),
      sleepCore: cs.getPropertyValue("--sleep-core").trim()
    };
  }

  function createColorHelpers({ getColors }) {
    function bandColor(score) {
      const COLORS = getColors();
      if (score == null) return COLORS.dim;
      if (score < 34) return COLORS.red;
      if (score < 67) return COLORS.amber;
      return COLORS.green;
    }
    function bandName(score) {
      if (score == null) return "CAL";
      if (score < 34) return "RED";
      if (score < 67) return "AMBER";
      return "GREEN";
    }
    return { bandColor, bandName };
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.colors = { hexToRgba, readColors, createColorHelpers };
})(window);
