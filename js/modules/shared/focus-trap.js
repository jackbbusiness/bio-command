"use strict";

/**
 * Generic overlay focus management, added once at boot rather than
 * threaded through the 9 static `.overlay` elements' open/close call
 * sites scattered across 5 modules. A MutationObserver watches each
 * overlay's `class` attribute (every module already toggles `"open"`
 * the same way) so this works for all current and future overlays
 * with zero changes to how modules open/close them.
 *
 * Scope is deliberately narrow: focus enters the overlay on open, Tab
 * is trapped inside it, and focus returns to whatever triggered it on
 * close. No Escape-to-close/click-outside — those would need to know
 * each overlay's own close semantics (e.g. the barcode overlay stops
 * a camera stream on close), which isn't safe to guess generically.
 */
(function (global) {
  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function focusablesIn(el) {
    return Array.from(el.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter((e) => e.offsetParent !== null || e === document.activeElement);
  }

  function initOverlayFocusManagement(root) {
    root = root || document;
    let lastTrigger = null;

    function onOverlayOpened(overlay) {
      lastTrigger = document.activeElement;
      const focusables = focusablesIn(overlay);
      (focusables[0] || overlay).focus({ preventScroll: true });
    }

    function onOverlayClosed() {
      if (lastTrigger && document.body.contains(lastTrigger) && typeof lastTrigger.focus === "function") {
        lastTrigger.focus({ preventScroll: true });
      }
      lastTrigger = null;
    }

    const observer = new MutationObserver((mutations) => {
      mutations.forEach((m) => {
        if (m.type !== "attributes" || m.attributeName !== "class") return;
        const el = m.target;
        if (!el.classList || !el.classList.contains("overlay")) return;
        const wasOpen = m.oldValue != null && m.oldValue.split(/\s+/).includes("open");
        const isOpen = el.classList.contains("open");
        if (isOpen && !wasOpen) onOverlayOpened(el);
        else if (!isOpen && wasOpen) onOverlayClosed();
      });
    });
    root.querySelectorAll(".overlay").forEach((el) => {
      observer.observe(el, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
    });

    root.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const openOverlay = root.querySelector(".overlay.open");
      if (!openOverlay) return;
      const focusables = focusablesIn(openOverlay);
      if (!focusables.length) { e.preventDefault(); return; }
      const first = focusables[0], last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    });
  }

  global.BioCommandShared = global.BioCommandShared || {};
  global.BioCommandShared.focusTrap = { initOverlayFocusManagement };
})(window);
