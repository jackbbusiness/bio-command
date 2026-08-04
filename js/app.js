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
   INTEL ENGINE (rendering extracted into js/modules/dashboard)
   meanOf stays here: Journal and Protocols also depend on it.
   ============================================================ */

function meanOf(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/* ============================================================
   SPARKLINES (data helpers extracted into js/modules/dashboard)
   sparkLine/sparkBars stay here: Dashboard depends on them, and
   they are pure chart primitives pending the shared-utilities pass.
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

/* ============================================================
   DETAIL ENGINE (orchestration extracted into js/modules/dashboard)
   bigLine/bigBars/bigStacked stay here: Dashboard depends on them,
   and bigLine is also relied on directly by the Biomarkers module.
   ============================================================ */

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

/* ============================================================
   SETTINGS (extracted into js/modules/settings/index.js)
   Constructed before Dashboard: Fuel/Biomarkers/Dashboard all read
   the stored AI key through settingsModule.loadAI. renderCommand is
   still a bare app.js identifier at this point in the file, but
   function declarations are hoisted, so this reference resolves
   correctly the moment it's actually called (never before boot).
   ============================================================ */

const settingsModule = window.BioCommandSettings.createSettingsModule({
  Storage,
  saveDB,
  renderCommand,
  computeStrain,
  readColors,
  getDB: () => DB,
  getColors: () => COLORS,
  setColors: (c) => { COLORS = c; }
});
settingsModule.init();

/* ============================================================
   DASHBOARD / TODAY VIEW (extracted into js/modules/dashboard/index.js)
   Scoring engine, chart primitives, genId/armDangerButton, meanOf,
   etc. still live in this file pending the shared-utilities
   extraction; Dashboard receives them all as injected dependencies,
   exactly like Fuel/Training/Journal/Biomarkers/Protocols already do.
   ============================================================ */

const dashboardModule = window.BioCommandDashboard.createDashboardModule({
  dayKey,
  saveDB,
  fmtMin,
  clamp01,
  hexToRgba,
  bandColor,
  bandName,
  baselineFor,
  computeScores,
  meanOf,
  loadAI: settingsModule.loadAI,
  sparkLine,
  sparkBars,
  bigLine,
  bigBars,
  bigStacked,
  renderJournal,
  renderTabBadges,
  getDB: () => DB,
  getColors: () => COLORS
});
dashboardModule.init();

function renderCommand() {
  dashboardModule.render();
}
function openDetail(key) {
  dashboardModule.openDetail(key);
}
function closeDetail() {
  dashboardModule.closeDetail();
}

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
   ADVISOR KEY BOOT GLUE (SYS)
   The AI key storage (loadAI/saveAI) now lives in Settings, and the
   brief-generation UI (Today) lives in Dashboard. This glue stays
   here because wiring it into either module directly would create a
   cycle: Dashboard already depends on Settings for loadAI, so
   Settings calling back into Dashboard's setAdvisorStatus would
   depend on Dashboard in turn.
   ============================================================ */

document.getElementById("btn-save-ai").addEventListener("click", () => {
  const key = document.getElementById("ai-key").value.trim();
  const st = document.getElementById("advisor-key-status");
  if (!key) { st.textContent = "ENTER A KEY FIRST"; st.style.color = COLORS.red; return; }
  settingsModule.saveAI({ key: key });
  st.textContent = "KEY SAVED ON DEVICE"; st.style.color = COLORS.green;
  dashboardModule.setAdvisorStatus("READY");
});

(function initAdvisor() {
  const cfg = settingsModule.loadAI();
  if (cfg && cfg.key) {
    document.getElementById("ai-key").value = cfg.key;
    dashboardModule.setAdvisorStatus("READY");
    const cached = DB.briefings[dayKey()];
    if (cached) { dashboardModule.showBrief(cached); }
  } else {
    dashboardModule.setAdvisorStatus("SET KEY IN SYS");
  }
})();

/* ============================================================
   DATA MANAGEMENT (extracted into js/modules/data-management/index.js)
   ============================================================ */

const dataManagementModule = window.BioCommandDataManagement.createDataManagementModule({
  Storage,
  DB_KEY,
  emptyDB,
  dayKey,
  saveDB,
  armDangerButton,
  renderCommand,
  getDB: () => DB,
  setDB: (newDB) => { DB = newDB; },
  getColors: () => COLORS
});
dataManagementModule.init();

function renderDataCard() {
  dataManagementModule.render();
}

/* ============================================================
   SHELL: tabs, SYS, header, theme
   ============================================================ */

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
  loadAI: settingsModule.loadAI,
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

const journalModule = window.BioCommandJournal.createJournalModule({
  dayKey,
  saveDB,
  meanOf,
  getDB: () => DB,
  getColors: () => COLORS
});
journalModule.init();

function renderJournal() {
  journalModule.render();
}
function renderJournalProto() {
  journalModule.renderProto();
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

const biomarkersModule = window.BioCommandBiomarkers.createBiomarkersModule({
  dayKey,
  saveDB,
  loadAI: settingsModule.loadAI,
  hexToRgba,
  bigLine,
  getDB: () => DB,
  getColors: () => COLORS
});
biomarkersModule.init();

function renderMarkerList() {
  biomarkersModule.render();
}

/* ============================================================
   PROTOCOL MODULE
   scheduleMask bit 0 = Monday ... bit 6 = Sunday. Streaks count
   consecutive scheduled days completed, working backward from
   today. The correlation line compares average Recovery on days
   a directive was completed vs not, once there is enough of
   both to say anything meaningful (3+ each).
   ============================================================ */

/* ============================================================
   PROTOCOL MODULE (extracted into js/modules/protocols/index.js)
   weekdayBit stays here: Notifications and Tab Badges (not yet
   extracted) also depend on it.
   ============================================================ */

function weekdayBit(date) {
  const d = date.getDay(); // 0 Sun .. 6 Sat
  return d === 0 ? 6 : d - 1; // Mon=0 .. Sun=6
}

const protocolsModule = window.BioCommandProtocols.createProtocolsModule({
  dayKey,
  saveDB,
  genId,
  armDangerButton,
  meanOf,
  weekdayBit,
  getDB: () => DB,
  getColors: () => COLORS
});
protocolsModule.init();

function renderProtocolList() {
  protocolsModule.render();
}

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
settingsModule.render();
renderDataCard();
renderCloudCard();
renderNotifCard();
trainingModule.seedDefaultWorkouts();
renderJournal();
initSupabase();
initServiceWorker();
renderTabBadges();
settingsModule.applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
if (loadSyncConfig() && (loadSyncConfig() || {}).pass) {
  syncNow();
}
