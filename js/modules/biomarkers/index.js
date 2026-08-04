"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - dayKey()
 * - saveDB()
 * - hexToRgba() — still defined in app.js (color helper), pending the
 *   shared-utilities extraction.
 * - bigLine() — still defined in app.js (Detail Engine chart helper),
 *   pending the Dashboard extraction; reused here for the marker trend
 *   chart exactly as the original code did.
 * - getDB() / getColors() — accessors rather than plain values, since
 *   DB and COLORS are both reassigned at runtime (import/reset/cloud
 *   sync for DB, theme toggle for COLORS).
 * - escapeHtml() — js/modules/shared/sanitize.js; run over marker
 *   name/category/unit/sourceNote and log labName before they're
 *   interpolated into a rendered HTML string (marker definitions and
 *   log entries can both come from import, not just manual entry).
 * - advisor / appendToken — js/modules/shared/ai-stream.js, the same
 *   shared instance every other AI consumer uses.
 */
(function (global) {
  function createBiomarkersModule({ dayKey, saveDB, hexToRgba, bigLine, escapeHtml, advisor, appendToken, getDB, getColors }) {
    let markerOpenCode = null;
    let pendingImport = null; // [{code, value, unit, date, accepted}]

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
      const unit = escapeHtml(marker.unit);
      const fmt = (lo, hi) => (lo != null ? lo : "--") + " - " + (hi != null ? hi : "--") + " " + unit;
      return "CLINICAL: " + fmt(marker.clinicalLow, marker.clinicalHigh) +
        "<br>OPTIMAL: " + fmt(marker.optimalLow, marker.optimalHigh) +
        "<br><span class=\"t3\">" + escapeHtml(marker.sourceNote) + "</span>";
    }

    // Bounds the value slider to a plausible range for this specific
    // marker -- clinical range padded 30%, or optimal range padded
    // further if clinical bounds aren't defined (e.g. HDL only has a
    // clinical floor). Typing an exact value in #mk-value still works
    // untouched; the slider is a fast path to a value that's already
    // in the right neighborhood, not the only way in.
    function sliderRangeFor(marker) {
      const lo = marker.clinicalLow ?? marker.optimalLow ?? 0;
      const hi = marker.clinicalHigh ?? marker.optimalHigh ?? (lo > 0 ? lo * 3 : 100);
      const span = Math.max(hi - lo, 1);
      const min = Math.max(0, lo - span * 0.3);
      const max = hi + span * 0.3;
      const step = span > 50 ? 1 : span > 5 ? 0.5 : 0.1;
      return { min, max, step };
    }

    function labNameOptions() {
      const DB = getDB();
      return Array.from(new Set(DB.biomarkerLogs.map(l => l.labName).filter(Boolean)));
    }

    /* ---------- Bio AI import ---------- */
    // Extracts markers via the shared advisor, then shows a per-row
    // accept/reject preview instead of bulk-inserting straight away --
    // the model's unit-conversion/date-guessing is fallible, so the
    // operator confirms what actually lands in DB.biomarkerLogs.
    async function bioAIImport() {
      const DB = getDB();
      const COLORS = getColors();
      const status = document.getElementById("bio-import-status");
      const text = document.getElementById("bio-ai-paste").value.trim();
      if (!text) { status.textContent = "Paste lab results first."; status.style.color = COLORS.red; return; }

      status.innerHTML = '<span class="ai-thinking">READING LAB REPORT...</span>';
      document.getElementById("bio-import-preview").hidden = true;

      const markers = Object.values(DB.markers);
      const markerList = markers.map(m => m.code + "=" + m.name + " (" + m.unit + ")").join(", ");

      try {
        const raw = await advisor.ask(
          "Extract blood test results from this lab report text. " +
          "Known markers to match: " + markerList + ". " +
          "Return ONLY a JSON array of objects: [{code, value, unit, date}]. " +
          "code must be one of the known marker codes. value must be a number. " +
          "date should be the report date if visible, otherwise omit. " +
          "Convert units if needed (e.g. nmol/L to ng/dL for testosterone: multiply by 28.84). " +
          "If a marker is not in the report, exclude it. No markdown, no explanation.\n\nLAB REPORT:\n" + text,
          { maxTokens: 600 }
        );
        const results = JSON.parse(raw.replace(/```json|```/g, "").trim());
        if (!Array.isArray(results) || !results.length) throw new Error("No markers recognised in this text.");

        const today = dayKey();
        pendingImport = results
          .filter(r => r.code && r.value != null && DB.markers[r.code])
          .map(r => ({ code: r.code, value: Number(r.value), date: r.date || today, accepted: true }));
        if (!pendingImport.length) throw new Error("No markers recognised in this text.");

        status.textContent = pendingImport.length + " marker" + (pendingImport.length !== 1 ? "s" : "") + " found. Review below.";
        status.style.color = COLORS.green;
        renderImportPreview();
      } catch (e) {
        status.textContent = e.message === "SET KEY IN SYS" ? "Set Anthropic API key in SYS first." : "Import failed: " + e.message;
        status.style.color = COLORS.red;
      }
    }

    function renderImportPreview() {
      const DB = getDB();
      const wrap = document.getElementById("bio-import-preview");
      const host = document.getElementById("bio-import-preview-rows");
      if (!pendingImport || !pendingImport.length) { wrap.hidden = true; return; }
      wrap.hidden = false;
      host.innerHTML = pendingImport.map((r, i) => {
        const m = DB.markers[r.code];
        return '<label class="bio-import-row' + (r.accepted ? "" : " rejected") + '" data-idx="' + i + '">' +
          '<input type="checkbox"' + (r.accepted ? " checked" : "") + '>' +
          '<span class="bir-code">' + escapeHtml(r.code) + '</span>' +
          '<span class="bir-value">' + r.value + ' ' + escapeHtml(m ? m.unit : "") + '</span>' +
          '<span class="bir-date">' + escapeHtml(r.date) + '</span>' +
          '</label>';
      }).join("");
    }

    function confirmImport() {
      const DB = getDB();
      const COLORS = getColors();
      const status = document.getElementById("bio-import-status");
      if (!pendingImport) return;
      let imported = 0;
      pendingImport.forEach(r => {
        if (!r.accepted) return;
        DB.biomarkerLogs.push({ code: r.code, date: r.date, value: r.value, labName: "AI Import", fasted: null });
        imported++;
      });
      saveDB(DB);
      renderMarkerList();
      status.textContent = imported + " marker" + (imported !== 1 ? "s" : "") + " imported. Tap any card to review.";
      status.style.color = COLORS.green;
      pendingImport = null;
      document.getElementById("bio-import-preview").hidden = true;
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
        return '<div class="marker-card clickable" data-marker="' + escapeHtml(m.code) + '">' +
          '<div class="marker-info">' +
          '<div class="marker-name">' + escapeHtml(m.name) + '</div>' +
          '<div class="marker-cat">' + escapeHtml(m.category) + '</div>' +
          '</div>' +
          '<div class="marker-value-col">' +
          '<span class="marker-value" style="color:' + band.color + '">' + (latest ? latest.value : "--") + '</span> ' +
          '<span class="marker-unit">' + escapeHtml(m.unit) + '</span>' +
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
        const refBand = (m.optimalLow != null || m.optimalHigh != null)
          ? [m.optimalLow, m.optimalHigh] : null;
        document.getElementById("marker-chart").innerHTML = bigLine(logs.map(l => l.value), COLORS.cyan, null, refBand);
      } else {
        chartWrap.style.display = "none";
      }

      const range = sliderRangeFor(m);
      const slider = document.getElementById("mk-value-slider");
      slider.min = range.min; slider.max = range.max; slider.step = range.step;
      const mid = latest ? latest.value : (range.min + range.max) / 2;
      slider.value = Math.min(range.max, Math.max(range.min, mid));
      document.getElementById("mk-value-slider-val").textContent = slider.value;

      const labList = document.getElementById("mk-lab-list");
      labList.innerHTML = labNameOptions().map(l => '<option value="' + escapeHtml(l) + '"></option>').join("");

      document.getElementById("mk-value").value = "";
      document.getElementById("mk-date").value = dayKey();
      document.getElementById("mk-lab").value = "";
      document.getElementById("mk-fasted").checked = false;

      document.getElementById("marker-history").innerHTML = logs.length
        ? logs.slice().reverse().map(l =>
            '<div class="log-history-row"><span>' + escapeHtml(l.date) + '</span><span>' + l.value + " " + escapeHtml(m.unit) +
            (l.labName ? " &middot; " + escapeHtml(l.labName) : "") + '</span></div>'
          ).join("")
        : '<div class="empty-hint">No results logged yet.</div>';

      document.getElementById("marker-overlay").classList.add("open");
    }

    function init() {
      document.getElementById("btn-bio-ai-import").addEventListener("click", bioAIImport);
      document.getElementById("btn-bio-ai-clear").addEventListener("click", () => {
        document.getElementById("bio-ai-paste").value = "";
        document.getElementById("bio-import-status").textContent = "";
        pendingImport = null;
        document.getElementById("bio-import-preview").hidden = true;
      });

      document.getElementById("bio-import-preview-rows").addEventListener("change", (ev) => {
        const row = ev.target.closest("[data-idx]");
        if (!row || !pendingImport) return;
        const idx = Number(row.dataset.idx);
        pendingImport[idx].accepted = ev.target.checked;
        row.classList.toggle("rejected", !ev.target.checked);
      });
      document.getElementById("btn-bio-import-confirm").addEventListener("click", confirmImport);
      document.getElementById("btn-bio-import-cancel").addEventListener("click", () => {
        pendingImport = null;
        document.getElementById("bio-import-preview").hidden = true;
        document.getElementById("bio-import-status").textContent = "";
      });

      // Slider <-> typed-value sync: dragging fills #mk-value (what
      // Save actually reads); typing an exact value keeps the slider
      // thumb in sync too, clamped to its range.
      const slider = document.getElementById("mk-value-slider");
      const valueInput = document.getElementById("mk-value");
      const sliderVal = document.getElementById("mk-value-slider-val");
      slider.addEventListener("input", () => {
        valueInput.value = slider.value;
        sliderVal.textContent = slider.value;
      });
      valueInput.addEventListener("input", () => {
        const v = parseFloat(valueInput.value);
        if (Number.isFinite(v)) {
          slider.value = Math.min(Number(slider.max), Math.max(Number(slider.min), v));
          sliderVal.textContent = slider.value;
        }
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
