"use strict";

/* ============================================================
   STORAGE ADAPTER (extracted module)
   ============================================================ */

const { Storage, DB_KEY, DB_CORRUPTED_BACKUP_KEY, emptyDB, loadDB } = window.BioCommandStorage;

function saveDB(db) {
  window.BioCommandStorage.saveDB(db, {
    onPersist: [() => {
      renderDataCard();
      enqueueCloudSync();
      window.dispatchEvent(new CustomEvent("biocommand:data-changed"));
    }],
    onError: (info) => {
      showStorageBanner(
        info.type === "quota"
          ? "Your device storage is full. This change was NOT saved. Free up space, then export a backup from SYS as soon as possible."
          : "This change could not be saved due to a storage error. Your data may be at risk -- export a backup from SYS as soon as possible.",
        "error"
      );
    }
  });
}

const dbLoadResult = loadDB();
let DB = dbLoadResult.db;

/* ============================================================
   STORAGE BANNER
   A single sticky bar (hidden by default) used for the three cases
   where data could be silently lost or already has been: a corrupted
   DB found at boot, a save that failed to persist (quota/storage
   error), and non-persistent storage (private browsing, storage
   blocked, etc). Dismissing it hides it for the rest of this page
   load; it is re-evaluated fresh on every boot, so a still-true
   volatile-storage warning reappears next load.
   ============================================================ */

function showStorageBanner(message, tone, actionLabel, onAction) {
  const banner = document.getElementById("storage-banner");
  const msgEl = document.getElementById("storage-banner-msg");
  const actionEl = document.getElementById("storage-banner-action");
  msgEl.textContent = message;
  banner.className = "storage-banner" + (tone === "error" ? " tone-error" : "");
  if (actionLabel && onAction) {
    actionEl.textContent = actionLabel;
    actionEl.hidden = false;
    actionEl.onclick = onAction;
  } else {
    actionEl.hidden = true;
    actionEl.onclick = null;
  }
  banner.hidden = false;
}

function hideStorageBanner() {
  document.getElementById("storage-banner").hidden = true;
}

document.getElementById("storage-banner-dismiss").addEventListener("click", hideStorageBanner);

function downloadCorruptedBackup() {
  const raw = Storage.get(DB_CORRUPTED_BACKUP_KEY);
  if (!raw) return;
  const blob = new Blob([raw], { type: "application/octet-stream" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "biocommand-corrupted-" + Date.now() + ".txt";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============================================================
   SHARED UTILITIES (js/modules/shared/*.js)
   Pure helpers (no DB/COLORS dependency) are destructured directly.
   Helpers that read the current DB or COLORS are built via small
   factories so they always see live state after import/reset/cloud
   sync (DB) or a theme change (COLORS) -- the same accessor pattern
   every feature module already uses.
   ============================================================ */

const { dayKey, weekdayBit } = window.BioCommandShared.dates;
const { fmtMin, clamp01, meanOf } = window.BioCommandShared.formatting;
const { armDangerButton } = window.BioCommandShared.dom;
const { genId } = window.BioCommandShared.ids;
const { hexToRgba, readColors } = window.BioCommandShared.colors;
const { escapeHtml } = window.BioCommandShared.sanitize;
const { initOverlayFocusManagement } = window.BioCommandShared.focusTrap;
const { createScoreRing } = window.BioCommandShared.scoreRing;
const { wireStepper } = window.BioCommandShared.stepper;
const { showToast } = window.BioCommandShared.toast;
const { createAdvisor, createBrowserAnthropicTransport, appendToken } = window.BioCommandShared.aiStream;

let COLORS = readColors();

const { bandColor, bandName } = window.BioCommandShared.colors.createColorHelpers({
  getColors: () => COLORS
});
const { sparkLine, sparkBars, bigLine, bigBars, bigStacked, bigMultiLine, wireChartTooltip } = window.BioCommandShared.charts.createChartHelpers({
  getColors: () => COLORS,
  hexToRgba,
  clamp01
});
const { baselineFor, computeStrain, computeScores } = window.BioCommandShared.scoring.createScoringHelpers({
  getDB: () => DB,
  clamp01
});

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
   AI ADVISOR (js/modules/shared/ai-stream.js)
   One shared transport-neutral instance: every module that wants an
   AI response (Dashboard now; Fuel/Biomarkers/History in later
   phases) calls advisor.ask(...) rather than fetching Anthropic
   directly. Swapping the transport later (e.g. to a Supabase Edge
   Function proxy) is a one-line change here, not a per-module rewrite.
   ============================================================ */

const advisorTransport = createBrowserAnthropicTransport({
  getApiKey: () => { const cfg = settingsModule.loadAI(); return cfg && cfg.key; }
});
const advisor = createAdvisor({ transport: advisorTransport });

/* ============================================================
   DASHBOARD / TODAY VIEW (extracted into js/modules/dashboard/index.js)
   pullLatest/getUpcomingWorkout are lazy accessors into syncModule/
   trainingModule, both constructed later in this file -- safe
   because they're only ever called from a user gesture, well after
   the whole file (and both modules) have finished loading, same
   pattern as getDB/getColors below.
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
  sparkLine,
  sparkBars,
  bigLine,
  bigBars,
  bigStacked,
  renderJournal,
  renderTabBadges,
  createScoreRing,
  advisor,
  appendToken,
  pullLatest: () => syncModule.pullLatest(),
  getUpcomingWorkout: () => trainingModule.getUpcomingWorkout(),
  showToast,
  getDB: () => DB,
  getColors: () => COLORS
});
dashboardModule.init();

function renderCommand() {
  dashboardModule.render();
}

/* ============================================================
   SYNC (Garmin Uplink + Supabase Cloud) — extracted into
   js/modules/sync/index.js
   enqueueCloudSync stays as a bare wrapper here since saveDB()
   above calls it on every persist. getSB/getCurrentUser are passed
   directly into the Notifications module below instead, since
   Notifications is the only other caller.
   ============================================================ */

const syncModule = window.BioCommandSync.createSyncModule({
  Storage,
  DB_KEY,
  dayKey,
  computeScores,
  saveDB,
  renderCommand,
  renderJournal,
  renderDataCard,
  showStorageBanner,
  getDB: () => DB,
  setDB: (newDB) => { DB = newDB; },
  getColors: () => COLORS
});
syncModule.init();

function enqueueCloudSync() {
  syncModule.enqueueCloudSync();
}
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
   ============================================================ */

const trainingModule = window.BioCommandTraining.createTrainingModule({
  dayKey,
  saveDB,
  genId,
  armDangerButton,
  computeScores,
  renderCommand,
  escapeHtml,
  wireStepper,
  createScoreRing,
  hexToRgba,
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
  armDangerButton,
  escapeHtml,
  advisor,
  appendToken,
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
  escapeHtml,
  createScoreRing,
  hexToRgba,
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
  hexToRgba,
  bigLine,
  escapeHtml,
  advisor,
  appendToken,
  getDB: () => DB,
  getColors: () => COLORS
});
biomarkersModule.init();

function renderMarkerList() {
  biomarkersModule.render();
}

/* ============================================================
   PROTOCOL MODULE (extracted into js/modules/protocols/index.js)
   scheduleMask bit 0 = Monday ... bit 6 = Sunday. Streaks count
   consecutive scheduled days completed, working backward from
   today. The correlation line compares average Recovery on days
   a directive was completed vs not, once there is enough of
   both to say anything meaningful (3+ each).
   ============================================================ */

const protocolsModule = window.BioCommandProtocols.createProtocolsModule({
  dayKey,
  saveDB,
  genId,
  armDangerButton,
  meanOf,
  weekdayBit,
  escapeHtml,
  getDB: () => DB,
  getColors: () => COLORS
});
protocolsModule.init();

function renderProtocolList() {
  protocolsModule.render();
}

/* ============================================================
   NOTIFICATIONS (extracted into js/modules/notifications/index.js)
   ============================================================ */

const notificationsModule = window.BioCommandNotifications.createNotificationsModule({
  dayKey,
  weekdayBit,
  getSB: syncModule.getSB,
  getCurrentUser: syncModule.getCurrentUser,
  getDB: () => DB,
  getColors: () => COLORS
});
notificationsModule.init();

function renderNotifCard() {
  notificationsModule.render();
}
function initServiceWorker() {
  return notificationsModule.initServiceWorker();
}

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
  document.getElementById("hdr-date-text").textContent =
    String(now.getDate()).padStart(2, "0") + " " + months[now.getMonth()];
})();

initOverlayFocusManagement();

/* ============================================================
   BOOT
   ============================================================ */

if (dbLoadResult.status === "corrupted") {
  showStorageBanner(
    "Your saved data could not be read and could not be recovered automatically. A raw copy of what was found has been kept so you can attempt manual recovery or share it for support. Starting from an empty store for now.",
    "error",
    "Download raw backup",
    downloadCorruptedBackup
  );
} else if (!Storage.persistent) {
  showStorageBanner(
    "This browser is not saving data between visits (private browsing, or storage is blocked). Anything you log now will be LOST when you close or reload this page.",
    "warn"
  );
}

syncModule.renderUplink();
settingsModule.render();
renderDataCard();
syncModule.renderCloudCard();
renderNotifCard();
trainingModule.seedDefaultWorkouts();
renderJournal();
syncModule.initSupabase();
initServiceWorker();
renderTabBadges();
settingsModule.applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
if (syncModule.loadSyncConfig() && syncModule.hasPassphrase()) {
  syncModule.syncNow();
}
