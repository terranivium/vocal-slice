// One-time tidy-up after Vocal Slice went free and open source (2.x). Versions up to 1.475 kept a
// licence/trial record in several places on purpose (see electron/license.js in the 1.x source): an
// encrypted cache in the profile, an anchor outside it, and a non-file mirror — the registry on Windows,
// the login Keychain on macOS. None of it means anything any more, so remove it rather than leave
// residue on people's machines.
//
// Runs once per profile, recorded by a marker file. Not keyed on whether the files exist: the mirror
// was built to survive their deletion, so "no files" doesn't mean "nothing left". The marker also keeps
// the reg/security spawns off every later launch, and is only written once the mirror delete has
// actually finished — a timeout or a quit mid-spawn leaves it unwritten, so the next launch retries.
// Best effort and never throws: a leftover we can't delete is harmless, a crash at startup isn't.
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

function anchorFile() {
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local');
    return path.join(local, 'Vocal Slice', 'state.dat');
  }
  if (process.platform === 'darwin') {
    return path.join(app.getPath('home'), 'Library', 'Preferences', 'com.vocalslice.app.state');
  }
  return path.join(app.getPath('home'), '.config', 'vocal-slice', 'state.dat');
}

function removeLegacyLicenseState() {
  try {
    const marker = path.join(app.getPath('userData'), 'license-cleanup-done');
    if (fs.existsSync(marker)) return;

    // 1.x wrote each record via <file>.tmp + rename, so a kill mid-write can have left the .tmp behind.
    for (const f of [
      path.join(app.getPath('userData'), 'app-state.dat'),
      path.join(app.getPath('userData'), 'license.json'),
      anchorFile(),
    ]) {
      fs.rmSync(f, { force: true });
      fs.rmSync(`${f}.tmp`, { force: true });
    }
    // The anchor's folder was created just for it on Windows and Linux; drop it if nothing else is there.
    if (process.platform !== 'darwin') {
      try { fs.rmdirSync(path.dirname(anchorFile())); } catch { /* not empty or already gone */ }
    }

    const done = () => { try { fs.writeFileSync(marker, ''); } catch { /* retried next launch */ } };
    // A non-zero exit is fine — "not found" is the common case and means the same as success. Only a
    // spawn that never completed (timed out, or the tool is missing) is worth another try.
    const settle = (err) => { if (!err || (typeof err.code === 'number' && !err.killed)) done(); };
    const quiet = { timeout: 4000, windowsHide: true };
    if (process.platform === 'win32') {
      execFile('reg', ['delete', 'HKCU\\Software\\vocal-slice', '/f'], quiet, settle);
    } else if (process.platform === 'darwin') {
      execFile('/usr/bin/security', ['delete-generic-password', '-s', 'vocal-slice', '-a', 't'], quiet, settle);
    } else {
      fs.rmSync(path.join(app.getPath('home'), '.vocal-slice'), { force: true });
      done();
    }
  } catch (err) {
    console.log('license cleanup skipped:', err && err.message);
  }
}

module.exports = { removeLegacyLicenseState };
