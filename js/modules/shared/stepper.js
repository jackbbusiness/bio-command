"use strict";

/**
 * Wires an existing `.stepper` DOM fragment (two `.stepper-btn[data-dir]`
 * buttons flanking a `.stepper-value` input) with +/- click handling and
 * min/max/step clamping. Typing directly into the value input still
 * works untouched -- this only adds the button behavior on top.
 */
(function (global) {
  function wireStepper(root, { min, max, step, value, onChange } = {}) {
    const input = root.querySelector(".stepper-value");
    const decBtn = root.querySelector('[data-dir="-1"]');
    const incBtn = root.querySelector('[data-dir="1"]');

    const lo = min != null ? min : (root.dataset.min != null ? parseFloat(root.dataset.min) : -Infinity);
    const hi = max != null ? max : (root.dataset.max != null ? parseFloat(root.dataset.max) : Infinity);
    const st = step != null ? step : (root.dataset.step != null ? parseFloat(root.dataset.step) : 1);
    const decimals = (String(st).split(".")[1] || "").length;

    function round(v) { return parseFloat(v.toFixed(decimals)); }
    function clamp(v) { return Math.min(hi, Math.max(lo, v)); }
    function current() { return parseFloat(input.value) || 0; }

    function set(v, emit) {
      v = clamp(round(v));
      input.value = String(v);
      if (emit !== false && typeof onChange === "function") onChange(v);
      return v;
    }

    decBtn && decBtn.addEventListener("click", () => set(current() - st));
    incBtn && incBtn.addEventListener("click", () => set(current() + st));
    input.addEventListener("change", () => set(current()));

    set(value != null ? value : current(), false);

    return { getValue: current, setValue: (v) => set(v) };
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.stepper = { wireStepper };
})(window);
