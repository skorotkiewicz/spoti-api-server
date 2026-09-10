#!/usr/bin/env python3
"""Offline checks. Creates only disposable test files under /tmp, never a real Firefox profile."""

from contextlib import redirect_stdout
import hashlib
import io
import json
from pathlib import Path
import stat
import struct
import subprocess
import sys
import tempfile
import zipfile

from install_firefox_media import (
    MODULES, PLATFORM, install, lock_profile, select_build, unpack,
)


def fails(call, text):
    try:
        call()
    except ValueError as error:
        assert text in str(error), str(error)
    else:
        raise AssertionError(f"Expected failure containing: {text}")


def archive(files, crx=False):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as output:
        for name, content in files.items():
            output.writestr(name, content)
        output.writestr("../../outside-profile", "must never be extracted")
    data = stream.getvalue()
    if crx:
        data = b"Cr24" + struct.pack("<II", 3, 4) + b"test" + data
    build = {"filesize": len(data), "hashValue": hashlib.sha512(data).hexdigest()}
    return data, build


def main():
    modules = []
    for name, (vendor, files) in MODULES.items():
        data, build = archive({source: b"fixture" for source in files}, crx=name == "widevinecdm")
        contents = unpack(data, build, files)
        assert set(contents) == set(files.values())
        fails(lambda: unpack(data + b"extra", build, files), "size")
        tampered = bytes([data[0] ^ 1]) + data[1:]
        fails(lambda: unpack(tampered, build, files), "SHA-512")
        modules.append((vendor, "1.2.3", build, contents))

    manifest = {"schema_version": 1000, "hashFunction": "sha512", "vendors": {
        "test": {"version": "1.2.3", "platforms": {PLATFORM: {"alias": "real"}, "real": build}}
    }}
    assert select_build(manifest, "test") == ("1.2.3", build)
    manifest["vendors"]["test"]["platforms"]["real"] = {"alias": PLATFORM}
    fails(lambda: select_build(manifest, "test"), "cycle")
    manifest["vendors"]["test"]["version"] = "../../escape"
    fails(lambda: select_build(manifest, "test"), "version")

    link = zipfile.ZipInfo("library")
    link.create_system = 3
    link.external_attr = (stat.S_IFLNK | 0o777) << 16
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as output:
        output.writestr(link, "/etc/passwd")
    data = stream.getvalue()
    build = {"filesize": len(data), "hashValue": hashlib.sha512(data).hexdigest()}
    fails(lambda: unpack(data, build, {"library": "library"}), "Unsafe")

    # Leave test artifacts for inspection rather than deleting files.
    root = Path(tempfile.mkdtemp(prefix="spoti-media-test-"))
    profile = root / "profile"
    profile.mkdir()
    original = b'// Keep this comment\nuser_pref("unrelated", 42);\nuser_pref("media.eme.enabled", false);\n'
    (profile / "prefs.js").write_bytes(original)
    with redirect_stdout(io.StringIO()):
        install(profile, modules)
    prefs = (profile / "prefs.js").read_text()
    assert 'user_pref("unrelated", 42);' in prefs
    assert 'user_pref("media.eme.enabled", true);' in prefs
    assert prefs.count('"media.eme.enabled"') == 1
    assert 'user_pref("media.gmp-widevinecdm.version", "1.2.3");' in prefs
    assert next(profile.glob("prefs.js.before-media-*.bak")).read_bytes() == original
    assert (profile / "gmp-widevinecdm/1.2.3/libwidevinecdm.so").read_bytes() == b"fixture"
    assert not (root / "outside-profile").exists()
    with redirect_stdout(io.StringIO()):
        install(profile, modules)  # Same version is safe to run again.
    current = (profile / "prefs.js").read_bytes()
    library = profile / "gmp-widevinecdm/1.2.3/libwidevinecdm.so"
    library.write_bytes(b"existing different installation")
    fails(lambda: install(profile, modules), "Existing install differs")
    assert library.read_bytes() == b"existing different installation"
    assert (profile / "prefs.js").read_bytes() == current

    with lock_profile(profile):
        child = subprocess.run([sys.executable, "-c", '''
import fcntl, sys
with open(sys.argv[1], "r+") as lock:
    try:
        fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.exit(0)
    sys.exit(1)
''', str(profile / ".parentlock")], check=False)
        assert child.returncode == 0, "Profile lock must exclude other processes"
        child = subprocess.run([sys.executable, "-c", '''
from pathlib import Path
from install_firefox_media import lock_profile
import sys
try:
    with lock_profile(Path(sys.argv[1])):
        sys.exit(1)
except ValueError as error:
    assert "in use" in str(error)
''', str(profile)], cwd=Path(__file__).parent, check=False)
        assert child.returncode == 0, "Installer must reject an active profile"
    print(f"PASS: ZIP/CRX3, hashes, paths, preferences, backups, repeat installs, and profile locking. Test files: {root}")


if __name__ == "__main__":
    main()
