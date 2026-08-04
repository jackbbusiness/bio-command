"use strict";

/**
 * Runtime dependencies supplied by app.js:
 * - dayKey() / weekdayBit() — weekdayBit still defined in app.js
 *   pending the shared-utilities extraction; also relied on by the
 *   Protocols module.
 * - getSB() / getCurrentUser() — sourced directly from the Sync
 *   module (syncModule.getSB / syncModule.getCurrentUser), since
 *   push subscriptions are registered against the same Supabase
 *   client and signed-in user Sync manages.
 * - getDB() / getColors() — accessors rather than plain values, since
 *   DB and COLORS are both reassigned at runtime (import/reset/cloud
 *   sync for DB, theme toggle for COLORS).
 */
(function (global) {
  function createNotificationsModule({ dayKey, weekdayBit, getSB, getCurrentUser, getDB, getColors }) {
    const VAPID_PUBLIC = "BNc4j1_b5Si40nI6Aet0VOJDusf2QpRQHABjgS_mntjB7Lj4O9rBoGIxHxog0_UP_qOA4o06z-YzP1fV5RQlLMQ";

    let _sw = null;

    async function initServiceWorker() {
      if (!("serviceWorker" in navigator)) return;
      try {
        const reg = await navigator.serviceWorker.register("sw.js", { scope: "/bio-command/" });
        _sw = reg;
        await scheduleNotifications();
        renderNotifCard();
      } catch (e) {
        console.log("SW registration failed:", e);
      }
    }

    function buildNotificationSchedule() {
      const DB = getDB();
      const now = Date.now();
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      const notifs = [];

      // Morning journal prompt at 08:30 tomorrow
      const journalTime = new Date(tomorrow);
      journalTime.setHours(8, 30, 0, 0);
      const entry = (DB.journal || {})[dayKey()];
      const allAnswered = entry && Object.keys(entry.answers || {}).length >= 3;
      if (!allAnswered) {
        notifs.push({
          at: journalTime.getTime(),
          title: "Bio-Command",
          body: "Morning journal waiting. Check your recovery and log how you feel.",
          tag: "journal-morning",
          url: "/bio-command/?action=journal"
        });
      }

      // Protocol reminders: for any active protocol scheduled today that is not yet complete
      const nowDate = new Date();
      const todayK = dayKey();
      (DB.protocols || []).forEach(p => {
        if (!p.isActive) return;
        if (!(p.scheduleMask & (1 << weekdayBit(nowDate)))) return;
        const comp = (DB.completions[todayK] || {})[p.id];
        if (comp && comp.completed) return;
        // Reminder at 18:30 for incomplete protocols
        const reminderTime = new Date(nowDate);
        reminderTime.setHours(18, 30, 0, 0);
        if (reminderTime.getTime() > now) {
          notifs.push({
            at: reminderTime.getTime(),
            title: "Protocol reminder",
            body: p.name + " not yet logged today.",
            tag: "proto-" + p.id,
            url: "/bio-command/?tab=proto"
          });
        }
      });

      // Recovery alert: if red recovery, send notification during morning window
      const todayRow = (DB.telemetry || {})[todayK];
      if (todayRow && todayRow.readinessScore != null && todayRow.readinessScore < 34) {
        const alertTime = new Date(tomorrow);
        alertTime.setHours(7, 45, 0, 0);
        notifs.push({
          at: alertTime.getTime(),
          title: "Recovery alert",
          body: "Recovery scored " + todayRow.readinessScore + "/100. Red day. Reduce load.",
          tag: "recovery-alert",
          url: "/bio-command/"
        });
      }

      return notifs;
    }

    async function scheduleNotifications() {
      if (!_sw) return;
      if (Notification.permission !== "granted") return;
      const schedule = buildNotificationSchedule();
      const channel = new MessageChannel();
      _sw.active && _sw.active.postMessage(
        { type: "SCHEDULE_NOTIFICATIONS", notifications: schedule },
        [channel.port2]
      );
    }

    async function requestNotificationPermission() {
      if (!("Notification" in window)) {
        document.getElementById("notif-detail").textContent = "Notifications are not supported in this browser.";
        return;
      }
      const result = await Notification.requestPermission();
      if (result === "granted") {
        await scheduleNotifications();
        // Try push subscription
        if (_sw && window.PushManager) {
          try {
            const sub = await _sw.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: VAPID_PUBLIC
            });
            const sb = getSB();
            const currentUser = getCurrentUser();
            if (sb && currentUser) {
              const key = sub.getKey("p256dh");
              const auth = sub.getKey("auth");
              await sb.from("push_subscriptions").upsert({
                user_id: currentUser.id,
                endpoint: sub.endpoint,
                p256dh: btoa(String.fromCharCode(...new Uint8Array(key))),
                auth_key: btoa(String.fromCharCode(...new Uint8Array(auth)))
              }, { onConflict: "user_id,endpoint" });
            }
          } catch (e) {
            console.log("Push subscription failed:", e.message);
          }
        }
      }
      renderNotifCard();
    }

    function renderNotifCard() {
      const COLORS = getColors();
      const dot = document.getElementById("notif-status-dot");
      const lbl = document.getElementById("notif-status-lbl");
      const detail = document.getElementById("notif-detail");
      const btn = document.getElementById("btn-notif-enable");
      if (!dot) return;
      if (!("Notification" in window)) {
        dot.style.color = COLORS.dim;
        lbl.textContent = "Not supported";
        if (detail) detail.textContent = "Use Safari on iOS 16.4+ with the app installed to the home screen.";
        if (btn) btn.style.display = "none";
        return;
      }
      const perm = Notification.permission;
      if (perm === "granted") {
        dot.style.color = COLORS.green;
        lbl.textContent = "Enabled";
        if (detail) detail.textContent = "Morning journal reminder, protocol nudges, and recovery alerts are scheduled.";
        if (btn) btn.textContent = "Reschedule";
      } else if (perm === "denied") {
        dot.style.color = COLORS.red;
        lbl.textContent = "Blocked";
        if (detail) detail.textContent = "Blocked in browser settings. Open Settings > Safari > Notifications to re-enable.";
        if (btn) btn.style.display = "none";
      } else {
        dot.style.color = COLORS.dim;
        lbl.textContent = "Not enabled";
        if (detail) detail.textContent = "Tap to enable. Must be installed to the home screen on iOS.";
        if (btn) btn.style.display = "block";
      }
    }

    function init() {
      document.getElementById("btn-notif-enable").addEventListener("click", requestNotificationPermission);
    }

    return { init, render: renderNotifCard, initServiceWorker };
  }

  global.BioCommandNotifications = { createNotificationsModule };
})(window);
