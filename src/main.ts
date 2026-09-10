import { chmod, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { browserType, launchBrowser } from './browser.js';
import { createApi } from './server.js';
import { SpotifyBrowser } from './spotify.js';

function integer(name: string, fallback: number, min: number, max: number) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

async function main() {
  const login = process.argv[2] === 'login';
  if (process.argv.length > (login ? 3 : 2)) throw new Error('Usage: npm start, or npm run login');
  if (login && !process.stdin.isTTY) throw new Error('Run login in an interactive terminal with a desktop display.');
  const token = process.env.API_TOKEN ?? '';
  if (!login && (token.length < 32 || !/^[\x21-\x7e]+$/.test(token))) {
    throw new Error('Set API_TOKEN to at least 32 printable non-space ASCII characters. See docs/setup.md.');
  }
  const port = integer('PORT', 3210, 1, 65535);
  const ttl = integer('CACHE_TTL_SECONDS', 300, 0, 3600) * 1000;
  if (process.env.HEADLESS !== undefined && !['0', '1'].includes(process.env.HEADLESS)) {
    throw new Error('HEADLESS must be 0 or 1.');
  }
  const profile = resolve(process.env.SPOTIFY_PROFILE_DIR ?? '.spotify-profile', browserType());
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await chmod(profile, 0o700);
  const browser = await launchBrowser(profile, !login && process.env.HEADLESS !== '0');
  const page = (await browser.pages())[0] ?? await browser.newPage();
  const spotify = new SpotifyBrowser(page);
  try {
    await spotify.open();
    if (login) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        await prompt.question('Log in to Spotify in the browser, set its language to English, and return to the web player. Press Enter here when done. ');
        await spotify.requireAccount();
        console.log('Spotify session saved. You can start the server now.');
      } finally {
        prompt.close();
        await browser.close();
      }
      return;
    }
    const server = createApi(spotify, token, ttl);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    console.log(`Spotify browser API listening on http://127.0.0.1:${port}`);
    const shutdown = async () => {
      server.close();
      server.closeAllConnections();
      await browser.close();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    browser.once('disconnected', () => {
      server.close();
      server.closeAllConnections();
    });
  } catch (error) {
    await browser.close();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Startup failed.');
  process.exitCode = 1;
});
