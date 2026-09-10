import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';

const token = 'local-tui-test-token-'.repeat(3);
const id = '4uLU6hMCjMI75M1A2tKUQC';
const executable = new URL('../src/tui.js', import.meta.url);

async function run(api: string, commands: string, apiToken = token) {
  const child = spawn(process.execPath, [executable.pathname], {
    env: { ...process.env, API_URL: api, API_TOKEN: apiToken }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  const finished = once(child, 'close');
  child.stdin.end(commands);
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try {
    const [code] = await finished;
    assert(!output.includes(token), 'The bearer token must not appear in terminal output');
    return { code, output };
  } finally { clearTimeout(timer); }
}

test('TUI searches, paginates, selects tracks, and sends authenticated playback requests', async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let playing = false;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${token}`);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    calls.push({ path: req.url!, method: req.method!, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') {
      assert.equal(req.headers['content-type'], 'application/json');
      playing = req.url !== '/v1/player/pause';
      res.writeHead(202);
      res.end(JSON.stringify({ accepted: true }));
    } else if (req.url === '/v1/player') {
      res.end(JSON.stringify({ playing, track: { name: 'Test song' }, position: '0:10', duration: '3:00' }));
    } else {
      const items = Array.from({ length: 13 }, (_, i) => ({
        type: 'track', id: i === 0 ? id : String(i).padStart(22, 'A'), name: `Track ${i + 1}`,
      }));
      items[0]!.name = 'Safe\x1b[31m title\x1b[0m\x1b]52;c;clipboard\x07';
      res.end(JSON.stringify({ items: [...items, { type: 'artist', id, name: 'Not a track' }] }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { code, output } = await run(base, `s Daft Punk & friends\n]\n[\n1\npause\nplay\nnext\nprev\nplay ${id}\nl\nr\nq\n`);
    assert.equal(code, 0, output);
    assert(output.includes('Page 2/2'));
    assert(output.includes('13. Track 13'));
    assert(output.includes('Safe title'));
    assert(!output.includes('\x1b'), 'API content must not inject terminal control sequences');
    assert(!output.includes('Not a track'));
    assert(output.includes('Playing: Test song'));
    assert(output.includes('Paused: Test song'));
    assert(output.includes('Liked songs'));
    assert(calls.some((call) => call.path === '/v1/search?q=Daft%20Punk%20%26%20friends'));
    assert.deepEqual(calls.filter((call) => call.method === 'POST'), [
      { path: '/v1/player/play', method: 'POST', body: { trackId: id } },
      { path: '/v1/player/pause', method: 'POST', body: {} },
      { path: '/v1/player/play', method: 'POST', body: {} },
      { path: '/v1/player/next', method: 'POST', body: {} },
      { path: '/v1/player/previous', method: 'POST', body: {} },
      { path: '/v1/player/play', method: 'POST', body: { trackId: id } },
    ]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('TUI reports API failures and invalid input without sending accidental controls', async () => {
  let controls = 0;
  const server = createServer((req, res) => {
    if (req.method === 'POST') controls++;
    res.setHeader('Content-Type', 'application/json');
    if (req.url?.startsWith('/v1/search')) {
      res.end(JSON.stringify({ items: [{ type: 'track', id: '../../bad', name: 'Bad ID' }] }));
    } else {
      res.writeHead(401);
      res.end(JSON.stringify({ error: { message: 'Spotify login required.' } }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { code, output } = await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 's test\n1\nplay invalid\npause extra\ns\nunknown\nq\n');
    assert.equal(code, 0);
    assert(output.includes('HTTP 401: Spotify login required.'));
    assert(output.includes('API returned an invalid track entry.'));
    assert(output.includes('Choose a listed track number'));
    assert(output.includes('This command takes no arguments.'));
    assert(output.includes('Unknown command.'));
    assert.equal(controls, 0);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('TUI does not retry accepted actions, follow redirects, or hang on interruption', async () => {
  let mode = 'invalid-json';
  let controls = 0;
  let redirected = 0;
  let arrived = () => {};
  const server = createServer((req, res) => {
    req.resume();
    if (req.url === '/forbidden') redirected++;
    if (mode === 'hang') { arrived(); return; }
    if (mode === 'redirect') { res.writeHead(302, { Location: '/forbidden' }); res.end(); return; }
    if (mode === 'invalid-json') { res.end('not JSON'); return; }
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST') { controls++; res.writeHead(202); res.end('{"accepted":true}'); }
    else { res.writeHead(503); res.end('{"error":{"message":"State unavailable"}}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    assert((await run(base, 'q\n')).output.includes('API returned invalid JSON.'));
    mode = 'read-error';
    const accepted = await run(base, 'play\nq\n');
    assert.equal(accepted.code, 0);
    assert(accepted.output.includes('Action accepted. State check failed: HTTP 503'));
    assert.equal(controls, 1);
    mode = 'redirect';
    assert((await run(base, 'q\n')).output.includes('API connection failed.'));
    assert.equal(redirected, 0);
    mode = 'hang';
    const requested = new Promise<void>((resolve) => { arrived = resolve; });
    const child = spawn(process.execPath, [executable.pathname], {
      env: { ...process.env, API_URL: base, API_TOKEN: token }, stdio: ['pipe', 'ignore', 'ignore'],
    });
    const finished = once(child, 'close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await requested;
      child.kill('SIGINT');
      assert.equal((await finished)[0], 0, 'SIGINT must cancel the pending request and exit cleanly');
    } finally { clearTimeout(timer); }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('TUI rejects missing tokens and unsafe API origins before making requests', async () => {
  const missing = await run('http://127.0.0.1:1', 'q\n', '');
  assert.equal(missing.code, 1);
  assert(missing.output.includes('Set API_TOKEN'));
  for (const base of ['http://example.com', 'https://user:password@example.com', 'http://127.0.0.1/v1']) {
    const invalid = await run(base, 'q\n');
    assert.equal(invalid.code, 1);
    assert(invalid.output.includes('API_URL must be'));
  }
});
