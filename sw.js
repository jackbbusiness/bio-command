/* ============================================================
   BIO-COMMAND SERVICE WORKER v1.0
   Strategies:
     - App shell (index.html, manifest.json): cache-first with
       background update.
     - Everything else: network-first with cache fallback.
   Notifications:
     - Scheduled local: app sends SCHEDULE_NOTIFICATIONS message
       on every open; SW fires showNotification at the given times.
       Works on iOS 16.4+ PWA even when app is in recent background.
     - Push: handler ready for VAPID pushes from the Supabase
       Edge Function cron once that step is configured.
   ============================================================ */

const CACHE_VERSION = "bc-v2.6.0-fuel-redesign";
const APP_ROOT = self.registration.scope;
const SHELL_URLS = [
  APP_ROOT,
  APP_ROOT + "index.html",
  APP_ROOT + "manifest.json",
  APP_ROOT + "css/app.css?v=2.6.0",
  APP_ROOT + "css/intelligence.css?v=2.3.1",
  APP_ROOT + "css/history.css?v=2.3.1",
  APP_ROOT + "js/vendor/supabase.min.js?v=2.112.0",
  APP_ROOT + "js/vendor/html5-qrcode.min.js?v=2.3.8",
  APP_ROOT + "js/theme-boot.js?v=2.3.0",
  APP_ROOT + "js/modules/storage.js?v=2.2.2",
  APP_ROOT + "js/modules/shared/dates.js?v=2.2.2",
  APP_ROOT + "js/modules/shared/formatting.js?v=2.2.2",
  APP_ROOT + "js/modules/shared/dom.js?v=2.2.2",
  APP_ROOT + "js/modules/shared/ids.js?v=2.2.2",
  APP_ROOT + "js/modules/shared/colors.js?v=2.3.1",
  APP_ROOT + "js/modules/shared/charts.js?v=2.3.3",
  APP_ROOT + "js/modules/shared/scoring.js?v=2.2.2",
  APP_ROOT + "js/modules/shared/sanitize.js?v=2.2.2",
  APP_ROOT + "js/modules/shared/focus-trap.js?v=2.3.2",
  APP_ROOT + "js/modules/shared/stepper.js?v=2.5.0",
  APP_ROOT + "js/modules/shared/score-ring.js?v=2.3.3",
  APP_ROOT + "js/modules/shared/toast.js?v=2.3.3",
  APP_ROOT + "js/modules/shared/ai-stream.js?v=2.6.0",
  APP_ROOT + "js/modules/history/index.js?v=2.2.2",
  APP_ROOT + "js/modules/fuel/index.js?v=2.6.0",
  APP_ROOT + "js/modules/training/index.js?v=2.5.0",
  APP_ROOT + "js/modules/journal/index.js?v=2.2.2",
  APP_ROOT + "js/modules/biomarkers/index.js?v=2.2.2",
  APP_ROOT + "js/modules/protocols/index.js?v=2.2.2",
  APP_ROOT + "js/modules/dashboard/index.js?v=2.4.0",
  APP_ROOT + "js/modules/settings/index.js?v=2.3.1",
  APP_ROOT + "js/modules/data-management/index.js?v=2.2.2",
  APP_ROOT + "js/modules/sync/index.js?v=2.4.0",
  APP_ROOT + "js/modules/notifications/index.js?v=2.2.2",
  APP_ROOT + "js/app.js?v=2.6.0",
  APP_ROOT + "js/intelligence.js?v=2.2.2",
  APP_ROOT + "js/history.js?v=2.2.2"
];

/* ---------- Install ---------- */

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(SHELL_URLS))
      .catch(() => {}) // non-fatal if offline at install time
  );
  self.skipWaiting();
});

/* ---------- Activate ---------- */

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* ---------- Fetch (offline-first app shell) ---------- */

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Only intercept same-origin GET requests. API calls (Supabase, Anthropic) pass through.
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;

  const isShell = SHELL_URLS.some((p) => event.request.url === p);
  if (isShell) {
    // Cache-first, then update in background
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request).then((res) => {
          if (res.ok) {
            caches.open(CACHE_VERSION).then((c) => c.put(event.request, res.clone()));
          }
          return res;
        });
        return cached || network;
      })
    );
  } else {
    // Network-first, cache fallback
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(event.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});

/* ---------- Scheduled local notifications ---------- */

let scheduledTimers = [];

function clearScheduled() {
  scheduledTimers.forEach((t) => clearTimeout(t));
  scheduledTimers = [];
}

function scheduleOne(notif) {
  const delay = notif.at - Date.now();
  if (delay < 0 || delay > 86400000) return; // skip past or >24h future
  const t = setTimeout(() => {
    self.registration.showNotification(notif.title, {
      body: notif.body,
      icon: new URL("icon-192.png", APP_ROOT).href,
      badge: new URL("icon-192.png", APP_ROOT).href,
      tag: notif.tag || "biocommand",
      data: { url: notif.url || APP_ROOT },
      requireInteraction: false,
      silent: false
    });
  }, delay);
  scheduledTimers.push(t);
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SCHEDULE_NOTIFICATIONS") {
    clearScheduled();
    (event.data.notifications || []).forEach(scheduleOne);
    event.ports[0] && event.ports[0].postMessage({ ok: true, count: event.data.notifications.length });
  }
  if (event.data && event.data.type === "CLEAR_NOTIFICATIONS") {
    clearScheduled();
  }
});

/* ---------- Push (VAPID, from Supabase Edge Function) ---------- */

self.addEventListener("push", (event) => {
  if (!event.data) return;
  let payload;
  try { payload = event.data.json(); } catch (e) { payload = { title: "Bio-Command", body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(payload.title || "Bio-Command", {
      body: payload.body || "",
      icon: new URL("icon-192.png", APP_ROOT).href,
      badge: new URL("icon-192.png", APP_ROOT).href,
      tag: payload.tag || "biocommand-push",
      data: { url: payload.url || APP_ROOT },
      requireInteraction: false
    })
  );
});

/* ---------- Notification click ---------- */

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || APP_ROOT;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if (c.url.startsWith(self.location.origin) && "focus" in c) {
          return c.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    })
  );
});
