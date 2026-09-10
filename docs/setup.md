# Setup

Use Node.js 22 or later, Bun, and a desktop display for the initial login. Commands below assume a POSIX shell and the project directory.

## Quick start

For Firefox on Linux x86_64:

```sh
./setup.sh
```

This runs dependency installation, builds TypeScript, installs OpenH264 and Widevine DRM into the Firefox profile via `tools/install_firefox_media.py`, and launches Firefox for interactive Spotify login.

## Install and log in manually

1. Install dependencies and select an installed browser.

   ```sh
   bun install --frozen-lockfile
   export BROWSER_EXECUTABLE_PATH=/usr/sbin/firefox
   ```

   Stock Firefox uses WebDriver BiDi through Puppeteer. No patched Firefox or geckodriver is needed. To use Chromium instead:

   ```sh
   export BROWSER_EXECUTABLE_PATH=/usr/sbin/chromium
   ```

   Install the browser through your system package manager if it is missing. Without an executable path, the app looks for a standard Google Chrome installation. It does not download browsers automatically.

2. Build the server.

   ```sh
   bun run build
   ```

3. Open Spotify in the dedicated browser profile.

   ```sh
   bun run login
   ```

   Click Spotify's Log in button. Complete login and any consent or verification steps yourself. Set Spotify's language to English in its settings. Return to the web player in the original tab, then press Enter in the terminal. The command checks the account menu and closes the browser. It does not ask for or store your password itself.

4. Generate a server token and start the API.

   ```sh
   export API_TOKEN="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
   bun run start
   ```

   Keep the token private. This environment variable lasts for the current shell. The API listens only on `127.0.0.1:3210`.

5. In another terminal, set `API_TOKEN` to the same value and check the session.

   ```sh
   curl -H "Authorization: Bearer $API_TOKEN" \
     http://127.0.0.1:3210/v1/session
   ```

   Expected after login: `{"authenticated":true}`. A server that has not logged in can still read public pages where Spotify permits it.

## Browser and playback settings

Both Firefox and Chromium run headlessly by default. Keep `BROWSER_EXECUTABLE_PATH` set to the same browser for login and server startup. For playback troubleshooting, stop the server and run it visibly:

```sh
HEADLESS=0 bun run start
```

If installed, Google Chrome can offer DRM support that Chromium lacks. To select a standard Chrome installation:

```sh
unset BROWSER_EXECUTABLE_PATH
bun run login
HEADLESS=0 bun run start
```

Firefox needs DRM-controlled content enabled in its own settings for protected playback. The server does not install browsers or configure Widevine. Account tier, region, codec support, protected-content settings, and Spotify's player restrictions still apply. A successful control response does not prove audio is playing.

## Configuration

Environment variables are read at startup. The server does not load `.env` files automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_TOKEN` | Required for server | At least 32 non-space printable ASCII characters. Generate a random token. |
| `PORT` | `3210` | Local TCP port, 1 through 65535. |
| `HEADLESS` | `1` | `0` opens the server browser visibly. Login always opens visibly. |
| `CACHE_TTL_SECONDS` | `300` | Snapshot TTL, 0 through 3600. `0` disables caching. Library and liked songs are capped at 30 seconds. |
| `SPOTIFY_PROFILE_DIR` | `.spotify-profile` | Profile root, relative to the working directory or absolute. The app appends `firefox` or `chrome` to keep engine profiles separate. |
| `BROWSER_EXECUTABLE_PATH` | Unset | Absolute installed browser path. A filename containing `firefox` selects Firefox and BiDi; other filenames select Chrome/Chromium and CDP. If unset, use standard installed Chrome. |

## Protect the account session

Each engine has its own profile, `.spotify-profile/firefox` or `.spotify-profile/chrome` by default. Log in separately when switching between Firefox and Chromium. Chrome and Chromium use the same engine profile.

The profile contains cookies and browser storage that grant account access. The app creates its directory with owner-only permissions on POSIX systems. The default profile and `.env` are ignored by Git. If you select another profile path, exclude it from source control and backups yourself. Do not point the app at your everyday browser profile.

Run one process per profile. Stop the server before running login again or changing accounts. Restarting clears all cached data. To sign out, stop the server, open the profile with the login command, sign out through Spotify, and exit the command. The login command will report that login is required. No HTTP endpoint exports cookies or accepts Spotify credentials.

Do not expose this port to the internet. The bearer token can read private library information and control playback. Remote access needs an authenticated HTTPS proxy, access restrictions, and rate limits. None are included.
