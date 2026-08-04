"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - dayKey()
 * - saveDB()
 * - loadAI() — AI key config reader, still defined in app.js pending
 *   the Settings extraction; injected here rather than duplicated.
 * - hexToRgba() — still defined in app.js (color helper), pending the
 *   shared-utilities extraction.
 * - bigLine() — still defined in app.js (Detail Engine chart helper),
 *   pending the Dashboard extraction; reused here for the marker trend
 *   chart exactly as the original code did.
 * - getDB() / getColors() — accessors rather than plain values, since
 *   DB and COLORS are both reassigned at runtime (import/reset/cloud
 *   sync for DB, theme toggle for COLORS).
 */
(function (global) {
  function createBiomarkersModule({ dayKey, saveDB, loadAI, hexToRgba, bigLine, getDB, getColors }) {
    let markerOpenCode = null;

    function seedDefaultMarkers() {
      const DB = getDB();
      if (Object.keys(DB.markers).length > 0) return;
      const mk = (code, name, unit, category, clinicalLow, clinicalHigh, optimalLow, optimalHigh, sourceNote) => {
        DB.markers[code] = { code, name, unit, category, clinicalLow, clinicalHigh, optimalLow, optimalHigh, sourceNote };
      };
      mk("TT", "Total Testosterone", "ng/dL", "hormonal", 264, 916, 500, 900,
        "General adult male lab reference; varies by lab and assay.");
      mk("FREE_T", "Free Testosterone", "pg/mL", "hormonal", 66, 309, 200, 300,
        "Equilibrium dialysis reference range, healthy adult men.");
      mk("APOB", "Apolipoprotein B", "mg/dL", "lipid", null, 130, null, 80,
        "Standard lipid panel cutoff; optimal band targets lower cardiovascular risk.");
      mk("CRP_HS", "hs-CRP", "mg/L", "inflammatory", null, 3.0, null, 1.0,
        "AHA cardiovascular risk cutpoints (low risk under 1.0).");
      mk("VITD", "Vitamin D (25-OH)", "ng/mL", "micronutrient", 30, 100, 40, 60,
        "Endocrine Society sufficiency range.");
      mk("GLUCOSE", "Fasting Glucose", "mg/dL", "metabolic", null, 100, 70, 90,
        "ADA prediabetes threshold begins at 100mg/dL.");
      mk("HDL", "HDL Cholesterol", "mg/dL", "lipid", 40, null, 60, null,
        "Standard lipid panel; higher is protective.");
      mk("LDL", "LDL Cholesterol", "mg/dL", "lipid", null, 130, null, 100,
        "ADA/AHA near-optimal to optimal cutpoints.");
      saveDB(DB);
    }

    function markerBand(marker, value) {
      const COLORS = getColors();
      if (value == null) return { label: "NO DATA", color: COLORS.dim };
      const { clinicalLow, clinicalHigh, optimalLow, optimalHigh } = marker;
      if ((clinicalLow != null && value < clinicalLow) || (clinicalHigh != null && value > clinicalHigh)) {
        return { label: "OUT OF RANGE", color: COLORS.red };
      }
      const belowOptimal = optimalLow != null && value < optimalLow;
      const aboveOptimal = optimalHigh != null && value > optimalHigh;
      if (belowOptimal || aboveOptimal) return { label: "IN RANGE", color: COLORS.amber };
      return { label: "OPTIMAL", color: COLORS.green };
    }

    function logsForMarker(code) {
      const DB = getDB();
      return DB.biomarkerLogs.filter(l => l.code === code).sort((a, b) => a.date.localeCompare(b.date));
    }

    function rangeCaption(marker) {
      const fmt = (lo, hi) => (lo != null ? lo : "--") + " - " + (hi != null ? hi : "--") + " " + marker.unit;
      return "CLINICAL: " + fmt(marker.clinicalLow, marker.clinicalHigh) +
        "<br>OPTIMAL: " + fmt(marker.optimalLow, marker.optimalHigh) +
        "<br><span class=\"t3\">" + marker.sourceNote + "</span>";
    }

    /* ---------- Bio AI import ---------- */
    async function bioAIImport() {
      const DB = getDB();
      const COLORS = getColors();
      const status = document.getElementById("bio-import-status");
      const text = document.getElementById("bio-ai-paste").value.trim();
      if (!text) { status.textContent = "Paste lab results first."; status.style.color = COLORS.red; return; }
      const cfg = loadAI();
      if (!cfg || !cfg.key) { status.textContent = "Set Anthropic API key in SYS first."; status.style.color = COLORS.red; return; }

      status.innerHTML = '<span class="ai-thinking">READING LAB REPORT...</span>';

      const markers = Object.values(DB.markers);
      const markerList = markers.map(m => m.code + "=" + m.name + " (" + m.unit + ")").join(", ");

      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": cfg.key, "anthropic-version": "2023-06-01",
            "content-type": "application/json", "anthropic-dangerous-direct-browser-access": "true" },
          body: JSON.stringify({
            model: "claude-sonnet-4-6", max_tokens: 600,
            messages: [{ role: "user", content:
              "Extract blood test results from this lab report text. " +
              "Known markers to match: " + markerList + ". " +
              "Return ONLY a JSON array of objects: [{code, value, unit, date}]. " +
              "code must be one of the known marker codes. value must be a number. " +
              "date should be the report date if visible, otherwise omit. " +
              "Convert units if needed (e.g. nmol/L to ng/dL for testosterone: multiply by 28.84). " +
              "If a marker is not in the report, exclude it. No markdown, no explanation.\n\nLAB REPORT:\n" + text
            }]
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error((data.error && data.error.message) || "HTTP " + res.status);
        const raw = (data.content || []).map(b => b.text || "").join("").trim();
        const results = JSON.parse(raw.replace(/```json|```/g, "").trim());
        if (!Array.isArray(results) || !results.length) throw new Error("No markers recognised in this text.");

        let imported = 0;
        const today = dayKey();
        results.forEach(r => {
          if (!r.code || r.value == null || !DB.markers[r.code]) return;
          DB.biomarkerLogs.push({
            code: r.code, date: r.date || today,
            value: Number(r.value), labName: "AI Import", fasted: null
          });
          imported++;
        });
        saveDB(DB);
        renderMarkerList();
        status.textContent = imported + " marker" + (imported !== 1 ? "s" : "") + " imported. Tap any card to review.";
        status.style.color = COLORS.green;
      } catch (e) {
        status.textContent = "Import failed: " + e.message;
        status.style.color = COLORS.red;
      }
    }

    function renderMarkerList() {
      const DB = getDB();
      seedDefaultMarkers();
      const host = document.getElementById("marker-list");
      host.innerHTML = Object.values(DB.markers).map(m => {
        const logs = logsForMarker(m.code);
        const latest = logs.length ? logs[logs.length - 1] : null;
        const band = markerBand(m, latest ? latest.value : null);
        const ageLabel = latest
          ? Math.floor((Date.now() - new Date(latest.date).getTime()) / 86400000) + "d ago"
          : "Not logged";
        return '<div class="marker-card clickable" data-marker="' + m.code + '">' +
          '<div class="marker-info">' +
          '<div class="marker-name">' + m.name + '</div>' +
          '<div class="marker-cat">' + m.category + '</div>' +
          '</div>' +
          '<div class="marker-value-col">' +
          '<span class="marker-value" style="color:' + band.color + '">' + (latest ? latest.value : "--") + '</span> ' +
          '<span class="marker-unit">' + m.unit + '</span>' +
          '<div class="marker-age">' + ageLabel + '</div>' +
          '</div></div>';
      }).join("");
    }

    function openMarkerOverlay(code) {
      const DB = getDB();
      const COLORS = getColors();
      markerOpenCode = code;
      const m = DB.markers[code];
      const logs = logsForMarker(code);
      const latest = logs.length ? logs[logs.length - 1] : null;
      const band = markerBand(m, latest ? latest.value : null);

      document.getElementById("marker-title").textContent = m.name.toUpperCase();
      document.getElementById("marker-latest-value").textContent = latest ? latest.value : "--";
      document.getElementById("marker-latest-value").style.color = band.color;
      document.getElementById("marker-latest-unit").textContent = m.unit;
      const badgeEl = document.getElementById("marker-badge");
      if (latest) {
        badgeEl.textContent = band.label;
        badgeEl.style.display = "inline-block";
        badgeEl.style.background = hexToRgba(band.color, 0.14);
        badgeEl.style.color = band.color;
      } else {
        badgeEl.style.display = "none";
      }
      document.getElementById("marker-range-caption").innerHTML = rangeCaption(m);

      const chartWrap = document.getElementById("marker-chart-wrap");
      if (logs.length >= 2) {
        chartWrap.style.display = "block";
        document.getElementById("marker-chart").innerHTML = bigLine(logs.map(l => l.value), COLORS.cyan);
      } else {
        chartWrap.style.display = "none";
      }

      document.getElementById("mk-value").value = "";
      document.getElementById("mk-date").value = dayKey();
      document.getElementById("mk-lab").value = "";
      document.getElementById("mk-fasted").checked = false;

      document.getElementById("marker-history").innerHTML = logs.length
        ? logs.slice().reverse().map(l =>
            '<div class="log-history-row"><span>' + l.date + '</span><span>' + l.value + " " + m.unit +
            (l.labName ? " &middot; " + l.labName : "") + '</span></div>'
          ).join("")
        : '<div class="empty-hint">No results logged yet.</div>';

      document.getElementById("marker-overlay").classList.add("open");
    }

    function init() {
      document.getElementById("btn-bio-ai-import").addEventListener("click", bioAIImport);
      document.getElementById("btn-bio-ai-clear").addEventListener("click", () => {
        document.getElementById("bio-ai-paste").value = "";
        document.getElementById("bio-import-status").textContent = "";
      });

      document.getElementById("marker-list").addEventListener("click", (ev) => {
        const card = ev.target.closest("[data-marker]");
        if (card) openMarkerOverlay(card.dataset.marker);
      });

      document.getElementById("btn-close-marker").addEventListener("click", () => {
        document.getElementById("marker-overlay").classList.remove("open");
      });

      document.getElementById("btn-save-marker-log").addEventListener("click", () => {
        const DB = getDB();
        const value = Number(document.getElementById("mk-value").value);
        if (!Number.isFinite(value)) return;
        const date = document.getElementById("mk-date").value || dayKey();
        DB.biomarkerLogs.push({
          code: markerOpenCode, date, value,
          labName: document.getElementById("mk-lab").value.trim() || null,
          fasted: document.getElementById("mk-fasted").checked
        });
        saveDB(DB);
        renderMarkerList();
        openMarkerOverlay(markerOpenCode);
      });
    }

    return { init, render: renderMarkerList };
  }

  global.BioCommandBiomarkers = { createBiomarkersModule };
})(window);
