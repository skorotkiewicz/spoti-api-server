import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { errors } from 'playwright';
import { ApiError, BrowserQueue, Cache } from './core.js';
import { SpotifyBrowser, type Snapshot } from './spotify.js';

const ID = /^[A-Za-z0-9]{22}$/;
const digest = (value: string) => createHash('sha256').update(value).digest();

function send(res: ServerResponse, status: number, data: unknown, cache?: string) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(cache ? { 'X-Cache': cache } : {}),
    ...(status === 429 || status === 503 ? { 'Retry-After': '30' } : {}),
  });
  res.end(JSON.stringify(data));
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 4096) {
      req.resume();
      throw new ApiError(413, 'BODY_TOO_LARGE', 'Request body must be at most 4096 bytes.');
    }
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return {};
  if (req.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') {
    throw new ApiError(415, 'JSON_REQUIRED', 'Use Content-Type: application/json.');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Body must be a JSON object.');
  }
}

export function createApi(spotify: SpotifyBrowser, token: string, cacheTtlMs = 300_000) {
  if (token.length < 32) throw new Error('API_TOKEN must contain at least 32 characters.');
  const expected = digest(`Bearer ${token}`);
  const queue = new BrowserQueue();
  const cache = new Cache<Snapshot>();
  return createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, async (req, res) => {
    try {
      // Reject browser-origin requests as well as requiring a token. No CORS or cookie authentication.
      if (req.headers.origin || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new ApiError(403, 'ORIGIN_FORBIDDEN', 'Use a server-side client, not a cross-origin browser request.');
      }
      if (!timingSafeEqual(expected, digest(req.headers.authorization ?? ''))) {
        res.setHeader('WWW-Authenticate', 'Bearer');
        throw new ApiError(401, 'UNAUTHORIZED', 'A valid bearer token is required.');
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//') || req.url.length > 2048) {
        throw new ApiError(400, 'INVALID_URL', 'Invalid request URL.');
      }
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;
      const params = [...url.searchParams.keys()];
      if (params.some((key) => path !== '/v1/search' || key !== 'q') || new Set(params).size !== params.length) {
        throw new ApiError(400, 'INVALID_QUERY', 'Only one q parameter on /v1/search is supported.');
      }
      if (req.method === 'GET' && path === '/health') {
        send(res, 200, { ok: true });
        return;
      }
      let load: (() => Promise<Snapshot>) | undefined;
      let key = path;
      let ttl = cacheTtlMs;
      let privateRead = false;
      if (req.method === 'GET') {
        const entity = path.match(/^\/v1\/(tracks|albums|artists|playlists)\/([A-Za-z0-9]{22})$/);
        if (entity) load = () => spotify.snapshot(`/${entity[1]!.slice(0, -1)}/${entity[2]}`);
        if (path === '/v1/search') {
          const q = url.searchParams.get('q')?.trim();
          if (!q || q.length > 200 || /[\u0000-\u001f\u007f]/.test(q)) {
            throw new ApiError(400, 'INVALID_QUERY', 'q must contain 1 to 200 characters, without control characters.');
          }
          key = `${path}?q=${encodeURIComponent(q)}`;
          load = () => spotify.snapshot(`/search/${encodeURIComponent(q)}`, 'search');
        }
        if (path === '/v1/me/library' || path === '/v1/me/tracks') {
          privateRead = true;
          ttl = Math.min(ttl, 30_000);
          load = () => spotify.snapshot(path.endsWith('/tracks') ? '/collection/tracks' : '/collection', 'library');
        }
      }
      const control = req.method === 'POST' ? path.match(/^\/v1\/player\/(play|pause|next|previous)$/) : null;
      let trackId: string | undefined;
      if (control) {
        const data = await body(req);
        if (Object.keys(data).some((key) => key !== 'trackId') ||
          (data.trackId !== undefined && (control[1] !== 'play' || typeof data.trackId !== 'string' || !ID.test(data.trackId)))) {
          throw new ApiError(400, 'INVALID_BODY', 'Only play accepts trackId, a 22-character Spotify ID. Other controls require an empty object.');
        }
        trackId = data.trackId as string | undefined;
      }
      const session = req.method === 'GET' && path === '/v1/session';
      const player = req.method === 'GET' && path === '/v1/player';
      const clear = req.method === 'DELETE' && path === '/v1/cache';
      if (!load && !control && !session && !player && !clear) {
        throw new ApiError(404, 'ROUTE_NOT_FOUND', 'Unknown route, method, or invalid Spotify ID. See docs/api.md.');
      }
      await queue.run(async () => {
        if (res.destroyed) return;
        if (load) {
          if (privateRead) await spotify.requireAccount();
          const result = await cache.read(key, ttl, load);
          send(res, 200, result.data, result.cache);
        } else if (session) {
          await spotify.open();
          send(res, 200, await spotify.session());
        } else if (player) {
          send(res, 200, await spotify.player());
        } else if (control) {
          cache.clear();
          send(res, 202, await spotify.control(control[1] as 'play' | 'pause' | 'next' | 'previous', trackId));
        } else if (clear) {
          cache.clear();
          send(res, 200, { cleared: true });
        }
      });
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      const problem = error instanceof ApiError ? error
        : error instanceof errors.TimeoutError
          ? new ApiError(504, 'BROWSER_TIMEOUT', 'Spotify did not expose the expected UI in time. Check login, language, consent dialogs, and selector compatibility.')
          : new ApiError(502, 'BROWSER_ERROR', 'Browser operation failed. Check the browser session and restart if it closed.');
      send(res, problem.status, { error: { code: problem.code, message: problem.message } });
    }
  });
}
