"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - Storage / DB_KEY — the storage.js adapter and its DB key,
 *   destructured once in app.js and never reassigned.
 * - dayKey() / computeScores() — computeScores still defined in
 *   app.js (Scoring Engines), pending the shared-utilities extraction.
 * - renderCommand() / renderJournal() — cross-module render calls
 *   this module triggers after a Garmin feed sync or a cloud pull.
 * - getDB() / getColors() — read accessors, and setDB() — a write
 *   callback — because DB is reassigned wholesale by a cloud pull
 *   merge (this module *is* one of the reassignment sources; every
 *   other module's getDB() picks up the new value automatically).
 *
 * Exposes getSB/getCurrentUser beyond init/render because the
 * Notifications code (not yet extracted) registers push
 * subscriptions against the same Supabase client and signed-in user.
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
  function createSyncModule({ Storage, DB_KEY, dayKey, computeScores, saveDB, renderCommand, renderJournal, renderDataCard, getDB, setDB, getColors }) {
    const SYNC_KEY = "biocommand.sync";
    const SB_CONFIG_KEY = "biocommand.supabase";
    const CLOUD_SYNC_KEY = "biocommand.cloudsync";

    let _supabaseClient = null;
    let _currentUser = null;
    let _syncTimer = null;

    /* ---------- Garmin Uplink (silent auto-sync; header dot reports state) ---------- */

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
      const DB = getDB();
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
        const merged = { ...remote };
        if (localRecent.telemetry) merged.telemetry = { ...merged.telemetry, ...localRecent.telemetry };
        // Ensure migrations
        merged.journal = merged.journal || {};
        merged.fuelLog = merged.fuelLog || [];
        merged.briefings = merged.briefings || {};
        merged.workouts = merged.workouts || [];
        merged.sessions = merged.sessions || [];
        merged.seededWorkouts = merged.seededWorkouts || false;
        setDB(merged);
        Storage.set(DB_KEY, JSON.stringify(merged));
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
        cfg.pass = document.getElementById("up-pass").value;
        saveSyncConfig(cfg);
        renderUplink();
        setUplinkStatus("Saved. Auto-sync runs each time the app opens.", "ok");
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
      getSB, getCurrentUser: () => _currentUser,
      enqueueCloudSync
    };
  }

  global.BioCommandSync = { createSyncModule };
})(window);
