"use strict";

/**
 * Transient, non-modal notifications -- distinct from the storage
 * banner (persistent, actionable, dismissible-only-by-user) and from
 * inline status text (module-local, e.g. "SAVED"). Reserved for
 * cross-cutting confirmations that don't have a natural inline home.
 *
 * The icon markup is a fixed, internally-controlled string (never
 * built from DB/AI/user-sourced data), so building it via innerHTML
 * here doesn't reopen the C1 XSS fix -- the caller-supplied `message`
 * is always set through a separate textContent assignment, never
 * concatenated into the HTML string.
 */
(function (global) {
  const ICONS = { ok: "icon-check", warn: "icon-warn", error: "icon-error", info: "icon-info" };
  let stack = null;

  function ensureStack() {
    if (stack && document.body.contains(stack)) return stack;
    stack = document.createElement("div");
    stack.className = "toast-stack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
    return stack;
  }

  function showToast(message, { tone = "info", duration = 3200 } = {}) {
    const root = ensureStack();
    const el = document.createElement("div");
    el.className = "toast tone-" + tone;
    const iconId = ICONS[tone] || ICONS.info;
    el.innerHTML =
      '<svg class="icon" aria-hidden="true"><use href="#' + iconId + '"></use></svg>' +
      '<span class="toast-msg"></span>';
    el.querySelector(".toast-msg").textContent = message;
    root.appendChild(el);
    requestAnimationFrame(() => el.classList.add("show"));

    let dismissed = false;
    function dismiss() {
      if (dismissed) return;
      dismissed = true;
      clearTimeout(timer);
      el.classList.remove("show");
      el.addEventListener("transitionend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 500);
    }
    const timer = setTimeout(dismiss, duration);
    el.addEventListener("click", dismiss);
    return { dismiss };
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.toast = { showToast };
})(window);
