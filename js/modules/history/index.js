"use strict";

/**
 * Runtime dependencies supplied by js/history.js (its own small boot
 * shim, loaded after app.js -- see that file for why getDB/getColors
 * are accessors reading app.js's `DB`/`COLORS` bindings live rather
 * than a value captured once at construction, fixing a real bug the
 * Phase 6 rewrite found: the old boot shim passed a bare `DB` snapshot,
 * so History would silently keep showing pre-import/pre-sync data
 * after DB was reassigned elsewhere in the app):
 * - dayKey() / fmtMin() / bandColor() / showView()
 * - escapeHtml() -- js/modules/shared/sanitize.js
 * - bigMultiLine() / wireChartTooltip() -- js/modules/shared/charts.js
 * - advisor / appendToken -- js/modules/shared/ai-stream.js, the same
 *   shared instance every other AI consumer uses
 * - getDB() / getColors()
 */
(function (global) {
  function createHistoryModule({ dayKey, fmtMin, bandColor, showView, escapeHtml, bigMultiLine, wireChartTooltip, advisor, appendToken, getDB, getColors }) {
    let rangeDays = 7;
    let endKey = dayKey();
    let searchQuery = "";
    let activeFilters = new Set(["wearable", "sleep", "training", "fuel", "protocols", "journal", "biomarkers"]);
    let activeSeries = new Set(["recovery", "strain", "sleep"]);
    let openKeys = new Set();
    let chartTooltipHandle = null;

    const $ = (id) => document.getElementById(id);
    const parseKey = (key) => {
      const [y, m, d] = key.split("-").map(Number);
      return new Date(y, m - 1, d, 12, 0, 0);
    };
    const shiftKey = (key, amount) => {
      const d = parseKey(key);
      d.setDate(d.getDate() + amount);
      return dayKey(d);
    };
    const humanDate = (key) => parseKey(key).toLocaleDateString(undefined, {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    });
    const shortDate = (key) => parseKey(key).toLocaleDateString(undefined, { day: "numeric", month: "short" });
    const esc = escapeHtml;
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);

    /* ============================================================
       DATA ACCESS (unchanged logic from the pre-rewrite module --
       already correct/tested, just now reading a live DB via getDB())
       ============================================================ */

    function dayDataExists(key) {
      const DB = getDB();
      return Boolean(
        DB.telemetry[key] ||
        (DB.fuelLog || []).some((x) => x.dayKey === key) ||
        (DB.sessions || []).some((x) => (x.dayKey || (x.startedAt || "").slice(0, 10)) === key) ||
        (DB.journal || {})[key] ||
        (DB.completions || {})[key] ||
        (DB.biomarkerLogs || []).some((x) => x.date === key)
      );
    }

    function fuelFor(key) {
      const DB = getDB();
      const meals = (DB.fuelLog || []).filter((x) => x.dayKey === key);
      return {
        meals,
        kcal: sum(meals.map((x) => Number(x.kcal || x.calories || 0))),
        protein: sum(meals.map((x) => Number(x.protein || x.proteinG || 0))),
        carbs: sum(meals.map((x) => Number(x.carbs || x.carbsG || 0))),
        fat: sum(meals.map((x) => Number(x.fat || x.fatG || 0)))
      };
    }

    function sessionsFor(key) {
      const DB = getDB();
      return (DB.sessions || []).filter((x) => (x.dayKey || (x.startedAt || "").slice(0, 10)) === key);
    }

    function rangeKeys() {
      const DB = getDB();
      const all = new Set([
        ...Object.keys(DB.telemetry || {}),
        ...(DB.fuelLog || []).map((x) => x.dayKey),
        ...(DB.sessions || []).map((x) => x.dayKey || (x.startedAt || "").slice(0, 10)),
        ...Object.keys(DB.journal || {}),
        ...Object.keys(DB.completions || {}),
        ...(DB.biomarkerLogs || []).map((x) => x.date)
      ].filter(Boolean));
      if (rangeDays === 0) return [...all].filter((k) => k <= endKey).sort();
      const start = shiftKey(endKey, -(rangeDays - 1));
      const keys = [];
      for (let k = start; k <= endKey; k = shiftKey(k, 1)) keys.push(k);
      return keys;
    }

    /* ============================================================
       DAILY RECORD (same field set as before the rewrite -- the
       Phase 6 field-parity checklist this was built against: wearable
       telemetry, sleep stages, training, fuel, protocols, journal,
       biomarkers. Filterable now via activeFilters and searchable via
       searchQuery, but every field that existed before still renders.)
       ============================================================ */

    function group(kind, title, lines, color) {
      if (!activeFilters.has(kind)) return "";
      if (!lines.length) return "";
      return `<div class="history-record-group"><div class="hrg-head"><span class="status-dot" style="color:${color}"></span>${esc(title)}</div>` +
        lines.map(([a, b]) => `<div class="hrg-line"><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join("") + `</div>`;
    }

    function dayRecordHtml(key) {
      const DB = getDB();
      const t = DB.telemetry[key] || {};
      const f = fuelFor(key);
      const sessions = sessionsFor(key);
      const journal = (DB.journal || {})[key];
      const completions = (DB.completions || {})[key] || {};
      const labs = (DB.biomarkerLogs || []).filter((x) => x.date === key);
      let html = "";

      const wearable = [];
      [["HRV", t.hrvMs != null ? `${t.hrvMs} ms` : null], ["Resting heart rate", t.restingHR != null ? `${t.restingHR} bpm` : null],
       ["Respiratory rate", t.respiratoryRate != null ? `${t.respiratoryRate}/min` : null], ["Body mass", t.bodyMassKg != null ? `${t.bodyMassKg} kg` : null],
       ["Active energy", t.activeEnergyKcal != null ? `${Math.round(t.activeEnergyKcal)} kcal` : null]].forEach((x) => { if (x[1]) wearable.push(x); });
      html += group("wearable", "Wearable telemetry", wearable, "var(--cyan)");

      const sleep = [];
      [["Total", t.sleepTotalMin != null ? fmtMin(t.sleepTotalMin) : null], ["Deep", t.sleepDeepMin != null ? fmtMin(t.sleepDeepMin) : null],
       ["REM", t.sleepREMMin != null ? fmtMin(t.sleepREMMin) : null], ["Awake", t.sleepAwakeMin != null ? fmtMin(t.sleepAwakeMin) : null]].forEach((x) => { if (x[1]) sleep.push(x); });
      html += group("sleep", "Sleep", sleep, "var(--amber)");

      const training = sessions.map((s) => [s.workoutName || s.name || "Workout", [s.durationMin ? `${s.durationMin} min` : "", s.totalVolume ? `${Math.round(s.totalVolume)} volume` : ""].filter(Boolean).join(" · ") || "Completed"]);
      if (!training.length && t.trainingMinutes) training.push(["Training", `${t.trainingMinutes} min${t.sessionRPE ? ` · RPE ${t.sessionRPE}` : ""}`]);
      html += group("training", "Training", training, "var(--red)");

      const nutrition = f.meals.map((m) => [m.name || m.productName || "Food", `${Math.round(Number(m.kcal || m.calories || 0))} kcal · ${Math.round(Number(m.protein || m.proteinG || 0))}g protein`]);
      if (f.meals.length) nutrition.unshift(["Daily total", `${Math.round(f.kcal)} kcal · P ${Math.round(f.protein)}g · C ${Math.round(f.carbs)}g · F ${Math.round(f.fat)}g`]);
      html += group("fuel", "Fuel", nutrition, "var(--green)");

      const DB2 = getDB();
      const protocolLines = Object.entries(completions).map(([id, c]) => {
        const p = (DB2.protocols || []).find((x) => x.id === id);
        return [p ? p.name : "Protocol", c && c.completed ? "Completed" : "Not completed"];
      });
      html += group("protocols", "Protocols", protocolLines, "var(--green)");

      const journalLines = [];
      if (journal) {
        Object.entries(journal.answers || {}).forEach(([k, v]) => journalLines.push([k.replace(/_/g, " "), String(v)]));
        if (journal.note) journalLines.push(["Note", journal.note]);
      }
      html += group("journal", "Journal", journalLines, "var(--amber)");

      html += group("biomarkers", "Biomarkers", labs.map((l) => [l.code || l.marker || "Marker", `${l.value} ${l.unit || ""}`.trim()]), "var(--cyan)");

      return html || '<div class="history-empty">Nothing was logged on this date.</div>';
    }

    // Cheap plain-text haystack for search -- same fields the record
    // renders, so "matches search" and "what search can find" stay
    // in sync by construction.
    function dayHaystack(key) {
      const DB = getDB();
      const f = fuelFor(key);
      const sessions = sessionsFor(key);
      const journal = (DB.journal || {})[key];
      const labs = (DB.biomarkerLogs || []).filter((x) => x.date === key);
      const parts = [
        ...sessions.map((s) => s.workoutName || s.name || ""),
        ...f.meals.map((m) => m.name || m.productName || ""),
        journal && journal.note || "",
        ...labs.map((l) => l.code || l.marker || "")
      ];
      return parts.join(" ").toLowerCase();
    }

    /* ============================================================
       TIMELINE
       ============================================================ */

    function dayMetaLine(key) {
      const DB = getDB();
      const t = DB.telemetry[key] || {};
      const sessions = sessionsFor(key);
      const f = fuelFor(key);
      const parts = [];
      parts.push(sessions.length ? `${sessions.length} session${sessions.length === 1 ? "" : "s"}` : "Rest");
      if (f.meals.length) parts.push(`${Math.round(f.kcal)} kcal`);
      if (t.sleepTotalMin != null) parts.push(fmtMin(t.sleepTotalMin) + " sleep");
      return parts.join(" · ");
    }

    function renderTimeline() {
      const COLORS = getColors();
      const host = $("history-timeline");
      let keys = rangeKeys().slice().reverse(); // most recent first
      if (searchQuery) keys = keys.filter((k) => dayHaystack(k).includes(searchQuery));
      if (!keys.length) {
        host.innerHTML = '<div class="history-empty">No days match. Try a different range, filter, or search.</div>';
        return;
      }
      if (!openKeys.size) openKeys.add(keys[0]);

      host.innerHTML = keys.map((k) => {
        const DB = getDB();
        const t = DB.telemetry[k] || {};
        const rdy = t.readinessScore != null ? Math.round(t.readinessScore) : null;
        const col = rdy != null ? bandColor(rdy) : COLORS.dim;
        const d = parseKey(k);
        const isOpen = openKeys.has(k);
        return `<div class="history-day-row${isOpen ? " open" : ""}" data-key="${k}">` +
          `<button class="history-day-summary" data-toggle-key="${k}">` +
          `<span class="hd-date"><span class="hd-weekday">${d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()}</span>` +
          `<span class="hd-daynum">${shortDate(k).toUpperCase()}</span></span>` +
          `<span class="hd-readiness" style="color:${col}">${rdy != null ? rdy : "--"}</span>` +
          `<span class="hd-meta">${esc(dayMetaLine(k))}</span>` +
          `<svg class="icon icon-sm hd-chevron" aria-hidden="true"><use href="#icon-chevron-down"></use></svg>` +
          `</button>` +
          `<div class="history-day-body">${isOpen ? dayRecordHtml(k) : ""}</div>` +
          `</div>`;
      }).join("");
    }

    function toggleDay(key) {
      const row = document.querySelector(`.history-day-row[data-key="${CSS.escape(key)}"]`);
      if (!row) return;
      const body = row.querySelector(".history-day-body");
      if (openKeys.has(key)) {
        openKeys.delete(key);
        row.classList.remove("open");
        body.innerHTML = "";
      } else {
        openKeys.add(key);
        row.classList.add("open");
        body.innerHTML = dayRecordHtml(key);
      }
    }

    /* ============================================================
       RANGE CHART + SUMMARY
       ============================================================ */

    function renderRangeSummaryAndChart() {
      const DB = getDB();
      const COLORS = getColors();
      const keys = rangeKeys();
      const rows = keys.map((k) => DB.telemetry[k]).filter(Boolean);
      const recoveries = rows.map((x) => Number(x.readinessScore)).filter(Number.isFinite);
      const hrvs = rows.map((x) => Number(x.hrvMs)).filter(Number.isFinite);
      const sleeps = rows.map((x) => Number(x.sleepTotalMin)).filter(Number.isFinite);
      const strains = rows.map((x) => Number(x.systemLoadScore)).filter(Number.isFinite);
      const proteins = keys.map((k) => fuelFor(k).protein).filter((x) => x > 0);
      const sessions = keys.flatMap(sessionsFor);
      const caption = rangeDays === 0 ? "ALL AVAILABLE" : `${rangeDays} DAYS ENDING ${shortDate(endKey).toUpperCase()}`;
      $("history-range-caption").textContent = caption;

      const items = [
        [recoveries.length ? Math.round(avg(recoveries)) : "--", "Avg recovery"],
        [hrvs.length ? Math.round(avg(hrvs)) + " ms" : "--", "Avg HRV"],
        [sleeps.length ? fmtMin(avg(sleeps)) : "--", "Avg sleep"],
        [sessions.length, "Training sessions"],
        [strains.length ? avg(strains).toFixed(1) : "--", "Avg strain"],
        [proteins.length ? Math.round(avg(proteins)) + "g" : "--", "Avg protein"],
        [rows.length, "Garmin days"],
        [keys.filter(dayDataExists).length, "Days with data"]
      ];
      $("history-range-summary").innerHTML = items.map(([v, l]) =>
        `<div class="history-summary-item"><div class="hsi-value">${v}</div><div class="hsi-label">${l}</div></div>`
      ).join("");

      const plotted = keys.length > 60 ? keys.filter((_, i) => i % Math.ceil(keys.length / 60) === 0) : keys;
      const dayLabels = plotted.map((k) => shortDate(k));
      const series = [];
      if (activeSeries.has("recovery")) {
        series.push({
          values: plotted.map((k) => { const v = (DB.telemetry[k] || {}).readinessScore; return v != null ? Number(v) : null; }),
          color: COLORS.cyan, domain: [0, 100], seriesLabel: "Recovery", pointLabels: dayLabels
        });
      }
      if (activeSeries.has("strain")) {
        series.push({
          values: plotted.map((k) => { const v = (DB.telemetry[k] || {}).systemLoadScore; return v != null ? Number(v) : null; }),
          color: COLORS.red, domain: [0, 21], seriesLabel: "Strain", pointLabels: dayLabels
        });
      }
      if (activeSeries.has("sleep")) {
        series.push({
          values: plotted.map((k) => { const v = (DB.telemetry[k] || {}).sleepTotalMin; return v != null ? Number(v) : null; }),
          color: COLORS.amber, domain: [0, 600], seriesLabel: "Sleep", pointLabels: dayLabels
        });
      }

      const chartHost = $("history-chart-host");
      const anyData = series.some((s) => s.values.some((v) => v != null));
      if (!series.length || !anyData) {
        chartHost.innerHTML = '<div class="history-empty">No trend data for this range yet.</div>';
        return;
      }
      chartHost.innerHTML = bigMultiLine(series);
      chartTooltipHandle = wireChartTooltip(chartHost.querySelector("svg"));
    }

    /* ============================================================
       AI TREND SUMMARY
       ============================================================ */

    const HISTORY_AI_SYSTEM =
      "You are the Bio-Command Advisor, narrating a range of historical performance data for the " +
      "operator (not a single day). You receive a JSON digest of recent daily telemetry. Identify " +
      "genuine trends (direction, not noise), call out anything notable (missed targets, standout " +
      "days, drift in recovery/strain/sleep balance), and end with one concrete suggestion. Ground " +
      "every statement in the numbers given, never invent data; if the range is thin, say so. You are " +
      "not a medical professional. Under 180 words. UK English. Plain text, no markdown.";

    function setAiStatus(msg, tone) {
      const COLORS = getColors();
      const el = $("history-ai-status");
      el.textContent = msg;
      el.style.color = tone === "err" ? COLORS.red : tone === "ok" ? COLORS.green : "";
      $("history-ai-dot").style.color = tone === "ok" ? COLORS.green : tone === "err" ? COLORS.red : COLORS.dim;
    }

    async function generateHistorySummary() {
      const DB = getDB();
      const keys = rangeKeys();
      const digest = {
        rangeDays: rangeDays === 0 ? "all" : rangeDays,
        endDate: endKey,
        days: keys.map((k) => {
          const t = DB.telemetry[k] || {};
          return {
            d: k, rdy: t.readinessScore ?? null, hrv: t.hrvMs ?? null,
            strain: t.systemLoadScore ?? null, sleep: t.sleepTotalMin ?? null,
            sessions: sessionsFor(k).length, protein: Math.round(fuelFor(k).protein) || null
          };
        })
      };
      const out = $("history-ai-out");
      out.textContent = "";
      out.className = "brief-out show skeleton";
      setAiStatus("ANALYZING...");
      let firstToken = true;
      await advisor.ask("RANGE SUMMARY REQUEST. TELEMETRY DIGEST:\n" + JSON.stringify(digest), {
        system: HISTORY_AI_SYSTEM,
        onToken: (delta) => {
          if (firstToken) { out.classList.remove("skeleton"); firstToken = false; }
          appendToken(out, delta);
        },
        onDone: () => setAiStatus("DONE", "ok"),
        onError: (e) => { out.classList.remove("skeleton"); setAiStatus("OFFLINE: " + e.message, "err"); }
      });
    }

    /* ============================================================
       HEADER / NAV
       ============================================================ */

    function renderHeader() {
      const today = dayKey();
      const yesterday = shiftKey(today, -1);
      $("history-date-kicker").textContent = endKey === today ? "TODAY" : endKey === yesterday ? "YESTERDAY" : "HISTORICAL";
      $("history-date-label").textContent = humanDate(endKey);
      $("history-date-input").value = endKey;
      $("history-next").disabled = endKey >= today;
    }

    function render() {
      renderHeader();
      renderRangeSummaryAndChart();
      renderTimeline();
    }

    function setEndKey(key) {
      if (!key || key > dayKey()) key = dayKey();
      endKey = key;
      openKeys = new Set();
      render();
    }

    function openHistory() {
      showView("view-history");
      render();
    }

    function init() {
      const headerDate = $("hdr-date");
      $("history-date-input").max = dayKey();
      if (headerDate) headerDate.addEventListener("click", openHistory);
      $("history-prev").addEventListener("click", () => setEndKey(shiftKey(endKey, -1)));
      $("history-next").addEventListener("click", () => setEndKey(shiftKey(endKey, 1)));
      $("btn-history-today").addEventListener("click", () => setEndKey(dayKey()));
      $("history-date-main").addEventListener("click", () => {
        const input = $("history-date-input");
        if (typeof input.showPicker === "function") input.showPicker(); else input.click();
      });
      $("history-date-input").addEventListener("change", (e) => setEndKey(e.target.value));

      $("history-range-row").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        rangeDays = Number(b.dataset.days);
        $("history-range-row").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        openKeys = new Set();
        renderRangeSummaryAndChart();
        renderTimeline();
      }));

      $("btn-history-search-toggle").addEventListener("click", () => {
        const row = $("history-search-row");
        row.hidden = !row.hidden;
        if (!row.hidden) $("history-search-input").focus();
      });
      $("history-search-input").addEventListener("input", (e) => {
        searchQuery = e.target.value.trim().toLowerCase();
        openKeys = new Set();
        renderTimeline();
      });

      $("btn-history-filter-toggle").addEventListener("click", () => {
        const row = $("history-filter-row");
        row.hidden = !row.hidden;
      });
      $("history-filter-row").addEventListener("click", (ev) => {
        const chip = ev.target.closest(".chip");
        if (!chip) return;
        const kind = chip.dataset.filter;
        if (activeFilters.has(kind)) activeFilters.delete(kind); else activeFilters.add(kind);
        chip.classList.toggle("selected");
        openKeys.forEach((k) => {
          const body = document.querySelector(`.history-day-row[data-key="${CSS.escape(k)}"] .history-day-body`);
          if (body) body.innerHTML = dayRecordHtml(k);
        });
      });

      $("history-series-toggle").addEventListener("click", (ev) => {
        const chip = ev.target.closest(".chip");
        if (!chip) return;
        const s = chip.dataset.series;
        if (activeSeries.has(s)) activeSeries.delete(s); else activeSeries.add(s);
        chip.classList.toggle("selected");
        renderRangeSummaryAndChart();
      });

      $("history-timeline").addEventListener("click", (ev) => {
        const btn = ev.target.closest("[data-toggle-key]");
        if (!btn) return;
        toggleDay(btn.dataset.toggleKey);
      });

      $("btn-history-ai-summary").addEventListener("click", generateHistorySummary);

      window.addEventListener("storage", render);
      window.addEventListener("biocommand:data-changed", render);
    }

    return { init, render, setDate: setEndKey, openHistory };
  }

  global.BioCommandHistory = { createHistoryModule };
})(window);
