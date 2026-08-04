"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - dayKey()
 * - saveDB()
 * - genId() / armDangerButton() — still defined in app.js pending the
 *   shared-utilities extraction; injected here rather than duplicated.
 * - computeScores() — still defined in app.js (Scoring Engine), pending
 *   the shared-utilities extraction.
 * - renderCommand() — Dashboard's Today render, called after a session
 *   is finished so Command reflects the new strain/telemetry.
 * - getDB() / getColors() — accessors rather than plain values, since
 *   DB and COLORS are both reassigned at runtime (import/reset/cloud
 *   sync for DB, theme toggle for COLORS).
 */
(function (global) {
  function createTrainingModule({ dayKey, saveDB, genId, armDangerButton, computeScores, renderCommand, getDB, getColors }) {
    let builderExercises = [];
    let builderEditId = null;
    let exec = null; // { workout, startedAt, exSets: {exId: [{loadKg,reps,rpe,completed,completedAt}]}, restHandle, elapsedHandle }

    function seedDefaultWorkouts() {
      const DB = getDB();
      if (DB.seededWorkouts || DB.workouts.length > 0) return;
      const mk = (name, focus, exercises) => ({
        id: genId("wk"), name, focus, progression: "doubleProgression",
        isArchived: false, createdAt: new Date().toISOString(),
        exercises: exercises.map((e, i) => ({ id: genId("ex"), order: i, ...e }))
      });
      DB.workouts.push(
        mk("OP: LOWER HEAVY", "Lower / Posterior", [
          { name: "Back Squat", targetSets: 4, repLow: 5, repHigh: 8, targetRPE: 8, restSec: 180, loadIncrementKg: 2.5 },
          { name: "Romanian Deadlift", targetSets: 3, repLow: 8, repHigh: 10, targetRPE: 8, restSec: 120, loadIncrementKg: 2.5 },
          { name: "Walking Lunge", targetSets: 3, repLow: 10, repHigh: 12, targetRPE: 7, restSec: 90, loadIncrementKg: 2.5 },
          { name: "Calf Raise", targetSets: 3, repLow: 12, repHigh: 15, targetRPE: 8, restSec: 60, loadIncrementKg: 2.5 }
        ]),
        mk("OP: PUSH", "Chest / Shoulders / Triceps", [
          { name: "Bench Press", targetSets: 4, repLow: 5, repHigh: 8, targetRPE: 8, restSec: 180, loadIncrementKg: 2.5 },
          { name: "Overhead Press", targetSets: 3, repLow: 6, repHigh: 10, targetRPE: 8, restSec: 120, loadIncrementKg: 2.5 },
          { name: "Incline Dumbbell Press", targetSets: 3, repLow: 8, repHigh: 12, targetRPE: 7, restSec: 90, loadIncrementKg: 2 },
          { name: "Triceps Pushdown", targetSets: 3, repLow: 10, repHigh: 15, targetRPE: 8, restSec: 60, loadIncrementKg: 2 }
        ]),
        mk("OP: PULL", "Back / Biceps", [
          { name: "Deadlift", targetSets: 3, repLow: 3, repHigh: 6, targetRPE: 8, restSec: 210, loadIncrementKg: 5 },
          { name: "Pull-Up", targetSets: 4, repLow: 6, repHigh: 10, targetRPE: 8, restSec: 120, loadIncrementKg: 0 },
          { name: "Barbell Row", targetSets: 3, repLow: 8, repHigh: 10, targetRPE: 8, restSec: 120, loadIncrementKg: 2.5 },
          { name: "Barbell Curl", targetSets: 3, repLow: 10, repHigh: 12, targetRPE: 7, restSec: 60, loadIncrementKg: 1.25 }
        ])
      );
      DB.seededWorkouts = true;
      saveDB(DB);
    }

    /* ---------- Workout list (Train home) ---------- */

    function lastPerformedLabel(workoutId) {
      const DB = getDB();
      const sessions = DB.sessions.filter(s => s.workoutId === workoutId).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (!sessions.length) return "Not yet performed";
      const days = Math.floor((Date.now() - new Date(sessions[0].startedAt).getTime()) / 86400000);
      if (days <= 0) return "Last: today";
      if (days === 1) return "Last: yesterday";
      return "Last: " + days + "d ago";
    }

    function renderWorkoutList() {
      const DB = getDB();
      seedDefaultWorkouts();
      const host = document.getElementById("workout-list");
      const active = DB.workouts.filter(w => !w.isArchived);
      if (!active.length) {
        host.innerHTML = '<div class="empty-hint">No workouts yet. Tap New to build one.</div>';
        return;
      }
      host.innerHTML = active.map(w => {
        const exLines = w.exercises.map(e =>
          e.name + " &middot; " + e.targetSets + "x" + e.repLow + "-" + e.repHigh
        ).join("<br>");
        return '<div class="hud-card workout-card">' +
          '<div class="wk-head"><span class="wk-name">' + w.name + '</span>' +
          '<span class="spacer"></span><span class="wk-focus">' + (w.focus || "") + '</span></div>' +
          '<div class="wk-exlist">' + exLines + '</div>' +
          '<div class="telemetry cap t3">' + lastPerformedLabel(w.id) + '</div>' +
          '<div class="wk-actions">' +
          '<button class="tac-btn primary" data-start="' + w.id + '" style="flex:2;">Start</button>' +
          '<button class="tac-btn" data-edit="' + w.id + '" style="flex:1;">Edit</button>' +
          '</div></div>';
      }).join("");
    }

    /* ---------- Session history ---------- */

    function renderSessionList() {
      const DB = getDB();
      const host = document.getElementById("session-list");
      const recent = DB.sessions.slice().sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 8);
      if (!recent.length) {
        host.innerHTML = '<div class="empty-hint">No sessions logged yet.</div>';
        return;
      }
      host.innerHTML = recent.map(sess => {
        const d = new Date(sess.startedAt);
        const dstr = String(d.getDate()).padStart(2, "0") + "/" + String(d.getMonth() + 1).padStart(2, "0");
        const setCount = sess.sets.length;
        return '<div class="session-row">' +
          '<span class="sr-date">' + dstr + '</span>' +
          '<span class="sr-name">' + sess.workoutName + '</span>' +
          '<span class="sr-meta">' + setCount + ' sets &middot; ' +
          (sess.durationMin != null ? sess.durationMin + " min" : "--") +
          (sess.sessionRPE != null ? " &middot; RPE " + sess.sessionRPE : "") + '</span>' +
          '</div>';
      }).join("");
    }

    /* ---------- Builder ---------- */

    function renderExRows() {
      const host = document.getElementById("ex-rows");
      host.innerHTML = builderExercises.map((e, i) =>
        '<div class="ex-row" data-idx="' + i + '">' +
        '<button class="ex-remove" data-remove="' + i + '">&times;</button>' +
        '<input class="tac-input" data-field="name" data-idx="' + i + '" placeholder="Exercise name" value="' +
          (e.name || "").replace(/"/g, "&quot;") + '">' +
        '<div class="ex-row-grid">' +
        '<div><label class="ex-field-lbl">Sets</label><input class="tac-input" type="number" min="1" step="1" data-field="targetSets" data-idx="' + i + '" value="' + (e.targetSets ?? "") + '"></div>' +
        '<div><label class="ex-field-lbl">Rep low</label><input class="tac-input" type="number" min="1" step="1" data-field="repLow" data-idx="' + i + '" value="' + (e.repLow ?? "") + '"></div>' +
        '<div><label class="ex-field-lbl">Rep high</label><input class="tac-input" type="number" min="1" step="1" data-field="repHigh" data-idx="' + i + '" value="' + (e.repHigh ?? "") + '"></div>' +
        '<div><label class="ex-field-lbl">Target RPE</label><input class="tac-input" type="number" min="1" max="10" step="0.5" data-field="targetRPE" data-idx="' + i + '" value="' + (e.targetRPE ?? "") + '"></div>' +
        '<div><label class="ex-field-lbl">Rest sec</label><input class="tac-input" type="number" min="0" step="15" data-field="restSec" data-idx="' + i + '" value="' + (e.restSec ?? "") + '"></div>' +
        '<div><label class="ex-field-lbl">Load step kg</label><input class="tac-input" type="number" min="0" step="0.25" data-field="loadIncrementKg" data-idx="' + i + '" value="' + (e.loadIncrementKg ?? "") + '"></div>' +
        '</div></div>'
      ).join("");
    }

    function openBuilder(workoutId) {
      const DB = getDB();
      builderEditId = workoutId;
      const delBtn = document.getElementById("btn-delete-workout");
      if (workoutId) {
        const w = DB.workouts.find(x => x.id === workoutId);
        document.getElementById("builder-title").textContent = "Edit Workout";
        document.getElementById("wk-name").value = w.name;
        document.getElementById("wk-focus").value = w.focus || "";
        builderExercises = w.exercises.map(e => ({ ...e }));
        delBtn.style.display = "block";
      } else {
        document.getElementById("builder-title").textContent = "New Workout";
        document.getElementById("wk-name").value = "";
        document.getElementById("wk-focus").value = "";
        builderExercises = [];
        delBtn.style.display = "none";
      }
      document.getElementById("builder-status").textContent = "";
      renderExRows();
      document.getElementById("builder-overlay").classList.add("open");
    }

    /* ---------- Execution ---------- */

    function lastPerformance(exerciseName) {
      const DB = getDB();
      const past = DB.sessions
        .filter(sess => sess.sets.some(st => st.exerciseName === exerciseName))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
      if (!past.length) return null;
      const sets = past[0].sets.filter(st => st.exerciseName === exerciseName);
      const top = sets.reduce((a, b) => (b.loadKg > a.loadKg ? b : a), sets[0]);
      return { sets, top, date: past[0].startedAt };
    }

    function suggestLoad(prescription, last) {
      if (!last) return { load: null, reason: "No prior data. Pick a load you can control for the full rep range." };
      const hitTop = last.top.reps >= prescription.repHigh;
      const rpeOk = last.top.rpe == null || prescription.targetRPE == null || last.top.rpe <= prescription.targetRPE;
      if (hitTop && rpeOk && prescription.loadIncrementKg > 0) {
        const next = last.top.loadKg + prescription.loadIncrementKg;
        return { load: next, reason: "Hit top of range last time at target RPE. +" + prescription.loadIncrementKg + "kg." };
      }
      return { load: last.top.loadKg, reason: "Repeat the load, push for more reps or better RPE." };
    }

    function epley1RM(loadKg, reps) {
      return loadKg * (1 + reps / 30);
    }

    function priorBest1RM(exerciseName, excludeSessionId) {
      const DB = getDB();
      let best = 0;
      DB.sessions.forEach(sess => {
        if (sess.id === excludeSessionId) return;
        sess.sets.forEach(st => {
          if (st.exerciseName === exerciseName) {
            const e1 = epley1RM(st.loadKg, st.reps);
            if (e1 > best) best = e1;
          }
        });
      });
      return best;
    }

    function findExercise(exId) {
      if (!exec) return null;
      return exec.workout.exercises.find(e => e.id === exId) || null;
    }

    function setRowHtml(exId, idx, row, prevLabel) {
      return '<div class="set-row' + (row.completed ? " done" : "") + '" data-exid="' + exId + '" data-setidx="' + idx + '">' +
        '<span class="sc-num">' + (idx + 1) + '</span>' +
        '<span class="sc-prev">' + prevLabel + '</span>' +
        '<input class="sc-input sc-load" type="number" inputmode="decimal" step="0.5" value="' + (row.loadKg ?? "") + '"' + (row.completed ? " disabled" : "") + '>' +
        '<input class="sc-input sc-reps" type="number" inputmode="numeric" step="1" value="' + (row.reps ?? "") + '"' + (row.completed ? " disabled" : "") + '>' +
        '<input class="sc-input sc-rpe" type="number" inputmode="decimal" min="1" max="10" step="0.5" value="' + (row.rpe ?? "") + '"' + (row.completed ? " disabled" : "") + '>' +
        '<button class="sc-check" data-check>' + (row.completed ? "&#10003;" : "") + '</button>' +
        '</div>';
    }

    function renderExecBody() {
      const w = exec.workout;
      const host = document.getElementById("exec-exercise-list");
      host.innerHTML = w.exercises.map(e => {
        const last = lastPerformance(e.name);
        const rows = exec.exSets[e.id];
        const rowsHtml = rows.map((row, idx) => {
          const prevLabel = (last && last.sets[idx])
            ? last.sets[idx].loadKg + "x" + last.sets[idx].reps
            : "--";
          return setRowHtml(e.id, idx, row, prevLabel);
        }).join("");
        return '<div class="exec-ex-card">' +
          '<div class="exec-ex-head">' +
          '<span class="exec-ex-title">' + e.name + '</span>' +
          '<span class="exec-ex-sub">' + e.targetSets + "x" + e.repLow + "-" + e.repHigh +
          (e.targetRPE ? " @ RPE " + e.targetRPE : "") + " &middot; rest " + e.restSec + "s</span>" +
          '</div>' +
          '<div class="set-row set-row-head"><span>SET</span><span>PREV</span><span>KG</span><span>REPS</span><span>RPE</span><span></span></div>' +
          '<div class="set-rows" data-exrows="' + e.id + '">' + rowsHtml + '</div>' +
          '<button class="add-set-btn" data-add="' + e.id + '">+ ADD SET</button>' +
          '</div>';
      }).join("");
      updateExecStats();
    }

    function updateExecStats() {
      if (!exec) return;
      let volume = 0;
      Object.values(exec.exSets).forEach(rows => {
        rows.forEach(r => { if (r.completed) volume += (r.loadKg || 0) * (r.reps || 0); });
      });
      document.getElementById("exec-volume").textContent = Math.round(volume) + "KG";
      const elapsedSec = Math.floor((Date.now() - exec.startedAt) / 1000);
      const m = Math.floor(elapsedSec / 60), sec = elapsedSec % 60;
      document.getElementById("exec-elapsed").textContent = m + ":" + String(sec).padStart(2, "0");
    }

    function startSession(workoutId) {
      const DB = getDB();
      const w = DB.workouts.find(x => x.id === workoutId);
      if (!w) return;
      const exSets = {};
      w.exercises.forEach(e => {
        const last = lastPerformance(e.name);
        const sug = suggestLoad(e, last);
        const rows = [];
        for (let i = 0; i < e.targetSets; i++) {
          rows.push({ loadKg: sug.load, reps: e.repHigh, rpe: null, completed: false, completedAt: null });
        }
        exSets[e.id] = rows;
      });
      exec = { workout: w, startedAt: Date.now(), exSets, restHandle: null, elapsedHandle: null };
      document.getElementById("exec-workout-name").textContent = w.name.toUpperCase();
      document.getElementById("exec-done-screen").style.display = "none";
      document.getElementById("exec-exercise-list").style.display = "block";
      document.getElementById("exec-restbar").style.display = "none";
      document.getElementById("exec-overlay").classList.add("open");
      renderExecBody();
      clearInterval(exec.elapsedHandle);
      exec.elapsedHandle = setInterval(updateExecStats, 1000);
    }

    function startFloatingRest(seconds) {
      clearInterval(exec.restHandle);
      let remaining = seconds;
      const bar = document.getElementById("exec-restbar");
      const timeEl = document.getElementById("rb-time");
      bar.style.display = "flex";
      const m0 = Math.floor(remaining / 60), s0 = remaining % 60;
      timeEl.textContent = m0 + ":" + String(s0).padStart(2, "0");
      exec.restHandle = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
          clearInterval(exec.restHandle);
          bar.style.display = "none";
          return;
        }
        const m = Math.floor(remaining / 60), sec = remaining % 60;
        timeEl.textContent = m + ":" + String(sec).padStart(2, "0");
      }, 1000);
    }

    function finishSession() {
      const DB = getDB();
      clearInterval(exec.restHandle);
      clearInterval(exec.elapsedHandle);
      document.getElementById("exec-restbar").style.display = "none";

      const durationMin = Math.max(1, Math.round((Date.now() - exec.startedAt) / 60000));
      const sets = [];
      exec.workout.exercises.forEach(e => {
        exec.exSets[e.id].forEach((row, i) => {
          if (row.completed) {
            sets.push({ order: sets.length, exerciseName: e.name, loadKg: row.loadKg || 0, reps: row.reps || 0, rpe: row.rpe, completedAt: row.completedAt });
          }
        });
      });
      const rpes = sets.map(s => s.rpe).filter(v => v != null);
      const avgRPE = rpes.length ? Math.round((rpes.reduce((a, b) => a + b, 0) / rpes.length) * 2) / 2 : null;

      const sessionId = genId("sess");
      const session = {
        id: sessionId, dayKey: dayKey(), startedAt: new Date(exec.startedAt).toISOString(),
        workoutId: exec.workout.id, workoutName: exec.workout.name,
        durationMin, sessionRPE: avgRPE, sets
      };
      DB.sessions.push(session);

      const prLines = [];
      const byExercise = {};
      sets.forEach(s => { (byExercise[s.exerciseName] = byExercise[s.exerciseName] || []).push(s); });
      Object.keys(byExercise).forEach(name => {
        const prior = priorBest1RM(name, sessionId);
        if (prior <= 0) return;
        const best = byExercise[name].reduce((a, b) => epley1RM(b.loadKg, b.reps) > epley1RM(a.loadKg, a.reps) ? b : a);
        if (epley1RM(best.loadKg, best.reps) > prior) {
          prLines.push(name + ": " + best.loadKg + "kg x " + best.reps + " (est 1RM " + Math.round(epley1RM(best.loadKg, best.reps)) + "kg)");
        }
      });

      const key = dayKey();
      const existing = DB.telemetry[key] || {};
      const row = {
        ...existing, dayKey: key,
        trainingMinutes: durationMin, sessionRPE: avgRPE,
        source: existing.source || "manual", scoreVersion: 2, updatedAt: new Date().toISOString()
      };
      const sc = computeScores(row, key);
      row.readinessScore = sc.readiness;
      row.systemLoadScore = Math.round(sc.strain * 10) / 10;
      row.strainMethod = sc.strainMethod;
      DB.telemetry[key] = row;

      saveDB(DB);
      renderCommand();
      renderWorkoutList();
      renderSessionList();

      document.getElementById("exec-exercise-list").style.display = "none";
      document.getElementById("exec-done-screen").style.display = "block";
      const volume = sets.reduce((a, s) => a + s.loadKg * s.reps, 0);
      let summary = sets.length + " sets logged over " + durationMin + " min, " + Math.round(volume) + "kg total volume" +
        (avgRPE != null ? ", average RPE " + avgRPE : "") + ". Strain updated on Command.";
      if (prLines.length) {
        summary += '<br><br><span class="pr-line">NEW PR' + (prLines.length > 1 ? "S" : "") + ":<br>" + prLines.join("<br>") + "</span>";
      }
      document.getElementById("exec-summary").innerHTML = summary;

      exec = null;
    }

    function init() {
      document.getElementById("workout-list").addEventListener("click", (ev) => {
        const startId = ev.target.dataset.start;
        const editId = ev.target.dataset.edit;
        if (startId) startSession(startId);
        if (editId) openBuilder(editId);
      });

      document.getElementById("btn-new-workout").addEventListener("click", () => openBuilder(null));

      document.getElementById("ex-rows").addEventListener("input", (ev) => {
        const idx = Number(ev.target.dataset.idx);
        const field = ev.target.dataset.field;
        if (Number.isNaN(idx) || !field) return;
        const v = ev.target.value;
        builderExercises[idx][field] = field === "name" ? v : (v === "" ? null : Number(v));
      });

      document.getElementById("ex-rows").addEventListener("click", (ev) => {
        const rm = ev.target.dataset.remove;
        if (rm == null) return;
        builderExercises.splice(Number(rm), 1);
        renderExRows();
      });

      document.getElementById("btn-add-exercise").addEventListener("click", () => {
        builderExercises.push({ name: "", targetSets: 3, repLow: 8, repHigh: 12, targetRPE: 8, restSec: 90, loadIncrementKg: 2.5 });
        renderExRows();
      });

      document.getElementById("btn-cancel-builder").addEventListener("click", () => {
        document.getElementById("builder-overlay").classList.remove("open");
      });

      document.getElementById("btn-save-workout").addEventListener("click", () => {
        const DB = getDB();
        const COLORS = getColors();
        const statusEl = document.getElementById("builder-status");
        statusEl.textContent = "";
        const name = document.getElementById("wk-name").value.trim();
        if (!name) {
          statusEl.textContent = "Name the workout first.";
          statusEl.style.color = COLORS.red;
          return;
        }
        const clean = builderExercises
          .filter(e => e.name && e.name.trim())
          .map((e, i) => ({
            id: e.id || genId("ex"), order: i, name: e.name.trim(),
            targetSets: e.targetSets || 3, repLow: e.repLow || 1, repHigh: e.repHigh || (e.repLow || 1),
            targetRPE: e.targetRPE || null, restSec: e.restSec || 90, loadIncrementKg: e.loadIncrementKg || 0
          }));
        if (!clean.length) {
          statusEl.textContent = "Add at least one exercise.";
          statusEl.style.color = COLORS.red;
          return;
        }

        if (builderEditId) {
          const w = DB.workouts.find(x => x.id === builderEditId);
          w.name = name; w.focus = document.getElementById("wk-focus").value.trim();
          w.exercises = clean;
        } else {
          DB.workouts.push({
            id: genId("wk"), name, focus: document.getElementById("wk-focus").value.trim(),
            progression: "doubleProgression", isArchived: false,
            createdAt: new Date().toISOString(), exercises: clean
          });
        }
        saveDB(DB);
        document.getElementById("builder-overlay").classList.remove("open");
        renderWorkoutList();
      });

      document.getElementById("btn-delete-workout").addEventListener("click", (ev) => {
        const DB = getDB();
        if (!builderEditId) return;
        armDangerButton(ev.currentTarget, "Delete", () => {
          DB.workouts = DB.workouts.filter(w => w.id !== builderEditId);
          saveDB(DB);
          document.getElementById("builder-overlay").classList.remove("open");
          renderWorkoutList();
        });
      });

      document.getElementById("exec-exercise-list").addEventListener("input", (ev) => {
        const row = ev.target.closest(".set-row");
        if (!row) return;
        const exId = row.dataset.exid, idx = Number(row.dataset.setidx);
        const state = exec.exSets[exId][idx];
        if (ev.target.classList.contains("sc-load")) state.loadKg = ev.target.value === "" ? null : Number(ev.target.value);
        if (ev.target.classList.contains("sc-reps")) state.reps = ev.target.value === "" ? null : Number(ev.target.value);
        if (ev.target.classList.contains("sc-rpe")) state.rpe = ev.target.value === "" ? null : Number(ev.target.value);
      });

      document.getElementById("exec-exercise-list").addEventListener("click", (ev) => {
        const addId = ev.target.dataset.add;
        if (addId) {
          const rows = exec.exSets[addId];
          const lastRow = rows[rows.length - 1];
          rows.push({ loadKg: lastRow ? lastRow.loadKg : null, reps: lastRow ? lastRow.reps : null, rpe: null, completed: false, completedAt: null });
          const container = document.querySelector('[data-exrows="' + addId + '"]');
          const last = lastPerformance(findExercise(addId).name);
          const idx = rows.length - 1;
          const prevLabel = (last && last.sets[idx]) ? last.sets[idx].loadKg + "x" + last.sets[idx].reps : "--";
          container.insertAdjacentHTML("beforeend", setRowHtml(addId, idx, rows[idx], prevLabel));
          return;
        }
        if (ev.target.hasAttribute("data-check")) {
          const row = ev.target.closest(".set-row");
          const exId = row.dataset.exid, idx = Number(row.dataset.setidx);
          const state = exec.exSets[exId][idx];
          state.completed = !state.completed;
          if (state.completed) {
            state.completedAt = new Date().toISOString();
            row.classList.add("done");
            ev.target.innerHTML = "&#10003;";
            row.querySelectorAll(".sc-input").forEach(el => el.disabled = true);
            const ex = findExercise(exId);
            if (ex && ex.restSec > 0) startFloatingRest(ex.restSec);
          } else {
            state.completedAt = null;
            row.classList.remove("done");
            ev.target.innerHTML = "";
            row.querySelectorAll(".sc-input").forEach(el => el.disabled = false);
          }
          updateExecStats();
        }
      });

      document.getElementById("btn-end-session").addEventListener("click", () => {
        if (!exec) return;
        const anyCompleted = Object.values(exec.exSets).some(rows => rows.some(r => r.completed));
        if (!anyCompleted) {
          clearInterval(exec.restHandle);
          clearInterval(exec.elapsedHandle);
          document.getElementById("exec-overlay").classList.remove("open");
          exec = null;
          return;
        }
        finishSession();
      });

      document.getElementById("btn-close-exec").addEventListener("click", () => {
        document.getElementById("exec-overlay").classList.remove("open");
      });
    }

    function render() {
      renderWorkoutList();
      renderSessionList();
    }

    return { init, render, seedDefaultWorkouts };
  }

  global.BioCommandTraining = { createTrainingModule };
})(window);
