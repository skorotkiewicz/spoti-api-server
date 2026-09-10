# Install Firefox media modules manually

This optional installer downloads OpenH264 and Widevine from the exact URLs and SHA-512 hashes in Mozilla's manifests:

- [OpenH264 manifest](https://raw.githubusercontent.com/mozilla-firefox/firefox/refs/heads/main/toolkit/content/gmp-sources/openh264.json)
- [Widevine manifest](https://raw.githubusercontent.com/mozilla-firefox/firefox/refs/heads/main/toolkit/content/gmp-sources/widevinecdm.json)

It supports **native Linux x86_64 Firefox only**, with Python 3.10 or later and no Python packages. It does not install Firefox itself or configure Chromium. Use a current Firefox release; versions listed on Mozilla's `main` branch can be newer than an older Firefox release supports.

## Install

Run commands from the project directory.

1. Stop the API server and close Firefox instances using its profile. Other Firefox profiles can stay open.

2. Preview the versions, download URLs, and target profile without changing files.

   ```sh
   python3 tools/install_firefox_media.py --dry-run
   ```

3. Review the distribution licenses. OpenH264 uses Cisco's [binary license](https://www.openh264.org/BINARY_LICENSE.txt). Widevine includes a `LICENSE` file in the archive linked by its manifest. Review that file before installation. The flag below confirms your acceptance; this project does not grant additional rights to either module.

   ```sh
   python3 tools/install_firefox_media.py --accept-license
   ```

4. Start the API with visible Firefox.

   ```sh
   BROWSER_EXECUTABLE_PATH=/usr/sbin/firefox HEADLESS=0 bun run start
   ```

   Set `API_TOKEN` first as described in [setup](setup.md). Open `about:addons` in another tab of that Firefox window and check **Plugins** for OpenH264 and Widevine. In Firefox Settings, check **Play DRM-controlled content**. Leave the API's original Spotify tab open.

## Profile selection

The default target is `.spotify-profile/firefox`, matching the API's Firefox profile. If `SPOTIFY_PROFILE_DIR` is set, the script uses `$SPOTIFY_PROFILE_DIR/firefox`.

To install into a different profile, pass the exact Firefox profile directory, not its parent:

```sh
python3 tools/install_firefox_media.py \
  --profile /absolute/path/to/firefox-profile \
  --accept-license
```

The script holds Firefox's Linux `.parentlock` while writing. It refuses a profile already locked by Firefox. Do not start Firefox until installation finishes. No `sudo` is needed for a profile you own.

## Files and preferences

The installer verifies archive byte counts and SHA-512 hashes before reading their contents. It copies only these expected files:

```text
<profile>/
  gmp-gmpopenh264/<version>/
    gmpopenh264.info
    libgmpopenh264.so
  gmp-widevinecdm/<version>/
    libwidevinecdm.so
    manifest.json
    LICENSE
  prefs.js
  prefs.js.before-media-<timestamp>.bak
```

Python's ZIP reader supports Widevine's CRX3 container. The installer copies `_platform_specific/linux_x64/libwidevinecdm.so` to the module directory root, where Firefox expects it. It does not execute archive contents during installation.

The script enables `media.eme.enabled`, `media.gmp-provider.enabled`, both modules' `enabled` preferences, and Widevine visibility. It records each module's version, ABI, hash, and update time. Unrelated `prefs.js` lines stay unchanged. An existing `prefs.js` gets a timestamped backup before atomic replacement.

The script updates `prefs.js`, not `user.js`. Puppeteer rewrites `user.js` on browser launch, but backs up the installed `prefs.js`; these module settings therefore survive that launch process. If you use a custom `user.js` outside this app that disables DRM, its settings can override the installer.

## Limits and recovery

- Hashes authenticate against the HTTPS manifest you fetched, not a separately pinned signing key. The script trusts Mozilla's current manifest and the named distributors.
- An identical installed version can be used again. A differing file at the same version causes an error. The installer never overwrites module files or deletes older versions, backups, or files in `drm/`.
- A write failure can leave a partially installed version directory. Inspect it and move it aside before retrying. The script does not delete or silently repair it. Modules are enabled only after both have been written.
- To undo preference changes, close Firefox and restore the printed `prefs.js` backup. New profiles have no prior backup. Existing module directories remain on disk.
- OpenH264 is primarily a WebRTC video codec, not Spotify's audio decoder. Widevine installation does not prove that Spotify playback works. Account restrictions, Linux audio codecs, browser compatibility, and DRM support still apply. No DRM or account checks are bypassed.

## Test the installer without downloads

```sh
python3 tools/test_firefox_media.py
```

The check covers ZIP and CRX3 handling, byte counts, hash failures, alias validation, unsafe entries, preference preservation, backups, repeated installation, and cross-process profile locks. It uses synthetic archives and prints the temporary test directory, leaving it available for inspection. It never opens or changes your real Firefox profile.
