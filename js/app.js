"use strict";

/* ============================================================
   STORAGE ADAPTER (extracted module)
   ============================================================ */

const { Storage, DB_KEY, emptyDB, loadDB } = window.BioCommandStorage;

function saveDB(db) {
  window.BioCommandStorage.saveDB(db, {
    onPersist: [() => {
      renderDataCard();
      enqueueCloudSync();
      window.dispatchEvent(new CustomEvent("biocommand:data-changed"));
    }]
  });
}

let DB = loadDB();

/* ---------- Helpers ---------- */

function dayKey(d) {
  const dt = d || new Date();
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const day = String(dt.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function fmtMin(min) {
  const neg = min < 0;
  const a = Math.abs(Math.round(min));
  const h = Math.floor(a / 60);
  const m = a % 60;
  return (neg ? "-" : "") + h + ":" + String(m).padStart(2, "0");
}

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  return {
    red:   cs.getPropertyValue("--red").trim(),
    amber: cs.getPropertyValue("--amber").trim(),
    green: cs.getPropertyValue("--green").trim(),
    cyan:  cs.getPropertyValue("--cyan").trim(),
    dim:   cs.getPropertyValue("--text-3").trim()
  };
}
let COLORS = readColors();
let LAST_ROW = {};
let LAST_SCORES = {};

function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h, 16);
  return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
}

function bandColor(score) {
  if (score == null) return COLORS.dim;
  if (score < 34) return COLORS.red;
  if (score < 67) return COLORS.amber;
  return COLORS.green;
}
function bandName(score) {
  if (score == null) return "CAL";
  if (score < 34) return "RED";
  if (score < 67) return "AMBER";
  return "GREEN";
}

/* ============================================================
   SCORING ENGINES
   ============================================================ */

function baselineFor(field, excludeKey, windowDays) {
  const keys = Object.keys(DB.telemetry)
    .filter(k => k !== excludeKey && DB.telemetry[k][field] != null)
    .sort()
    .reverse()
    .slice(0, windowDays);
  if (keys.length < 3) return null;
  const sum = keys.reduce((s, k) => s + DB.telemetry[k][field], 0);
  return sum / keys.length;
}

/* Strain: RPE-based when the operator logged perceived effort (most
   accurate). When Garmin supplied minutes and average training HR but
   no RPE (the normal auto-sync case), fall back to a heart-rate-reserve
   proxy: %HRR maps to an effective RPE, then runs through the same
   saturating curve so the two methods land on a comparable scale.
   Requires the operator's max HR (set once in SYS > Profile). */
function computeStrain(row) {
  const trainMin = row.trainingMinutes;
  if (!trainMin || trainMin <= 0) return { value: 0, method: "none" };

  if (row.sessionRPE != null) {
    const lp = trainMin * row.sessionRPE;
    return { value: 21 * (1 - Math.exp(-lp / 450)), method: "rpe" };
  }

  const maxHR = DB.operator.maxHR;
  if (row.trainingAvgHR != null && row.restingHR != null && maxHR && maxHR > row.restingHR) {
    const hrr = clamp01((row.trainingAvgHR - row.restingHR) / (maxHR - row.restingHR));
    const effRPE = hrr * 10;
    const lp = trainMin * effRPE;
    return { value: 21 * (1 - Math.exp(-lp / 450)), method: "hr" };
  }

  return { value: 0, method: "none" };
}

function computeScores(row, key) {
  const win = DB.operator.baselineWindowDays;
  const target = DB.operator.targetSleepMinutes;

  const hrvBase = baselineFor("hrvMs", key, win);
  const rhrBase = baselineFor("restingHR", key, win);

  const out = {
    hrvBase: hrvBase,
    hrvDeltaPct: null,
    readiness: null,
    sleepPerf: null,
    strain: 0,
    strainMethod: "none",
    calibrating: hrvBase == null
  };
  const strainResult = computeStrain(row);
  out.strain = strainResult.value;
  out.strainMethod = strainResult.method;

  if (row.sleepTotalMin != null) {
    out.sleepPerf = Math.min(100, Math.round(row.sleepTotalMin / target * 100));
  }

  if (hrvBase != null && row.hrvMs != null) {
    const ratio = row.hrvMs / hrvBase;
    out.hrvDeltaPct = Math.round((ratio - 1) * 100);
    const hrvScore = clamp01((ratio - 0.55) / (1.20 - 0.55)) * 100;

    let rhrScore = null;
    if (rhrBase != null && row.restingHR != null && row.restingHR > 0) {
      const rRatio = rhrBase / row.restingHR;
      rhrScore = clamp01((rRatio - 0.80) / (1.12 - 0.80)) * 100;
    }
    const sleepScore = out.sleepPerf != null ? out.sleepPerf : null;

    if (rhrScore != null && sleepScore != null) {
      out.readiness = Math.round(0.50 * hrvScore + 0.25 * rhrScore + 0.25 * sleepScore);
      out.components = [
        { label: "HRV vs baseline", weight: 0.50, score: hrvScore },
        { label: "Resting HR vs baseline", weight: 0.25, score: rhrScore },
        { label: "Sleep vs target", weight: 0.25, score: sleepScore }
      ];
    } else if (sleepScore != null) {
      out.readiness = Math.round(0.65 * hrvScore + 0.35 * sleepScore);
      out.components = [
        { label: "HRV vs baseline", weight: 0.65, score: hrvScore },
        { label: "Sleep vs target", weight: 0.35, score: sleepScore }
      ];
    } else {
      out.readiness = Math.round(hrvScore);
      out.components = [
        { label: "HRV vs baseline", weight: 1.00, score: hrvScore }
      ];
    }
  }

  return out;
}

/* ============================================================
   INTEL ENGINE
   ============================================================ */

function lastLogged(field, count) {
  return Object.keys(DB.telemetry).sort().reverse()
    .map(k => DB.telemetry[k][field])
    .filter(v => v != null)
    .slice(0, count);
}

function meanOf(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function buildIntel() {
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
   SPARKLINES
   ============================================================ */

const SPARK_W = 132, SPARK_H = 38;

function sparkLine(values, color) {
  const n = values.length;
  const defined = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
  if (!defined.length) return '<svg class="mc-spark" viewBox="0 0 132 38"></svg>';
  const vals = defined.map(p => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const pad = (max - min) * 0.18 || Math.max(1, max * 0.05);
  const lo = min - pad, hi = max + pad;
  const x = i => 6 + i * (SPARK_W - 12) / (n - 1);
  const y = v => SPARK_H - 5 - (v - lo) / (hi - lo) * (SPARK_H - 10);

  let d = "", prevIdx = null;
  defined.forEach(p => {
    const cmd = (prevIdx != null && p.i === prevIdx + 1) ? "L" : "M";
    d += cmd + x(p.i).toFixed(1) + " " + y(p.v).toFixed(1) + " ";
    prevIdx = p.i;
  });
  const last = defined[defined.length - 1];
  const area = d && defined.length > 1
    ? '<path d="' + d + 'L' + x(last.i).toFixed(1) + " " + (SPARK_H - 3) +
      " L" + x(defined[0].i).toFixed(1) + " " + (SPARK_H - 3) +
      ' Z" fill="' + hexToRgba(color, 0.1) + '" stroke="none"></path>'
    : "";
  return '<svg class="mc-spark" viewBox="0 0 132 38">' + area +
    '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round"></path>' +
    '<circle cx="' + x(last.i).toFixed(1) + '" cy="' + y(last.v).toFixed(1) +
    '" r="3" fill="' + color + '"></circle></svg>';
}

function sparkBars(values, color, fixedMax) {
  const n = values.length;
  const max = fixedMax || Math.max(...values.filter(v => v != null), 1);
  const slot = SPARK_W / n, bw = slot * 0.5;
  let rects = "";
  values.forEach((v, i) => {
    const cx = i * slot + slot / 2;
    if (v == null || v <= 0) {
      rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (SPARK_H - 4) +
        '" width="' + bw.toFixed(1) + '" height="2" rx="1" fill="' +
        hexToRgba(color, 0.18) + '"></rect>';
    } else {
      const h = Math.max(3, (v / max) * (SPARK_H - 8));
      rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (SPARK_H - 2 - h).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' +
        color + '"></rect>';
    }
  });
  return '<svg class="mc-spark" viewBox="0 0 132 38">' + rects + "</svg>";
}

function last7Keys() {
  const out = [];
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    out.push(dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  }
  return out;
}

function seriesFor(field) {
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

function bigLine(values, color) {
  const n = values.length;
  const defined = values.map((v, i) => ({ v, i })).filter(p => p.v != null);
  if (!defined.length) return '<svg class="detail-chart" viewBox="0 0 320 100"></svg>';
  const vals = defined.map(p => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const pad = (max - min) * 0.18 || Math.max(1, max * 0.05);
  const lo = min - pad, hi = max + pad;
  const x = i => 14 + i * (320 - 28) / Math.max(1, n - 1);
  const y = v => 90 - (v - lo) / (hi - lo) * 66;

  let d = "", prevIdx = null;
  defined.forEach(p => {
    const cmd = (prevIdx != null && p.i === prevIdx + 1) ? "L" : "M";
    d += cmd + x(p.i).toFixed(1) + " " + y(p.v).toFixed(1) + " ";
    prevIdx = p.i;
  });
  const last = defined[defined.length - 1];
  const area = defined.length > 1
    ? '<path d="' + d + "L" + x(last.i).toFixed(1) + " 90 L" +
      x(defined[0].i).toFixed(1) + ' 90 Z" fill="' + hexToRgba(color, 0.1) + '" stroke="none"></path>'
    : "";
  const dots = defined.map(p =>
    '<circle cx="' + x(p.i).toFixed(1) + '" cy="' + y(p.v).toFixed(1) +
    '" r="2.6" fill="' + color + '"></circle>').join("");
  return '<svg class="detail-chart" viewBox="0 0 320 100">' + area +
    '<path d="' + d + '" fill="none" stroke="' + color +
    '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"></path>' +
    dots + "</svg>";
}

function bigBars(values, color, fixedMax, targetLine) {
  const n = values.length;
  const max = fixedMax || Math.max(...values.filter(v => v != null), 1);
  const slot = (320 - 16) / n, bw = slot * 0.55;
  let rects = "";
  values.forEach((v, i) => {
    const cx = 8 + i * slot + slot / 2;
    if (v == null || v <= 0) {
      rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="87" width="' +
        bw.toFixed(1) + '" height="3" rx="1.5" fill="' + hexToRgba(color, 0.18) + '"></rect>';
    } else {
      const h = Math.max(4, (v / max) * 70);
      rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + (90 - h).toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
        '" rx="3" fill="' + color + '"></rect>';
    }
  });
  let line = "";
  if (targetLine != null && max) {
    const ty = 90 - clamp01(targetLine / max) * 70;
    line = '<line x1="4" y1="' + ty.toFixed(1) + '" x2="316" y2="' + ty.toFixed(1) +
      '" stroke="' + COLORS.dim + '" stroke-width="1" stroke-dasharray="3,3"></line>';
  }
  return '<svg class="detail-chart" viewBox="0 0 320 100">' + line + rects + "</svg>";
}

function bigStacked(days) {
  const n = days.length;
  const maxTotal = Math.max(...days.map(d => (d.deep || 0) + (d.core || 0) + (d.rem || 0) + (d.awake || 0)), 1);
  const slot = (320 - 16) / n, bw = slot * 0.55;
  const seg = [["deep", "#2456C9"], ["core", "#3B4552"], ["rem", COLORS.cyan], ["awake", COLORS.red]];
  let rects = "";
  days.forEach((d, i) => {
    const cx = 8 + i * slot + slot / 2;
    const total = (d.deep || 0) + (d.core || 0) + (d.rem || 0) + (d.awake || 0);
    if (total <= 0) {
      rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="87" width="' +
        bw.toFixed(1) + '" height="3" rx="1.5" fill="' + hexToRgba(COLORS.dim, 0.3) + '"></rect>';
      return;
    }
    const scale = 70 / maxTotal;
    let yBottom = 90;
    seg.forEach(([key, col]) => {
      const v = d[key] || 0;
      if (v <= 0) return;
      const h = v * scale;
      const yTop = yBottom - h;
      rects += '<rect x="' + (cx - bw / 2).toFixed(1) + '" y="' + yTop.toFixed(1) +
        '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) +
        '" rx="1.5" fill="' + col + '"></rect>';
      yBottom = yTop;
    });
  });
  return '<svg class="detail-chart" viewBox="0 0 320 100">' + rects + "</svg>";
}

function buildBigChart(key) {
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

function isSim() { return Object.keys(DB.telemetry).length === 0; }

/* ============================================================
   RENDER: HERO + METRICS + SLEEP
   ============================================================ */

const RING_C = 2 * Math.PI * 62;

function renderHero(t, s, sim) {
  const rdy = s.readiness;
  const col = bandColor(rdy);
  const arc = document.getElementById("hero-arc");
  const loggedDays = Object.keys(DB.telemetry).length;

  document.getElementById("rg1").setAttribute("stop-color", col);
  document.getElementById("rg2").setAttribute("stop-color", col);

  arc.setAttribute("stroke-dasharray", RING_C.toFixed(1));
  const frac = rdy != null ? rdy / 100 : clamp01(loggedDays / 3) * 0.25;
  arc.setAttribute("stroke-dashoffset", (RING_C * (1 - clamp01(frac))).toFixed(1));
  arc.style.filter = "drop-shadow(0 0 10px " + hexToRgba(col, 0.5) + ")";

  const scoreEl = document.getElementById("hero-score");
  const bandEl = document.getElementById("hero-band");
  if (rdy != null) {
    scoreEl.textContent = rdy;
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
    color: () => COLORS.cyan, fmt: v => Math.round(v) },
  { field: "restingHR", label: "Resting HR", unit: "BPM", kind: "line",
    color: () => COLORS.green, fmt: v => Math.round(v) },
  { field: "sleepTotalMin", label: "Sleep", unit: "H:MM", kind: "bars",
    color: () => COLORS.amber, fmt: v => fmtMin(v),
    max: () => DB.operator.targetSleepMinutes * 1.25 },
  { field: "systemLoadScore", label: "Strain", unit: "/21", kind: "bars",
    color: () => COLORS.red, fmt: v => v.toFixed(1), max: () => 21 },
  { field: "bodyMassKg", label: "Mass", unit: "KG", kind: "line",
    color: () => COLORS.cyan, fmt: v => v.toFixed(1) },
  { field: "respiratoryRate", label: "Respiration", unit: "/MIN", kind: "line",
    color: () => COLORS.green, fmt: v => v.toFixed(1) }
];

function renderMetrics() {
  const grid = document.getElementById("metrics-grid");
  const letters = dayLetters();
  const sim = isSim();
  grid.innerHTML = "";

  METRICS.forEach(m => {
    const series = sim ? SIM[m.field].slice() : seriesFor(m.field);
    const definedVals = series.filter(v => v != null);
    const latest = definedVals.length ? definedVals[definedVals.length - 1] : null;
    const color = m.color();
    const badge = badgeFor(m.field, latest, series);
    const spark = m.kind === "bars"
      ? sparkBars(series, color, m.max ? m.max() : null)
      : sparkLine(series, color);

    const card = document.createElement("div");
    card.className = "metric-card clickable";
    card.dataset.detail = m.field;
    card.addEventListener("click", () => openDetail(m.field));
    card.innerHTML =
      '<div class="mc-head"><span class="mc-label">' + m.label + "</span>" +
      '<span class="badge" style="background:' + hexToRgba(badge.col, 0.14) +
      ";color:" + badge.col + '">' + badge.txt + "</span></div>" +
      '<div class="mc-value-row"><span class="mc-value" style="color:' + color + '">' +
      (latest != null ? m.fmt(latest) : "--") + "</span>" +
      '<span class="mc-unit">' + m.unit + "</span></div>" +
      spark +
      '<div class="mc-days">' + letters.map(l => "<span>" + l + "</span>").join("") + "</div>";
    grid.appendChild(card);
  });
}

function renderSleep(t) {
  const segs = [
    { key: "sleepDeepMin",  label: "DEEP",  color: "#2456C9" },
    { key: "sleepREMMin",   label: "REM",   color: COLORS.cyan },
    { key: "sleepCoreMin",  label: "CORE",  color: "#3B4552" },
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
  renderSleep(t);
  renderIntel();
  renderJournal();
  renderTabBadges();
}

/* ============================================================
   LOG OVERLAY
   ============================================================ */

const overlay = document.getElementById("log-overlay");

function num(id) {
  const v = document.getElementById(id).value;
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function openLog() {
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

document.getElementById("btn-log").addEventListener("click", openLog);
document.getElementById("btn-save-log").addEventListener("click", saveLog);
document.getElementById("btn-cancel-log").addEventListener("click", () => overlay.classList.remove("open"));

/* ============================================================
   GARMIN UPLINK (silent auto-sync; header dot reports state)
   ============================================================ */

const SYNC_KEY = "biocommand.sync";

function loadSyncConfig() {
  try { return JSON.parse(Storage.get(SYNC_KEY)) || null; }
  catch (e) { return null; }
}
function saveSyncConfig(cfg) { Storage.set(SYNC_KEY, JSON.stringify(cfg)); }

function setSyncDot(state) {
  document.getElementById("sync-dot").className = "sync-dot " + (state || "");
}

function b64bytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function decryptFeed(blob, passphrase) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: b64bytes(blob.salt),
      iterations: blob.iter || 210000, hash: "SHA-256" },
    baseKey, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64bytes(blob.nonce) }, key, b64bytes(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

const FEED_FIELDS = [
  "hrvMs", "hrvMethod", "restingHR", "respiratoryRate",
  "sleepTotalMin", "sleepDeepMin", "sleepREMMin", "sleepCoreMin",
  "sleepAwakeMin", "steps", "activeEnergyKcal", "basalEnergyKcal",
  "trainingMinutes", "trainingAvgHR", "bodyMassKg"
];

function mergeFeedDay(key, feedRow) {
  const existing = DB.telemetry[key] || { dayKey: key };
  const merged = { ...existing };
  FEED_FIELDS.forEach(f => {
    if (feedRow[f] != null) merged[f] = feedRow[f];
  });
  merged.dayKey = key;
  merged.source = "garmin";
  merged.scoreVersion = 2;
  merged.updatedAt = new Date().toISOString();
  DB.telemetry[key] = merged;
}

function setUplinkStatus(msg, tone) {
  const el = document.getElementById("uplink-status");
  el.textContent = msg;
  el.style.color = tone === "err" ? COLORS.red
                 : tone === "ok" ? COLORS.green : "";
}

async function syncNow() {
  const cfg = loadSyncConfig();
  if (!cfg || !cfg.pass) {
    setUplinkStatus("Uplink not configured. Set the passphrase and save.", "err");
    return;
  }
  if (!window.crypto || !crypto.subtle) {
    setUplinkStatus("Crypto unavailable. Serve over HTTPS.", "err");
    setSyncDot("err");
    return;
  }
  const url = cfg.url || "data/telemetry.enc";
  setSyncDot("busy");
  setUplinkStatus("Syncing...");
  let blob;
  try {
    const res = await fetch(url + (url.includes("?") ? "&" : "?") + "t=" + Date.now(),
      { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    blob = await res.json();
  } catch (e) {
    setUplinkStatus("Feed fetch failed: " + e.message, "err");
    setSyncDot("err");
    return;
  }
  let payload;
  try {
    payload = await decryptFeed(blob, cfg.pass);
  } catch (e) {
    setUplinkStatus("Decrypt failed. Check the passphrase.", "err");
    setSyncDot("err");
    return;
  }
  const days = payload.days || {};
  const keys = Object.keys(days).sort();
  keys.forEach(k => mergeFeedDay(k, days[k]));
  keys.forEach(k => {
    const r = DB.telemetry[k];
    const sc = computeScores(r, k);
    r.readinessScore = sc.readiness;
    r.systemLoadScore = Math.round(sc.strain * 10) / 10;
    r.strainMethod = sc.strainMethod;
  });
  cfg.lastSync = new Date().toISOString();
  saveSyncConfig(cfg);
  saveDB(DB);
  renderCommand();
  renderUplink();
  setUplinkStatus("Synced " + keys.length + " day(s). Feed " + (payload.generatedAt || "?"), "ok");
  setSyncDot("ok");
}

function renderUplink() {
  const cfg = loadSyncConfig();
  document.getElementById("up-url").value = (cfg && cfg.url) || "";
  document.getElementById("up-pass").value = (cfg && cfg.pass) || "";
  const last = document.getElementById("uplink-last");
  last.textContent = cfg && cfg.lastSync
    ? "LAST " + cfg.lastSync.slice(5, 16).replace("T", " ")
    : "";
}

function renderProfile() {
  document.getElementById("prof-maxhr").value = DB.operator.maxHR || "";
}

document.getElementById("btn-save-profile").addEventListener("click", () => {
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

document.getElementById("btn-save-uplink").addEventListener("click", () => {
  const cfg = loadSyncConfig() || {};
  cfg.url = document.getElementById("up-url").value.trim();
  cfg.pass = document.getElementById("up-pass").value;
  saveSyncConfig(cfg);
  renderUplink();
  setUplinkStatus("Saved. Auto-sync runs each time the app opens.", "ok");
});

document.getElementById("btn-sync").addEventListener("click", syncNow);

/* ============================================================
   ADVISOR (brief on Today; key management in SYS)
   ============================================================ */

const AI_KEY = "biocommand.ai";

function loadAI() {
  try { return JSON.parse(Storage.get(AI_KEY)) || null; }
  catch (e) { return null; }
}
function saveAI(cfg) { Storage.set(AI_KEY, JSON.stringify(cfg)); }

function setAdvisorStatus(msg, tone) {
  const el = document.getElementById("advisor-status");
  el.textContent = msg;
  el.style.color = tone === "err" ? COLORS.red : tone === "ok" ? COLORS.green : "";
  document.getElementById("advisor-dot").style.color =
    tone === "ok" ? COLORS.green : tone === "err" ? COLORS.red : COLORS.dim;
}

function buildDigest() {
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

async function callAdvisor(userText) {
  const cfg = loadAI();
  if (!cfg || !cfg.key) throw new Error("SET KEY IN SYS");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": cfg.key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      "anthropic-dangerous-direct-browser-access": "true"
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system: ADVISOR_SYSTEM,
      messages: [{ role: "user", content: userText }]
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || ("HTTP " + res.status);
    throw new Error(msg);
  }
  return (data.content || [])
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("\n")
    .trim();
}

function showBrief(text) {
  const out = document.getElementById("brief-out");
  out.textContent = text;
  out.classList.add("show");
}

async function generateBriefing() {
  const k = dayKey();
  if (DB.briefings[k]) {
    showBrief(DB.briefings[k]);
    setAdvisorStatus("CACHED " + k, "ok");
    return;
  }
  try {
    setAdvisorStatus("ANALYZING...");
    const text = await callAdvisor(
      "DAILY BRIEFING REQUEST. TELEMETRY DIGEST:\n" + JSON.stringify(buildDigest()));
    DB.briefings[k] = text;
    saveDB(DB);
    showBrief(text);
    setAdvisorStatus("BRIEFED " + k, "ok");
  } catch (e) {
    setAdvisorStatus("OFFLINE: " + e.message, "err");
  }
}

async function askAdvisor() {
  const q = document.getElementById("ai-q").value.trim();
  if (!q) return;
  try {
    setAdvisorStatus("ANALYZING...");
    const text = await callAdvisor(
      "OPERATOR QUESTION: " + q +
      "\nTELEMETRY DIGEST:\n" + JSON.stringify(buildDigest()));
    showBrief(text);
    setAdvisorStatus("ANSWERED", "ok");
  } catch (e) {
    setAdvisorStatus("OFFLINE: " + e.message, "err");
  }
}

document.getElementById("btn-save-ai").addEventListener("click", () => {
  const key = document.getElementById("ai-key").value.trim();
  const st = document.getElementById("advisor-key-status");
  if (!key) { st.textContent = "ENTER A KEY FIRST"; st.style.color = COLORS.red; return; }
  saveAI({ key: key });
  st.textContent = "KEY SAVED ON DEVICE"; st.style.color = COLORS.green;
  setAdvisorStatus("READY");
});

document.getElementById("btn-brief").addEventListener("click", generateBriefing);
document.getElementById("btn-brief-jump").addEventListener("click", () => {
  document.getElementById("advisor-card").scrollIntoView({ behavior: "smooth", block: "start" });
  generateBriefing();
});
document.getElementById("btn-ask").addEventListener("click", askAdvisor);

(function initAdvisor() {
  const cfg = loadAI();
  if (cfg && cfg.key) {
    document.getElementById("ai-key").value = cfg.key;
    setAdvisorStatus("READY");
    const cached = DB.briefings[dayKey()];
    if (cached) { showBrief(cached); }
  } else {
    setAdvisorStatus("SET KEY IN SYS");
  }
})();

/* ============================================================
   DATA CARD (SYS): store status, export / import / wipe
   ============================================================ */

function renderDataCard() {
  document.getElementById("store-desc").textContent = Storage.persistent
    ? "Persistent local store active. Export regularly as backup."
    : "Volatile store (sandboxed preview). Data clears on reload. Open in Safari or host to persist.";
  const bytes = (Storage.get(DB_KEY) || "").length;
  document.getElementById("db-size").textContent = "DB " + bytes + " B";
}

document.getElementById("btn-export").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(DB, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "biocommand-backup-" + dayKey() + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
});

document.getElementById("btn-import").addEventListener("click", () => {
  document.getElementById("import-file").click();
});

document.getElementById("import-file").addEventListener("change", (ev) => {
  const file = ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const incoming = JSON.parse(reader.result);
      if (!incoming || incoming.version !== 1) {
        document.getElementById("import-status").textContent = "Import rejected: unsupported DB version.";
        document.getElementById("import-status").style.color = COLORS.red;
        return;
      }
      incoming.briefings = incoming.briefings || {};
      incoming.workouts = incoming.workouts || [];
      incoming.sessions = incoming.sessions || [];
      DB = incoming;
      saveDB(DB);
      renderCommand();
      document.getElementById("import-status").textContent = "Import successful.";
      document.getElementById("import-status").style.color = COLORS.green;
    } catch (e) {
      document.getElementById("import-status").textContent = "Import rejected: file is not valid Bio-Command JSON.";
      document.getElementById("import-status").style.color = COLORS.red;
    }
  };
  reader.readAsText(file);
  ev.target.value = "";
});

document.getElementById("btn-wipe").addEventListener("click", (ev) => {
  armDangerButton(ev.currentTarget, "Wipe", () => {
    Storage.remove(DB_KEY);
    DB = emptyDB();
    saveDB(DB);
    renderCommand();
  });
});

/* ============================================================
   SHELL: tabs, SYS, header, theme
   ============================================================ */

/* ============================================================
   TRAIN MODULE
   Templates (workouts) hold prescriptions; sessions are the
   immutable execution log. Finishing a session writes duration
   and average RPE straight into today's telemetry row, so
   strain is computed from what you actually lifted rather than
   a manual estimate.
   ============================================================ */

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

function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/* ============================================================
   TRAIN MODULE (extracted into js/modules/training/index.js)
   armDangerButton/genId remain here pending the shared-utilities
   extraction; other modules (Fuel, Training) already depend on them.
   ============================================================ */

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

function genId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const trainingModule = window.BioCommandTraining.createTrainingModule({
  dayKey,
  saveDB,
  genId,
  armDangerButton,
  computeScores,
  renderCommand,
  getDB: () => DB,
  getColors: () => COLORS
});
trainingModule.init();


/* ============================================================
   FUEL MODULE (extracted into js/modules/fuel/index.js)
   ============================================================ */

const fuelModule = window.BioCommandFuel.createFuelModule({
  dayKey,
  saveDB,
  genId,
  baselineFor,
  loadAI,
  armDangerButton,
  getDB: () => DB,
  getColors: () => COLORS
});
fuelModule.init();

function renderFuel() {
  fuelModule.render();
}

/* ============================================================
   JOURNAL ENGINE (Whoop-style morning check-in)
   Journal lives in DB.journal: { dayKey: { answers: {q: bool}, note: "" } }
   Renders on Command (compact), PROTO tab (full with history), and
   correlates answers against telemetry in Behavior Insights.
   ============================================================ */

const JOURNAL_QUESTIONS = [
  { key: "ALCOHOL",       label: "Alcohol last night?" },
  { key: "STRESS",        label: "Stress elevated?" },
  { key: "CAFFEINE_LATE", label: "Caffeine after 2pm?" },
  { key: "POOR_SLEEP",    label: "Sleep disrupted?" },
  { key: "SICK",          label: "Feeling unwell?" }
];

function getJournalEntry(day) {
  DB.journal = DB.journal || {};
  if (!DB.journal[day]) DB.journal[day] = { answers: {}, note: "" };
  return DB.journal[day];
}

function setJournalAnswer(day, key, val) {
  const entry = getJournalEntry(day);
  entry.answers[key] = val;
  saveDB(DB);
}

function setJournalNote(day, text) {
  const entry = getJournalEntry(day);
  entry.note = text;
  saveDB(DB);
}

function journalStreakCount() {
  let streak = 0;
  const now = new Date();
  for (let i = 0; i < 60; i++) {
    const k = dayKey(new Date(now.getTime() - i * 86400000));
    const entry = (DB.journal || {})[k];
    if (entry && Object.keys(entry.answers).length > 0) streak++;
    else break;
  }
  return streak;
}

function buildJournalUI(container, day, compact) {
  if (!container) return;
  const entry = getJournalEntry(day);
  container.innerHTML = "";

  JOURNAL_QUESTIONS.forEach(q => {
    const ans = entry.answers[q.key];
    const row = document.createElement("div");
    row.className = "jq-row";
    row.innerHTML =
      '<span class="jq-q">' + q.label + '</span><span class="jq-opts">' +
      '<button class="jq-btn' + (ans === true ? " sel" : "") + '" data-jkey="' + q.key + '" data-jval="true">YES</button>' +
      '<button class="jq-btn' + (ans === false ? " sel" : "") + '" data-jkey="' + q.key + '" data-jval="false">NO</button>' +
      '</span>';
    container.appendChild(row);
  });

  if (!compact) {
    const noteRow = document.createElement("div");
    noteRow.style.marginTop = "10px";
    noteRow.innerHTML = '<textarea class="journal-note" id="journal-note-' + day + '" placeholder="Notes, how you feel, anything notable today...">' +
      (entry.note || "") + '</textarea>';
    container.appendChild(noteRow);
    container.querySelector(".journal-note").addEventListener("input", (ev) => {
      setJournalNote(day, ev.target.value);
    });
  }

  container.addEventListener("click", (ev) => {
    const btn = ev.target.closest(".jq-btn");
    if (!btn) return;
    const val = btn.dataset.jval === "true";
    setJournalAnswer(day, btn.dataset.jkey, val);
    renderJournal();
    if (container.id === "cmd-journal-body") renderJournalProto();
    else renderJournal();
  });
}

function renderJournal() {
  const today = dayKey();
  const streak = journalStreakCount();
  const entry = getJournalEntry(today);
  const allAnswered = JOURNAL_QUESTIONS.every(q => entry.answers[q.key] !== undefined);
  const dot = document.getElementById("journal-cmd-dot");
  if (dot) dot.style.color = allAnswered ? COLORS.green : COLORS.amber;

  const streakEl = document.getElementById("journal-streak");
  if (streakEl) streakEl.textContent = streak + "d streak";

  buildJournalUI(document.getElementById("cmd-journal-body"), today, true);
}

function renderJournalProto() {
  const today = dayKey();
  const streak = journalStreakCount();
  const streakEl = document.getElementById("proto-journal-streak");
  if (streakEl) streakEl.textContent = streak + "d streak";
  buildJournalUI(document.getElementById("proto-journal-body"), today, false);

  // Behavior insights: correlate each journal key vs recovery
  const insightsHost = document.getElementById("behavior-insights");
  const insightLines = [];
  JOURNAL_QUESTIONS.forEach(q => {
    const yes = [], no = [];
    Object.keys(DB.journal || {}).forEach(day => {
      const entry = DB.journal[day];
      const row = DB.telemetry[day];
      if (!row || row.readinessScore == null) return;
      if (entry.answers[q.key] === true) yes.push(row.readinessScore);
      else if (entry.answers[q.key] === false) no.push(row.readinessScore);
    });
    if (yes.length >= 5 && no.length >= 5) {
      const avgYes = Math.round(meanOf(yes));
      const avgNo = Math.round(meanOf(no));
      const delta = avgYes - avgNo;
      insightLines.push({ label: q.label, delta, n: yes.length + no.length });
    }
  });
  if (!insightLines.length) {
    insightsHost.innerHTML = '<div class="empty-hint">Log 5 yes and 5 no days for each question to unlock correlations.</div>';
  } else {
    insightLines.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    insightsHost.innerHTML = insightLines.map(l =>
      '<div class="insight-row">' + l.label +
      ' <span style="color:' + (l.delta < 0 ? COLORS.red : COLORS.green) + '">' +
      (l.delta >= 0 ? "+" : "") + l.delta + 'pt recovery on YES days</span>' +
      ' <span class="telemetry cap t3">(n=' + l.n + ')</span></div>'
    ).join("");
  }

  // 7-day history
  const historyHost = document.getElementById("journal-history");
  const last7 = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(Date.now() - i * 86400000);
    last7.push({ key: dayKey(d), d });
  }
  historyHost.innerHTML = last7.map(({ key, d }) => {
    const entry = (DB.journal || {})[key];
    if (!entry || Object.keys(entry.answers).length === 0) return "";
    const dstr = String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0");
    const flags = JOURNAL_QUESTIONS.filter(q => entry.answers[q.key] === true).map(q => q.label.split(" ").slice(-1)[0].replace("?","")).join(", ");
    return '<div class="insight-row">' + dstr +
      (flags ? ' <span class="telemetry cap" style="color:var(--amber)">' + flags + '</span>' : ' <span class="telemetry cap t3">No flags</span>') +
      (entry.note ? '<br><span class="telemetry cap t3">' + entry.note.slice(0, 80) + (entry.note.length > 80 ? "…" : "") + "</span>" : "") +
      "</div>";
  }).filter(Boolean).join("") || '<div class="empty-hint">No journal entries yet this week.</div>';
}

/* ============================================================
   BIO MODULE
   Reference ranges are seeded defaults sourced from standard
   clinical lab references and commonly cited optimal/wellness
   targets (see reference note in the Bio tab). Band logic is a
   simple two-boundary system: outside the clinical range is
   red, inside clinical but outside optimal is amber, inside
   optimal is green. This is informational, not diagnostic.
   ============================================================ */

function seedDefaultMarkers() {
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

document.getElementById("btn-bio-ai-import").addEventListener("click", bioAIImport);
document.getElementById("btn-bio-ai-clear").addEventListener("click", () => {
  document.getElementById("bio-ai-paste").value = "";
  document.getElementById("bio-import-status").textContent = "";
});

function renderMarkerList() {
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

document.getElementById("marker-list").addEventListener("click", (ev) => {
  const card = ev.target.closest("[data-marker]");
  if (card) openMarkerOverlay(card.dataset.marker);
});

let markerOpenCode = null;

function openMarkerOverlay(code) {
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

document.getElementById("btn-close-marker").addEventListener("click", () => {
  document.getElementById("marker-overlay").classList.remove("open");
});

document.getElementById("btn-save-marker-log").addEventListener("click", () => {
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

/* ============================================================
   PROTOCOL MODULE
   scheduleMask bit 0 = Monday ... bit 6 = Sunday. Streaks count
   consecutive scheduled days completed, working backward from
   today. The correlation line compares average Recovery on days
   a directive was completed vs not, once there is enough of
   both to say anything meaningful (3+ each).
   ============================================================ */

const CATEGORY_LABELS = {
  coldExposure: "Cold exposure", heat: "Heat", supplement: "Supplement",
  sleepHygiene: "Sleep hygiene", mobility: "Mobility", zone2: "Zone 2",
  mindset: "Mindset", custom: "Custom"
};

function seedDefaultProtocols() {
  if (DB.protocols.length > 0) return;
  DB.protocols.push(
    { id: genId("pd"), name: "COLD EXPOSURE", category: "coldExposure", scheduleMask: 0b1111111, targetValue: 3, targetUnit: "min", isActive: true, sortOrder: 0 },
    { id: genId("pd"), name: "CREATINE 5G", category: "supplement", scheduleMask: 0b1111111, targetValue: 5, targetUnit: "g", isActive: true, sortOrder: 1 },
    { id: genId("pd"), name: "SCREENS OFF BY 22:00", category: "sleepHygiene", scheduleMask: 0b1111111, targetValue: null, targetUnit: null, isActive: true, sortOrder: 2 },
    { id: genId("pd"), name: "ZONE 2 SESSION", category: "zone2", scheduleMask: 0b0010010, targetValue: 30, targetUnit: "min", isActive: true, sortOrder: 3 }
  );
  saveDB(DB);
}

function weekdayBit(date) {
  const d = date.getDay(); // 0 Sun .. 6 Sat
  return d === 0 ? 6 : d - 1; // Mon=0 .. Sun=6
}

function isScheduledOnDate(directive, date) {
  return (directive.scheduleMask & (1 << weekdayBit(date))) !== 0;
}

function completionFor(dayKeyStr, directiveId) {
  return DB.completions[dayKeyStr] && DB.completions[dayKeyStr][directiveId];
}

function streakFor(directive) {
  let streak = 0;
  let d = new Date();
  for (let i = 0; i < 90; i++) {
    if (isScheduledOnDate(directive, d)) {
      const comp = completionFor(dayKey(d), directive.id);
      if (comp && comp.completed) streak++;
      else break;
    }
    d = new Date(d.getTime() - 86400000);
  }
  return streak;
}

function correlationFor(directiveId) {
  const done = [], skipped = [];
  Object.keys(DB.completions).forEach(day => {
    const row = DB.telemetry[day];
    if (!row || row.readinessScore == null) return;
    const comp = DB.completions[day][directiveId];
    if (comp && comp.completed) done.push(row.readinessScore);
    else if (comp) skipped.push(row.readinessScore);
  });
  if (done.length < 3 || skipped.length < 3) return null;
  const avgDone = Math.round(meanOf(done));
  const avgSkip = Math.round(meanOf(skipped));
  return { delta: avgDone - avgSkip, n: done.length + skipped.length };
}

function renderProtocolList() {
  seedDefaultProtocols();
  const host = document.getElementById("protocol-list");
  const today = dayKey();
  const now = new Date();
  const active = DB.protocols.filter(p => p.isActive !== false);
  const scheduledToday = active.filter(p => isScheduledOnDate(p, now));

  if (!scheduledToday.length) {
    host.innerHTML = '<div class="empty-hint">Nothing scheduled today. Tap New to add a directive.</div>';
    return;
  }

  host.innerHTML = scheduledToday.map(p => {
    const comp = completionFor(today, p.id);
    const done = !!(comp && comp.completed);
    const streak = streakFor(p);
    const corr = correlationFor(p.id);
    let corrText = "";
    if (corr) {
      const cls = corr.delta > 0 ? "corr-pos" : corr.delta < 0 ? "corr-neg" : "";
      corrText = ' &middot; <span class="' + cls + '">Recovery ' + (corr.delta >= 0 ? "+" : "") + corr.delta + "pt on done days (n=" + corr.n + ")</span>";
    }
    return '<div class="hud-card proto-row" data-editproto="' + p.id + '">' +
      '<button class="sc-check' + (done ? " done" : "") + '" data-checkproto="' + p.id + '">' + (done ? "&#10003;" : "") + '</button>' +
      '<div style="flex:1;">' +
      '<div class="proto-name">' + p.name + '</div>' +
      '<div class="proto-meta">' + CATEGORY_LABELS[p.category] +
      (p.targetValue ? " &middot; " + p.targetValue + (p.targetUnit || "") : "") +
      " &middot; " + streak + "d streak" + corrText + '</div>' +
      '</div></div>';
  }).join("");
}

document.getElementById("protocol-list").addEventListener("click", (ev) => {
  const checkId = ev.target.dataset.checkproto;
  if (checkId) {
    const today = dayKey();
    DB.completions[today] = DB.completions[today] || {};
    const existing = DB.completions[today][checkId];
    const nowDone = !(existing && existing.completed);
    DB.completions[today][checkId] = { completed: nowDone, loggedValue: null, loggedAt: new Date().toISOString() };
    saveDB(DB);
    renderProtocolList();
    return;
  }
  const row = ev.target.closest("[data-editproto]");
  if (row) openProtocolBuilder(row.dataset.editproto);
});

let protocolEditId = null;

function openProtocolBuilder(id) {
  protocolEditId = id;
  document.getElementById("protocol-builder-status").textContent = "";
  const delBtn = document.getElementById("btn-delete-protocol");
  const dayBtns = document.querySelectorAll("#pd-days .day-toggle");
  if (id) {
    const p = DB.protocols.find(x => x.id === id);
    document.getElementById("protocol-builder-title").textContent = "Edit Directive";
    document.getElementById("pd-name").value = p.name;
    document.getElementById("pd-category").value = p.category;
    document.getElementById("pd-target").value = p.targetValue || "";
    document.getElementById("pd-unit").value = p.targetUnit || "";
    dayBtns.forEach(b => b.classList.toggle("active", (p.scheduleMask & (1 << Number(b.dataset.day))) !== 0));
    delBtn.style.display = "block";
  } else {
    document.getElementById("protocol-builder-title").textContent = "New Directive";
    document.getElementById("pd-name").value = "";
    document.getElementById("pd-category").value = "custom";
    document.getElementById("pd-target").value = "";
    document.getElementById("pd-unit").value = "";
    dayBtns.forEach(b => b.classList.add("active"));
    delBtn.style.display = "none";
  }
  document.getElementById("protocol-builder-overlay").classList.add("open");
}

document.getElementById("btn-new-protocol").addEventListener("click", () => openProtocolBuilder(null));
document.getElementById("btn-cancel-protocol").addEventListener("click", () => {
  document.getElementById("protocol-builder-overlay").classList.remove("open");
});
document.getElementById("pd-days").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".day-toggle");
  if (btn) btn.classList.toggle("active");
});
document.getElementById("btn-save-protocol").addEventListener("click", () => {
  const status = document.getElementById("protocol-builder-status");
  const name = document.getElementById("pd-name").value.trim();
  if (!name) { status.textContent = "Name the directive first."; status.style.color = COLORS.red; return; }
  let mask = 0;
  document.querySelectorAll("#pd-days .day-toggle.active").forEach(b => { mask |= (1 << Number(b.dataset.day)); });
  if (mask === 0) { status.textContent = "Pick at least one day."; status.style.color = COLORS.red; return; }
  const data = {
    name, category: document.getElementById("pd-category").value, scheduleMask: mask,
    targetValue: Number(document.getElementById("pd-target").value) || null,
    targetUnit: document.getElementById("pd-unit").value.trim() || null,
    isActive: true
  };
  if (protocolEditId) {
    const p = DB.protocols.find(x => x.id === protocolEditId);
    Object.assign(p, data);
  } else {
    DB.protocols.push({ id: genId("pd"), sortOrder: DB.protocols.length, ...data });
  }
  saveDB(DB);
  document.getElementById("protocol-builder-overlay").classList.remove("open");
  renderProtocolList();
});
document.getElementById("btn-delete-protocol").addEventListener("click", (ev) => {
  if (!protocolEditId) return;
  armDangerButton(ev.currentTarget, "Delete", () => {
    DB.protocols = DB.protocols.filter(p => p.id !== protocolEditId);
    saveDB(DB);
    document.getElementById("protocol-builder-overlay").classList.remove("open");
    renderProtocolList();
  });
});

/* ============================================================
   SUPABASE CLOUD SYNC
   Strategy: localStorage is primary (fast, offline). Supabase
   is the cloud backup. On every saveDB, we enqueue a cloud push.
   On app open, we pull from cloud and merge.
   ============================================================ */

const SB_CONFIG_KEY = "biocommand.supabase";
const CLOUD_SYNC_KEY = "biocommand.cloudsync";
let _supabaseClient = null;
let _currentUser = null;
let _syncTimer = null;

function loadSBConfig() {
  try { return JSON.parse(Storage.get(SB_CONFIG_KEY)) || null; } catch (e) { return null; }
}
function saveSBConfig(cfg) { Storage.set(SB_CONFIG_KEY, JSON.stringify(cfg)); }

function getSB() {
  if (_supabaseClient) return _supabaseClient;
  const cfg = loadSBConfig();
  if (!cfg || !cfg.url || !cfg.key) return null;
  try {
    _supabaseClient = window.supabase.createClient(cfg.url, cfg.key, {
      auth: { persistSession: true, storageKey: "biocommand.sbsession" }
    });
    return _supabaseClient;
  } catch (e) { return null; }
}

function setCloudDot(state) {
  ["hdr-cloud-dot", "cloud-dot"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.className = "cloud-dot " + (state || "");
  });
}

function setCloudLabel(msg, state) {
  const el = document.getElementById("cloud-status-lbl");
  if (el) el.textContent = msg;
  setCloudDot(state || "");
}

async function cloudPush() {
  const sb = getSB();
  if (!sb || !_currentUser) return false;
  try {
    setCloudDot("syncing");
    const { error } = await sb.from("operator_data").upsert({
      user_id: _currentUser.id,
      data: DB,
      synced_at: new Date().toISOString()
    }, { onConflict: "user_id" });
    if (error) throw error;
    const cfg = loadSBConfig();
    cfg.lastSync = new Date().toISOString();
    saveSBConfig(cfg);
    setCloudDot("synced");
    renderCloudCard();
    return true;
  } catch (e) {
    setCloudDot("error");
    return false;
  }
}

async function cloudPull() {
  const sb = getSB();
  if (!sb || !_currentUser) return false;
  try {
    const { data, error } = await sb.from("operator_data")
      .select("data, synced_at").eq("user_id", _currentUser.id).single();
    if (error || !data) return false;
    const remote = data.data;
    if (!remote || remote.version !== 1) return false;
    // Merge: take remote as the base, but preserve any very recent local writes
    // by keeping the most recent day's telemetry, sessions, fuelLog, journal
    const localRecent = {};
    const todayK = dayKey();
    if (DB.telemetry[todayK]) localRecent.telemetry = { [todayK]: DB.telemetry[todayK] };
    DB = { ...remote };
    if (localRecent.telemetry) DB.telemetry = { ...DB.telemetry, ...localRecent.telemetry };
    // Ensure migrations
    DB.journal = DB.journal || {};
    DB.fuelLog = DB.fuelLog || [];
    DB.briefings = DB.briefings || {};
    DB.workouts = DB.workouts || [];
    DB.sessions = DB.sessions || [];
    DB.seededWorkouts = DB.seededWorkouts || false;
    Storage.set(DB_KEY, JSON.stringify(DB));
    return true;
  } catch (e) { return false; }
}

// Debounced cloud push: batches rapid writes into one network call
function enqueueCloudSync() {
  if (!getSB() || !_currentUser) return;
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => cloudPush(), 2000);
}

// Override saveDB to also enqueue a cloud sync
const _originalSaveDB = saveDB;
// Patch: saveDB is declared as a regular function above, we extend it here
const _saveThenSync = (db) => {
  Storage.set(DB_KEY, JSON.stringify(db));
  renderDataCard();
  enqueueCloudSync();
};

async function initSupabase() {
  const sb = getSB();
  if (!sb) { renderCloudCard(); return; }
  try {
    const { data: { user } } = await sb.auth.getUser();
    _currentUser = user;
    if (user) {
      setCloudDot("syncing");
      const pulled = await cloudPull();
      if (pulled) {
        renderCommand();
        renderJournal();
      }
      setCloudDot("synced");
      renderCloudCard();
    } else {
      renderCloudCard();
    }
    sb.auth.onAuthStateChange(async (event, session) => {
      _currentUser = session ? session.user : null;
      if (event === "SIGNED_IN" && _currentUser) {
        await cloudPull();
        renderCommand();
      }
      renderCloudCard();
    });
  } catch (e) { renderCloudCard(); }
}

function renderCloudCard() {
  const cfg = loadSBConfig();
  const signedInUI = document.getElementById("cloud-signed-in-ui");
  const authUI = document.getElementById("cloud-auth-ui");
  const emailRow = document.getElementById("cloud-email-row");
  const signinRow = document.getElementById("cloud-signin-row");
  if (!signedInUI || !authUI) return;

  if (cfg && cfg.url && cfg.key) {
    document.getElementById("sb-url").value = cfg.url;
    document.getElementById("sb-key").value = cfg.key;
    emailRow.style.display = "block";
    signinRow.style.display = "block";
  }

  if (_currentUser) {
    signedInUI.style.display = "block";
    authUI.style.display = "none";
    document.getElementById("cloud-user-email").textContent = _currentUser.email;
    const cfg2 = loadSBConfig();
    const lastEl = document.getElementById("cloud-last-sync");
    if (lastEl) {
      lastEl.textContent = cfg2 && cfg2.lastSync
        ? "Last synced " + cfg2.lastSync.slice(5, 16).replace("T", " ")
        : "Not yet synced this session";
    }
    setCloudDot("synced");
    setCloudLabel("Signed in", "synced");
  } else if (cfg && cfg.url) {
    signedInUI.style.display = "none";
    authUI.style.display = "block";
    setCloudDot("offline");
    setCloudLabel("Sign in to sync");
  } else {
    signedInUI.style.display = "none";
    authUI.style.display = "block";
    setCloudDot("");
    setCloudLabel("Not configured");
  }
}

document.getElementById("btn-sb-save").addEventListener("click", async () => {
  const url = document.getElementById("sb-url").value.trim();
  const key = document.getElementById("sb-key").value.trim();
  const msg = document.getElementById("cloud-msg");
  if (!url || !key) { msg.textContent = "Enter both URL and key."; msg.style.color = COLORS.red; return; }
  _supabaseClient = null;
  saveSBConfig({ url, key });
  const sb = getSB();
  if (!sb) { msg.textContent = "Could not create client. Check URL and key."; msg.style.color = COLORS.red; return; }
  msg.textContent = "Saved. Enter your email to sign in.";
  msg.style.color = COLORS.green;
  document.getElementById("cloud-email-row").style.display = "block";
  document.getElementById("cloud-signin-row").style.display = "block";
  await initSupabase();
});

document.getElementById("btn-sb-signin").addEventListener("click", async () => {
  const email = document.getElementById("sb-email").value.trim();
  const msg = document.getElementById("cloud-msg");
  const sb = getSB();
  if (!sb || !email) { msg.textContent = "Enter your email."; msg.style.color = COLORS.red; return; }
  msg.innerHTML = '<span class="ai-thinking">SENDING...</span>';
  const origin = window.location.origin;
  const path = window.location.pathname.replace(/\/$/, "");
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: origin + path + "/" }
  });
  if (error) {
    msg.textContent = "Error: " + error.message;
    msg.style.color = COLORS.red;
  } else {
    msg.textContent = "Magic link sent to " + email + ". Click it to sign in. You can close this screen.";
    msg.style.color = COLORS.green;
  }
});

document.getElementById("btn-cloud-sync").addEventListener("click", async () => {
  await cloudPush();
  renderCloudCard();
});

document.getElementById("btn-sb-signout").addEventListener("click", async () => {
  const sb = getSB();
  if (sb) await sb.auth.signOut();
  _currentUser = null;
  renderCloudCard();
});

document.getElementById("btn-sb-clear").addEventListener("click", () => {
  _supabaseClient = null;
  _currentUser = null;
  Storage.remove(SB_CONFIG_KEY);
  renderCloudCard();
});

/* ============================================================
   NOTIFICATIONS (Service Worker + Web Push)
   ============================================================ */

const VAPID_PUBLIC = "BNc4j1_b5Si40nI6Aet0VOJDusf2QpRQHABjgS_mntjB7Lj4O9rBoGIxHxog0_UP_qOA4o06z-YzP1fV5RQlLMQ";

let _sw = null;

async function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.register("sw.js", { scope: "/bio-command/" });
    _sw = reg;
    await scheduleNotifications();
    renderNotifCard();
  } catch (e) {
    console.log("SW registration failed:", e);
  }
}

function buildNotificationSchedule() {
  const now = Date.now();
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const notifs = [];

  // Morning journal prompt at 08:30 tomorrow
  const journalTime = new Date(tomorrow);
  journalTime.setHours(8, 30, 0, 0);
  const entry = (DB.journal || {})[dayKey()];
  const allAnswered = entry && Object.keys(entry.answers || {}).length >= 3;
  if (!allAnswered) {
    notifs.push({
      at: journalTime.getTime(),
      title: "Bio-Command",
      body: "Morning journal waiting. Check your recovery and log how you feel.",
      tag: "journal-morning",
      url: "/bio-command/?action=journal"
    });
  }

  // Protocol reminders: for any active protocol scheduled today that is not yet complete
  const nowDate = new Date();
  const todayK = dayKey();
  (DB.protocols || []).forEach(p => {
    if (!p.isActive) return;
    if (!(p.scheduleMask & (1 << weekdayBit(nowDate)))) return;
    const comp = (DB.completions[todayK] || {})[p.id];
    if (comp && comp.completed) return;
    // Reminder at 18:30 for incomplete protocols
    const reminderTime = new Date(nowDate);
    reminderTime.setHours(18, 30, 0, 0);
    if (reminderTime.getTime() > now) {
      notifs.push({
        at: reminderTime.getTime(),
        title: "Protocol reminder",
        body: p.name + " not yet logged today.",
        tag: "proto-" + p.id,
        url: "/bio-command/?tab=proto"
      });
    }
  });

  // Recovery alert: if red recovery, send notification during morning window
  const todayRow = (DB.telemetry || {})[todayK];
  if (todayRow && todayRow.readinessScore != null && todayRow.readinessScore < 34) {
    const alertTime = new Date(tomorrow);
    alertTime.setHours(7, 45, 0, 0);
    notifs.push({
      at: alertTime.getTime(),
      title: "Recovery alert",
      body: "Recovery scored " + todayRow.readinessScore + "/100. Red day. Reduce load.",
      tag: "recovery-alert",
      url: "/bio-command/"
    });
  }

  return notifs;
}

async function scheduleNotifications() {
  if (!_sw) return;
  if (Notification.permission !== "granted") return;
  const schedule = buildNotificationSchedule();
  const channel = new MessageChannel();
  _sw.active && _sw.active.postMessage(
    { type: "SCHEDULE_NOTIFICATIONS", notifications: schedule },
    [channel.port2]
  );
}

async function requestNotificationPermission() {
  if (!("Notification" in window)) {
    document.getElementById("notif-detail").textContent = "Notifications are not supported in this browser.";
    return;
  }
  const result = await Notification.requestPermission();
  if (result === "granted") {
    await scheduleNotifications();
    // Try push subscription
    if (_sw && window.PushManager) {
      try {
        const sub = await _sw.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: VAPID_PUBLIC
        });
        const sb = getSB();
        if (sb && _currentUser) {
          const key = sub.getKey("p256dh");
          const auth = sub.getKey("auth");
          await sb.from("push_subscriptions").upsert({
            user_id: _currentUser.id,
            endpoint: sub.endpoint,
            p256dh: btoa(String.fromCharCode(...new Uint8Array(key))),
            auth_key: btoa(String.fromCharCode(...new Uint8Array(auth)))
          }, { onConflict: "user_id,endpoint" });
        }
      } catch (e) {
        console.log("Push subscription failed:", e.message);
      }
    }
  }
  renderNotifCard();
}

function renderNotifCard() {
  const dot = document.getElementById("notif-status-dot");
  const lbl = document.getElementById("notif-status-lbl");
  const detail = document.getElementById("notif-detail");
  const btn = document.getElementById("btn-notif-enable");
  if (!dot) return;
  if (!("Notification" in window)) {
    dot.style.color = COLORS.dim;
    lbl.textContent = "Not supported";
    if (detail) detail.textContent = "Use Safari on iOS 16.4+ with the app installed to the home screen.";
    if (btn) btn.style.display = "none";
    return;
  }
  const perm = Notification.permission;
  if (perm === "granted") {
    dot.style.color = COLORS.green;
    lbl.textContent = "Enabled";
    if (detail) detail.textContent = "Morning journal reminder, protocol nudges, and recovery alerts are scheduled.";
    if (btn) btn.textContent = "Reschedule";
  } else if (perm === "denied") {
    dot.style.color = COLORS.red;
    lbl.textContent = "Blocked";
    if (detail) detail.textContent = "Blocked in browser settings. Open Settings > Safari > Notifications to re-enable.";
    if (btn) btn.style.display = "none";
  } else {
    dot.style.color = COLORS.dim;
    lbl.textContent = "Not enabled";
    if (detail) detail.textContent = "Tap to enable. Must be installed to the home screen on iOS.";
    if (btn) btn.style.display = "block";
  }
}

document.getElementById("btn-notif-enable").addEventListener("click", requestNotificationPermission);

/* ============================================================
   TAB BADGES
   ============================================================ */

function renderTabBadges() {
  const today = dayKey();
  const now = new Date();

  // CMD badge: journal not complete
  const entry = (DB.journal || {})[today] || { answers: {} };
  const journalDone = Object.keys(entry.answers).length >= 3;
  const cmdBadge = document.querySelector('[data-view="view-command"] .tab-badge');
  if (cmdBadge) cmdBadge.classList.toggle("show", !journalDone);

  // PROTO badge: any scheduled directive not yet checked
  const protoPending = (DB.protocols || [])
    .filter(p => p.isActive && (p.scheduleMask & (1 << weekdayBit(now))))
    .some(p => {
      const comp = ((DB.completions || {})[today] || {})[p.id];
      return !comp || !comp.completed;
    });
  const protoBadge = document.querySelector('[data-view="view-proto"] .tab-badge');
  if (protoBadge) protoBadge.classList.toggle("show", protoPending);
}

function showView(id) {
  document.querySelectorAll("section.view").forEach(v => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.querySelectorAll("nav.tabbar button").forEach(b =>
    b.classList.toggle("active", b.dataset.view === id));
  window.scrollTo(0, 0);
  if (id === "view-training") { trainingModule.render(); }
  if (id === "view-fuel") { renderFuel(); }
  if (id === "view-bio") { renderMarkerList(); }
  if (id === "view-proto") { renderProtocolList(); renderJournalProto(); }
  renderTabBadges();
}

document.querySelectorAll("nav.tabbar button").forEach(btn => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});
document.getElementById("btn-sys").addEventListener("click", () => showView("view-sys"));

(function initHeader() {
  const now = new Date();
  const months = ["JAN","FEB","MAR","APR","MAY","JUN","JUL","AUG","SEP","OCT","NOV","DEC"];
  document.getElementById("hdr-date").textContent =
    String(now.getDate()).padStart(2, "0") + " " + months[now.getMonth()];
})();

const THEME_KEY = "biocommand.theme";
const metaTheme = document.getElementById("meta-theme");
const btnTheme = document.getElementById("btn-theme");

function applyTheme(mode) {
  if (mode === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }
  metaTheme.setAttribute("content", mode === "light" ? "#EFF2F5" : "#0D0F12");
  btnTheme.textContent = mode === "light" ? "DAY" : "NIGHT";
  COLORS = readColors();
  renderCommand();
}

btnTheme.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  Storage.set(THEME_KEY, next);
  applyTheme(next);
});

/* ============================================================
   BOOT
   ============================================================ */

const heroRingHook = document.getElementById("hero-ring-hook");
if (heroRingHook) {
  heroRingHook.classList.add("clickable");
  heroRingHook.addEventListener("click", () => openDetail("recovery"));
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
document.getElementById("btn-close-detail").addEventListener("click", closeDetail);

renderUplink();
renderProfile();
renderDataCard();
renderCloudCard();
renderNotifCard();
trainingModule.seedDefaultWorkouts();
renderJournal();
initSupabase();
initServiceWorker();
renderTabBadges();
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
if (loadSyncConfig() && (loadSyncConfig() || {}).pass) {
  syncNow();
}
