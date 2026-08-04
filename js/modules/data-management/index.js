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
  function createDataManagementModule({ Storage, DB_KEY, emptyDB, dayKey, saveDB, armDangerButton, renderCommand, getDB, setDB, getColors }) {
    function renderDataCard() {
      const DB = getDB();
      document.getElementById("store-desc").textContent = Storage.persistent
        ? "Persistent local store active. Export regularly as backup."
        : "Volatile store (sandboxed preview). Data clears on reload. Open in Safari or host to persist.";
      const bytes = (Storage.get(DB_KEY) || "").length;
      document.getElementById("db-size").textContent = "DB " + bytes + " B";
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
            setDB(incoming);
            saveDB(incoming);
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
