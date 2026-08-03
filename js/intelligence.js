"use strict";

/* ============================================================
   BIO-COMMAND v2 // OPERATIONAL INTELLIGENCE
   A derived-data layer. It never overwrites operator records.
   ============================================================ */

(function () {
  const el = id => document.getElementById(id);
  const safeMean = values => {
    const xs = values.filter(v => Number.isFinite(v));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  };
  const recentKeys = n => Object.keys(DB.telemetry || {}).sort().reverse().slice(0, n);
  const latestKey = () => Object.keys(DB.telemetry || {}).sort().pop() || null;
  const pct = value => Math.max(0, Math.min(100, Math.round(value || 0)));
  const esc = value => String(value == null ? "" : value)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;").replaceAll('"', "&quot;");

  function derivedModel() {
    const key = latestKey();
    const row = key ? DB.telemetry[key] : {};
    const scores = key ? computeScores(row, key) : { readiness: null, sleepPerf: null, strain: 0 };
    const keys7 = recentKeys(7);
    const rows7 = keys7.map(k => DB.telemetry[k]);
    const readiness = row.readinessScore ?? scores.readiness;
    const sleepDebtMin = rows7.reduce((sum, r) => sum + Math.max(0, (DB.operator.targetSleepMinutes || 450) - (r.sleepTotalMin || 0)), 0);
    const weeklyStrain = rows7.reduce((sum, r) => sum + Number(r.systemLoadScore || computeStrain(r).value || 0), 0);
    const avgRHR = safeMean(rows7.map(r => Number(r.restingHR)));
    const rhrBase = key ? baselineFor("restingHR", key, DB.operator.baselineWindowDays || 30) : null;
    const avgHRV = safeMean(rows7.map(r => Number(r.hrvMs)));
    const hrvBase = key ? baselineFor("hrvMs", key, DB.operator.baselineWindowDays || 30) : null;

    const today = dayKey();
    const fuelToday = (DB.fuelLog || []).filter(x => x.dayKey === today);
    const protein = fuelToday.reduce((s, x) => s + Number(x.proteinG || x.protein || 0), 0);
    const bodyMass = row.bodyMassKg || DB.operator.targetBodyMassKg || 0;
    const proteinTarget = bodyMass ? Math.round(bodyMass * (DB.operator.targetProteinPerKg || 2)) : null;

    const scheduled = (DB.protocols || []).filter(p => p.isActive && isScheduledOnDate(p, new Date()));
    const completed = scheduled.filter(p => {
      const c = ((DB.completions || {})[today] || {})[p.id];
      return c && c.completed;
    }).length;
    const adherence = scheduled.length ? completed / scheduled.length * 100 : null;

    const fatigueSignals = [
      readiness != null ? 100 - readiness : null,
      hrvBase && row.hrvMs ? pct((1 - row.hrvMs / hrvBase) * 200 + 35) : null,
      rhrBase && row.restingHR ? pct((row.restingHR / rhrBase - 1) * 500 + 25) : null,
      pct(sleepDebtMin / 6)
    ];
    const fatigue = pct(safeMean(fatigueSignals) || 0);

    const momentum = recentKeys(3).map(k => DB.telemetry[k].readinessScore).filter(Number.isFinite);
    const trend = momentum.length >= 2 ? momentum[0] - momentum[momentum.length - 1] : 0;
    const forecast = readiness == null ? null : pct(readiness - fatigue * 0.08 + trend * 0.35);

    return { key, row, scores, readiness, forecast, sleepDebtMin, weeklyStrain, avgRHR, rhrBase, avgHRV, hrvBase, protein, proteinTarget, adherence, fatigue, keys7, rows7 };
  }

  function kpi(label, value, note, tone) {
    return '<div class="ops-kpi"><span class="ops-kpi-label">' + esc(label) + '</span>' +
      '<span class="ops-kpi-value" style="color:' + tone + '">' + esc(value) + '</span>' +
      '<div class="ops-kpi-note">' + esc(note) + '</div></div>';
  }

  function renderKPIs(m) {
    el("ops-kpis").innerHTML = [
      kpi("Fatigue", m.key ? m.fatigue + "%" : "--", m.fatigue > 65 ? "High accumulated load" : "Current composite", m.fatigue > 65 ? COLORS.red : COLORS.cyan),
      kpi("Sleep Debt", m.key ? fmtMin(m.sleepDebtMin) : "--", "Rolling 7-night deficit", m.sleepDebtMin > 180 ? COLORS.red : m.sleepDebtMin > 60 ? COLORS.amber : COLORS.green),
      kpi("Weekly Load", m.key ? m.weeklyStrain.toFixed(1) : "--", "Combined strain points", m.weeklyStrain > 75 ? COLORS.amber : COLORS.green),
      kpi("Protocol", m.adherence == null ? "--" : Math.round(m.adherence) + "%", m.adherence == null ? "No directives due" : "Today's adherence", m.adherence >= 80 ? COLORS.green : COLORS.amber)
    ].join("");
  }

  function lineChart(m) {
    const data = [...m.rows7].reverse().map((r, i) => ({
      load: Number(r.systemLoadScore || computeStrain(r).value || 0),
      readiness: Number(r.readinessScore),
      label: [...m.keys7].reverse()[i]?.slice(5) || ""
    }));
    if (!data.length) return '<div class="empty-hint">LOG OR SYNC DATA TO BUILD LOAD INTELLIGENCE</div>';
    const W = 420, H = 150, P = 18;
    const x = i => P + i * (W - P * 2) / Math.max(1, data.length - 1);
    const yLoad = v => H - P - Math.min(21, v) / 21 * (H - P * 2);
    const yReady = v => H - P - Math.max(0, Math.min(100, v || 0)) / 100 * (H - P * 2);
    const path = (field, y) => data.map((d, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(d[field]).toFixed(1)).join(" ");
    const labels = data.map((d, i) => '<text x="' + x(i).toFixed(1) + '" y="147" text-anchor="middle" fill="' + COLORS.dim + '" font-size="8">' + esc(d.label) + '</text>').join("");
    return '<svg viewBox="0 0 420 150" role="img" aria-label="Seven day readiness and strain chart">' +
      '<line x1="18" y1="75" x2="402" y2="75" stroke="' + COLORS.dim + '" stroke-opacity=".18" />' +
      '<path d="' + path("readiness", yReady) + '" fill="none" stroke="' + COLORS.green + '" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />' +
      '<path d="' + path("load", yLoad) + '" fill="none" stroke="' + COLORS.red + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />' + labels + '</svg>' +
      '<div class="legend"><span class="key"><span class="swatch" style="background:' + COLORS.green + '"></span>READINESS</span><span class="key"><span class="swatch" style="background:' + COLORS.red + '"></span>STRAIN</span></div>';
  }

  function driver(label, score, note, color) {
    return '<div class="ops-bar-row"><div class="ops-bar-head"><span>' + esc(label) + '</span><span>' + esc(note) + '</span></div>' +
      '<div class="ops-bar-track"><div class="ops-bar-fill" style="width:' + pct(score) + '%;color:' + color + '"></div></div></div>';
  }

  function renderDrivers(m) {
    const sleepScore = m.scores.sleepPerf ?? (m.row.sleepTotalMin ? pct(m.row.sleepTotalMin / (DB.operator.targetSleepMinutes || 450) * 100) : 0);
    const hrvScore = m.hrvBase && m.row.hrvMs ? pct(m.row.hrvMs / m.hrvBase * 80) : 0;
    const rhrScore = m.rhrBase && m.row.restingHR ? pct(m.rhrBase / m.row.restingHR * 90) : 0;
    const proteinScore = m.proteinTarget ? pct(m.protein / m.proteinTarget * 100) : 0;
    el("ops-drivers").innerHTML = [
      driver("SLEEP", sleepScore, m.row.sleepTotalMin ? fmtMin(m.row.sleepTotalMin) : "NO DATA", bandColor(sleepScore)),
      driver("HRV", hrvScore, m.row.hrvMs ? Math.round(m.row.hrvMs) + " MS" : "NO DATA", bandColor(hrvScore)),
      driver("RESTING HR", rhrScore, m.row.restingHR ? Math.round(m.row.restingHR) + " BPM" : "NO DATA", bandColor(rhrScore)),
      driver("PROTEIN", proteinScore, m.proteinTarget ? Math.round(m.protein) + "/" + m.proteinTarget + " G" : "SET BODY MASS", bandColor(proteinScore))
    ].join("");
  }

  function action(priority, title, copy, tone) {
    return '<div class="ops-action"><span class="ops-action-priority" style="color:' + tone + '">' + priority + '</span><div class="ops-action-copy"><strong>' + esc(title) + '</strong>' + esc(copy) + '</div></div>';
  }

  function renderActions(m) {
    const actions = [];
    if (!m.key) actions.push(action("SETUP", "Connect telemetry", "Sync Garmin or log the first morning record to activate forecasts.", COLORS.cyan));
    if (m.sleepDebtMin > 120) actions.push(action("HIGH", "Repay sleep debt", "Move lights-out earlier by 30 to 60 minutes for the next two nights.", COLORS.red));
    if (m.fatigue > 65) actions.push(action("HIGH", "Reduce training dose", "Hold intensity and remove roughly 20% of planned working sets today.", COLORS.red));
    if (m.proteinTarget && m.protein < m.proteinTarget * 0.75) actions.push(action("MED", "Close protein gap", Math.round(m.proteinTarget - m.protein) + " g remains against today's target.", COLORS.amber));
    if (m.adherence != null && m.adherence < 100) actions.push(action("MED", "Complete protocol", "One or more scheduled directives remain unchecked.", COLORS.amber));
    if (!actions.length) actions.push(action("CLEAR", "No critical interventions", "Current signals support the planned session. Continue monitoring through the day.", COLORS.green));
    el("ops-actions").innerHTML = actions.slice(0, 5).join("");
  }

  function timelineEvents() {
    const events = [];
    (DB.sessions || []).forEach(s => events.push({ at: s.startedAt || s.dayKey, title: "Training", text: (s.workoutName || "Session") + " · " + (s.durationMin || 0) + " min · " + (s.sets || []).length + " sets" }));
    (DB.fuelLog || []).forEach(x => events.push({ at: x.createdAt || x.loggedAt || x.dayKey, title: "Fuel", text: (x.name || x.description || "Meal logged") + (x.proteinG ? " · " + Math.round(x.proteinG) + " g protein" : "") }));
    (DB.biomarkerLogs || []).forEach(x => events.push({ at: x.loggedAt || x.createdAt || x.dayKey, title: "Biomarker", text: (x.code || x.markerCode || "Marker") + " · " + (x.value ?? "") }));
    Object.entries(DB.journal || {}).forEach(([day, x]) => {
      if ((x.answers && Object.keys(x.answers).length) || x.note) events.push({ at: x.updatedAt || day, title: "Journal", text: x.note || "Morning check-in completed" });
    });
    Object.entries(DB.telemetry || {}).forEach(([day, r]) => {
      if (r.readinessScore != null) events.push({ at: r.updatedAt || day, title: "Recovery", text: "Readiness " + Math.round(r.readinessScore) + " · HRV " + (r.hrvMs ?? "--") + " ms" });
    });
    return events.sort((a, b) => new Date(b.at) - new Date(a.at)).slice(0, 10);
  }

  function renderTimeline() {
    const events = timelineEvents();
    el("ops-timeline").innerHTML = events.length ? events.map(e => {
      const d = new Date(e.at);
      const label = Number.isNaN(d.getTime()) ? String(e.at).slice(5) : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
      return '<div class="ops-timeline-item"><span class="ops-time">' + esc(label.toUpperCase()) + '</span><span class="status-dot" style="color:' + COLORS.cyan + ';margin-top:4px"></span><div class="ops-event"><strong>' + esc(e.title) + '</strong> ' + esc(e.text) + '</div></div>';
    }).join("") : '<div class="empty-hint">YOUR TRAINING, FUEL, RECOVERY AND BIOMARKER EVENTS WILL APPEAR HERE</div>';
  }

  function renderOps() {
    const m = derivedModel();
    const forecast = el("ops-readiness");
    forecast.textContent = m.forecast == null ? "--" : m.forecast;
    forecast.style.color = bandColor(m.forecast);
    if (!m.key) {
      el("ops-headline").textContent = "Connect data to build your operational picture";
      el("ops-subline").textContent = "OPS combines recovery, sleep, training, nutrition and protocol adherence without modifying your source records.";
    } else if (m.fatigue > 65) {
      el("ops-headline").textContent = "Fatigue is outrunning recovery";
      el("ops-subline").textContent = "Protect sleep and reduce today's training dose before adding more load.";
    } else if ((m.forecast || 0) >= 67) {
      el("ops-headline").textContent = "Green window for productive work";
      el("ops-subline").textContent = "Current recovery signals support the planned session, provided warm-up markers agree.";
    } else {
      el("ops-headline").textContent = "Proceed with controlled intensity";
      el("ops-subline").textContent = "Readiness is usable but not optimal. Keep volume flexible and reassess after warm-up.";
    }
    renderKPIs(m);
    el("ops-load-chart").innerHTML = lineChart(m);
    renderDrivers(m);
    renderActions(m);
    renderTimeline();
  }

  const originalShowView = showView;
  showView = function (id) {
    originalShowView(id);
    if (id === "view-ops") renderOps();
  };

  const originalSaveDB = saveDB;
  saveDB = function (db) {
    originalSaveDB(db);
    if (el("view-ops")?.classList.contains("active")) renderOps();
  };

  window.BioCommandIntelligence = { render: renderOps, model: derivedModel };
})();
