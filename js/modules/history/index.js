"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - DB
 * - dayKey
 * - fmtMin
 * - bandColor
 * - showView
 */
(function (global) {
  function createHistoryModule({ dayKey, fmtMin, bandColor, DB, showView }) {
    let selectedKey = dayKey();
    let rangeDays = 7;

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
    const esc = (value) => String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);

    function dayDataExists(key) {
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
      return (DB.sessions || []).filter((x) => (x.dayKey || (x.startedAt || "").slice(0, 10)) === key);
    }

    function rangeKeys() {
      const all = new Set([
        ...Object.keys(DB.telemetry || {}),
        ...(DB.fuelLog || []).map((x) => x.dayKey),
        ...(DB.sessions || []).map((x) => x.dayKey || (x.startedAt || "").slice(0, 10)),
        ...Object.keys(DB.journal || {}),
        ...Object.keys(DB.completions || {}),
        ...(DB.biomarkerLogs || []).map((x) => x.date)
      ].filter(Boolean));
      if (rangeDays === 0) return [...all].filter((k) => k <= selectedKey).sort();
      const start = shiftKey(selectedKey, -(rangeDays - 1));
      const keys = [];
      for (let k = start; k <= selectedKey; k = shiftKey(k, 1)) keys.push(k);
      return keys;
    }

    function metricCard(label, value, sub, color) {
      return `<div class="history-metric"><span class="hm-label">${label}</span>` +
        `<span class="hm-value"${color ? ` style="color:${color}"` : ""}>${value}</span>` +
        `<span class="hm-sub">${sub}</span></div>`;
    }

    function renderDayHeader() {
      const today = dayKey();
      const yesterday = shiftKey(today, -1);
      $("history-date-kicker").textContent = selectedKey === today ? "TODAY" : selectedKey === yesterday ? "YESTERDAY" : "HISTORICAL";
      $("history-date-label").textContent = humanDate(selectedKey);
      $("history-date-input").value = selectedKey;
      $("history-next").disabled = selectedKey >= today;
    }

    function renderDayMetrics() {
      const t = DB.telemetry[selectedKey] || {};
      const f = fuelFor(selectedKey);
      const sessions = sessionsFor(selectedKey);
      const readiness = t.readinessScore != null ? Math.round(t.readinessScore) : "--";
      const strain = t.systemLoadScore != null ? Number(t.systemLoadScore).toFixed(1) : "--";
      const sleep = t.sleepTotalMin != null ? fmtMin(t.sleepTotalMin) : "--";
      const protein = f.meals.length ? Math.round(f.protein) + "g" : "--";
      $("history-day-metrics").innerHTML =
        metricCard("Recovery", readiness, t.hrvMs != null ? `HRV ${Math.round(t.hrvMs)} ms` : "No HRV recorded", readiness !== "--" ? bandColor(Number(readiness)) : "") +
        metricCard("Strain", strain, sessions.length ? `${sessions.length} training session${sessions.length === 1 ? "" : "s"}` : "No session logged", "var(--red)") +
        metricCard("Sleep", sleep, t.sleepDeepMin != null ? `${fmtMin(t.sleepDeepMin)} deep` : "No sleep stages", "var(--amber)") +
        metricCard("Protein", protein, f.meals.length ? `${Math.round(f.kcal)} kcal logged` : "No meals logged", "var(--green)");
    }

    function renderRange() {
      const keys = rangeKeys();
      const rows = keys.map((k) => DB.telemetry[k]).filter(Boolean);
      const recoveries = rows.map((x) => Number(x.readinessScore)).filter(Number.isFinite);
      const hrvs = rows.map((x) => Number(x.hrvMs)).filter(Number.isFinite);
      const sleeps = rows.map((x) => Number(x.sleepTotalMin)).filter(Number.isFinite);
      const strains = rows.map((x) => Number(x.systemLoadScore)).filter(Number.isFinite);
      const proteins = keys.map((k) => fuelFor(k).protein).filter((x) => x > 0);
      const sessions = keys.flatMap(sessionsFor);
      const caption = rangeDays === 0 ? "ALL AVAILABLE" : `${rangeDays} DAYS ENDING ${shortDate(selectedKey).toUpperCase()}`;
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
      const values = plotted.map((k) => ({
        r: Number((DB.telemetry[k] || {}).readinessScore),
        s: Number((DB.telemetry[k] || {}).systemLoadScore)
      }));
      if (!values.some((v) => Number.isFinite(v.r) || Number.isFinite(v.s))) {
        $("history-trend").innerHTML = '<div class="history-empty" style="width:100%;align-self:center;">No recovery trend exists for this range yet.</div>';
      } else {
        $("history-trend").innerHTML = values.map((v) => {
          const rh = Number.isFinite(v.r) ? Math.max(2, Math.min(100, v.r)) : 2;
          const sh = Number.isFinite(v.s) ? Math.max(2, Math.min(100, (v.s / 21) * 100)) : 2;
          return `<div class="history-trend-col"><i class="history-trend-bar" style="height:${rh}%"></i><i class="history-trend-bar strain" style="height:${sh}%"></i></div>`;
        }).join("");
      }
    }

    function group(title, lines, color = "var(--cyan)") {
      if (!lines.length) return "";
      return `<div class="history-record-group"><div class="hrg-head"><span class="status-dot" style="color:${color}"></span>${esc(title)}</div>` +
        lines.map(([a, b]) => `<div class="hrg-line"><span>${esc(a)}</span><strong>${esc(b)}</strong></div>`).join("") + `</div>`;
    }

    function renderRecord() {
      const t = DB.telemetry[selectedKey] || {};
      const f = fuelFor(selectedKey);
      const sessions = sessionsFor(selectedKey);
      const journal = (DB.journal || {})[selectedKey];
      const completions = (DB.completions || {})[selectedKey] || {};
      const labs = (DB.biomarkerLogs || []).filter((x) => x.date === selectedKey);
      let html = "";
      const wearable = [];
      [["HRV", t.hrvMs != null ? `${t.hrvMs} ms` : null], ["Resting heart rate", t.restingHR != null ? `${t.restingHR} bpm` : null],
       ["Respiratory rate", t.respiratoryRate != null ? `${t.respiratoryRate}/min` : null], ["Body mass", t.bodyMassKg != null ? `${t.bodyMassKg} kg` : null],
       ["Active energy", t.activeEnergyKcal != null ? `${Math.round(t.activeEnergyKcal)} kcal` : null]].forEach((x) => { if (x[1]) wearable.push(x); });
      html += group("Wearable telemetry", wearable, "var(--cyan)");
      const sleep = [];
      [["Total", t.sleepTotalMin != null ? fmtMin(t.sleepTotalMin) : null], ["Deep", t.sleepDeepMin != null ? fmtMin(t.sleepDeepMin) : null],
       ["REM", t.sleepREMMin != null ? fmtMin(t.sleepREMMin) : null], ["Awake", t.sleepAwakeMin != null ? fmtMin(t.sleepAwakeMin) : null]].forEach((x) => { if (x[1]) sleep.push(x); });
      html += group("Sleep", sleep, "var(--amber)");
      const training = sessions.map((s) => [s.workoutName || s.name || "Workout", [s.durationMin ? `${s.durationMin} min` : "", s.totalVolume ? `${Math.round(s.totalVolume)} volume` : ""].filter(Boolean).join(" · ") || "Completed"]);
      if (!training.length && t.trainingMinutes) training.push(["Training", `${t.trainingMinutes} min${t.sessionRPE ? ` · RPE ${t.sessionRPE}` : ""}`]);
      html += group("Training", training, "var(--red)");
      const nutrition = f.meals.map((m) => [m.name || m.productName || "Food", `${Math.round(Number(m.kcal || m.calories || 0))} kcal · ${Math.round(Number(m.protein || m.proteinG || 0))}g protein`]);
      if (f.meals.length) nutrition.unshift(["Daily total", `${Math.round(f.kcal)} kcal · P ${Math.round(f.protein)}g · C ${Math.round(f.carbs)}g · F ${Math.round(f.fat)}g`]);
      html += group("Fuel", nutrition, "var(--green)");
      const protocolLines = Object.entries(completions).map(([id, c]) => {
        const p = (DB.protocols || []).find((x) => x.id === id);
        return [p ? p.name : "Protocol", c && c.completed ? "Completed" : "Not completed"];
      });
      html += group("Protocols", protocolLines, "var(--green)");
      const journalLines = [];
      if (journal) {
        Object.entries(journal.answers || {}).forEach(([k, v]) => journalLines.push([k.replace(/_/g, " "), String(v)]));
        if (journal.note) journalLines.push(["Note", journal.note]);
      }
      html += group("Journal", journalLines, "var(--amber)");
      html += group("Biomarkers", labs.map((l) => [l.code || l.marker || "Marker", `${l.value} ${l.unit || ""}`.trim()]), "var(--cyan)");
      $("history-record").innerHTML = html || '<div class="history-empty">Nothing was logged on this date. Use the arrows or calendar to choose another day.</div>';
    }

    function renderStrip() {
      const keys = [];
      for (let i = 13; i >= 0; i--) keys.push(shiftKey(selectedKey, -i));
      $("history-day-strip").innerHTML = keys.map((k) => {
        const d = parseKey(k);
        return `<button class="history-day-chip ${k === selectedKey ? "active" : ""} ${dayDataExists(k) ? "has-data" : ""}" data-key="${k}">` +
          `<span class="hdc-dow">${d.toLocaleDateString(undefined, { weekday: "short" }).toUpperCase()}</span><span class="hdc-day">${d.getDate()}</span><i class="hdc-dot"></i></button>`;
      }).join("");
      $("history-day-strip").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => setDate(b.dataset.key)));
      const active = $("history-day-strip").querySelector(".active");
      if (active) active.scrollIntoView({ inline: "center", block: "nearest" });
    }

    function render() {
      renderDayHeader();
      renderDayMetrics();
      renderRange();
      renderRecord();
      renderStrip();
    }

    function setDate(key) {
      if (!key || key > dayKey()) key = dayKey();
      selectedKey = key;
      render();
      window.scrollTo({ top: 0, behavior: "smooth" });
    }

    function openHistory() {
      showView("view-history");
      render();
    }

    function init() {
      const headerDate = $("hdr-date");
      $("history-date-input").max = dayKey();
      if (headerDate) headerDate.addEventListener("click", openHistory);
      $("history-prev").addEventListener("click", () => setDate(shiftKey(selectedKey, -1)));
      $("history-next").addEventListener("click", () => setDate(shiftKey(selectedKey, 1)));
      $("history-today").addEventListener("click", () => setDate(dayKey()));
      $("history-date-main").addEventListener("click", () => {
        const input = $("history-date-input");
        if (typeof input.showPicker === "function") input.showPicker(); else input.click();
      });
      $("history-date-input").addEventListener("change", (e) => setDate(e.target.value));
      $("history-range-row").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
        rangeDays = Number(b.dataset.days);
        $("history-range-row").querySelectorAll("button").forEach((x) => x.classList.toggle("active", x === b));
        renderRange();
      }));

      window.addEventListener("storage", render);
      window.addEventListener("biocommand:data-changed", render);
    }

    return { init, render, setDate, openHistory };
  }

  global.BioCommandHistory = { createHistoryModule };
})(window);
