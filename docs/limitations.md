# Limits and verification

## Browser-only boundary

Only Puppeteer page navigation, DOM reads, and UI clicks access Spotify. Chromium uses CDP; stock Firefox uses WebDriver BiDi. Spotify's own browser code still makes its normal network requests. The server does not use a Spotify SDK, call Spotify APIs from Node, issue custom browser fetch requests, intercept credentials, or reuse captured internal endpoints.

The app does not download audio, bypass DRM, evade bot checks, or automate verification challenges. Review Spotify's terms and your account's permitted use before running automation. Stop if Spotify blocks the session.

## What this version does not guarantee

- Complete results. Spotify virtualizes and lazy-loads lists. Search, library, and entity snapshots contain only currently rendered content. No pagination or library export is provided.
- Stable selectors. Account reads and controls depend on Spotify's English UI, account-menu markers, and player test IDs. A Spotify update can break them.
- Headless audio. Browser DRM, account eligibility, autoplay policy, and region can prevent playback. The API reports completed UI actions, not proof that sound played.
- Multi-account or remote service operation. One local process owns one dedicated profile and one bounded cache. Restart before switching accounts. No device selection, playlist editing, or account-specific cache partitioning exists.
- Full Spotify API parity. These are page snapshots and displayed player state, not official track objects, audio features, or a guaranteed ordered playlist tracklist.

## Automated verification

```sh
bun run check
BROWSER_EXECUTABLE_PATH=/usr/sbin/firefox bun run test
```

For an existing Chromium installation:

```sh
BROWSER_EXECUTABLE_PATH=/usr/sbin/chromium bun run test
```

Tests use the selected real browser with intercepted navigation and local HTML fixtures. The suite has passed with both `/usr/sbin/firefox` and `/usr/sbin/chromium`. They make no live Spotify requests and need no account. They exercise:

1. HTTP authentication, cross-origin rejection, URL and JSON validation, and request-body limits.
2. DOM extraction, delayed result rendering, duplicate-link removal, cache hits, expiry, capacity eviction, disabling, and invalidation.
3. Queue ordering, capacity limits, and recovery after a failed request.
4. Account-required routes, including checks before private cache hits.
5. Idempotent play/pause, track selection, next-button clicks, and unavailable controls.

These tests verify the server's behavior against its UI assumptions. They do not prove that Spotify's authenticated UI still matches those assumptions.

## Real-account acceptance check

Run this after logging in. Use a playlist that your account can access. These commands read data except for the explicit playback step.

1. Confirm login and read liked songs.

   ```sh
   curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3210/v1/session
   curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3210/v1/me/tracks
   ```

   Expect `authenticated: true` and a Liked Songs snapshot. Compare the snapshot with the browser, not your entire library count.

2. Read your library and a private playlist.

   ```sh
   curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3210/v1/me/library
   export PLAYLIST_ID='replace_with_your_22_character_playlist_id'
   curl -H "Authorization: Bearer $API_TOKEN" "http://127.0.0.1:3210/v1/playlists/$PLAYLIST_ID"
   ```

   Check that the title and visible entries match the web player. A timeout on `/collection` can indicate that Spotify changed its library view.

3. Check caching by running the same request twice.

   ```sh
   curl -i -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3210/v1/search?q=Daft%20Punk
   ```

   Expect `X-Cache: MISS`, then `X-Cache: HIT` within the TTL, unless that query was already cached.

4. Test playback only when you are ready for audio to start. Select a playable track manually in the visible browser first.

   ```sh
   curl -X POST -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3210/v1/player/play
   curl -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3210/v1/player
   curl -X POST -H "Authorization: Bearer $API_TOKEN" http://127.0.0.1:3210/v1/player/pause
   ```

   Confirm the web player's buttons change. Verify audio separately. HTTP 202 alone is not a playback test.

5. Stop the server, run login again if needed, and restart before changing accounts. Do not reuse cached snapshots across an account switch.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Browser executable missing | Install Firefox, Chromium, or Chrome through your system package manager, then set `BROWSER_EXECUTABLE_PATH` to its absolute path. |
| Profile already in use | Stop the other server or login process using that profile. |
| Login marker not found | Return to the web player, set English, and dismiss dialogs. Account-menu selectors may need updating in `src/spotify.ts`. |
| Playback click accepted but silent | Test in visible Chrome with protected content enabled. Check account restrictions and the active Spotify device. |
| Page or library timeout | Run with `HEADLESS=0` and inspect the page. Do not interpret a timeout as an empty library. |

The app does not automatically retry blocked Spotify navigation. Raw Puppeteer errors, cookies, and page dumps are not returned to API clients.
