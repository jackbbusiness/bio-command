"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - Storage — the storage.js adapter, destructured once in app.js and
 *   never reassigned.
 * - saveDB() / renderCommand() / computeStrain() — computeStrain still
 *   defined in app.js (Scoring Engines), pending the shared-utilities
 *   extraction; also relied on by computeScores there.
 * - readColors() — recomputes the color set from CSS custom
 *   properties; used after a theme switch.
 * - getDB() / getColors() — read accessors, and setColors() — a write
 *   callback — because DB and COLORS are both reassigned at runtime
 *   (import/reset/cloud sync for DB, theme toggle for COLORS) and
 *   this module is literally the one that *drives* the COLORS
 *   reassignment on theme change.
 *
 * Exposes applyTheme (boot calls it once before first paint) and
 * loadAI/saveAI (Fuel, Biomarkers and Dashboard all read the stored
 * AI key through these; the SYS "save key" button and the boot-time
 * advisor status check stay as app.js glue, since updating Today's
 * advisor card would otherwise make this module depend on Dashboard
 * while Dashboard already depends on Settings for loadAI — avoiding
 * the cycle).
 */
(function (global) {
  function createSettingsModule({ Storage, saveDB, renderCommand, computeStrain, readColors, getDB, getColors, setColors }) {
    const THEME_KEY = "biocommand.theme";
    const AI_KEY = "biocommand.ai";
    const metaTheme = document.getElementById("meta-theme");
    const btnTheme = document.getElementById("btn-theme");

    function applyTheme(mode) {
      if (mode === "light") {
        document.documentElement.dataset.theme = "light";
      } else {
        delete document.documentElement.dataset.theme;
      }
      metaTheme.setAttribute("content", getComputedStyle(document.documentElement).getPropertyValue("--tac-base").trim());
      btnTheme.textContent = mode === "light" ? "DAY" : "NIGHT";
      setColors(readColors());
      renderCommand();
    }

    function renderProfile() {
      const DB = getDB();
      document.getElementById("prof-maxhr").value = DB.operator.maxHR || "";
    }

    function loadAI() {
      try { return JSON.parse(Storage.get(AI_KEY)) || null; }
      catch (e) { return null; }
    }
    function saveAI(cfg) { Storage.set(AI_KEY, JSON.stringify(cfg)); }

    function init() {
      btnTheme.addEventListener("click", () => {
        const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
        Storage.set(THEME_KEY, next);
        applyTheme(next);
      });

      document.getElementById("btn-save-profile").addEventListener("click", () => {
        const DB = getDB();
        const COLORS = getColors();
        const v = Number(document.getElementById("prof-maxhr").value);
        const st = document.getElementById("profile-status");
        if (!Number.isFinite(v) || v < 100 || v > 230) {
          st.textContent = "ENTER A VALID BPM";
          st.style.color = COLORS.red;
          return;
        }
        DB.operator.maxHR = v;
        let updated = 0;
        Object.keys(DB.telemetry).forEach(k => {
          const r = DB.telemetry[k];
          if (r.sessionRPE == null && r.trainingAvgHR != null) {
            const res = computeStrain(r);
            r.systemLoadScore = Math.round(res.value * 10) / 10;
            r.strainMethod = res.method;
            updated++;
          }
        });
        saveDB(DB);
        renderCommand();
        st.textContent = "SAVED. " + updated + " DAY(S) RECALCULATED.";
        st.style.color = COLORS.green;
      });
    }

    return { init, render: renderProfile, applyTheme, loadAI, saveAI };
  }

  global.BioCommandSettings = { createSettingsModule };
})(window);
