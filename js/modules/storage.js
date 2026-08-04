"use strict";

(function (global) {
  const Storage = (() => {
    let mem = {};
    let persistent = false;
    try {
      const k = "__bc_probe__";
      window.localStorage.setItem(k, "1");
      window.localStorage.removeItem(k);
      persistent = true;
    } catch (e) {
      persistent = false;
    }
    return {
      persistent,
      get(key) {
        try {
          if (persistent) return window.localStorage.getItem(key);
          return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
        } catch (e) {
          return null;
        }
      },
      /* Never throws. Returns { ok: true } or { ok: false, error } so
         callers (saveDB below) can surface a quota/storage failure to
         the user instead of losing the write silently. */
      set(key, value) {
        try {
          if (persistent) window.localStorage.setItem(key, value);
          else mem[key] = value;
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e };
        }
      },
      remove(key) {
        try {
          if (persistent) window.localStorage.removeItem(key);
          else delete mem[key];
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e };
        }
      }
    };
  })();

  const DB_KEY = "biocommand.db.v1";
  const DB_CORRUPTED_BACKUP_KEY = DB_KEY + ".corrupted";

  // AI briefing text is appended once per day (Dashboard's generateBriefing)
  // with nothing that ever removes an old entry, so DB.briefings grows by
  // one text blob per active day forever. Retention is capped at 90 days
  // (roughly one quarter -- matches the "90 Day" range already offered
  // elsewhere in the app) so a long-time user's DB doesn't grow without
  // bound purely from this one field.
  const BRIEFING_RETENTION_DAYS = 90;

  function pruneBriefings(db) {
    if (!db || !db.briefings || typeof db.briefings !== "object") return;
    const keys = Object.keys(db.briefings);
    if (keys.length <= BRIEFING_RETENTION_DAYS) return;
    // Briefing keys are dayKey() strings ("YYYY-MM-DD"), which sort
    // lexicographically in chronological order -- reverse for newest-first.
    keys.sort().reverse().slice(BRIEFING_RETENTION_DAYS).forEach((k) => {
      delete db.briefings[k];
    });
  }

  function emptyDB() {
    return {
      version: 1,
      operator: {
        callsign: "OPERATOR",
        usesMetric: true,
        baselineWindowDays: 30,
        targetSleepMinutes: 450,
        targetBodyMassKg: null,
        targetProteinPerKg: 2.0,
        maxHR: null,
        createdAt: new Date().toISOString()
      },
      telemetry: {},
      markers: {},
      biomarkerLogs: [],
      fuelPlans: {},
      mealTemplates: [],
      plannedMeals: [],
      workouts: [],
      sessions: [],
      protocols: [],
      completions: {},
      briefings: {},
      journal: {},
      fuelLog: [],
      seededWorkouts: false
    };
  }

  /* Returns { db, status, backupKey }.
     status is one of:
       "empty"     — no stored value; a genuinely fresh install.
       "ok"        — loaded and parsed correctly.
       "corrupted" — a stored value existed but could not be used
                     (unparseable JSON, or not the expected shape).
                     The raw value is preserved under backupKey
                     (best-effort) rather than discarded, and db is
                     emptyDB() so the app can still function -- but
                     the caller is expected to surface this to the
                     user rather than proceeding as if nothing
                     happened. Never silently treat corrupted data as
                     "no data". */
  function loadDB() {
    const raw = Storage.get(DB_KEY);
    if (!raw) return { db: emptyDB(), status: "empty" };
    try {
      const db = JSON.parse(raw);
      if (db && typeof db === "object" && db.version === 1) {
        db.briefings = db.briefings || {};
        db.workouts = db.workouts || [];
        db.sessions = db.sessions || [];
        db.journal = db.journal || {};
        db.fuelLog = db.fuelLog || [];
        if (db.operator && db.operator.maxHR === undefined) db.operator.maxHR = null;
        if (db.seededWorkouts === undefined) db.seededWorkouts = false;
        return { db, status: "ok" };
      }
      Storage.set(DB_CORRUPTED_BACKUP_KEY, raw);
      return { db: emptyDB(), status: "corrupted", backupKey: DB_CORRUPTED_BACKUP_KEY };
    } catch (e) {
      Storage.set(DB_CORRUPTED_BACKUP_KEY, raw);
      return { db: emptyDB(), status: "corrupted", backupKey: DB_CORRUPTED_BACKUP_KEY };
    }
  }

  /* Never throws. On a serialize or storage failure, calls
     options.onError({ type, error }) so the caller can warn the user
     that this save did not persist -- the in-memory db is unaffected
     either way, so the app keeps working for the rest of the
     session; only durability across reloads is at risk. */
  function saveDB(db, options) {
    const opts = options || {};
    const callbacks = opts.onPersist || [];
    pruneBriefings(db);
    let json;
    try {
      json = JSON.stringify(db);
    } catch (e) {
      if (opts.onError) opts.onError({ type: "serialize", error: e });
      callbacks.forEach((cb) => cb(db));
      return db;
    }
    const result = Storage.set(DB_KEY, json);
    if (!result.ok && opts.onError) opts.onError({ type: "quota", error: result.error });
    callbacks.forEach((cb) => cb(db));
    return db;
  }

  global.BioCommandStorage = {
    Storage,
    DB_KEY,
    DB_CORRUPTED_BACKUP_KEY,
    BRIEFING_RETENTION_DAYS,
    emptyDB,
    loadDB,
    saveDB,
    pruneBriefings
  };
})(window);
