# Spotify browser API

A local, single-account API server in TypeScript. Puppeteer drives the Spotify web player in Chromium or Firefox. The server reads rendered HTML and clicks player buttons. It does not call Spotify's Web API, extract access tokens, or replay private network requests.

Includes search and entity snapshots, your library and liked songs, private playlist snapshots by ID, player controls, and a bounded in-memory cache.

**Account endpoints are experimental.** Offline browser tests cover their behavior against fixtures, not Spotify's current logged-in UI. Headless audio playback is not guaranteed.

## Start here

1. Follow [setup and browser login](docs/setup.md).
2. Run `bun run tui` with the same `API_TOKEN` to open the [terminal player](docs/tui.md), or use the routes in [API reference](docs/api.md).
3. Read [limits and verification](docs/limitations.md) before relying on the results.

Node.js 22 or later runs the server. Bun can install dependencies and run the package scripts.

## Checks

```sh
bun install --frozen-lockfile
bun run check
BROWSER_EXECUTABLE_PATH=/usr/sbin/firefox bun run test
```

Set `BROWSER_EXECUTABLE_PATH` to an installed Firefox, Chromium, or Chrome executable. Without it, the server looks for a standard Google Chrome installation. No browser is downloaded automatically.
