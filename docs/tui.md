# Terminal player

The TUI uses the existing HTTP API. It does not start another browser or call Spotify directly. Node's built-in terminal tools provide a numbered menu with line editing. No new dependencies are needed.

## Start

1. Leave your API server running and logged in to Spotify.

2. In another terminal, export the same `API_TOKEN` that the server uses. If it is already exported, run `bun run tui`. To enter it without putting it in Bash history:

   ```bash
   read -rsp 'API token: ' API_TOKEN; printf '\n'
   export API_TOKEN
   bun run tui
   ```

   This command builds the TypeScript files, then opens the TUI. It connects to `http://127.0.0.1:3210` by default. The token is not displayed or written to disk.

3. Type `s Rick Astley` and press Enter. Enter a result number to play that track.

Every command requires Enter. Normal readline editing works in an interactive terminal. Ctrl+C, Ctrl+D, or `q` exits. Exiting leaves the API server and Spotify playback running.

## Commands

| Command | Action |
| --- | --- |
| `s <query>`, `l` | Search for tracks, or load rendered liked songs. |
| `<number>`, `play <number>`, `play <track ID>` | Play a listed result or a 22-character Spotify track ID. |
| `play`, `pause`, `next`, `prev` | Resume, pause, skip forward, or skip back. |
| `[`, `]` | Move between pages of the already loaded results. |
| `r`, empty Enter, `q` | Refresh player state, refresh player state, or quit. |

Example using the track from your curl request:

```text
play 4uLU6hMCjMI75M1A2tKUQC
```

Result numbers stay the same across pages. Only track entries appear; artist, album, and playlist links are filtered out. A result page shows up to 10 tracks, with fewer in a short terminal. An 80-column terminal makes the command help easier to read.

## Connection settings

Set `API_URL` if the server uses a different address or port:

```sh
API_URL=http://127.0.0.1:3211 bun run tui
```

Without `API_URL`, the TUI uses `http://127.0.0.1:$PORT`, defaulting to port 3210. An explicit URL must contain only an origin, with no username, password, query string, or path. HTTP is accepted only for loopback hosts; remote origins require HTTPS. Redirects are never followed, so a redirect cannot forward your bearer token to another host.

## Behavior and limits

The TUI reads player state at startup, after an accepted playback command, and on `r`. There is no background polling. The display is the last observed state, not a live audio meter.

Search and liked-song lists inherit the API's caching and incomplete rendered snapshots. `[` and `]` page through those snapshots; they do not scroll Spotify or fetch your entire library.

A playback command returning HTTP 202 means the API accepted the UI action. It does not prove audio output. If the action succeeds but its state check fails, the TUI reports both facts without repeating the command.

Requests time out after 60 seconds. The API may still finish an action after a timeout, so refresh before retrying. The TUI never retries commands automatically. API text has terminal control sequences removed before display.

## Checks

```sh
bun run check
bun run build
node --test dist/test/tui.test.js
```

The tests run the actual TUI process against a local fake HTTP API. They check authentication headers, query encoding, result paging, track selection, playback bodies, error messages, token validation, and terminal escape removal. They also check redirect rejection, request interruption, and that an accepted action is not retried when its state check fails. They do not play music or touch your Spotify profile.
