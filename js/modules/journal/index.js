"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - dayKey()
 * - saveDB()
 * - meanOf() — still defined in app.js (Intel Engine), pending the
 *   shared-utilities extraction; injected here rather than duplicated.
 * - createScoreRing() / hexToRgba() — js/modules/shared/score-ring.js;
 *   the streak indicator's small ring (capped at a 7-day "week" fill).
 * - getDB() / getColors() — accessors rather than plain values, since
 *   DB and COLORS are both reassigned at runtime (import/reset/cloud
 *   sync for DB, theme toggle for COLORS).
 *
 * Renders into two distinct places in the shell: a compact widget on
 * Command (render) and a full history/insights view on PROTO
 * (renderProto). Both are exposed since the app calls them separately.
 *
 * escapeHtml (js/modules/shared/sanitize.js) is used for entry.note
 * wherever it's interpolated into a list-rendering HTML string; the
 * note *editor* itself is built via DOM nodes instead (see
 * buildJournalUI below) since that removes the injection vector
 * entirely rather than just neutralizing it.
 */
(function (global) {
  function createJournalModule({ dayKey, saveDB, meanOf, escapeHtml, createScoreRing, hexToRgba, getDB, getColors }) {
    const JOURNAL_QUESTIONS = [
      { key: "ALCOHOL",       label: "Alcohol last night?" },
      { key: "STRESS",        label: "Stress elevated?" },
      { key: "CAFFEINE_LATE", label: "Caffeine after 2pm?" },
      { key: "POOR_SLEEP",    label: "Sleep disrupted?" },
      { key: "SICK",          label: "Feeling unwell?" }
    ];

    // Two ring instances (Command's compact card, Protocols' full
    // card) sharing the same "streak capped at a week" visual.
    const streakRings = {};
    ["cmd", "proto"].forEach((id) => {
      const hook = document.getElementById(id === "cmd" ? "journal-streak-ring-hook" : "proto-journal-streak-ring-hook");
      if (!hook) return;
      const ring = createScoreRing({ radius: 7, hexToRgba });
      hook.insertAdjacentHTML("afterbegin", ring.markup());
      streakRings[id] = ring;
    });

    function updateStreakRing(id, numEl, streak) {
      const COLORS = getColors();
      const ring = streakRings[id];
      if (ring) ring.setProgress(Math.min(streak, 7) / 7, streak > 0 ? COLORS.green : COLORS.dim);
      if (numEl) numEl.textContent = streak + "d";
    }

    // Set right before a full re-render triggered by answering one
    // question, so buildJournalUI can mark just that button for a
    // pulse animation instead of every button replaying it on any
    // unrelated re-render.
    let justAnsweredKey = null;

    function getJournalEntry(day) {
      const DB = getDB();
      DB.journal = DB.journal || {};
      if (!DB.journal[day]) DB.journal[day] = { answers: {}, note: "" };
      return DB.journal[day];
    }

    function setJournalAnswer(day, key, val) {
      const DB = getDB();
      const entry = getJournalEntry(day);
      entry.answers[key] = val;
      saveDB(DB);
    }

    function setJournalNote(day, text) {
      const DB = getDB();
      const entry = getJournalEntry(day);
      entry.note = text;
      saveDB(DB);
    }

    function journalStreakCount() {
      const DB = getDB();
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
        const justAnswered = q.key === justAnsweredKey;
        const row = document.createElement("div");
        row.className = "jq-row";
        row.innerHTML =
          '<span class="jq-q">' + q.label + '</span><span class="jq-opts">' +
          '<button class="jq-btn' + (ans === true ? " sel" : "") + (justAnswered && ans === true ? " jq-pulse" : "") +
            '" data-jkey="' + q.key + '" data-jval="true">YES</button>' +
          '<button class="jq-btn' + (ans === false ? " sel" : "") + (justAnswered && ans === false ? " jq-pulse" : "") +
            '" data-jkey="' + q.key + '" data-jval="false">NO</button>' +
          '</span>';
        container.appendChild(row);
      });

      if (!compact) {
        const noteRow = document.createElement("div");
        noteRow.style.marginTop = "10px";
        const textarea = document.createElement("textarea");
        textarea.className = "journal-note";
        textarea.id = "journal-note-" + day;
        textarea.placeholder = "Notes, how you feel, anything notable today...";
        textarea.value = entry.note || "";
        noteRow.appendChild(textarea);
        container.appendChild(noteRow);
        textarea.addEventListener("input", (ev) => {
          setJournalNote(day, ev.target.value);
        });
      }

      container.addEventListener("click", (ev) => {
        const btn = ev.target.closest(".jq-btn");
        if (!btn) return;
        const val = btn.dataset.jval === "true";
        justAnsweredKey = btn.dataset.jkey;
        setJournalAnswer(day, btn.dataset.jkey, val);
        // Always refresh both renders regardless of which container
        // was edited -- previously only a cmd-side edit propagated to
        // proto; an edit made directly on the proto view's own full
        // journal never re-rendered that same container in-session
        // (the answer still saved correctly, it just didn't visually
        // show as selected until something unrelated re-rendered it).
        renderJournal();
        renderJournalProto();
        justAnsweredKey = null;
      });
    }

    function renderJournal() {
      const COLORS = getColors();
      const today = dayKey();
      const streak = journalStreakCount();
      const entry = getJournalEntry(today);
      const allAnswered = JOURNAL_QUESTIONS.every(q => entry.answers[q.key] !== undefined);
      const dot = document.getElementById("journal-cmd-dot");
      if (dot) dot.style.color = allAnswered ? COLORS.green : COLORS.amber;

      updateStreakRing("cmd", document.getElementById("journal-streak-num"), streak);

      buildJournalUI(document.getElementById("cmd-journal-body"), today, true);
    }

    function renderJournalProto() {
      const DB = getDB();
      const COLORS = getColors();
      const today = dayKey();
      const streak = journalStreakCount();
      updateStreakRing("proto", document.getElementById("proto-journal-streak-num"), streak);
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
          (entry.note ? '<br><span class="telemetry cap t3">' + escapeHtml(entry.note.slice(0, 80)) + (entry.note.length > 80 ? "…" : "") + "</span>" : "") +
          "</div>";
      }).filter(Boolean).join("") || '<div class="empty-hint">No journal entries yet this week.</div>';
    }

    function init() {}

    return { init, render: renderJournal, renderProto: renderJournalProto };
  }

  global.BioCommandJournal = { createJournalModule };
})(window);
