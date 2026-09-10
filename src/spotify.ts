import type { Page } from 'playwright';
import { ApiError } from './core.js';

const ORIGIN = 'https://open.spotify.com';
const ACCOUNT = '[data-testid="user-widget-link"], [data-testid="user-widget-button"]';
const LOGIN = '[data-testid="login-button"]';

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
    if (new URL(this.page.url()).hostname === 'accounts.spotify.com') {
      return { authenticated: false };
    }
    await this.page.locator(`${ACCOUNT}, ${LOGIN}`).locator('visible=true').first().waitFor();
    return { authenticated: await this.page.locator(ACCOUNT).first().isVisible() };
  }

  async requireAccount() {
    if (!(await this.session()).authenticated) {
      throw new ApiError(401, 'SPOTIFY_LOGIN_REQUIRED', 'Stop the server, run the login command, then restart.');
    }
  }

  async snapshot(path: string, mode: 'search' | 'entity' | 'library' = 'entity'): Promise<Snapshot> {
    await this.open(path);
    if (mode === 'library') await this.requireAccount();
    // Wait for page content, not just Spotify's empty application shell.
    await this.page.waitForFunction((kind) => {
      const main = document.querySelector('main');
      if (!main) return false;
      const text = main.textContent ?? '';
      const emptyOrError = /no results found|couldn't find|could not find|something went wrong|this page is not available|this playlist is not available|your liked songs will appear here|save your favourite songs|save your favorite songs|create your first playlist/i.test(text);
      if (emptyOrError) return true;
      if (kind === 'search') return !!main.querySelector('a[href*="/track/"], a[href*="/artist/"], a[href*="/album/"], a[href*="/playlist/"]');
      return !!main.querySelector('h1');
    }, mode);
    const main = this.page.locator('main');
    const text = await main.innerText();
    if (/couldn't find|could not find|this page is not available|this playlist is not available/i.test(text.slice(0, 500))) {
      throw new ApiError(404, 'NOT_FOUND', 'Spotify did not expose this resource to the current account.');
    }
    if (/something went wrong/i.test(text.slice(0, 500))) {
      throw new ApiError(502, 'SPOTIFY_PAGE_ERROR', 'Spotify displayed an error.');
    }
    const items = await main.locator('a[href]').evaluateAll((links) => {
      const found = new Map<string, { type: string; id: string; name: string; url: string }>();
      for (const element of links) {
        const link = element as HTMLAnchorElement;
        const url = new URL(link.href);
        const match = url.pathname.match(/^\/(?:intl-[^/]+\/)?(track|album|artist|playlist)\/([A-Za-z0-9]{22})\/?$/);
        const name = (link.innerText || link.getAttribute('aria-label') || link.querySelector('img')?.alt || '').trim();
        if (url.origin !== 'https://open.spotify.com' || !match || !name) continue;
        const [, type, id] = match as [string, string, string];
        const key = `${type}/${id}`;
        if (!found.has(key)) found.set(key, { type, id, name, url: `https://open.spotify.com/${key}` });
        if (found.size >= 200) break;
      }
      return [...found.values()];
    });
    return {
      url: this.page.url(),
      title: await main.locator('h1').count() ? await main.locator('h1').first().textContent() : null,
      text: text.slice(0, 30_000),
      items,
      capturedAt: new Date().toISOString(),
      complete: false,
    };
  }

  async player() {
    await this.requireAccount();
    const bar = this.page.getByTestId('now-playing-bar');
    const button = bar.getByTestId('control-button-playpause');
    await button.waitFor();
    const label = await button.getAttribute('aria-label');
    const track = bar.locator('a[href*="/track/"]').first();
    return {
      playing: label === 'Pause' ? true : label === 'Play' ? false : null,
      track: await track.count() ? { name: await track.innerText(), url: await track.getAttribute('href') } : null,
      position: await bar.getByTestId('playback-position').textContent().catch(() => null),
      duration: await bar.getByTestId('playback-duration').textContent().catch(() => null),
      capturedAt: new Date().toISOString(),
    };
  }

  async control(action: 'play' | 'pause' | 'next' | 'previous', trackId?: string) {
    await this.requireAccount();
    if (trackId) {
      await this.snapshot(`/track/${trackId}`);
      await this.requireAccount();
      const button = this.page.locator('main').getByTestId('play-button').first();
      if (!(await button.count()) || !(await button.isEnabled())) {
        throw new ApiError(409, 'CONTROL_UNAVAILABLE', 'Spotify did not expose an enabled track play button.');
      }
      // Do not toggle a track that is already playing.
      if (!/^Pause(?:\s|$)/.test(await button.getAttribute('aria-label') ?? '')) await button.click();
    } else {
      const bar = this.page.getByTestId('now-playing-bar');
      const id = action === 'next' ? 'control-button-skip-forward'
        : action === 'previous' ? 'control-button-skip-back' : 'control-button-playpause';
      const button = bar.getByTestId(id);
      if (!(await button.count()) || !(await button.isEnabled())) {
        throw new ApiError(409, 'CONTROL_UNAVAILABLE', 'Spotify did not expose this control. Check your account and active player.');
      }
      if (action === 'play' || action === 'pause') {
        const label = await button.getAttribute('aria-label');
        if (label !== 'Play' && label !== 'Pause') {
          throw new ApiError(409, 'CONTROL_UNAVAILABLE', 'Unrecognized player button. Set Spotify language to English.');
        }
        if (label.toLowerCase() === action) await button.click();
      } else {
        await button.click();
      }
    }
    // A successful UI click is not proof of audio output or a remote-device state change.
    return { accepted: true, action, ...(trackId ? { trackId } : {}) };
  }
}
