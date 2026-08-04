"use strict";

/**
 * Formalizes the dashboard hero ring's markup/update logic into a
 * reusable primitive so Training's rest-timer countdown (Phase 4) can
 * share it instead of re-deriving the SVG-arc math. Reuses the
 * existing .ring-wrap/.ring-track/.ring-arc/.ring-center CSS as-is
 * (app.css's .ring-wrap now sizes off --ring-size, default 148px, so
 * an instance at a different radius is just a different inline style
 * on the same classes -- no new CSS needed).
 *
 * Not yet wired into the dashboard itself in this phase -- 2B proves
 * the primitive standalone; Phase 3 is what points the hero ring's
 * existing markup at it.
 */
(function (global) {
  function createScoreRing({ radius = 62, hexToRgba } = {}) {
    const uid = "sr" + Math.random().toString(36).slice(2, 9);
    const c = 2 * Math.PI * radius;
    const size = (radius + 10) * 2;

    function markup() {
      return (
        '<svg viewBox="0 0 ' + size + " " + size + '">' +
          '<defs><linearGradient id="rg-' + uid + '" x1="0%" y1="0%" x2="100%" y2="100%">' +
            '<stop offset="0%" id="rg1-' + uid + '" stop-color="#1FE87E"></stop>' +
            '<stop offset="100%" id="rg2-' + uid + '" stop-color="#1FE87E" stop-opacity="0.45"></stop>' +
          "</linearGradient></defs>" +
          '<circle class="ring-track" cx="' + size / 2 + '" cy="' + size / 2 + '" r="' + radius + '"></circle>' +
          '<circle class="ring-arc" id="ring-arc-' + uid + '" cx="' + size / 2 + '" cy="' + size / 2 +
            '" r="' + radius + '" stroke="url(#rg-' + uid + ')" stroke-dasharray="' + c +
            '" stroke-dashoffset="' + c + '"></circle>' +
        "</svg>"
      );
    }

    function setProgress(fraction, color) {
      const arc = document.getElementById("ring-arc-" + uid);
      if (!arc) return;
      const f = Math.max(0, Math.min(1, fraction == null ? 0 : fraction));
      arc.style.strokeDashoffset = String(c * (1 - f));
      if (color) {
        arc.style.filter = "drop-shadow(0 0 10px " + (hexToRgba ? hexToRgba(color, 0.5) : color) + ")";
        const rg1 = document.getElementById("rg1-" + uid);
        const rg2 = document.getElementById("rg2-" + uid);
        if (rg1) rg1.setAttribute("stop-color", color);
        if (rg2) rg2.setAttribute("stop-color", color);
      }
    }

    return { uid, circumference: c, markup, setProgress };
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.scoreRing = { createScoreRing };
})(window);
