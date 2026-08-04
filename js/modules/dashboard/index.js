"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - dayKey() / saveDB()
 * - fmtMin() / clamp01() / hexToRgba() / bandColor() / bandName() — color
 *   and formatting helpers, still defined in app.js pending the
 *   shared-utilities extraction.
 * - baselineFor() / computeScores() — still defined in app.js (Scoring
 *   Engines), pending the shared-utilities extraction; also relied on
 *   directly by the Fuel and Training modules.
 * - meanOf() — still defined in app.js (used by Journal/Protocols too).
 * - sparkLine() / sparkBars() / bigLine() / bigBars() / bigStacked() —
 *   chart-drawing primitives, still defined in app.js; bigLine is also
 *   relied on directly by the Biomarkers module.
 * - renderJournal() / renderTabBadges() — cross-module render calls
 *   Command triggers after every refresh.
 * - getDB() / getColors() — accessors rather than plain values, since
 *   DB and COLORS are both reassigned at runtime (import/reset/cloud
 *   sync for DB, theme toggle for COLORS).
 * - createScoreRing — js/modules/shared/score-ring.js factory, used to
 *   build the hero ring instead of hand-rolling the arc math here.
 * - advisor / appendToken — js/modules/shared/ai-stream.js. advisor is
 *   one shared createAdvisor({transport}) instance (constructed once
 *   in app.js) so this module never talks to Anthropic directly;
 *   appendToken is the innerHTML-free token renderer.
 * - pullLatest — lazy accessor to syncModule.pullLatest, wired this
 *   way because syncModule is constructed after this module in
 *   app.js's boot order (same pattern as getDB/getColors: the
 *   closure only needs to resolve by the time a user gesture, not
 *   module construction, calls it).
 * - getUpcomingWorkout — lazy accessor to trainingModule's read-only
 *   getter, same reasoning.
 * - showToast — js/modules/shared/toast.js.
 *
 * Exposes openDetail/closeDetail/setAdvisorStatus/showBrief beyond the
 * usual init/render because app.js's boot-time wiring (detail overlay
 * triggers on Command, and the AI-key-driven initAdvisor sequence that
 * spans this module and the not-yet-extracted Settings AI key UI)
 * genuinely still needs to call into them directly.
 */
(function (global) {
  function createDashboardModule({
    dayKey, saveDB, fmtMin, clamp01, hexToRgba, bandColor, bandName,
    baselineFor, computeScores, meanOf,
    sparkLine, sparkBars, bigLine, bigBars, bigStacked,
    renderJournal, renderTabBadges,
    createScoreRing, advisor, appendToken,
    pullLatest, getUpcomingWorkout, showToast,
    getDB, getColors
  }) {
    let LAST_ROW = {};
    let LAST_SCORES = {};
    const overlay = document.getElementById("log-overlay");
    const heroRingHookEl = document.getElementById("hero-ring-hook");
    const heroRing = createScoreRing({ radius: 62, hexToRgba });

    /* ============================================================
       SIM FEED (only when the store is completely empty)
       ============================================================ */

    const SIM = {
      hrvMs: [78, 81, 76, 84, 80, 86, 84],
      restingHR: [46, 45, 47, 44, 45, 44, 44],
      sleepTotalMin: [432, 415, 468, 451, 440, 470, 462],
      systemLoadScore: [8.2, 12.5, 0, 14.1, 6.4, 0, 13.0],
      respiratoryRate: [15.1, 14.9, 15.0, 14.7, 14.8, 14.6, 14.8],
      bodyMassKg: [84.6, 84.5, 84.5, 84.3, 84.4, 84.2, 84.1],
      readinessScore: [74, 79, 68, 85, 77, 88, 82]
    };
    const SIM_TODAY = {
      hrvMs: 84, restingHR: 44, respiratoryRate: 14.8,
      sleepTotalMin: 462, sleepDeepMin: 78, sleepREMMin: 104,
      sleepCoreMin: 262, sleepAwakeMin: 18, bodyMassKg: 84.1
    };
    const SIM_SCORES = { readiness: 82, sleepPerf: 100, strain: 13.0, hrvDeltaPct: 6, calibrating: false };

    function isSim() {
      const DB = getDB();
      return Object.keys(DB.telemetry).length === 0;
    }

    /* ============================================================
       INTEL ENGINE
       ============================================================ */

    function lastLogged(field, count) {
      const DB = getDB();
      return Object.keys(DB.telemetry).sort().reverse()
        .map(k => DB.telemetry[k][field])
        .filter(v => v != null)
        .slice(0, count);
    }

    function buildIntel() {
      const DB = getDB();
      const flags = [];
      const keys = Object.keys(DB.telemetry).sort();
      const n = keys.length;
      const today = dayKey();

      if (n === 0) {
        flags.push({ tone: "dim", msg: "NO TELEMETRY IN STORE. SYNC OR LOG TO ARM THE INTEL ENGINE." });
        return flags;
      }
      if (n < 7) {
        flags.push({ tone: "cyan", msg: "DATASET " + n + " DAY(S). PATTERN CALLS UNLOCK AT 7+, LOAD RATIOS AT 14+." });
      }

      const hrvBase = baselineFor("hrvMs", today, DB.operator.baselineWindowDays);
      const hrv3 = lastLogged("hrvMs", 3);
      if (hrvBase && hrv3.length === 3 && hrv3.every(v => v < hrvBase * 0.93)) {
        flags.push({ tone: "red", msg: "HRV SUPPRESSED 3 SESSIONS RUNNING (" +
          Math.round(meanOf(hrv3)) + "MS VS BASE " + Math.round(hrvBase) +
          "). CUT LOAD, PROTECT SLEEP." });
      }

      const rhrBase = baselineFor("restingHR", today, DB.operator.baselineWindowDays);
      const rhr1 = lastLogged("restingHR", 1);
      if (rhrBase && rhr1.length && rhr1[0] > rhrBase * 1.06) {
        flags.push({ tone: "amber", msg: "RHR ELEVATED +" +
          Math.round((rhr1[0] / rhrBase - 1) * 100) +
          "% VS BASE. FATIGUE OR ILLNESS SIGNAL. MONITOR." });
      }

      const sleep7 = lastLogged("sleepTotalMin", 7);
      if (sleep7.length >= 4) {
        const debt = sleep7.reduce((a, v) => a + (DB.operator.targetSleepMinutes - v), 0);
        if (debt > 90) {
          flags.push({ tone: "amber", msg: "SLEEP DEBT " + fmtMin(debt) +
            " OVER LAST " + sleep7.length + " NIGHTS. EARLIER LIGHTS OUT." });
        } else if (debt < -60) {
          flags.push({ tone: "green", msg: "SLEEP SURPLUS " + fmtMin(-debt) + ". BANKED RECOVERY." });
        } else {
          flags.push({ tone: "green", msg: "SLEEP HOLDING AT TARGET ACROSS " + sleep7.length + " NIGHTS." });
        }
      }

      const strain28 = lastLogged("systemLoadScore", 28);
      if (strain28.length >= 14) {
        const acute = meanOf(strain28.slice(0, 7));
        const chronic = meanOf(strain28);
        if (chronic > 0.5) {
          const acwr = acute / chronic;
          if (acwr > 1.5) {
            flags.push({ tone: "red", msg: "LOAD RAMP ACWR " + acwr.toFixed(2) +
              ". SPIKE TERRITORY, HOLD VOLUME THIS WEEK." });
          } else if (acwr < 0.8) {
            flags.push({ tone: "cyan", msg: "ACWR " + acwr.toFixed(2) +
              ". LOAD TAPERING, DETRAINING DRIFT IF SUSTAINED." });
          } else {
            flags.push({ tone: "green", msg: "LOAD RAMP CONTROLLED. ACWR " + acwr.toFixed(2) + "." });
          }
        }
      }

      const rdy3 = lastLogged("readinessScore", 3);
      if (rdy3.length === 3 && rdy3.every(v => v >= 67)) {
        flags.push({ tone: "green", msg: "3-DAY GREEN READINESS STREAK. WINDOW FOR AN OVERLOAD BLOCK." });
      }

      const order = { red: 0, amber: 1, cyan: 2, green: 3, dim: 4 };
      flags.sort((a, b) => order[a.tone] - order[b.tone]);
      return flags.slice(0, 6);
    }

    function toneColor(t) {
      const COLORS = getColors();
      return t === "red" ? COLORS.red
           : t === "amber" ? COLORS.amber
           : t === "green" ? COLORS.green
           : t === "cyan" ? COLORS.cyan : COLORS.dim;
    }

    function renderIntel() {
      const list = document.getElementById("intel-list");
      const headline = document.getElementById("intel-headline");
      if (!list) return;
      const flags = buildIntel();
      list.innerHTML = "";
      if (flags.length) {
        headline.textContent = flags[0].msg;
        headline.style.color = toneColor(flags[0].tone);
      }
      flags.slice(1).forEach(f => {
        const item = document.createElement("div");
        item.className = "intel-item";
        item.innerHTML = '<span class="status-dot" style="color:' + toneColor(f.tone) +
          '"></span><span>' + f.msg + "</span>";
        list.appendChild(item);
      });
    }

    /* ============================================================
       SPARKLINES (data helpers; sparkLine/sparkBars are injected)
       ============================================================ */

    function last7Keys() {
      const out = [];
      const now = new Date();
      for (let i = 6; i >= 0; i--) {
        out.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
      }
      return out;
    }

    function seriesFor(field) {
      const DB = getDB();
      return last7Keys().map(k => {
        const r = DB.telemetry[k];
        return r && r[field] != null ? r[field] : null;
      });
    }

    function fmtSigned(n, digits) {
      digits = digits || 0;
      const v = n.toFixed(digits);
      return (n >= 0 ? "+" : "") + v;
    }

    /* ============================================================
       DETAIL ENGINE
       Builds the explainer content for every tappable element on
       Command: hero recovery ring, the three hero chips, each key
       metric card, and sleep architecture. Reads LAST_ROW/LAST_SCORES
       so it always matches exactly what is currently on screen.
       ============================================================ */

    function buildDetail(key) {
      const DB = getDB();
      const COLORS = getColors();
      const t = LAST_ROW || {};
      const s = LAST_SCORES || {};
      const win = DB.operator.baselineWindowDays;
      const todayKey = dayKey();

      if (key === "recovery") {
        const band = bandName(s.readiness);
        const col = bandColor(s.readiness);
        const lines = (s.components || []).map(c =>
          Math.round(c.weight * 100) + "% " + c.label + ": " +
          (c.score != null ? Math.round(c.score) + "/100" : "--"));
        return {
          title: "Recovery",
          value: s.readiness != null ? s.readiness : "CAL",
          unit: s.readiness != null ? "/100" : "",
          badge: band,
          color: col,
          def: "Recovery estimates how ready your body is to perform today. It blends " +
            "HRV against your rolling baseline, resting heart rate against baseline, " +
            "and sleep against your target, each compared to your last " + win + " days.",
          breakdown: lines,
          note: s.readiness == null
            ? "Still calibrating. Needs at least 3 days of HRV history before it can score."
            : null
        };
      }

      if (key === "systemLoadScore") {
        const method = s.strainMethod;
        let line;
        if (method === "rpe") {
          line = "Calculated from logged training (" + (t.trainingMinutes || 0) +
            " min at RPE " + t.sessionRPE + "/10), the most accurate method since " +
            "it reflects how the session actually felt.";
        } else if (method === "hr") {
          line = "Estimated from Garmin heart rate: " + (t.trainingMinutes || 0) +
            " min at an average of " + Math.round(t.trainingAvgHR || 0) +
            " bpm, against your max HR of " + DB.operator.maxHR + " bpm. No RPE was " +
            "logged for this session, so this figure is marked EST.";
        } else {
          line = "No training logged today, or not enough data (minutes plus either " +
            "RPE or Garmin heart rate) to calculate a value.";
        }
        return {
          title: "Strain",
          value: (s.strain || 0).toFixed(1),
          unit: "/21",
          badge: method === "hr" ? "ESTIMATED" : method === "rpe" ? "LOGGED" : "NO DATA",
          color: COLORS.red,
          def: "Strain is a 0-21 measure of cardiovascular load for the day, on a " +
            "saturating scale so very hard sessions approach the ceiling rather than " +
            "blowing past it.",
          breakdown: [line]
        };
      }

      if (key === "hrvMs") {
        const base = baselineFor("hrvMs", todayKey, win);
        const val = t.hrvMs;
        let line = "Not enough history yet to compare against a baseline.";
        let badge = "BUILDING";
        if (base && val != null) {
          const d = Math.round((val / base - 1) * 100);
          const ratio = val / base;
          badge = ratio < 0.88 ? "SUPPRESSED" : ratio < 0.94 ? "BELOW BASE" : "IN RANGE";
          line = "Your " + win + "-day baseline is " + Math.round(base) + "ms. Today is " +
            fmtSigned(d) + "% vs baseline, which reads as " +
            (ratio < 0.88 ? "suppressed, a sign of accumulated fatigue or stress" :
             ratio < 0.94 ? "slightly below baseline" : "within normal range") + ".";
        }
        return {
          title: "HRV", value: val != null ? Math.round(val) : "--", unit: "ms",
          badge: badge, color: COLORS.cyan,
          def: "Heart rate variability measures the variation in time between " +
            "heartbeats (RMSSD, from Garmin overnight readings). Higher relative to " +
            "your own baseline generally means better-recovered; lower suggests " +
            "fatigue, stress, illness, or poor sleep.",
          breakdown: [line]
        };
      }

      if (key === "restingHR") {
        const base = baselineFor("restingHR", todayKey, win);
        const val = t.restingHR;
        let line = "Not enough history yet to compare against a baseline.";
        let badge = "IN RANGE";
        if (base && val != null) {
          const d = Math.round((val / base - 1) * 100);
          badge = val / base > 1.05 ? "ELEVATED" : "IN RANGE";
          line = "Your baseline is " + Math.round(base) + " bpm. Today is " +
            fmtSigned(d) + "%. A resting heart rate meaningfully above baseline is " +
            "often an early sign of fatigue, dehydration, or oncoming illness.";
        }
        return {
          title: "Resting HR", value: val != null ? Math.round(val) : "--", unit: "bpm",
          badge: badge, color: COLORS.green,
          def: "Your lowest heart rate at rest, typically measured overnight. It " +
            "tends to fall as fitness improves and rise under fatigue, illness, heat, " +
            "or alcohol.",
          breakdown: [line]
        };
      }

      if (key === "sleepTotalMin") {
        const val = t.sleepTotalMin;
        const target = DB.operator.targetSleepMinutes;
        const perf = s.sleepPerf;
        let line = "No sleep logged for last night yet.";
        if (val != null) {
          line = "You slept " + fmtMin(val) + " against a " + fmtMin(target) +
            " target, " + (perf >= 100 ? "meeting or exceeding target" :
            "short of target by " + fmtMin(target - val)) + ".";
        }
        return {
          title: "Sleep", value: val != null ? fmtMin(val) : "--", unit: "",
          badge: perf != null ? (perf >= 100 ? "TARGET MET" : perf >= 85 ? "SHORT" : "LOW") : "NO DATA",
          color: COLORS.amber,
          def: "Total time asleep last night, compared against your target. Sleep is " +
            "the single biggest lever on recovery, and directly feeds the Recovery score.",
          breakdown: [line]
        };
      }

      if (key === "bodyMassKg") {
        const val = t.bodyMassKg;
        const series = seriesFor("bodyMassKg").filter(v => v != null);
        const first = series[0];
        const line = (val != null && first != null && series.length > 1)
          ? "7-day change: " + fmtSigned(val - first, 1) + "kg."
          : "Not enough recent entries yet to show a weekly trend.";
        return {
          title: "Mass", value: val != null ? val.toFixed(1) : "--", unit: "kg",
          badge: "", color: COLORS.cyan,
          def: "Body mass from Garmin body composition scans. Day-to-day swings are " +
            "mostly water and glycogen, so read the weekly trend, not any single number.",
          breakdown: [line]
        };
      }

      if (key === "respiratoryRate") {
        const base = baselineFor("respiratoryRate", todayKey, win);
        const val = t.respiratoryRate;
        const line = (base && val != null)
          ? "Baseline " + base.toFixed(1) + "/min, today " + val.toFixed(1) + "/min."
          : "Not enough history yet for a baseline.";
        return {
          title: "Respiration", value: val != null ? val.toFixed(1) : "--", unit: "/min",
          badge: "", color: COLORS.green,
          def: "Average breathing rate while asleep. A noticeable rise above your own " +
            "baseline can be an early flag for illness or a heavy training load.",
          breakdown: [line]
        };
      }

      if (key === "sleepArch") {
        const segs = [
          { l: "Deep", v: t.sleepDeepMin, note: "Physical recovery, tissue repair, growth hormone release." },
          { l: "REM", v: t.sleepREMMin, note: "Cognitive recovery, memory consolidation, emotional processing." },
          { l: "Core", v: t.sleepCoreMin, note: "Light sleep, the bulk of a normal night, general recovery." },
          { l: "Awake", v: t.sleepAwakeMin, note: "Brief wake periods are normal in small amounts; a high total means fragmented sleep." }
        ];
        return {
          title: "Sleep Architecture",
          value: t.sleepTotalMin != null ? fmtMin(t.sleepTotalMin) : "--",
          unit: "", badge: "", color: COLORS.cyan,
          def: "A breakdown of last night into sleep stages. Different stages serve " +
            "different recovery functions, so the mix matters as much as the total.",
          breakdown: segs.map(x => x.l + ": " + (x.v ? fmtMin(x.v) : "--") + " -- " + x.note)
        };
      }

      return null;
    }

    function openDetail(key) {
      const COLORS = getColors();
      const d = buildDetail(key);
      if (!d) return;
      if (isSim()) {
        d.note = (d.note ? d.note + " " : "") +
          "Showing simulated example data, not yours yet.";
      }
      document.getElementById("detail-title").textContent = d.title.toUpperCase();
      const valueEl = document.getElementById("detail-value");
      valueEl.textContent = d.value;
      valueEl.style.color = d.color || COLORS.cyan;
      document.getElementById("detail-unit").textContent = d.unit || "";
      const badgeEl = document.getElementById("detail-badge");
      if (d.badge) {
        badgeEl.textContent = d.badge;
        badgeEl.style.display = "inline-block";
        badgeEl.style.background = hexToRgba(d.color || COLORS.cyan, 0.14);
        badgeEl.style.color = d.color || COLORS.cyan;
      } else {
        badgeEl.style.display = "none";
      }
      const chartHtml = buildBigChart(key);
      document.getElementById("detail-chart").innerHTML = chartHtml || "";
      document.getElementById("detail-chart-days").innerHTML =
        dayLetters().map(l => "<span>" + l + "</span>").join("");

      document.getElementById("detail-def").textContent = d.def || "";
      const bd = document.getElementById("detail-breakdown");
      bd.innerHTML = "";
      (d.breakdown || []).forEach(line => {
        const row = document.createElement("div");
        row.className = "detail-line";
        row.textContent = line;
        bd.appendChild(row);
      });
      const noteEl = document.getElementById("detail-note");
      if (d.note) {
        noteEl.textContent = d.note;
        noteEl.style.display = "block";
      } else {
        noteEl.style.display = "none";
      }
      document.getElementById("detail-overlay").classList.add("open");
    }

    function closeDetail() {
      document.getElementById("detail-overlay").classList.remove("open");
    }

    function buildBigChart(key) {
      const DB = getDB();
      const COLORS = getColors();
      const sim = isSim();
      if (key === "recovery") {
        const series = sim ? SIM.readinessScore.slice() : seriesFor("readinessScore");
        const lastVal = series.filter(v => v != null).slice(-1)[0];
        return bigLine(series, bandColor(lastVal != null ? lastVal : null));
      }
      if (key === "systemLoadScore") {
        const series = sim ? SIM.systemLoadScore.slice() : seriesFor("systemLoadScore");
        return bigBars(series, COLORS.red, 21);
      }
      if (key === "hrvMs") {
        const series = sim ? SIM.hrvMs.slice() : seriesFor("hrvMs");
        return bigLine(series, COLORS.cyan);
      }
      if (key === "restingHR") {
        const series = sim ? SIM.restingHR.slice() : seriesFor("restingHR");
        return bigLine(series, COLORS.green);
      }
      if (key === "sleepTotalMin") {
        const series = sim ? SIM.sleepTotalMin.slice() : seriesFor("sleepTotalMin");
        return bigBars(series, COLORS.amber, DB.operator.targetSleepMinutes * 1.25, DB.operator.targetSleepMinutes);
      }
      if (key === "bodyMassKg") {
        const series = sim ? SIM.bodyMassKg.slice() : seriesFor("bodyMassKg");
        return bigLine(series, COLORS.cyan);
      }
      if (key === "respiratoryRate") {
        const series = sim ? SIM.respiratoryRate.slice() : seriesFor("respiratoryRate");
        return bigLine(series, COLORS.green);
      }
      if (key === "sleepArch") {
        const days = last7Keys();
        const dayObjs = sim
          ? days.map((k, i) => i === days.length - 1
              ? { deep: SIM_TODAY.sleepDeepMin, core: SIM_TODAY.sleepCoreMin, rem: SIM_TODAY.sleepREMMin, awake: SIM_TODAY.sleepAwakeMin }
              : { deep: 0, core: 0, rem: 0, awake: 0 })
          : days.map(k => {
              const r = DB.telemetry[k] || {};
              return { deep: r.sleepDeepMin || 0, core: r.sleepCoreMin || 0, rem: r.sleepREMMin || 0, awake: r.sleepAwakeMin || 0 };
            });
        return bigStacked(dayObjs);
      }
      return null;
    }

    function dayLetters() {
      const L = ["S", "M", "T", "W", "T", "F", "S"];
      const now = new Date();
      const out = [];
      for (let i = 6; i >= 0; i--) {
        out.push(L[new Date(now.getFullYear(), now.getMonth(), now.getDate() - i).getDay()]);
      }
      return out;
    }

    /* ============================================================
       RENDER: HERO + METRICS + SLEEP
       ============================================================ */

    function animateCount(el, to, duration) {
      const reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const from = parseInt(el.textContent, 10);
      if (reduced || !Number.isFinite(from) || from === to) { el.textContent = to; return; }
      const start = performance.now();
      function tick(now) {
        const p = Math.min(1, (now - start) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el.textContent = Math.round(from + (to - from) * eased);
        if (p < 1) requestAnimationFrame(tick);
        else el.textContent = to;
      }
      requestAnimationFrame(tick);
    }

    function renderHero(t, s, sim) {
      const DB = getDB();
      const COLORS = getColors();
      const rdy = s.readiness;
      const col = bandColor(rdy);
      const loggedDays = Object.keys(DB.telemetry).length;

      const frac = rdy != null ? rdy / 100 : clamp01(loggedDays / 3) * 0.25;
      heroRing.setProgress(frac, col);

      const scoreEl = document.getElementById("hero-score");
      const bandEl = document.getElementById("hero-band");
      if (rdy != null) {
        animateCount(scoreEl, rdy, 700);
        scoreEl.style.color = col;
        bandEl.textContent = bandName(rdy);
      } else {
        scoreEl.textContent = "CAL";
        scoreEl.style.color = COLORS.dim;
        bandEl.textContent = "BASELINE " + Math.min(loggedDays, 3) + "/3";
      }
      bandEl.style.background = hexToRgba(col, 0.14);
      bandEl.style.color = col;

      const strain = s.strain || 0;
      document.getElementById("chip-strain").textContent = strain.toFixed(1);
      document.getElementById("chip-strain-sub").textContent =
        "/21" + (s.strainMethod === "hr" ? " EST" : "");
      document.getElementById("chip-hrv").textContent = t.hrvMs != null ? Math.round(t.hrvMs) : "--";
      document.getElementById("chip-hrv-sub").textContent =
        s.hrvDeltaPct != null ? "MS " + (s.hrvDeltaPct >= 0 ? "+" : "") + s.hrvDeltaPct + "%" : "MS";
      document.getElementById("chip-sleep").textContent =
        t.sleepTotalMin != null ? fmtMin(t.sleepTotalMin) : "--";
      document.getElementById("chip-sleep-sub").textContent =
        s.sleepPerf != null ? s.sleepPerf + "%" : "";
    }

    function badgeFor(metric, latest, series) {
      const DB = getDB();
      const COLORS = getColors();
      const win = DB.operator.baselineWindowDays;
      const mk = (txt, col) => ({ txt, col });
      if (latest == null) return mk("NO DATA", COLORS.dim);

      if (metric === "hrvMs" || metric === "respiratoryRate" || metric === "restingHR") {
        const base = isSim() ? meanOf(SIM[metric]) : baselineFor(metric, dayKey(), win);
        if (!base) return mk("BUILDING", COLORS.dim);
        const d = latest / base - 1;
        if (metric === "hrvMs") {
          if (d < -0.12) return mk("SUPPRESSED", COLORS.red);
          if (d < -0.06) return mk("BELOW BASE", COLORS.amber);
          return mk("IN RANGE", COLORS.green);
        }
        if (metric === "restingHR") {
          if (d > 0.05) return mk("ELEVATED", COLORS.amber);
          return mk("IN RANGE", COLORS.green);
        }
        if (Math.abs(d) > 0.08) return mk("ELEVATED", COLORS.amber);
        return mk("IN RANGE", COLORS.green);
      }
      if (metric === "sleepTotalMin") {
        const pct = latest / DB.operator.targetSleepMinutes;
        if (pct >= 1) return mk("TARGET MET", COLORS.green);
        if (pct >= 0.85) return mk("SHORT", COLORS.amber);
        return mk("LOW", COLORS.red);
      }
      if (metric === "systemLoadScore") {
        if (latest <= 0.1) return mk("REST DAY", COLORS.cyan);
        const m = meanOf(series.filter(v => v != null && v > 0));
        if (m && latest > m * 1.4) return mk("SPIKE", COLORS.amber);
        return mk("STEADY", COLORS.green);
      }
      if (metric === "bodyMassKg") {
        const first = series.find(v => v != null);
        if (first == null) return mk("BUILDING", COLORS.dim);
        const d = latest - first;
        const s = (d >= 0 ? "+" : "") + d.toFixed(1) + "KG 7D";
        return mk(s, COLORS.cyan);
      }
      return mk("", COLORS.dim);
    }

    const METRICS = [
      { field: "hrvMs", label: "HRV", unit: "MS", kind: "line",
        color: () => getColors().cyan, fmt: v => Math.round(v) },
      { field: "restingHR", label: "Resting HR", unit: "BPM", kind: "line",
        color: () => getColors().green, fmt: v => Math.round(v) },
      { field: "sleepTotalMin", label: "Sleep", unit: "H:MM", kind: "bars",
        color: () => getColors().amber, fmt: v => fmtMin(v),
        max: () => getDB().operator.targetSleepMinutes * 1.25 },
      { field: "systemLoadScore", label: "Strain", unit: "/21", kind: "bars",
        color: () => getColors().red, fmt: v => v.toFixed(1), max: () => 21 },
      { field: "bodyMassKg", label: "Mass", unit: "KG", kind: "line",
        color: () => getColors().cyan, fmt: v => v.toFixed(1) },
      { field: "respiratoryRate", label: "Respiration", unit: "/MIN", kind: "line",
        color: () => getColors().green, fmt: v => v.toFixed(1) }
    ];

    // Condensed, single-row, horizontally-scrollable strip -- the
    // same 6 metrics and tap-to-detail behavior as the old multi-row
    // grid, laid out to fit above the 390x844 fold alongside the
    // hero. Badge/day-letter detail is one tap away via openDetail,
    // not duplicated here.
    function renderMetrics() {
      const strip = document.getElementById("metrics-strip");
      const sim = isSim();
      strip.innerHTML = "";

      METRICS.forEach(m => {
        const series = sim ? SIM[m.field].slice() : seriesFor(m.field);
        const definedVals = series.filter(v => v != null);
        const latest = definedVals.length ? definedVals[definedVals.length - 1] : null;
        const color = m.color();
        const spark = m.kind === "bars"
          ? sparkBars(series, color, m.max ? m.max() : null)
          : sparkLine(series, color);

        const chip = document.createElement("div");
        chip.className = "metric-chip clickable";
        chip.dataset.detail = m.field;
        chip.addEventListener("click", () => openDetail(m.field));
        chip.innerHTML =
          '<div class="mc-label">' + m.label + "</div>" +
          '<div class="mc-value-row"><span class="mc-value" style="color:' + color + '">' +
          (latest != null ? m.fmt(latest) : "--") + "</span>" +
          '<span class="mc-unit">' + m.unit + "</span></div>" +
          spark;
        strip.appendChild(chip);
      });
    }

    function renderUpcoming() {
      const body = document.getElementById("upcoming-body");
      const w = getUpcomingWorkout ? getUpcomingWorkout() : null;
      if (!w) {
        body.innerHTML = '<div class="upcoming-empty">No workouts set up yet.</div>';
        return;
      }
      body.innerHTML =
        '<div style="flex:1;">' +
        '<div class="upcoming-name"></div>' +
        '<div class="upcoming-focus"></div>' +
        '<div class="upcoming-last"></div>' +
        "</div>";
      body.querySelector(".upcoming-name").textContent = w.name;
      body.querySelector(".upcoming-focus").textContent = w.focus || "";
      body.querySelector(".upcoming-last").textContent = w.lastLabel;
    }

    function renderSleep(t) {
      const COLORS = getColors();
      const segs = [
        { key: "sleepDeepMin",  label: "DEEP",  color: COLORS.sleepDeep },
        { key: "sleepREMMin",   label: "REM",   color: COLORS.cyan },
        { key: "sleepCoreMin",  label: "CORE",  color: COLORS.sleepCore },
        { key: "sleepAwakeMin", label: "AWAKE", color: COLORS.red }
      ];
      const total = segs.reduce((sum, x) => sum + (t[x.key] || 0), 0);
      document.getElementById("sleep-total").textContent =
        t.sleepTotalMin != null ? fmtMin(t.sleepTotalMin) : (total ? fmtMin(total) : "--");
      const track = document.getElementById("sleep-track");
      const legend = document.getElementById("sleep-legend");
      track.innerHTML = "";
      legend.innerHTML = "";
      segs.forEach(sg => {
        const v = t[sg.key] || 0;
        if (total > 0 && v > 0) {
          const bar = document.createElement("i");
          bar.style.width = (v / total * 100) + "%";
          bar.style.background = sg.color;
          track.appendChild(bar);
        }
        const el = document.createElement("span");
        el.className = "key";
        el.innerHTML = '<i class="swatch" style="background:' + sg.color + '"></i>' +
          sg.label + " " + (v ? fmtMin(v) : "--");
        legend.appendChild(el);
      });
    }

    function renderCommand() {
      const DB = getDB();
      const key = dayKey();
      const row = DB.telemetry[key];
      const sim = isSim();
      const t = row || (sim ? SIM_TODAY : (DB.telemetry[Object.keys(DB.telemetry).sort().pop()] || {}));
      const s = sim ? SIM_SCORES : computeScores(t, row ? key : "");

      document.querySelectorAll("[data-sim]").forEach(el => { el.hidden = !sim; });

      LAST_ROW = t;
      LAST_SCORES = s;

      renderHero(t, s, sim);
      renderMetrics();
      renderUpcoming();
      renderSleep(t);
      renderIntel();
      renderJournal();
      renderTabBadges();
    }

    /* ============================================================
       LOG OVERLAY
       ============================================================ */

    function num(id) {
      const v = document.getElementById(id).value;
      if (v === "" || v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    }

    function openLog() {
      const DB = getDB();
      const key = dayKey();
      document.getElementById("log-date").textContent = key;
      const row = DB.telemetry[key] || {};
      const set = (id, v) => { document.getElementById(id).value = v != null ? v : ""; };
      set("in-hrv", row.hrvMs);
      set("in-rhr", row.restingHR);
      set("in-resp", row.respiratoryRate);
      set("in-mass", row.bodyMassKg);
      set("in-sleep-h", row.sleepTotalMin != null ? Math.floor(row.sleepTotalMin / 60) : null);
      set("in-sleep-m", row.sleepTotalMin != null ? row.sleepTotalMin % 60 : null);
      set("in-deep", row.sleepDeepMin);
      set("in-rem", row.sleepREMMin);
      set("in-awake", row.sleepAwakeMin);
      set("in-train-min", row.trainingMinutes);
      set("in-train-rpe", row.sessionRPE);
      overlay.classList.add("open");
    }

    function saveLog() {
      const DB = getDB();
      const key = dayKey();
      const h = num("in-sleep-h");
      const m = num("in-sleep-m");
      const sleepTotal = (h != null || m != null) ? (h || 0) * 60 + (m || 0) : null;
      const deep = num("in-deep");
      const rem = num("in-rem");
      const awake = num("in-awake");
      const core = (sleepTotal != null && deep != null && rem != null)
        ? Math.max(0, sleepTotal - deep - rem)
        : null;

      const existing = DB.telemetry[key] || {};
      const row = {
        ...existing,
        dayKey: key,
        hrvMs: num("in-hrv"),
        hrvMethod: existing.hrvMethod || "rmssd",
        restingHR: num("in-rhr"),
        respiratoryRate: num("in-resp"),
        bodyMassKg: num("in-mass"),
        sleepTotalMin: sleepTotal,
        sleepDeepMin: deep,
        sleepREMMin: rem,
        sleepCoreMin: core,
        sleepAwakeMin: awake,
        trainingMinutes: num("in-train-min"),
        sessionRPE: num("in-train-rpe"),
        source: existing.source || "manual",
        scoreVersion: 2,
        updatedAt: new Date().toISOString()
      };

      const s = computeScores(row, key);
      row.readinessScore = s.readiness;
      row.systemLoadScore = Math.round(s.strain * 10) / 10;
      row.strainMethod = s.strainMethod;

      DB.telemetry[key] = row;
      saveDB(DB);
      overlay.classList.remove("open");
      renderCommand();
    }

    /* ============================================================
       ADVISOR (brief on Today; key management is owned by Settings)
       ============================================================ */

    function setAdvisorStatus(msg, tone) {
      const COLORS = getColors();
      const el = document.getElementById("advisor-status");
      el.textContent = msg;
      el.style.color = tone === "err" ? COLORS.red : tone === "ok" ? COLORS.green : "";
      document.getElementById("advisor-dot").style.color =
        tone === "ok" ? COLORS.green : tone === "err" ? COLORS.red : COLORS.dim;
    }

    function buildDigest() {
      const DB = getDB();
      const keys = Object.keys(DB.telemetry).sort();
      const recent = keys.slice(-14).map(k => {
        const r = DB.telemetry[k];
        return {
          d: k, hrv: r.hrvMs ?? null, rhr: r.restingHR ?? null,
          slp: r.sleepTotalMin ?? null, deep: r.sleepDeepMin ?? null,
          rem: r.sleepREMMin ?? null, strain: r.systemLoadScore ?? null,
          rdy: r.readinessScore ?? null, mass: r.bodyMassKg ?? null,
          trainMin: r.trainingMinutes ?? null
        };
      });
      return {
        date: dayKey(),
        daysInStore: keys.length,
        targets: {
          sleepMin: DB.operator.targetSleepMinutes,
          baselineWindowDays: DB.operator.baselineWindowDays,
          massKg: DB.operator.targetBodyMassKg
        },
        baselines: {
          hrv: baselineFor("hrvMs", dayKey(), DB.operator.baselineWindowDays),
          rhr: baselineFor("restingHR", dayKey(), DB.operator.baselineWindowDays)
        },
        intelFlags: buildIntel().map(f => f.msg),
        last14: recent
      };
    }

    const ADVISOR_SYSTEM =
      "You are the Bio-Command Advisor, a performance coach embedded in a personal " +
      "health dashboard. You receive the operator's wearable telemetry digest as JSON " +
      "(HRV in ms RMSSD, resting HR, sleep minutes, strain 0-21 from session RPE x " +
      "minutes, readiness 0-100 vs rolling baseline). Ground every statement in the " +
      "numbers provided and never invent data. Give specific, actionable direction on " +
      "training load, sleep and recovery, with the single highest-leverage action first. " +
      "If the dataset is thin, say so plainly and scale your confidence down. You are " +
      "not a medical professional: no diagnoses, no medication or dosing advice, and " +
      "for symptoms or health concerns tell the operator to see a clinician. Under 220 " +
      "words. UK English. Terse command-brief tone, short lines, plain text, no markdown.";

    function showBrief(text) {
      const out = document.getElementById("brief-out");
      out.textContent = text;
      out.classList.remove("skeleton");
      out.classList.add("show");
    }

    // Shared by generateBriefing/askAdvisor: streams tokens straight
    // into #brief-out via appendToken (never innerHTML -- the C1 XSS
    // fix holds regardless of what the model returns), showing a
    // skeleton shimmer only for the real gap before the first token
    // arrives (removed the instant a token lands, via :empty no
    // longer matching).
    async function streamInto(prompt, { onDone, onOk } = {}) {
      const out = document.getElementById("brief-out");
      out.textContent = "";
      out.className = "brief-out show skeleton";
      setAdvisorStatus("ANALYZING...");
      let full = "";
      await advisor.ask(prompt, {
        system: ADVISOR_SYSTEM,
        onToken: (delta) => {
          if (!full) out.classList.remove("skeleton");
          full += delta;
          appendToken(out, delta);
        },
        onDone: () => {
          setAdvisorStatus(onOk || "DONE", "ok");
          if (typeof onDone === "function") onDone(full);
        },
        onError: (e) => {
          out.classList.remove("skeleton");
          setAdvisorStatus("OFFLINE: " + e.message, "err");
        }
      });
    }

    async function generateBriefing() {
      const DB = getDB();
      const k = dayKey();
      if (DB.briefings[k]) {
        showBrief(DB.briefings[k]);
        setAdvisorStatus("CACHED " + k, "ok");
        return;
      }
      await streamInto(
        "DAILY BRIEFING REQUEST. TELEMETRY DIGEST:\n" + JSON.stringify(buildDigest()),
        {
          onOk: "BRIEFED " + k,
          onDone: (full) => { DB.briefings[k] = full; saveDB(DB); }
        }
      );
    }

    async function askAdvisor() {
      const q = document.getElementById("ai-q").value.trim();
      if (!q) return;
      await streamInto(
        "OPERATOR QUESTION: " + q + "\nTELEMETRY DIGEST:\n" + JSON.stringify(buildDigest()),
        { onOk: "ANSWERED" }
      );
    }

    // Vanilla touch-gesture pull-to-refresh, scoped to Today: only
    // arms when the page is already scrolled to the top (so it can't
    // fight normal scrolling), re-runs the same cloud-pull path boot
    // uses, then re-renders. No-ops safely (resolves false) when
    // cloud sync isn't configured -- still worth the gesture existing
    // since it also just re-renders from whatever's in local storage.
    function initPullToRefresh() {
      const view = document.getElementById("view-command");
      const indicator = document.getElementById("pull-refresh-indicator");
      if (!view || !indicator) return;
      const THRESHOLD = 64;
      let startY = null, pulling = false, refreshing = false;

      view.addEventListener("touchstart", (e) => {
        if (refreshing) return;
        startY = window.scrollY <= 0 ? e.touches[0].clientY : null;
        pulling = false;
      }, { passive: true });

      view.addEventListener("touchmove", (e) => {
        if (startY == null || refreshing) return;
        const dy = e.touches[0].clientY - startY;
        if (dy <= 0) { indicator.style.height = "0px"; indicator.classList.remove("pulling"); pulling = false; return; }
        pulling = true;
        const h = Math.min(dy * 0.5, 64);
        indicator.style.height = h + "px";
        indicator.classList.toggle("pulling", h >= THRESHOLD);
      }, { passive: true });

      view.addEventListener("touchend", () => {
        const triggered = pulling && indicator.classList.contains("pulling");
        startY = null;
        pulling = false;
        if (!triggered) { indicator.style.height = "0px"; return; }
        refreshing = true;
        indicator.classList.remove("pulling");
        indicator.classList.add("refreshing");
        indicator.style.height = "40px";
        Promise.resolve(pullLatest ? pullLatest() : false)
          .then((didPull) => {
            renderCommand();
            if (showToast) showToast(didPull ? "Synced from cloud" : "Up to date", { tone: "ok", duration: 2000 });
          })
          .catch(() => { if (showToast) showToast("Sync failed", { tone: "error", duration: 2500 }); })
          .finally(() => {
            refreshing = false;
            indicator.classList.remove("refreshing");
            indicator.style.height = "0px";
          });
      }, { passive: true });
    }

    function init() {
      heroRingHookEl.insertAdjacentHTML("afterbegin", heroRing.markup());

      document.getElementById("btn-log").addEventListener("click", openLog);
      document.getElementById("btn-save-log").addEventListener("click", saveLog);
      document.getElementById("btn-cancel-log").addEventListener("click", () => overlay.classList.remove("open"));

      document.getElementById("btn-brief").addEventListener("click", generateBriefing);
      document.getElementById("btn-brief-jump").addEventListener("click", () => {
        document.getElementById("advisor-card").scrollIntoView({ behavior: "smooth", block: "start" });
        generateBriefing();
      });
      document.getElementById("btn-ask").addEventListener("click", askAdvisor);

      if (heroRingHookEl) {
        heroRingHookEl.classList.add("clickable");
        heroRingHookEl.addEventListener("click", () => openDetail("recovery"));
      }
      document.querySelectorAll(".stat-chip[data-detail]").forEach(el => {
        el.classList.add("clickable");
        el.addEventListener("click", () => openDetail(el.dataset.detail));
      });
      const sleepArchCard = document.getElementById("sleep-arch-card");
      if (sleepArchCard) {
        sleepArchCard.classList.add("clickable");
        sleepArchCard.addEventListener("click", () => openDetail("sleepArch"));
      }
      const upcomingCard = document.getElementById("upcoming-card");
      if (upcomingCard) {
        upcomingCard.addEventListener("click", () => {
          const trainTab = document.querySelector('nav.tabbar button[data-view="view-training"]');
          if (trainTab) trainTab.click();
        });
      }
      document.getElementById("btn-close-detail").addEventListener("click", closeDetail);

      initPullToRefresh();
    }

    return { init, render: renderCommand, openDetail, closeDetail, setAdvisorStatus, showBrief };
  }

  global.BioCommandDashboard = { createDashboardModule };
})(window);
