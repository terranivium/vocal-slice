// Download counts from the public repo's releases, snapshotted so they can be diffed over time.
// Read-only: it only ever GETs, and it never publishes or mutates a release.
//
//   npm run downloads                    show current totals + change since the last snapshot
//   npm run downloads -- --record        also append today's numbers to download-stats.json
//   npm run downloads -- --history       print every recorded snapshot as a table
//
// Why this exists:
//
//   The app sends no telemetry, deliberately and permanently (CLAUDE.md, and privacy.html says so to
//   users in as many words). The marketing site now counts page views, but that stops at the
//   download link: the file is served from GitHub, so no site-side measurement can see the download
//   itself. GitHub's per-asset download count is therefore still the only number for that step, and
//   GitHub does not keep a history of it — it hands you one integer and forgets the past. Without a
//   recorded snapshot there is no curve, and without a curve a marketing push cannot be told apart
//   from a quiet week.
//
// READING THE NUMBERS. Two traps, both of which will mislead you if you skip them:
//
//   1. `VocalSlice-Setup.exe` MIXES new installs with auto-updates. electron-updater's Windows path
//      fetches the NSIS installer from the same release, so this number is inflated by the existing
//      installed base every time you ship. It is not a new-user count.
//   2. `VocalSlice.dmg` is much cleaner. macOS auto-update reads `VocalSlice-macOS-update.zip`
//      instead (dmg.writeUpdateInfo is false; see notarize-dmg.js), so the dmg is close to a true
//      new-download count. When you want "did that post work?", read the dmg line and the
//      latest.yml line, not the exe.
//
//   `latest.yml` / `latest-mac.yml` are update-feed polls, so they track the ACTIVE INSTALLED BASE
//   rather than acquisition. Useful, but a different question.
//
// No token needed — the repo is public. GH_TOKEN is used if present purely to raise the
// anonymous rate limit; it is never printed.

const fs = require('fs');
const path = require('path');

const { token, OWNER, REPO } = require('./release-notes.js');

const root = path.join(__dirname, '..');
const STORE = path.join(root, 'download-stats.json');

// Assets worth tracking, with what each one actually answers. Blockmaps are omitted: they're
// differential-download plumbing and their counts say nothing about people.
const TRACKED = [
    { name: 'VocalSlice.dmg', reads: 'macOS new downloads — the cleanest acquisition signal' },
    { name: 'VocalSlice-Setup.exe', reads: 'Windows installs + auto-updates MIXED — not a new-user count' },
    { name: 'VocalSlice-macOS-update.zip', reads: 'macOS auto-update fetches — installed base, not acquisition' },
    { name: 'latest.yml', reads: 'Windows update-feed polls — active installed base' },
    { name: 'latest-mac.yml', reads: 'macOS update-feed polls — active installed base' },
];

const flag = name => process.argv.includes('--' + name);
const today = () => new Date().toISOString().slice(0, 10);

function loadStore() {
    if (!fs.existsSync(STORE)) return { snapshots: [] };
    try {
        return JSON.parse(fs.readFileSync(STORE, 'utf8'));
    } catch (e) {
        console.error(`downloads: ${STORE} is not readable JSON (${e.message}).`);
        console.error('Fix or delete it — refusing to overwrite a file that might hold real history.');
        process.exit(1);
    }
}

async function main() {
    const tok = token();
    const headers = { Accept: 'application/vnd.github+json' };
    if (tok) headers.Authorization = 'Bearer ' + tok;

    const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`, { headers });
    if (!res.ok) {
        console.error(`downloads: GitHub API ${res.status} ${res.statusText}` +
            (res.status === 403 ? ' — likely the anonymous rate limit. Set GH_TOKEN to raise it.' : ''));
        process.exitCode = 1;
        return;
    }

    // Sum across releases: a download of an older version is still a download, and pinning to the
    // latest tag would make every release day look like a collapse to zero.
    const published = (await res.json()).filter(r => !r.draft);
    const totals = {};
    for (const { name } of TRACKED) totals[name] = 0;
    for (const rel of published) {
        for (const a of rel.assets) {
            if (a.name in totals) totals[a.name] += a.download_count;
        }
    }

    const store = loadStore();
    const previous = store.snapshots[store.snapshots.length - 1];

    if (flag('history')) {
        if (!store.snapshots.length) {
            console.log('No snapshots recorded yet. Run: npm run downloads -- --record');
            return;
        }
        console.log('date        ' + TRACKED.map(t => t.name.padStart(28)).join(''));
        for (const s of store.snapshots) {
            console.log(s.date.padEnd(12) + TRACKED.map(t => String(s.totals[t.name] ?? 0).padStart(28)).join(''));
        }
        return;
    }

    console.log(`${OWNER}/${REPO} — ${published.length} published release${published.length === 1 ? '' : 's'}, counts summed across all of them\n`);

    for (const { name, reads } of TRACKED) {
        const now = totals[name];
        let delta = '';
        if (previous) {
            const was = previous.totals[name] ?? 0;
            const d = now - was;
            const days = Math.max(1, Math.round((Date.parse(today()) - Date.parse(previous.date)) / 86400000));
            delta = d === 0 ? '   no change' : `   ${d > 0 ? '+' : ''}${d} since ${previous.date} (${(d / days).toFixed(1)}/day)`;
        }
        console.log(`  ${String(now).padStart(7)}  ${name.padEnd(28)}${delta}`);
        console.log(`           ${reads}`);
    }

    if (!previous) {
        console.log('\nNo previous snapshot, so there is no trend yet — the first --record is the baseline.');
    }

    if (flag('record')) {
        if (previous && previous.date === today()) {
            store.snapshots[store.snapshots.length - 1] = { date: today(), totals };
            console.log(`\nReplaced today's snapshot in ${path.basename(STORE)} (one per day).`);
        } else {
            store.snapshots.push({ date: today(), totals });
            console.log(`\nRecorded ${today()} in ${path.basename(STORE)} — ${store.snapshots.length} snapshot(s).`);
        }
        fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n');
        console.log('Commit it if you want the history to survive this machine — it is the only copy.');
    } else {
        console.log('\n(Nothing written. Add --record to append a snapshot.)');
    }
}

main().catch(e => {
    console.error('downloads:', e.message);
    process.exitCode = 1;
});
