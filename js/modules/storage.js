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
        if (persistent) return window.localStorage.getItem(key);
        return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
      },
      set(key, value) {
        if (persistent) window.localStorage.setItem(key, value);
        else mem[key] = value;
      },
      remove(key) {
        if (persistent) window.localStorage.removeItem(key);
        else delete mem[key];
      }
    };
  })();

  const DB_KEY = "biocommand.db.v1";

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

  function loadDB() {
    const raw = Storage.get(DB_KEY);
    if (!raw) return emptyDB();
    try {
      const db = JSON.parse(raw);
      if (db && db.version === 1) {
        db.briefings = db.briefings || {};
        db.workouts = db.workouts || [];
        db.sessions = db.sessions || [];
        db.journal = db.journal || {};
        db.fuelLog = db.fuelLog || [];
        if (db.operator && db.operator.maxHR === undefined) db.operator.maxHR = null;
        if (db.seededWorkouts === undefined) db.seededWorkouts = false;
        return db;
      }
      return emptyDB();
    } catch (e) {
      return emptyDB();
    }
  }

  function saveDB(db, options) {
    Storage.set(DB_KEY, JSON.stringify(db));
    const callbacks = options && options.onPersist ? options.onPersist : [];
    callbacks.forEach((cb) => cb(db));
    return db;
  }

  global.BioCommandStorage = {
    Storage,
    DB_KEY,
    emptyDB,
    loadDB,
    saveDB
  };
})(window);
