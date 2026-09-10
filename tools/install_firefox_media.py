#!/usr/bin/env python3
"""Install Mozilla-listed OpenH264 and Widevine into a closed Linux x64 Firefox profile."""

import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import stat
import sys
import time
import urllib.request
import zipfile

BASE = "https://raw.githubusercontent.com/mozilla-firefox/firefox/refs/heads/main/toolkit/content/gmp-sources/"
PLATFORM = "Linux_x86_64-gcc3"
MAX_SIZE = 64 * 1024 * 1024
# Copy only Firefox's required files, never extract arbitrary archive paths.
MODULES = {
    "openh264": ("gmp-gmpopenh264", {
        "gmpopenh264.info": "gmpopenh264.info",
        "libgmpopenh264.so": "libgmpopenh264.so",
    }),
    "widevinecdm": ("gmp-widevinecdm", {
        "_platform_specific/linux_x64/libwidevinecdm.so": "libwidevinecdm.so",
        "manifest.json": "manifest.json",
        "LICENSE": "LICENSE",
    }),
}


def download(url, limit=MAX_SIZE):
    if not isinstance(url, str) or not url.startswith("https://"):
        raise ValueError("Downloads must use HTTPS")
    request = urllib.request.Request(url, headers={"User-Agent": "spoti-firefox-media-installer/1.0"})
    with urllib.request.urlopen(request, timeout=30) as response:
        if not response.geturl().startswith("https://"):
            raise ValueError("Refusing a download redirected away from HTTPS")
        data = response.read(limit + 1)
    if len(data) > limit:
        raise ValueError(f"Download exceeds {limit} bytes")
    return data


def select_build(manifest, vendor):
    if manifest.get("schema_version") != 1000 or manifest.get("hashFunction") != "sha512":
        raise ValueError("Unsupported manifest schema or hash function")
    module = manifest["vendors"][vendor]
    version = module["version"]
    if not isinstance(version, str) or not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
        raise ValueError("Invalid module version")
    platforms = module["platforms"]
    key, seen = PLATFORM, set()
    while True:
        if key in seen:
            raise ValueError("Manifest contains a platform alias cycle")
        seen.add(key)
        build = platforms[key]
        if "alias" not in build:
            break
        key = build["alias"]
    if type(build.get("filesize")) is not int or not 0 < build["filesize"] <= MAX_SIZE:
        raise ValueError("Invalid archive size in manifest")
    if not re.fullmatch(r"[a-fA-F0-9]{128}", build.get("hashValue", "")):
        raise ValueError("Invalid SHA-512 hash in manifest")
    return version, build


def unpack(data, build, files):
    if len(data) != build["filesize"]:
        raise ValueError("Archive size does not match Mozilla's manifest")
    if hashlib.sha512(data).hexdigest() != build["hashValue"].lower():
        raise ValueError("Archive SHA-512 does not match Mozilla's manifest")
    result = {}
    # zipfile supports ZIP payloads with a prepended CRX3 header.
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        total = 0
        for source, target in files.items():
            if archive.namelist().count(source) != 1:
                raise ValueError(f"Missing or duplicate archive member: {source}")
            info = archive.getinfo(source)
            total += info.file_size
            mode = info.external_attr >> 16
            if info.is_dir() or stat.S_ISLNK(mode) or total > MAX_SIZE:
                raise ValueError(f"Unsafe archive member: {source}")
            result[target] = archive.read(info)
    return result


@contextmanager
def lock_profile(profile):
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Firefox uses this POSIX record lock on Linux. Holding it also blocks a concurrent launch.
    fd = os.open(profile / ".parentlock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.lockf(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Firefox profile is in use. Close Firefox and the API server first.") from None
        yield
    finally:
        os.close(fd)


def check_destination(directory, files):
    if directory.parent.is_symlink() or directory.is_symlink():
        raise ValueError(f"Refusing a symlinked module directory: {directory}")
    if directory.exists():
        for name, data in files.items():
            path = directory / name
            if path.is_symlink() or not path.is_file() or path.read_bytes() != data:
                raise ValueError(f"Existing install differs: {path}. No files were overwritten.")


def enable_preferences(profile, preferences):
    path = profile / "prefs.js"
    if path.is_symlink():
        raise ValueError("Refusing a symlinked prefs.js")
    original = path.read_bytes() if path.exists() else b""
    lines = []
    for line in original.decode("utf-8").splitlines():
        match = re.match(r'''^\s*user_pref\(\s*(["'])([^"']+)\1\s*,''', line)
        if not match or match[2] not in preferences:
            lines.append(line)
    lines.extend(f"user_pref({json.dumps(key)}, {json.dumps(value)});" for key, value in preferences.items())
    updated = ("\n".join(lines) + "\n").encode()
    if updated == original:
        return
    stamp = time.time_ns()
    if path.exists():
        backup = profile / f"prefs.js.before-media-{stamp}.bak"
        with backup.open("xb") as out:
            os.chmod(backup, 0o600)
            out.write(original)
        print(f"Preferences backup: {backup}")
    temporary = profile / f"prefs.js.media-{stamp}.tmp"
    with temporary.open("xb") as out:
        os.chmod(temporary, 0o600)
        out.write(updated)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)


def install(profile, modules):
    with lock_profile(profile):
        if (profile / "prefs.js").is_symlink():
            raise ValueError("Refusing a symlinked prefs.js")
        # Check both modules before writing either one. Never replace an existing version's files.
        for vendor, version, _, files in modules:
            check_destination(profile / vendor / version, files)
        preferences = {"media.eme.enabled": True, "media.gmp-provider.enabled": True}
        for vendor, version, build, files in modules:
            directory = profile / vendor / version
            if not directory.exists():
                directory.mkdir(parents=True, mode=0o700)
                for name, data in files.items():
                    with (directory / name).open("xb") as out:
                        out.write(data)
            prefix = f"media.{vendor}"
            preferences.update({
                f"{prefix}.enabled": True,
                f"{prefix}.version": version,
                f"{prefix}.abi": "x86_64-gcc3",
                f"{prefix}.hashValue": build["hashValue"],
                f"{prefix}.lastUpdate": int(time.time()),
            })
            print(f"Verified module: {directory}")
        preferences["media.gmp-widevinecdm.visible"] = True
        enable_preferences(profile, preferences)
    print("Installed and enabled both modules. Start Firefox and check about:addons > Plugins.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, default=Path(os.environ.get("SPOTIFY_PROFILE_DIR", ".spotify-profile")) / "firefox",
                        help="Exact Firefox profile directory. Default: $SPOTIFY_PROFILE_DIR/firefox or .spotify-profile/firefox")
    parser.add_argument("--dry-run", action="store_true", help="Read manifests and print the plan, without downloading binaries or writing files")
    parser.add_argument("--accept-license", action="store_true", help="Confirm you have reviewed and accept the OpenH264 and Widevine distribution licenses")
    args = parser.parse_args()
    if platform.system() != "Linux" or platform.machine().lower() not in ("x86_64", "amd64"):
        parser.error("This installer supports native Linux x86_64 Firefox only. No cross-architecture fallback is provided.")
    if not args.dry_run and not args.accept_license:
        parser.error("Review the licenses in docs/firefox-media.md, then pass --accept-license to install")
    profile = args.profile.expanduser().resolve()
    print(f"Firefox profile: {profile}")
    builds = []
    for name, (vendor, files) in MODULES.items():
        manifest = json.loads(download(f"{BASE}{name}.json", 1024 * 1024))
        version, build = select_build(manifest, vendor)
        builds.append((vendor, version, build, files))
        print(f"{vendor} {version}: {build['filesize']} bytes\n  {build['fileUrl']}")
    if args.dry_run:
        return
    modules = []
    for vendor, version, build, files in builds:
        data = download(build["fileUrl"], build["filesize"])
        modules.append((vendor, version, build, unpack(data, build, files)))
    install(profile, modules)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        print(f"Installation failed: {error}", file=sys.stderr)
        sys.exit(1)
