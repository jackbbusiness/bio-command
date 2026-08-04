"use strict";

/**
 * Pure DOM helper with no DB/COLORS dependency — safe to expose as a
 * plain object rather than a factory.
 */
(function (global) {
  function armDangerButton(btn, actionLabel, doAction) {
    if (btn.dataset.armed === "1") {
      clearTimeout(Number(btn.dataset.armTimer));
      btn.dataset.armed = "0";
      btn.textContent = actionLabel;
      doAction();
      return;
    }
    btn.dataset.armed = "1";
    const original = btn.textContent;
    btn.textContent = "TAP AGAIN TO CONFIRM";
    const t = setTimeout(() => {
      btn.dataset.armed = "0";
      btn.textContent = original;
    }, 3500);
    btn.dataset.armTimer = String(t);
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.dom = { armDangerButton };
})(window);
