import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import type { Browser, Page } from 'puppeteer-core';
import { browserType, launchBrowser } from '../src/browser.js';
import { ApiError, BrowserQueue, Cache } from '../src/core.js';
import { createApi } from '../src/server.js';
import { SpotifyBrowser } from '../src/spotify.js';

const token = 'test-token-'.repeat(4);
const id = 'A'.repeat(22);
let browser: Browser;
let page: Page;
let server: ReturnType<typeof createApi>;
let base: string;
let loggedIn = true;
let upstreamError = false;
const visits = new Map<string, number>();

before(async () => {
  browser = await launchBrowser();
  page = await browser.newPage();
  // Offline UI contract fixture. This is not evidence of current authenticated Spotify compatibility.
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    if (!request.isNavigationRequest()) {
      await request.abort();
      return;
    }
    const path = new URL(request.url()).pathname;
    visits.set(path, (visits.get(path) ?? 0) + 1);
    if (upstreamError) {
      await request.respond({ status: 503, body: 'Unavailable' });
      return;
    }
    const empty = path === '/search/nothing';
    await request.respond({ contentType: 'text/html', body: `<!doctype html>
      <html lang="en"><body>
      <button data-testid="${loggedIn ? 'user-widget-link' : 'login-button'}">Account</button>
      <main>${path.startsWith('/search/') ? '' : '<h1>Test resource</h1>'}
        ${empty ? '<p>No results found</p>' : `
          <a href="/track/${id}?si=ignored">Test song</a>
          <a href="https://open.spotify.com/track/${id}">Duplicate</a>
          <a href="/artist/${id}">Test artist</a>
          <a href="https://evil.example/track/${id}">External</a>
          <button data-testid="play-button" aria-label="Play Test song" onclick="document.querySelector('[data-testid=control-button-playpause]').setAttribute('aria-label','Pause')">Play</button>`}
      </main>
      <aside data-testid="now-playing-bar">
        <a href="/track/${id}">Test song</a>
        <button data-testid="control-button-playpause" aria-label="Play"
          onclick="this.dataset.clicks=String(Number(this.dataset.clicks||0)+1);this.setAttribute('aria-label',this.getAttribute('aria-label')==='Play'?'Pause':'Play')">Toggle</button>
        <button data-testid="control-button-skip-forward" onclick="this.dataset.clicked='yes'">Next</button>
        <button data-testid="control-button-skip-back" disabled>Previous</button>
        <span data-testid="playback-position">0:10</span><span data-testid="playback-duration">3:00</span>
      </aside>
      <script>
        if (location.pathname === '/search/delayed') setTimeout(() => {
          const link = document.createElement('a');
          link.href = '/track/${'B'.repeat(22)}';
          link.textContent = 'Late result';
          document.querySelector('main').append(link);
        }, 200);
      </script>
      </body></html>` });
  });
  const spotify = new SpotifyBrowser(page);
  await spotify.open();
  server = createApi(spotify, token);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await browser?.close();
});

const request = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, {
  ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers },
});
const control = (action: string, data: unknown = {}) => request(`/v1/player/${action}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
});

test('authentication and input validation block invalid requests before browser work', async () => {
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await request('/health', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await request('/health', { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/v1/search?q=')).status, 400);
  assert.equal((await request('/v1/search?q=a&q=b')).status, 400);
  assert.equal((await request('/v1/search?q=a&url=https://evil.example')).status, 400);
  assert.equal((await request('/v1/tracks/invalid')).status, 404);
  assert.equal((await control('play', { trackId: 'https://evil.example' })).status, 400);
  assert.equal((await control('pause', { trackId: id })).status, 400);
  assert.equal((await control('play', { unexpected: true })).status, 400);
  assert.equal((await control('play', [])).status, 400);
  assert.equal((await request('/v1/player/play', { method: 'POST', body: '{}' })).status, 415);
  assert.equal((await request('/v1/player/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
  assert.equal((await control('play', { padding: 'x'.repeat(5000) })).status, 413);
});

test('DOM extraction, normalized cache keys, concurrent misses, and explicit invalidation', async () => {
  const responses = await Promise.all([request('/v1/search?q=Test'), request('/v1/search?q=%20Test%20')]);
  assert.deepEqual(responses.map((r) => r.status), [200, 200]);
  assert.deepEqual(responses.map((r) => r.headers.get('x-cache')), ['MISS', 'HIT']);
  const data = await responses[0]!.json();
  assert.equal(data.complete, false);
  assert.equal(data.title, null);
  assert.equal(data.items.length, 2);
  assert.deepEqual(data.items[0], { type: 'track', id, name: 'Test song', url: `https://open.spotify.com/track/${id}` });
  assert.equal(visits.get('/search/Test'), 1);
  assert.equal((await request('/v1/cache', { method: 'DELETE' })).status, 200);
  assert.equal((await request('/v1/search?q=Test')).headers.get('x-cache'), 'MISS');
  assert.equal(visits.get('/search/Test'), 2);
  assert.equal((await request('/v1/search?q=nothing')).status, 200);
  for (const type of ['tracks', 'albums', 'artists', 'playlists']) {
    const result = await request(`/v1/${type}/${id}`);
    assert.equal(result.status, 200);
    assert.equal((await result.json()).title, 'Test resource');
  }
});

test('snapshots include results that arrive after the first link renders', async () => {
  const response = await request('/v1/search?q=delayed');
  assert.equal(response.status, 200);
  const data = await response.json();
  assert(data.items.some((item: { name: string }) => item.name === 'Late result'));
});

test('upstream errors are not cached and do not poison the browser queue', async () => {
  upstreamError = true;
  assert.equal((await request('/v1/search?q=retry')).status, 502);
  upstreamError = false;
  const response = await request('/v1/search?q=retry');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-cache'), 'MISS');
  assert.equal(visits.get('/search/retry'), 2);
});

test('account reads require Spotify login, including private cache hits', async () => {
  assert.deepEqual(await (await request('/v1/session')).json(), { authenticated: true });
  assert.equal((await request('/v1/me/library')).status, 200);
  assert.equal((await request('/v1/me/tracks')).status, 200);
  loggedIn = false;
  assert.deepEqual(await (await request('/v1/session')).json(), { authenticated: false });
  for (const path of ['/v1/me/library', '/v1/me/tracks', '/v1/player']) {
    const response = await request(path);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'SPOTIFY_LOGIN_REQUIRED');
  }
  assert.equal((await control('play')).status, 401);
  loggedIn = true;
  await request('/v1/session');
});

test('play and pause are idempotent; unavailable controls report errors', async () => {
  assert.equal((await control('play')).status, 202);
  assert.equal((await control('play')).status, 202);
  assert.equal((await (await request('/v1/player')).json()).playing, true);
  assert.equal(await page.$eval('[data-testid="control-button-playpause"]', (e) => e.getAttribute('data-clicks')), '1');
  assert.equal((await control('pause')).status, 202);
  assert.equal((await control('pause')).status, 202);
  assert.equal((await (await request('/v1/player')).json()).playing, false);
  assert.equal(await page.$eval('[data-testid="control-button-playpause"]', (e) => e.getAttribute('data-clicks')), '2');
  assert.equal((await control('next')).status, 202);
  assert.equal(await page.$eval('[data-testid="control-button-skip-forward"]', (e) => e.getAttribute('data-clicked')), 'yes');
  assert.equal((await control('previous')).status, 409);
  assert.equal((await control('play', { trackId: id })).status, 202);
  assert.equal((await (await request('/v1/player')).json()).playing, true);
});

test('browser selection recognizes Firefox paths without changing Chromium selection', () => {
  assert.equal(browserType('/usr/sbin/firefox'), 'firefox');
  assert.equal(browserType('/usr/bin/firefox-esr'), 'firefox');
  assert.equal(browserType('/usr/sbin/chromium'), 'chrome');
  assert.equal(browserType('/opt/google/chrome/chrome'), 'chrome');
});

test('cache expiration, eviction, bypass, and failed loads', async () => {
  let now = 0;
  const cache = new Cache<number>(2, () => now);
  let calls = 0;
  const load = async () => ++calls;
  assert.equal((await cache.read('a', 10, load)).cache, 'MISS');
  assert.equal((await cache.read('a', 10, load)).cache, 'HIT');
  now = 10;
  assert.equal((await cache.read('a', 10, load)).cache, 'MISS');
  await cache.read('b', 10, load);
  await cache.read('c', 10, load);
  assert.equal((await cache.read('a', 10, load)).cache, 'MISS');
  assert.equal((await cache.read('off', 0, load)).cache, 'MISS');
  assert.equal((await cache.read('off', 0, load)).cache, 'MISS');
  await assert.rejects(cache.read('error', 10, async () => { throw new Error('failed'); }));
  assert.equal((await cache.read('error', 10, load)).cache, 'MISS');
  cache.clear();
  assert.equal((await cache.read('error', 10, load)).cache, 'MISS');
});

test('queue is bounded, serial, and recovers after failure', async () => {
  const queue = new BrowserQueue();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const order: number[] = [];
  const jobs = Array.from({ length: 16 }, (_, i) => queue.run(async () => {
    await gate;
    order.push(i);
    if (i === 3) throw new Error('expected');
  }));
  const settled = Promise.allSettled(jobs);
  await assert.rejects(queue.run(async () => {}), (e: unknown) => e instanceof ApiError && e.code === 'BUSY');
  release();
  const results = await settled;
  assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  assert.deepEqual(order, Array.from({ length: 16 }, (_, i) => i));
  assert.equal(await queue.run(async () => 42), 42);
});
