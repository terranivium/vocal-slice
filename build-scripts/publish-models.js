// Publishes the mirrored Whisper weights in dist/models as release assets on the `models-v1` tag
// of vocal-slice. Run once per model set; `npm run models:mirror` produces the input.
//
// ── The release is a PRERELEASE, deliberately ────────────────────────────────────────────────────
// This is the detail that matters most here, and getting it wrong breaks auto-update for every
// installed copy of the app.
//
// electron-updater's GitHubProvider, with allowPrerelease false (the default), resolves the update
// target by calling GitHub's /releases/latest and then demanding `latest.yml` among that release's
// assets — see node_modules/electron-updater/out/providers/GitHubProvider.js. A models release
// carries no latest.yml, so if it were the "latest" release every update check would fail with
// ERR_UPDATER_CHANNEL_FILE_NOT_FOUND.
//
// GitHub defines "latest" as the most recent release that is NOT a draft and NOT a prerelease, so
// marking this one prerelease keeps it invisible to the updater while leaving its assets publicly
// downloadable. A draft would hide it from the updater too, but draft assets are not public, and
// the app has to be able to fetch them.
//
// ── The tag is immutable ─────────────────────────────────────────────────────────────────────────
// electron/models.js pins `models-v1` in RELEASE_BASE, and installs in the wild resolve their model
// downloads against it. Re-cutting this tag with different files would break them. A new model set
// means a new tag plus a manifest update shipped inside the app that expects it.

const fs = require('fs');
const path = require('path');

const OWNER = 'terranivium';
const REPO = 'vocal-slice';
const TAG = 'models-v1';
const DIR = path.join(__dirname, '../dist/models');
const API = 'https://api.github.com';

// Read from the gitignored electron-builder.env, the same place electron-builder takes it from.
// Never logged, never passed anywhere but the Authorization header.
function token() {
    const envFile = path.join(__dirname, '../electron-builder.env');
    const match = fs.readFileSync(envFile, 'utf8').match(/^\s*GH_TOKEN\s*=\s*(.+?)\s*$/m);
    if (!match) throw new Error('GH_TOKEN not found in electron-builder.env');
    return match[1].replace(/^["']|["']$/g, '');
}

const TOKEN = token();
const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'vocal-slice-publish-models',
};

const MB = (n) => (n / 1e6).toFixed(1);

async function getRelease() {
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { headers });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Looking up ${TAG}: ${res.status} ${await res.text()}`);
    return res.json();
}

async function createRelease() {
    const res = await fetch(`${API}/repos/${OWNER}/${REPO}/releases`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            tag_name: TAG,
            name: 'Whisper models v1',
            // Marked prerelease so GitHub's /releases/latest never returns it — see the header.
            prerelease: true,
            body: [
                'Whisper ONNX model weights downloaded on demand by Vocal Slice.',
                '',
                'These are the `onnx-community/*_timestamped` conversions of OpenAI\'s Whisper models,',
                'redistributed unmodified under Apache-2.0. The app verifies every file against the',
                'SHA-256 checksums in the manifest it ships with, so these assets are not a trust',
                'boundary.',
                '',
                'Not an application release: it carries no installer and no `latest.yml`, and is marked',
                'as a prerelease so the auto-updater ignores it.',
            ].join('\n'),
        }),
    });
    if (!res.ok) throw new Error(`Creating ${TAG}: ${res.status} ${await res.text()}`);
    return res.json();
}

// Assets are uploaded one at a time and skipped if already present at the right size, so an
// interrupted run resumes instead of restarting a multi-GB upload.
async function uploadAsset(release, file, existing) {
    const full = path.join(DIR, file);
    const size = fs.statSync(full).size;

    const already = existing.get(file);
    if (already && already.size === size) return 'skipped';
    if (already) {
        // Wrong size — a previous run died mid-upload. Delete before re-uploading; GitHub rejects a
        // duplicate asset name outright rather than replacing it.
        const del = await fetch(`${API}/repos/${OWNER}/${REPO}/releases/assets/${already.id}`,
            { method: 'DELETE', headers });
        if (!del.ok) throw new Error(`Deleting stale ${file}: ${del.status}`);
    }

    const url = `${release.upload_url.split('{')[0]}?name=${encodeURIComponent(file)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
        body: fs.createReadStream(full),
        duplex: 'half',   // required by undici when the body is a stream
    });
    if (!res.ok) throw new Error(`Uploading ${file}: ${res.status} ${await res.text()}`);
    return 'uploaded';
}

async function main() {
    const files = fs.readdirSync(DIR).filter((f) => !f.endsWith('.part')).sort();
    if (!files.length) throw new Error(`No assets in ${DIR} — run \`npm run models:mirror\` first`);
    const totalBytes = files.reduce((n, f) => n + fs.statSync(path.join(DIR, f)).size, 0);

    let release = await getRelease();
    if (release) {
        console.log(`Release ${TAG} exists (prerelease: ${release.prerelease}) — resuming`);
        if (!release.prerelease) {
            // Loud, because a published models release silently breaks every client's update check.
            throw new Error(
                `${TAG} exists but is NOT marked prerelease. That makes it GitHub's "latest" release, ` +
                `which breaks auto-update for installed apps. Set it to prerelease before continuing.`);
        }
    } else {
        console.log(`Creating prerelease ${TAG}…`);
        release = await createRelease();
    }

    const existing = new Map((release.assets || []).map((a) => [a.name, a]));
    console.log(`${files.length} assets, ${MB(totalBytes)} MB total\n`);

    let done = 0;
    for (const file of files) {
        const size = fs.statSync(path.join(DIR, file)).size;
        const result = await uploadAsset(release, file, existing);
        done++;
        console.log(`[${String(done).padStart(2)}/${files.length}] ${result.padEnd(8)} ${MB(size).padStart(7)} MB  ${file}`);
    }

    console.log(`\nDone: https://github.com/${OWNER}/${REPO}/releases/tag/${TAG}`);
}

main().catch((err) => {
    // err.message can carry a GitHub response body, which never contains the token.
    console.error(`\nPublish failed: ${err.message}`);
    process.exit(1);
});
