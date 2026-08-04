"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - dayKey()
 * - saveDB()
 * - genId() / armDangerButton() — still defined in app.js pending the
 *   shared-utilities extraction; injected here rather than duplicated.
 * - meanOf() — still defined in app.js (Intel Engine), pending the
 *   shared-utilities extraction.
 * - weekdayBit() — still defined in app.js; also used by the
 *   Notifications and Tab Badges code that hasn't been extracted yet,
 *   so it stays put until the shared-utilities pass relocates it.
 * - getDB() / getColors() — accessors rather than plain values, since
 *   DB and COLORS are both reassigned at runtime (import/reset/cloud
 *   sync for DB, theme toggle for COLORS).
 */
(function (global) {
  function createProtocolsModule({ dayKey, saveDB, genId, armDangerButton, meanOf, weekdayBit, getDB, getColors }) {
    const CATEGORY_LABELS = {
      coldExposure: "Cold exposure", heat: "Heat", supplement: "Supplement",
      sleepHygiene: "Sleep hygiene", mobility: "Mobility", zone2: "Zone 2",
      mindset: "Mindset", custom: "Custom"
    };

    let protocolEditId = null;

    function seedDefaultProtocols() {
      const DB = getDB();
      if (DB.protocols.length > 0) return;
      DB.protocols.push(
        { id: genId("pd"), name: "COLD EXPOSURE", category: "coldExposure", scheduleMask: 0b1111111, targetValue: 3, targetUnit: "min", isActive: true, sortOrder: 0 },
        { id: genId("pd"), name: "CREATINE 5G", category: "supplement", scheduleMask: 0b1111111, targetValue: 5, targetUnit: "g", isActive: true, sortOrder: 1 },
        { id: genId("pd"), name: "SCREENS OFF BY 22:00", category: "sleepHygiene", scheduleMask: 0b1111111, targetValue: null, targetUnit: null, isActive: true, sortOrder: 2 },
        { id: genId("pd"), name: "ZONE 2 SESSION", category: "zone2", scheduleMask: 0b0010010, targetValue: 30, targetUnit: "min", isActive: true, sortOrder: 3 }
      );
      saveDB(DB);
    }

    function isScheduledOnDate(directive, date) {
      return (directive.scheduleMask & (1 << weekdayBit(date))) !== 0;
    }

    function completionFor(dayKeyStr, directiveId) {
      const DB = getDB();
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
      const DB = getDB();
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
      const DB = getDB();
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

    function openProtocolBuilder(id) {
      const DB = getDB();
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

    function init() {
      document.getElementById("protocol-list").addEventListener("click", (ev) => {
        const DB = getDB();
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

      document.getElementById("btn-new-protocol").addEventListener("click", () => openProtocolBuilder(null));
      document.getElementById("btn-cancel-protocol").addEventListener("click", () => {
        document.getElementById("protocol-builder-overlay").classList.remove("open");
      });
      document.getElementById("pd-days").addEventListener("click", (ev) => {
        const btn = ev.target.closest(".day-toggle");
        if (btn) btn.classList.toggle("active");
      });
      document.getElementById("btn-save-protocol").addEventListener("click", () => {
        const DB = getDB();
        const COLORS = getColors();
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
        const DB = getDB();
        if (!protocolEditId) return;
        armDangerButton(ev.currentTarget, "Delete", () => {
          DB.protocols = DB.protocols.filter(p => p.id !== protocolEditId);
          saveDB(DB);
          document.getElementById("protocol-builder-overlay").classList.remove("open");
          renderProtocolList();
        });
      });
    }

    return { init, render: renderProtocolList };
  }

  global.BioCommandProtocols = { createProtocolsModule };
})(window);
