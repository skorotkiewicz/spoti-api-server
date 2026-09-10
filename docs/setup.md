# Setup

Use Node.js 22 or later, Bun, and a desktop display for the initial login. Commands below assume a POSIX shell and the project directory.

## Install and log in

1. Install dependencies and Chromium.

   ```sh
   bun install --frozen-lockfile
   bunx playwright install chromium
   ```

   On Linux, Playwright may report missing system libraries. Install the listed packages through your system package manager. If Chromium is already installed, you can skip the browser download and set its absolute path instead:

   ```sh
   export BROWSER_EXECUTABLE_PATH=/usr/sbin/chromium
   ```

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

Chromium runs headlessly by default. For playback troubleshooting, stop the server and run it visibly:

```sh
HEADLESS=0 bun run start
```

If installed, Google Chrome can offer DRM support that bundled Chromium lacks. Use the same browser selection for login and server startup:

```sh
unset BROWSER_EXECUTABLE_PATH
export BROWSER_CHANNEL=chrome
bun run login
HEADLESS=0 bun run start
```

The server does not install Chrome or configure Widevine. Account tier, region, codec support, protected-content settings, and Spotify's player restrictions still apply. A successful control response does not prove audio is playing.

## Configuration

Environment variables are read at startup. The server does not load `.env` files automatically.

| Variable | Default | Meaning |
| --- | --- | --- |
| `API_TOKEN` | Required for server | At least 32 non-space printable ASCII characters. Generate a random token. |
| `PORT` | `3210` | Local TCP port, 1 through 65535. |
| `HEADLESS` | `1` | `0` opens the server browser visibly. Login always opens visibly. |
| `CACHE_TTL_SECONDS` | `300` | Snapshot TTL, 0 through 3600. `0` disables caching. Library and liked songs are capped at 30 seconds. |
| `SPOTIFY_PROFILE_DIR` | `.spotify-profile` | Dedicated persistent browser profile, relative to the working directory or absolute. |
| `BROWSER_CHANNEL` | `chromium` | Playwright browser channel, such as `chromium` or installed `chrome`. |
| `BROWSER_EXECUTABLE_PATH` | Unset | Absolute browser executable path. Overrides channel selection. |

## Protect the account session

The profile contains cookies and browser storage that grant account access. The app creates its directory with owner-only permissions on POSIX systems. The default profile and `.env` are ignored by Git. If you select another profile path, exclude it from source control and backups yourself. Do not point the app at your everyday browser profile.

Run one process per profile. Stop the server before running login again or changing accounts. Restarting clears all cached data. To sign out, stop the server, open the profile with the login command, sign out through Spotify, and exit the command. The login command will report that login is required. No HTTP endpoint exports cookies or accepts Spotify credentials.

Do not expose this port to the internet. The bearer token can read private library information and control playback. Remote access needs an authenticated HTTPS proxy, access restrictions, and rate limits. None are included.
