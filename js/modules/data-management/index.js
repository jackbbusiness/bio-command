"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - Storage / DB_KEY / emptyDB — the storage.js adapter and its
 *   constants, destructured once in app.js and never reassigned.
 * - dayKey() / saveDB() / armDangerButton() / renderCommand() —
 *   armDangerButton still defined in app.js pending the
 *   shared-utilities extraction.
 * - getDB() / getColors() — read accessors, and setDB() — a write
 *   callback — because DB is reassigned wholesale by both import and
 *   wipe (this module *is* the reassignment source; every other
 *   module's getDB() picks up the new value automatically since they
 *   all close over the same app.js-level DB binding).
 */
(function (global) {
  const DB_BACKUP_SUFFIX = ".backup";

  // Object- and array-typed top-level fields, per storage.js's emptyDB().
  // A field missing from an imported file is fine (existing code already
  // defaults several of these); a field present with the wrong TYPE means
  // the file is not a Bio-Command export and is rejected before it ever
  // reaches setDB/saveDB.
  const OBJECT_FIELDS = ["operator", "telemetry", "markers", "fuelPlans", "completions", "briefings", "journal"];
  const ARRAY_FIELDS = ["biomarkerLogs", "mealTemplates", "plannedMeals", "workouts", "sessions", "protocols", "fuelLog"];

  function validateDBShape(obj) {
    const errors = [];
    if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
      return { ok: false, errors: ["File is not a JSON object."] };
    }
    if (obj.version !== 1) {
      errors.push("Unsupported or missing DB version (expected 1).");
    }
    OBJECT_FIELDS.forEach((f) => {
      if (obj[f] !== undefined && (obj[f] === null || typeof obj[f] !== "object" || Array.isArray(obj[f]))) {
        errors.push('"' + f + '" must be an object.');
      }
    });
    ARRAY_FIELDS.forEach((f) => {
      if (obj[f] !== undefined && !Array.isArray(obj[f])) {
        errors.push('"' + f + '" must be a list.');
      }
    });
    return { ok: errors.length === 0, errors };
  }

  function summarizeDB(db) {
    const days = Object.keys(db.telemetry || {}).length;
    const sessions = (db.sessions || []).length;
    const meals = (db.fuelLog || []).length;
    const journalDays = Object.keys(db.journal || {}).length;
    return days + " telemetry day(s), " + sessions + " training session(s), " +
      meals + " fuel log entries, " + journalDays + " journal day(s)";
  }

  function createDataManagementModule({ Storage, DB_KEY, emptyDB, dayKey, saveDB, armDangerButton, renderCommand, getDB, setDB, getColors }) {
    function hasBackup() {
      return !!Storage.get(DB_KEY + DB_BACKUP_SUFFIX);
    }

    function renderDataCard() {
      const DB = getDB();
      document.getElementById("store-desc").textContent = Storage.persistent
        ? "Persistent local store active. Export regularly as backup."
        : "Volatile store (sandboxed preview). Data clears on reload. Open in Safari or host to persist.";
      const bytes = (Storage.get(DB_KEY) || "").length;
      document.getElementById("db-size").textContent = "DB " + bytes + " B";
      document.getElementById("restore-backup-row").hidden = !hasBackup();
    }

    function init() {
      document.getElementById("btn-export").addEventListener("click", () => {
        const DB = getDB();
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
        const COLORS = getColors();
        const statusEl = document.getElementById("import-status");
        const file = ev.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
          let incoming;
          try {
            incoming = JSON.parse(reader.result);
          } catch (e) {
            statusEl.textContent = "Import rejected: file is not valid JSON.";
            statusEl.style.color = COLORS.red;
            return;
          }
          const shape = validateDBShape(incoming);
          if (!shape.ok) {
            statusEl.textContent = "Import rejected: " + shape.errors.join(" ");
            statusEl.style.color = COLORS.red;
            return;
          }
          const proceed = window.confirm(
            "Import will replace ALL current data with this file:\n\n" +
            summarizeDB(incoming) +
            "\n\nYour current data will be backed up first and can be restored from SYS if needed. Continue?"
          );
          if (!proceed) {
            statusEl.textContent = "Import cancelled.";
            statusEl.style.color = "";
            return;
          }
          incoming.briefings = incoming.briefings || {};
          incoming.workouts = incoming.workouts || [];
          incoming.sessions = incoming.sessions || [];
          incoming.journal = incoming.journal || {};
          incoming.fuelLog = incoming.fuelLog || [];

          const current = getDB();
          const backupResult = Storage.set(DB_KEY + DB_BACKUP_SUFFIX, JSON.stringify(current));
          if (!backupResult.ok) {
            statusEl.textContent = "Import stopped: could not back up your current data first (storage error). Nothing was changed.";
            statusEl.style.color = COLORS.red;
            return;
          }

          setDB(incoming);
          saveDB(incoming);
          renderCommand();
          renderDataCard();
          statusEl.textContent = "Import successful. Your previous data was backed up and can be restored from this card.";
          statusEl.style.color = COLORS.green;
        };
        reader.readAsText(file);
        ev.target.value = "";
      });

      document.getElementById("btn-restore-backup").addEventListener("click", (ev) => {
        const COLORS = getColors();
        const statusEl = document.getElementById("import-status");
        armDangerButton(ev.currentTarget, "Restore", () => {
          const raw = Storage.get(DB_KEY + DB_BACKUP_SUFFIX);
          if (!raw) return;
          let restored;
          try {
            restored = JSON.parse(raw);
          } catch (e) {
            statusEl.textContent = "Restore failed: the backup could not be read.";
            statusEl.style.color = COLORS.red;
            return;
          }
          setDB(restored);
          saveDB(restored);
          renderCommand();
          renderDataCard();
          statusEl.textContent = "Previous data restored.";
          statusEl.style.color = COLORS.green;
        });
      });

      document.getElementById("btn-wipe").addEventListener("click", (ev) => {
        armDangerButton(ev.currentTarget, "Wipe", () => {
          Storage.remove(DB_KEY);
          const fresh = emptyDB();
          setDB(fresh);
          saveDB(fresh);
          renderCommand();
        });
      });
    }

    return { init, render: renderDataCard };
  }

  global.BioCommandDataManagement = { createDataManagementModule };
})(window);
