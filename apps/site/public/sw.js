/**
 * Service worker kill switch.
 *
 * This site does not use a service worker. It ships this file anyway because
 * `localhost:3000` — and any other shared dev origin — accumulates stale
 * registrations from every other project ever served there. A leftover worker
 * keeps intercepting fetches, which in an App Router app means it can answer an
 * RSC request with a cached response from a different application. The symptom
 * is a console error like `chunk.reason.enqueueModel is not a function`, because
 * the streamed payload no longer matches the running React runtime.
 *
 * A browser only requests this file when a registration already exists, so on a
 * clean origin it is never fetched. When it is fetched, the update installs this
 * worker, which immediately unregisters itself and reloads any open pages so
 * they are served directly by the network again.
 */

self.addEventListener("install", () => {
  // Skip the waiting phase so the stale worker is replaced immediately.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Drop anything the previous worker cached.
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));

      await self.registration.unregister();

      // Reload open tabs so they stop going through a worker entirely.
      const clients = await self.clients.matchAll({ type: "window" });
      for (const client of clients) {
        client.navigate(client.url);
      }
    })(),
  );
});
