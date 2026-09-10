import type { Page } from 'puppeteer-core';
import { ApiError } from './core.js';

const ORIGIN = 'https://open.spotify.com';
const ACCOUNT = '[data-testid="user-widget-link"], [data-testid="user-widget-button"]';
const LOGIN = '[data-testid="login-button"]';
const BAR = '[data-testid="now-playing-bar"]';

export type Snapshot = {
  url: string;
  title: string | null;
  text: string;
  items: { type: string; id: string; name: string; url: string }[];
  capturedAt: string;
  complete: false;
};

export class SpotifyBrowser {
  constructor(private page: Page) {
    page.setDefaultTimeout(12_000);
    page.setDefaultNavigationTimeout(30_000);
  }

  async open(path = '/') {
    const response = await this.page.goto(`${ORIGIN}${path}`, { waitUntil: 'domcontentloaded' });
    if (response?.status() === 429) {
      throw new ApiError(429, 'SPOTIFY_RATE_LIMITED', 'Spotify rate limited this browser. Wait before retrying.');
    }
    if (response && response.status() >= 400) {
      throw new ApiError(response.status() === 404 ? 404 : 502, 'SPOTIFY_PAGE_ERROR', 'Spotify could not load this page.');
    }
  }

  async session() {
    if (new URL(this.page.url()).hostname === 'accounts.spotify.com') return { authenticated: false };
    await (await this.page.waitForFunction((selector) =>
      [...document.querySelectorAll(selector)].some((element) => element.checkVisibility()),
    {}, `${ACCOUNT}, ${LOGIN}`)).dispose();
    return { authenticated: await this.page.evaluate((selector) =>
      [...document.querySelectorAll(selector)].some((element) => element.checkVisibility()), ACCOUNT) };
  }

  async requireAccount() {
    if (!(await this.session()).authenticated) {
      throw new ApiError(401, 'SPOTIFY_LOGIN_REQUIRED', 'Stop the server, run the login command, then restart.');
    }
  }

  async snapshot(path: string, mode: 'search' | 'entity' | 'library' = 'entity'): Promise<Snapshot> {
    await this.open(path);
    if (mode === 'library') await this.requireAccount();
    await (await this.page.waitForFunction((kind) => {
      const main = document.querySelector('main');
      if (!main) return false;
      const text = main.textContent ?? '';
      if (/no results found|couldn't find|could not find|something went wrong|this page is not available|this playlist is not available|your liked songs will appear here|save your favourite songs|save your favorite songs|create your first playlist/i.test(text)) return true;
      if (kind === 'search') return [...main.querySelectorAll<HTMLAnchorElement>('a[href]')].some((link) =>
        /\/(track|artist|album|playlist)\/[A-Za-z0-9]{22}/.test(link.pathname) && link.checkVisibility() && link.innerText.trim());
      return !!main.querySelector('h1');
    }, {}, mode)).dispose();
    // ponytail: wait for 500 ms of settled content, capped at 3 s; add scrolling/pagination for complete lists.
    await this.page.evaluate(() => new Promise<void>((resolve) => {
      const main = document.querySelector('main')!;
      let quiet: number;
      const finish = () => {
        observer.disconnect();
        window.clearTimeout(quiet);
        window.clearTimeout(deadline);
        resolve();
      };
      const observer = new MutationObserver(() => {
        window.clearTimeout(quiet);
        quiet = window.setTimeout(finish, 500);
      });
      const deadline = window.setTimeout(finish, 3000);
      quiet = window.setTimeout(finish, 500);
      observer.observe(main, { childList: true, subtree: true, characterData: true });
    }));
    const snapshot = await this.page.evaluate(() => {
      const main = document.querySelector<HTMLElement>('main')!;
      const found = new Map<string, { type: string; id: string; name: string; url: string }>();
      for (const link of main.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const url = new URL(link.href);
        const match = url.pathname.match(/^\/(?:intl-[^/]+\/)?(track|album|artist|playlist)\/([A-Za-z0-9]{22})\/?$/);
        const name = (link.innerText || link.title || link.getAttribute('aria-label') || link.querySelector('img')?.alt || '').trim();
        if (url.origin !== 'https://open.spotify.com' || !match || !name || !link.checkVisibility()) continue;
        const [, type, id] = match as [string, string, string];
        const key = `${type}/${id}`;
        if (!found.has(key)) found.set(key, { type, id, name, url: `https://open.spotify.com/${key}` });
        if (found.size >= 200) break;
      }
      return {
        url: location.href,
        title: main.querySelector('h1')?.textContent ?? null,
        text: main.innerText.slice(0, 30_000),
        items: [...found.values()],
        capturedAt: new Date().toISOString(),
        complete: false as const,
      };
    });
    if (/couldn't find|could not find|this page is not available|this playlist is not available/i.test(snapshot.text.slice(0, 500))) {
      throw new ApiError(404, 'NOT_FOUND', 'Spotify did not expose this resource to the current account.');
    }
    if (/something went wrong/i.test(snapshot.text.slice(0, 500))) {
      throw new ApiError(502, 'SPOTIFY_PAGE_ERROR', 'Spotify displayed an error.');
    }
    return snapshot;
  }

  async player() {
    await this.requireAccount();
    await (await this.page.waitForSelector(`${BAR} [data-testid="control-button-playpause"]`, { visible: true }))?.dispose();
    return this.page.evaluate((selector) => {
      const bar = document.querySelector(selector)!;
      const label = bar.querySelector('[data-testid="control-button-playpause"]')?.getAttribute('aria-label');
      const title = bar.querySelector<HTMLElement>('[data-testid="context-item-info-title"]')
        ?? bar.querySelector<HTMLAnchorElement>('a[href*="/track/"]');
      const name = title?.innerText.trim();
      const link = title?.closest<HTMLAnchorElement>('a[href]') ?? title?.querySelector<HTMLAnchorElement>('a[href]');
      let artists = [...bar.querySelectorAll<HTMLAnchorElement>('a[href*="/artist/"]')].map((artist) => artist.innerText.trim()).filter(Boolean);
      if (!artists.length) {
        artists = [...bar.querySelectorAll<HTMLElement>('[data-testid="context-item-info-artist"]')].map((artist) => artist.innerText.trim()).filter(Boolean);
      }
      return {
        playing: label === 'Pause' ? true : label === 'Play' ? false : null,
        track: name ? { name, artists: [...new Set(artists)], url: link?.getAttribute('href') ?? null } : null,
        position: bar.querySelector('[data-testid="playback-position"]')?.textContent ?? null,
        duration: bar.querySelector('[data-testid="playback-duration"]')?.textContent ?? null,
        capturedAt: new Date().toISOString(),
      };
    }, BAR);
  }

  async control(action: 'play' | 'pause' | 'next' | 'previous', trackId?: string) {
    await this.requireAccount();
    if (trackId) {
      await this.snapshot(`/track/${trackId}`);
      await this.requireAccount();
    }
    const id = action === 'next' ? 'control-button-skip-forward'
      : action === 'previous' ? 'control-button-skip-back' : 'control-button-playpause';
    const selector = trackId ? 'main [data-testid="play-button"]' : `${BAR} [data-testid="${id}"]`;
    const button = await this.page.$(selector);
    if (!button) throw new ApiError(409, 'CONTROL_UNAVAILABLE', 'Spotify did not expose this player control.');
    try {
      const state = await button.evaluate((element) => ({
        enabled: !element.matches(':disabled, [aria-disabled="true"]') && element.checkVisibility(),
        label: element.getAttribute('aria-label'),
      }));
      if (!state.enabled) throw new ApiError(409, 'CONTROL_UNAVAILABLE', 'Spotify disabled or hid this player control. Check your account and active player.');
      if (action === 'play' || action === 'pause') {
        const current = trackId ? state.label?.match(/^(Play|Pause)(?:\s|$)/)?.[1] : state.label;
        if (current !== 'Play' && current !== 'Pause') {
          throw new ApiError(409, 'CONTROL_UNAVAILABLE', 'Unrecognized player button. Set Spotify language to English.');
        }
        if (current.toLowerCase() === action) await this.page.locator(selector).click();
      } else {
        await this.page.locator(selector).click();
      }
    } finally {
      await button.dispose();
    }
    // A successful UI click is not proof of audio output or a remote-device state change.
    return { accepted: true, action, ...(trackId ? { trackId } : {}) };
  }
}
