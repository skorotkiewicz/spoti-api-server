import { createInterface } from 'node:readline';
import { stripVTControlCharacters } from 'node:util';
import type { Snapshot } from './spotify.js';

type Track = Pick<Snapshot['items'][number], 'id' | 'name'>;
const ID = /^[A-Za-z0-9]{22}$/;
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ');
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('API returned an invalid response.');
  return value as Record<string, unknown>;
};

async function main() {
  const token = process.env.API_TOKEN ?? '';
  if (token.length < 32 || !/^[\x21-\x7e]+$/.test(token)) {
    throw new Error('Set API_TOKEN to the same token used by the API server.');
  }
  const base = new URL(process.env.API_URL ?? `http://127.0.0.1:${process.env.PORT ?? '3210'}`);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
    !(base.protocol === 'https:' || (base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)))) {
    throw new Error('API_URL must be an HTTPS origin or a local HTTP origin, without credentials or a path.');
  }
  const stopping = new AbortController();
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const input = createInterface({ input: process.stdin, output: process.stdout, terminal, historySize: 0 });
  const lines = input[Symbol.asyncIterator]();
  const stop = () => { stopping.abort(); input.close(); };
  input.on('SIGINT', stop);
  if (terminal) input.on('close', () => stopping.abort());
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const request = async (path: string, body?: Record<string, string>) => {
    process.stdout.write('Waiting for API...\n');
    try {
      const response = await fetch(new URL(path, base), {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.any([stopping.signal, AbortSignal.timeout(60_000)]),
      });
      const data = object(await response.json().catch((error: unknown) => {
        if (error instanceof SyntaxError) throw new Error('API returned invalid JSON. Refresh before retrying an action.');
        throw error;
      }));
      if (!response.ok) {
        const detail = data.error && typeof data.error === 'object' ? object(data.error).message : null;
        throw new Error(`HTTP ${response.status}: ${typeof detail === 'string' ? detail : 'API request failed.'}`);
      }
      return data;
    } catch (error) {
      if (stopping.signal.aborted) throw error;
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new Error('Request timed out. An action may have completed. Refresh before retrying.');
      }
      if (error instanceof TypeError) {
        throw new Error('API connection failed. Check server and API_URL; refresh before retrying actions.');
      }
      throw error;
    }
  };

  let tracks: Track[] = [];
  let page = 0;
  let heading = 'Search for a track, or load liked songs.';
  let status = 'Player state unavailable';
  let notice = 'Ready. Commands take effect when you press Enter.';
  const message = (error: unknown) => clean(error instanceof Error ? error.message : 'Request failed.').replaceAll(token, '[redacted]');
  const pageSize = () => Math.max(1, Math.min(10, (process.stdout.rows ?? 24) - 13));

  const refresh = async () => {
    status = 'Player state unavailable';
    const player = await request('/v1/player');
    if (![true, false, null].includes(player.playing as boolean | null) ||
      ![player.position, player.duration].every((value) => value === null || typeof value === 'string')) {
      throw new Error('API returned invalid player state.');
    }
    const track = player.track === null ? null : object(player.track);
    if (track && typeof track.name !== 'string') throw new Error('API returned invalid track state.');
    const state = player.playing === true ? 'Playing' : player.playing === false ? 'Paused' : 'Unknown';
    status = `${state}: ${track?.name ?? 'No track'}  ${player.position ?? '?'} / ${player.duration ?? '?'}`;
  };

  const list = async (path: string, title: string) => {
    const result = await request(path);
    if (!Array.isArray(result.items) || result.items.length > 200) throw new Error('API returned an invalid track list.');
    const found: Track[] = [];
    for (const value of result.items) {
      const item = object(value);
      if (item.type !== 'track') continue;
      if (typeof item.id !== 'string' || !ID.test(item.id) || typeof item.name !== 'string') {
        throw new Error('API returned an invalid track entry.');
      }
      found.push({ id: item.id, name: item.name });
    }
    tracks = found;
    page = 0;
    heading = title;
    notice = tracks.length ? 'Enter a track number to play it. Lists contain rendered tracks only.' : 'No rendered tracks found.';
  };

  const render = () => {
    const width = Math.max(20, (process.stdout.columns ?? 88) - 1);
    const size = pageSize();
    const pages = Math.max(1, Math.ceil(tracks.length / size));
    page = Math.min(page, pages - 1);
    const screen = [
      'Spotify browser API', status, '',
      `${heading} | ${tracks.length} tracks | Page ${page + 1}/${pages}`,
      ...tracks.slice(page * size, (page + 1) * size).map((track, index) => `${page * size + index + 1}. ${track.name}`),
      '',
      's <query> search | l liked songs | <number> play result',
      'play [track ID or number] | pause | next | prev',
      '[ previous results | ] more results | r refresh | q quit',
      '', notice,
    ];
    if (terminal) process.stdout.write('\x1b[2J\x1b[H');
    process.stdout.write(screen.map((line) => clean(line).slice(0, width)).join('\n') + '\n');
    if (terminal && !stopping.signal.aborted) {
      input.setPrompt('spotify> ');
      input.prompt();
    }
  };

  try {
    try { await refresh(); } catch (error) { notice = message(error); }
    while (!stopping.signal.aborted) {
      render();
      const line = await lines.next();
      if (line.done) break;
      const match = line.value.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const command = match?.[1]?.toLowerCase() ?? 'r';
      const argument = match?.[2] ?? '';
      if (command === 'q' && !argument) break;
      try {
        if (argument && !['s', 'play'].includes(command)) throw new Error('This command takes no arguments.');
        if (command === 's') {
          if (!argument || argument.length > 200 || /[\u0000-\u001f\u007f]/.test(argument)) throw new Error('Use s followed by a search query, at most 200 characters.');
          await list(`/v1/search?q=${encodeURIComponent(argument)}`, `Search: ${argument}`);
        } else if (command === 'l') {
          await list('/v1/me/tracks', 'Liked songs');
        } else if (command === '[' || command === ']') {
          page = Math.max(0, Math.min(page + (command === ']' ? 1 : -1), Math.max(0, Math.ceil(tracks.length / pageSize()) - 1)));
        } else if (command === 'r') {
          // ponytail: refresh only on commands; add polling if unattended live state matters.
          await refresh();
          notice = 'Player state refreshed.';
        } else if (['play', 'pause', 'next', 'prev'].includes(command) || /^\d+$/.test(command)) {
          const selection = command === 'play' ? argument : /^\d+$/.test(command) ? command : '';
          const action = /^\d+$/.test(command) ? 'play' : command === 'prev' ? 'previous' : command;
          let trackId: string | undefined;
          if (selection) {
            trackId = ID.test(selection) ? selection : /^\d+$/.test(selection) ? tracks[Number(selection) - 1]?.id : undefined;
            if (!trackId) throw new Error('Choose a listed track number or a 22-character track ID.');
          }
          const result = await request(`/v1/player/${action}`, trackId ? { trackId } : {});
          if (result.accepted !== true) throw new Error('API did not confirm the action. Refresh before retrying.');
          notice = `${action} accepted. Audio output is not verified.`;
          try { await refresh(); } catch (error) { notice = `Action accepted. State check failed: ${message(error)}`; }
        } else {
          throw new Error('Unknown command. Use the commands shown above.');
        }
      } catch (error) {
        notice = message(error);
      }
    }
  } finally {
    input.close();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

main().catch((error: unknown) => {
  console.error(clean(error instanceof Error ? error.message : 'TUI failed to start.'));
  process.exitCode = 1;
});
