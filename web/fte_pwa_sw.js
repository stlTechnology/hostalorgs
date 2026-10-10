// Kill switch. The engine's original worker cached the page cache-first on install
// and never changed, so a browser that visited once kept that first index.html
// forever: the owner played a3a364e's game code inside an old page with no help
// panel and no class menu. This version replaces it in every browser that has it:
// it clears every cache, unregisters itself and reloads open tabs from the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) =>
{
	event.waitUntil((async () =>
	{
		for (const key of await caches.keys())
			await caches.delete(key);
		await self.registration.unregister();
		for (const client of await self.clients.matchAll({ type: 'window' }))
			client.navigate(client.url);
	})());
});
