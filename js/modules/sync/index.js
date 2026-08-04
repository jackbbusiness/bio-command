"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - Storage / DB_KEY — the storage.js adapter and its DB key,
 *   destructured once in app.js and never reassigned.
 * - dayKey() / computeScores() — computeScores still defined in
 *   app.js (Scoring Engines), pending the shared-utilities extraction.
 * - renderCommand() / renderJournal() — cross-module render calls
 *   this module triggers after a Garmin feed sync or a cloud pull.
 * - showStorageBanner() — app.js's storage banner (added for the
 *   corrupted-DB/quota/volatile-storage warnings); reused here,
 *   informational tone, to surface when a cloud pull had to resolve
 *   a genuine conflict (same record edited on two unsynced devices)
 *   rather than resolving it silently.
 * - getDB() / getColors() — read accessors, and setDB() — a write
 *   callback — because DB is reassigned wholesale by a cloud pull
 *   merge (this module *is* one of the reassignment sources; every
 *   other module's getDB() picks up the new value automatically).
 *
 * Exposes getSB/getCurrentUser beyond init/render because the
 * Notifications code (not yet extracted) registers push
 * subscriptions against the same Supabase client and signed-in user.
 * Also exposes hasPassphrase() so app.js's boot sequence can decide
 * whether to auto-run syncNow() without reading the passphrase
 * itself (see the Garmin Uplink section below for why the
 * passphrase lives in sessionStorage, not the persisted config).
 *
 * Note: _originalSaveDB/_saveThenSync below are moved verbatim from
 * the original code — they look like an abandoned attempt to wrap
 * saveDB() with a cloud-sync side effect that was never actually
 * wired in (saveDB is never reassigned to _saveThenSync anywhere).
 * Cloud sync instead runs through the separate enqueueCloudSync()
 * call already present in app.js's saveDB(). Left as dead code
 * exactly as found; flagged here rather than removed, since deleting
 * it is a cleanup beyond the scope of this extraction.
 */
(function (global) {
  function createSyncModule({ Storage, DB_KEY, dayKey, computeScores, saveDB, renderCommand, renderJournal, renderDataCard, showStorageBanner, getDB, setDB, getColors }) {
    const SYNC_KEY = "biocommand.sync";
    const SYNC_PASS_KEY = "biocommand.sync.pass";
    const SB_CONFIG_KEY = "biocommand.supabase";
    const CLOUD_SYNC_KEY = "biocommand.cloudsync";

    let _supabaseClient = null;
    let _currentUser = null;
    let _syncTimer = null;

    /* ---------- Garmin Uplink (silent auto-sync; header dot reports state) ----------
       The passphrase is deliberately NOT part of the persisted config:
       it's the sole protection for telemetry that lives forever in a
       public git repo (see garmin_sync.py), so storing it in
       localStorage would mean any future XSS -- on this origin, ever
       -- could read it and decrypt the entire historical feed, not
       just current data. It's kept in sessionStorage instead: still
       readable by JS on this page (no client-side storage is safe
       against an active XSS), but scoped to the current tab and gone
       when it closes, rather than living on disk indefinitely. The
       tradeoff: the passphrase must be re-entered once per browser
       session for auto-sync to run; url/lastSync (non-secret) are
       unaffected and still persist normally. */

    function loadSyncConfig() {
      let cfg;
      try { cfg = JSON.parse(Storage.get(SYNC_KEY)) || null; }
      catch (e) { cfg = null; }
      if (cfg && cfg.pass !== undefined) {
        // One-time migration: strip and discard any passphrase persisted
        // by a previous version of this app rather than carrying it
        // forward on disk.
        delete cfg.pass;
        Storage.set(SYNC_KEY, JSON.stringify(cfg));
      }
      return cfg;
    }
    function saveSyncConfig(cfg) {
      const toStore = { url: cfg.url, lastSync: cfg.lastSync };
      Storage.set(SYNC_KEY, JSON.stringify(toStore));
    }

    function loadPassphrase() {
      try { return window.sessionStorage.getItem(SYNC_PASS_KEY) || ""; }
      catch (e) { return ""; }
    }
    function savePassphrase(pass) {
      try {
        if (pass) window.sessionStorage.setItem(SYNC_PASS_KEY, pass);
        else window.sessionStorage.removeItem(SYNC_PASS_KEY);
      } catch (e) { /* sessionStorage unavailable; passphrase just won't persist across renders */ }
    }

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
      const DB = getDB();
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
      const COLORS = getColors();
      const el = document.getElementById("uplink-status");
      el.textContent = msg;
      el.style.color = tone === "err" ? COLORS.red
                     : tone === "ok" ? COLORS.green : "";
    }

    async function syncNow() {
      const DB = getDB();
      const cfg = loadSyncConfig();
      const pass = loadPassphrase();
      if (!cfg || !pass) {
        setUplinkStatus("Uplink not configured. Enter the passphrase and save.", "err");
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
        payload = await decryptFeed(blob, pass);
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
      document.getElementById("up-pass").value = loadPassphrase();
      const last = document.getElementById("uplink-last");
      last.textContent = cfg && cfg.lastSync
        ? "LAST " + cfg.lastSync.slice(5, 16).replace("T", " ")
        : "";
    }

    /* ---------- Supabase Cloud Sync ----------
       Strategy: localStorage is primary (fast, offline). Supabase
       is the cloud backup. On every saveDB, we enqueue a cloud push.
       On app open, we pull from cloud and merge. */

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

    /* ---------- Cloud pull merge ----------
       A pull used to take the remote row as the base and discard
       everything local except today's telemetry -- meaning any
       local-only session, workout, protocol, fuel log entry, journal
       day, or biomarker log that hadn't been pushed yet was silently
       destroyed on every pull (which runs automatically on every app
       open with a signed-in session). These merge* helpers replace
       that with a union merge per DB.v1 field, so pulling can no
       longer make local-only data disappear:
         - id-keyed and value-only arrays (sessions, workouts,
           protocols, mealTemplates, plannedMeals, biomarkerLogs,
           fuelLog): unioned. An id present on only one side is kept
           as-is; genId()'s timestamp+random suffix makes a genuine
           same-id-different-content collision between independently
           generated records practically impossible, so "local wins
           on same id" is a safety net, not the normal path.
         - telemetry (day -> row): merged per day by comparing each
           row's existing updatedAt field, newest wins.
         - completions (day -> directiveId -> completion): merged per
           directive by its existing loggedAt field, newest wins.
         - journal (day -> {answers, note}): merged per day; answers
           are unioned per question key (local wins a same-question
           conflict), note prefers whichever side is non-empty, local
           on both-non-empty conflict.
         - markers, fuelPlans, briefings (all day/code/week -> value):
           unioned, local wins a same-key conflict.
         - operator (a single settings object, not keyed): local wins
           wholesale if it differs from remote at all -- this also
           fixes a related bug where a just-changed profile setting
           could be silently reverted by the next pull.
         - seededWorkouts: true if either side is true.
       Every merge function returns how many genuine same-key
       conflicts it resolved (both sides had the key with different
       content), so the caller can tell the user when that happened
       rather than resolving it invisibly. This is still not a full
       bidirectional CRDT -- a same-record edit made offline on two
       different devices before either syncs will have one side's
       edit kept and the other discarded for that one record -- but
       it replaces "always lose everything unsynced" with "at worst,
       lose the specific field that was edited on both sides at once,
       and be told about it." */

    function mergeArray(localArr, remoteArr) {
      const remote = remoteArr || [];
      const local = localArr || [];
      const byId = {};
      const noId = [];
      const noIdSeen = new Set();
      remote.forEach((item) => {
        if (item && item.id != null) byId[item.id] = item;
        else { noId.push(item); noIdSeen.add(JSON.stringify(item)); }
      });
      let conflicts = 0;
      local.forEach((item) => {
        if (item && item.id != null) {
          if (byId[item.id] !== undefined && JSON.stringify(byId[item.id]) !== JSON.stringify(item)) conflicts++;
          byId[item.id] = item;
        } else {
          const key = JSON.stringify(item);
          if (!noIdSeen.has(key)) { noId.push(item); noIdSeen.add(key); }
        }
      });
      return { merged: Object.values(byId).concat(noId), conflicts };
    }

    function mergeByField(localMap, remoteMap, timeField) {
      const merged = { ...(remoteMap || {}) };
      let conflicts = 0;
      Object.keys(localMap || {}).forEach((k) => {
        const localRow = localMap[k];
        if (!(k in merged)) { merged[k] = localRow; return; }
        const remoteRow = merged[k];
        if (JSON.stringify(localRow) === JSON.stringify(remoteRow)) return;
        conflicts++;
        const lt = localRow && localRow[timeField] ? Date.parse(localRow[timeField]) : 0;
        const rt = remoteRow && remoteRow[timeField] ? Date.parse(remoteRow[timeField]) : 0;
        if (lt >= rt) merged[k] = localRow;
      });
      return { merged, conflicts };
    }

    function mergeUnionPreferLocal(localMap, remoteMap) {
      const merged = { ...(remoteMap || {}) };
      let conflicts = 0;
      Object.keys(localMap || {}).forEach((k) => {
        if (!(k in merged)) { merged[k] = localMap[k]; return; }
        if (JSON.stringify(localMap[k]) !== JSON.stringify(merged[k])) {
          conflicts++;
          merged[k] = localMap[k];
        }
      });
      return { merged, conflicts };
    }

    function mergeCompletions(localC, remoteC) {
      const merged = { ...(remoteC || {}) };
      let conflicts = 0;
      Object.keys(localC || {}).forEach((day) => {
        const localDay = localC[day] || {};
        if (!merged[day]) { merged[day] = localDay; return; }
        const mergedDay = { ...merged[day] };
        Object.keys(localDay).forEach((directiveId) => {
          const localEntry = localDay[directiveId];
          const remoteEntry = mergedDay[directiveId];
          if (!remoteEntry) { mergedDay[directiveId] = localEntry; return; }
          if (JSON.stringify(localEntry) === JSON.stringify(remoteEntry)) return;
          conflicts++;
          const lt = localEntry && localEntry.loggedAt ? Date.parse(localEntry.loggedAt) : 0;
          const rt = remoteEntry && remoteEntry.loggedAt ? Date.parse(remoteEntry.loggedAt) : 0;
          if (lt >= rt) mergedDay[directiveId] = localEntry;
        });
        merged[day] = mergedDay;
      });
      return { merged, conflicts };
    }

    function mergeJournal(localJ, remoteJ) {
      const merged = { ...(remoteJ || {}) };
      let conflicts = 0;
      Object.keys(localJ || {}).forEach((day) => {
        const localEntry = localJ[day] || {};
        const remoteEntry = merged[day];
        if (!remoteEntry) { merged[day] = localEntry; return; }
        if (JSON.stringify(localEntry) === JSON.stringify(remoteEntry)) return;
        conflicts++;
        merged[day] = {
          answers: { ...(remoteEntry.answers || {}), ...(localEntry.answers || {}) },
          note: localEntry.note || remoteEntry.note || ""
        };
      });
      return { merged, conflicts };
    }

    function mergeDB(local, remote) {
      let conflicts = 0;
      const count = (n) => { conflicts += n; };

      const telemetry = mergeByField(local.telemetry, remote.telemetry, "updatedAt");
      count(telemetry.conflicts);
      const completions = mergeCompletions(local.completions, remote.completions);
      count(completions.conflicts);
      const journal = mergeJournal(local.journal, remote.journal);
      count(journal.conflicts);
      const markers = mergeUnionPreferLocal(local.markers, remote.markers);
      count(markers.conflicts);
      const fuelPlans = mergeUnionPreferLocal(local.fuelPlans, remote.fuelPlans);
      count(fuelPlans.conflicts);
      const briefings = mergeUnionPreferLocal(local.briefings, remote.briefings);
      count(briefings.conflicts);

      const biomarkerLogs = mergeArray(local.biomarkerLogs, remote.biomarkerLogs);
      count(biomarkerLogs.conflicts);
      const mealTemplates = mergeArray(local.mealTemplates, remote.mealTemplates);
      count(mealTemplates.conflicts);
      const plannedMeals = mergeArray(local.plannedMeals, remote.plannedMeals);
      count(plannedMeals.conflicts);
      const workouts = mergeArray(local.workouts, remote.workouts);
      count(workouts.conflicts);
      const sessions = mergeArray(local.sessions, remote.sessions);
      count(sessions.conflicts);
      const protocols = mergeArray(local.protocols, remote.protocols);
      count(protocols.conflicts);
      const fuelLog = mergeArray(local.fuelLog, remote.fuelLog);
      count(fuelLog.conflicts);

      const operatorDiffers = JSON.stringify(local.operator) !== JSON.stringify(remote.operator);
      if (operatorDiffers) count(1);

      const merged = {
        ...remote,
        operator: local.operator || remote.operator,
        telemetry: telemetry.merged,
        markers: markers.merged,
        biomarkerLogs: biomarkerLogs.merged,
        fuelPlans: fuelPlans.merged,
        mealTemplates: mealTemplates.merged,
        plannedMeals: plannedMeals.merged,
        workouts: workouts.merged,
        sessions: sessions.merged,
        protocols: protocols.merged,
        completions: completions.merged,
        briefings: briefings.merged,
        journal: journal.merged,
        fuelLog: fuelLog.merged,
        seededWorkouts: !!(local.seededWorkouts || remote.seededWorkouts)
      };
      return { merged, conflicts };
    }

    async function cloudPush() {
      const DB = getDB();
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
      const local = getDB();
      const sb = getSB();
      if (!sb || !_currentUser) return false;
      try {
        const { data, error } = await sb.from("operator_data")
          .select("data, synced_at").eq("user_id", _currentUser.id).single();
        if (error || !data) return false;
        const remote = data.data;
        if (!remote || remote.version !== 1) return false;

        const { merged, conflicts } = mergeDB(local, remote);
        setDB(merged);
        // saveDB (not a raw Storage.set) so the merge result gets the
        // same quota/corruption handling and briefing pruning as any
        // other write, and so it's queued straight back to the cloud
        // -- harmless (the union is idempotent) and means the next
        // device to pull sees this merge instead of re-deriving it.
        saveDB(merged);

        if (conflicts > 0 && showStorageBanner) {
          showStorageBanner(
            "Cloud sync merged data from another device. " + conflicts +
            " item(s) had conflicting edits made on both before they synced; " +
            "this device's version was kept for those.",
            "warn"
          );
        }
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

    function init() {
      document.getElementById("btn-save-uplink").addEventListener("click", () => {
        const cfg = loadSyncConfig() || {};
        cfg.url = document.getElementById("up-url").value.trim();
        saveSyncConfig(cfg);
        savePassphrase(document.getElementById("up-pass").value);
        renderUplink();
        setUplinkStatus("Saved. The passphrase is kept for this browser session only, so auto-sync runs on reload here but will need re-entering next time you open the app.", "ok");
      });

      document.getElementById("btn-sync").addEventListener("click", syncNow);

      document.getElementById("btn-sb-save").addEventListener("click", async () => {
        const COLORS = getColors();
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
        const COLORS = getColors();
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
    }

    function render() {
      renderUplink();
      renderCloudCard();
    }

    return {
      init, render,
      renderUplink, renderCloudCard,
      loadSyncConfig, syncNow, initSupabase,
      hasPassphrase: () => !!loadPassphrase(),
      getSB, getCurrentUser: () => _currentUser,
      enqueueCloudSync
    };
  }

  global.BioCommandSync = { createSyncModule };
})(window);
