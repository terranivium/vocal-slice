// Notarizes and staples the DMG, as an `artifactBuildCompleted` hook.
//
// electron-builder notarizes the **app** and nothing else: macPackager.js calls
// `notarizeIfProvided(appPath, …)` during packing, long before the disk image exists. The DMG that
// comes out the other side therefore contains a stapled app but carries no ticket of its own, and
// Apple's own tooling rates that as unfit to ship:
//
//   $ syspolicy_check distribution dist/VocalSlice.dmg
//     Codesign Error         Severity: Fatal   File is not signed at all.
//     Notary Ticket Missing  Severity: Fatal   A Notarization ticket is not stapled.
//
// That matters because the site links straight at the DMG — it is the file people actually download,
// and the release notes claim macOS is signed and notarized. Auto-update is unaffected either way:
// MacUpdater picks the zip and explicitly excludes the dmg (`findFile(files, "zip", ["pkg", "dmg"])`).
//
// ── Why this hook, and not one of the others ─────────────────────────────────────────────────────
//
// Uploads are dispatched per artifact as it completes, not in one batch at the end, so hook choice
// decides whether the fix reaches GitHub at all:
//
//   afterAllArtifactBuild   runs after `packager.build()` resolves — the DMG has ALREADY uploaded.
//                           Stapling there yields a good local file and a bad published one.
//   artifactBuildCompleted  runs immediately before the artifact is dispatched (packager.js:
//                           `await handler(event)` then `this.dispatchArtifactCreated(event)`).
//
// Hence this one. Signing is left to electron-builder's own `dmg.sign: true`, which runs earlier
// still — before `createBlockmap()` hashes the file — so the signature is inside the recorded hash.
//
// ── Why the dmg is excluded from the update feed ─────────────────────────────────────────────────
//
// `stapler staple` rewrites the file, and by the time this hook runs the sha512 in latest-mac.yml has
// already been computed. Rather than publish a hash that no longer describes the bytes, package.json
// sets `dmg.writeUpdateInfo: false`, so the feed lists only the zip — the sole file the updater reads.
//
// A missing credential SKIPS rather than fails, so `npm run build:mac` still works offline. That is
// safe only because `npm run release:check` independently refuses to let an unstapled DMG be
// published; the hook does the work, the gate enforces it.

const { spawnSync } = require('child_process');
const path = require('path');

const CREDS = ['APPLE_ID', 'APPLE_APP_SPECIFIC_PASSWORD', 'APPLE_TEAM_ID'];

// Never let the app-specific password reach a log line. notarytool takes it as an argument, so the
// command is not echoed; only its stdout is.
function run(cmd, args, label) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    if (r.error) throw new Error(`${label}: ${r.error.message}`);
    const out = ((r.stdout || '') + (r.stderr || '')).trim();
    if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status}):\n${out}`);
    return out;
}

exports.default = async function artifactBuildCompleted(event) {
    const file = event.file || '';
    if (path.extname(file).toLowerCase() !== '.dmg') return;

    // Respect an explicit opt-out: if the app itself isn't being notarized, notarizing its container
    // would be incoherent.
    if (event.packager && event.packager.platformSpecificBuildOptions.notarize === false) {
        console.log('  • notarize-dmg    skipped — mac.notarize is false');
        return;
    }

    const missing = CREDS.filter(k => !process.env[k]);
    if (missing.length) {
        console.warn(`  ⚠ notarize-dmg    SKIPPED — missing ${missing.join(', ')}.\n` +
            '                    The DMG will be signed but carry no notarization ticket.\n' +
            '                    "npm run release:check" will refuse to let it be published.');
        return;
    }

    const name = path.basename(file);
    console.log(`  • notarize-dmg    submitting ${name} to the Apple notary service (this waits)`);

    const submit = run('xcrun', [
        'notarytool', 'submit', file,
        '--apple-id', process.env.APPLE_ID,
        '--password', process.env.APPLE_APP_SPECIFIC_PASSWORD,
        '--team-id', process.env.APPLE_TEAM_ID,
        '--wait',
    ], 'notarytool submit');

    // notarytool exits 0 for a submission that completed but was REJECTED — the status is in the
    // output, not the exit code. Missing this is how an unnotarized dmg would sail through.
    const status = (submit.match(/^\s*status:\s*(.+)$/mi) || [])[1];
    if (!status || status.trim() !== 'Accepted') {
        throw new Error(`notarization of ${name} was not accepted (status: ${status || 'unknown'}).\n` +
            'Run "xcrun notarytool log <submission-id>" for the reasons.\n' + submit);
    }

    run('xcrun', ['stapler', 'staple', file], 'stapler staple');
    run('xcrun', ['stapler', 'validate', file], 'stapler validate');

    console.log(`  • notarize-dmg    ${name} notarized and stapled`);
};
