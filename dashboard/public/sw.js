// Service worker: shows Web Push notifications even when the dashboard is closed.
// The payload is {title, body, tag, url}, sent (encrypted) by the push-send edge function.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Snap Loans", {
      body: data.body || "",
      tag: data.tag || undefined,          // one notification per lead, even if it arrives twice
      renotify: !!data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      lang: "he",
      dir: "rtl",
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of windows) {
      if ("focus" in w) return w.focus();
    }
    return self.clients.openWindow(url);
  })());
});
