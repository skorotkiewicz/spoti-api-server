# API reference

Base URL: `http://127.0.0.1:3210`.

Every route, including health, requires `Authorization: Bearer <API_TOKEN>`. Responses are JSON. HTTP caching is disabled with `Cache-Control: no-store`; the server's internal snapshot cache is separate. Requests with an `Origin` header or cross-site fetch metadata are rejected. Use a terminal or server-side client, not browser JavaScript.

This is not compatible with Spotify's official API response format.

## Read public or account-visible pages

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/health` | Returns `{"ok":true}`. Checks the HTTP server, not Spotify. |
| GET | `/v1/session` | Reloads the web player and returns `{"authenticated":true}` or `false`. Never cached. |
| GET | `/v1/search?q=Daft%20Punk` | Snapshot of rendered search results. |
| GET | `/v1/tracks/:id`, `/v1/albums/:id`, `/v1/artists/:id` | Snapshot of the requested resource page. |
| GET | `/v1/playlists/:id` | Snapshot of a public playlist or a private playlist accessible to the signed-in account. |

IDs must contain exactly 22 ASCII letters or digits. Spotify URLs and URIs are not accepted as IDs. Search takes one `q`, with 1 to 200 characters after trimming. Unknown or duplicate query parameters are rejected.

```sh
curl -G -H "Authorization: Bearer $API_TOKEN" \
  --data-urlencode 'q=Daft Punk' \
  http://127.0.0.1:3210/v1/search

curl -H "Authorization: Bearer $API_TOKEN" \
  http://127.0.0.1:3210/v1/tracks/4uLU6hMCjMI75M1A2tKUQC
```

### Snapshot response

Illustrative search result, shortened:

```json
{
  "url": "https://open.spotify.com/search/Daft%20Punk",
  "title": null,
  "text": "All\nArtists\nSongs\nTop result\nDaft Punk",
  "items": [
    {
      "type": "artist",
      "id": "4tZwfgrHOc3mvqYlEYSvVi",
      "name": "Daft Punk",
      "url": "https://open.spotify.com/artist/4tZwfgrHOc3mvqYlEYSvVi"
    }
  ],
  "capturedAt": "2026-01-01T12:00:00.000Z",
  "complete": false
}
```

`title` is the main heading, or `null`. `text` contains at most 30,000 characters from the main page, including any rendered recommendations and footer. `items` contains at most 200 deduplicated track, album, artist, or playlist links in DOM order. Names come from link text or accessible labels.

**`items` is not a canonical tracklist.** An album page can contain links to the album's artist and recommended albums. The server does not infer fields that Spotify did not render. Lists are always marked `complete: false`; there is no pagination or automatic scrolling in this version. `capturedAt` remains unchanged on cache hits.

## Account reads and playback

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/v1/me/library` | Snapshot of Spotify's `/collection` page. |
| GET | `/v1/me/tracks` | Snapshot of the Liked Songs page. |
| GET | `/v1/player` | Uncached playback state from the bottom player bar. |
| POST | `/v1/player/play`, `/v1/player/pause` | Resume or pause without toggling an already matching state. Play optionally accepts `trackId`. |
| POST | `/v1/player/next`, `/v1/player/previous` | Click the enabled next or previous control. |

These routes require a signed-in Spotify session. Library results cover only rendered content, not the entire saved library. Private playlists use `/v1/playlists/:id`; playlist editing is not implemented.

### Player response

```json
{
  "playing": false,
  "track": {
    "name": "Never Gonna Give You Up",
    "url": "/track/4uLU6hMCjMI75M1A2tKUQC"
  },
  "position": "0:10",
  "duration": "3:33",
  "capturedAt": "2026-01-01T12:00:00.000Z"
}
```

`playing` is `true`, `false`, or `null` for an unrecognized button label. `track` can be `null`; its URL is the browser link and can be relative. Position and duration are displayed strings, not parsed milliseconds, and can be `null` or placeholders. Responses describe the web player's displayed state, not an independently verified device state.

### Control examples

```sh
curl -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"trackId":"4uLU6hMCjMI75M1A2tKUQC"}' \
  http://127.0.0.1:3210/v1/player/play

curl -X POST -H "Authorization: Bearer $API_TOKEN" \
  -H 'Content-Type: application/json' -d '{}' \
  http://127.0.0.1:3210/v1/player/pause
```

Controls accept an empty body or `{}`. Only play accepts `trackId`. Nonempty bodies need `Content-Type: application/json` and must not exceed 4096 bytes. Extra properties are rejected.

A successful control returns HTTP `202`:

```json
{"accepted":true,"action":"pause"}
```

This means the UI click completed or play/pause was already in the requested state. It does not guarantee audio output, Premium eligibility, or successful playback on another device. Poll `/v1/player` to observe the UI afterward. Do not automatically retry next or previous after an uncertain response; a repeated click can skip twice.

## Cache and concurrency

Successful snapshots have an `X-Cache: MISS` or `X-Cache: HIT` header. Session and player responses are never cached. The default cache stores at most 200 snapshots for 300 seconds. Account library and liked-song snapshots expire after at most 30 seconds. Entity snapshots, including private playlists, use the general TTL. Search keys normalize leading and trailing whitespace, but preserve case and internal whitespace.

The cache is in memory, belongs to one browser account, and disappears on restart. It does not store failures. When full, it evicts the oldest inserted entry. Player commands clear it before attempting the control.

Clear it manually after editing playlists or saved items in Spotify:

```sh
curl -X DELETE -H "Authorization: Bearer $API_TOKEN" \
  http://127.0.0.1:3210/v1/cache
```

Response: `{"cleared":true}`.

One browser page handles requests in order. At most 16 browser operations may be active or queued. Identical concurrent reads reuse the first successful result through this queue. HTTP health checks bypass the queue. Navigation times out after 30 seconds, individual UI waits after 12 seconds. Queue wait time is additional.

## Errors

```json
{"error":{"code":"SPOTIFY_LOGIN_REQUIRED","message":"Stop the server, run the login command, then restart."}}
```

| Status | Codes | Action |
| --- | --- | --- |
| 400, 404 | `INVALID_URL`, `INVALID_QUERY`, `INVALID_BODY`, `INVALID_JSON`, `ROUTE_NOT_FOUND`, `NOT_FOUND` | Check the route, method, input, and resource access. Malformed IDs return 404. |
| 401, 403 | `UNAUTHORIZED`, `SPOTIFY_LOGIN_REQUIRED`, `ORIGIN_FORBIDDEN` | Check the server token, log in through the browser, or use a server-side client. |
| 409, 413, 415 | `CONTROL_UNAVAILABLE`, `BODY_TOO_LARGE`, `JSON_REQUIRED` | Check the player control or correct the body. |
| 429, 503 | `SPOTIFY_RATE_LIMITED`, `BUSY` | Wait before retrying reads. The response includes `Retry-After: 30`. |
| 502, 504 | `SPOTIFY_PAGE_ERROR`, `BROWSER_ERROR`, `BROWSER_TIMEOUT` | Inspect the browser for errors, consent dialogs, login changes, or changed page selectors. |

Spotify can render an error inside an HTTP 200 page. Only recognized error text maps to `NOT_FOUND` or `SPOTIFY_PAGE_ERROR`; unfamiliar UI can result in `BROWSER_TIMEOUT`. Error detection currently expects English.
