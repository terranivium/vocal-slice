// Pre-publish verification for a Vocal Slice release. Read-only: it never PATCHes, never uploads and
// never publishes.
//
//   npm run release:check
//   npm run release:check -- --tag=v1.421.0     (an older release)
//
// Why this exists rather than a checklist in RELEASING.md:
//
//   1. A release is assembled by TWO machines. Between the Windows run and the Mac run the draft is
//      legitimately half-finished, and "half-finished" looks exactly like "finished" unless you know
//      the six filenames by heart.
//   2. Omitting `VocalSlice-macOS-update.zip` breaks macOS auto-update **silently** — downloads keep
//      working and updates simply never arrive. There is no user-visible symptom to catch it later.
//   3. The build log is not evidence. electron-builder logs `uploading file=` for binaries but not for
//      `latest.yml`, so reading the log once made a present feed look missing. Ask the API instead.
//
// Exit code is 1 if anything should block publishing, so it can gate a script if you ever want that.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const releaseNotes = require('./release-notes.js');
const { version, token, whatsNewProse, parseRows, OWNER, REPO, DOWNLOADABLE, START, END, SEED } = releaseNotes;

const root = path.join(__dirname, '..');

// The full set a finished release carries. Blockmaps are emitted by NSIS for differential download and
// are informational — their absence doesn't block anything.
// The Windows portable is deliberately NOT here: it's built for manual handout (npm run build:portable)
// and never published, so a release without it is correct, not incomplete.
const EXPECTED = [
    { name: 'VocalSlice-Setup.exe', note: 'Windows installer — what the site links to' },
    { name: 'VocalSlice.dmg', note: 'macOS download — what the site links to' },
    { name: 'VocalSlice-macOS-update.zip', note: 'macOS AUTO-UPDATE source (Squirrel.Mac reads the zip, not the dmg)' },
    { name: 'latest.yml', note: 'Windows update feed' },
    { name: 'latest-mac.yml', note: 'macOS update feed' },
];

const problems = [];
const notes = [];
const fail = m => problems.push(m);

// ── macOS signing ────────────────────────────────────────────────────────────────────────────────
// Added because the first Mac release through this pipeline shipped an unsigned, unnotarized DMG and
// every other check passed. electron-builder notarizes the .app only; the disk image the site links
// to came out with no ticket, and nothing here noticed. `build-scripts/notarize-dmg.js` now fixes it
// at build time — this is the gate that proves it actually happened.
//
// Necessarily a LOCAL check: verifying the uploaded copy would mean downloading 200 MB. So it also
// compares sizes against the uploaded asset, and refuses to vouch for a local file that isn't the
// one on the release.
function macCheck(args, label) {
    const r = spawnSync('xcrun', args, { encoding: 'utf8' });
    if (r.error) return { ok: false, why: `${label} unavailable: ${r.error.message}` };
    return { ok: r.status === 0, why: ((r.stdout || '') + (r.stderr || '')).trim().split('\n')[0] };
}

function checkMacSigning(byName) {
    if (process.platform !== 'darwin') {
        console.log('  ..  not checked            needs macOS — run release:check on the Mac before publishing');
        notes.push('macOS signing unverified on this machine (not macOS)');
        return;
    }

    const dmg = path.join(root, 'dist', 'VocalSlice.dmg');
    const app = path.join(root, 'dist', 'mac-universal', 'Vocal Slice.app');
    if (!fs.existsSync(dmg)) {
        console.log('  ..  not checked            no dist/VocalSlice.dmg on this machine');
        notes.push('macOS signing unverified — nothing in dist/ to inspect');
        return;
    }

    // A local artifact only speaks for the release if it IS the released artifact.
    const asset = byName.get('VocalSlice.dmg');
    const localSize = fs.statSync(dmg).size;
    if (asset && asset.size !== localSize) {
        console.log(`  --  dist/VocalSlice.dmg    ${localSize} bytes locally, ${asset.size} uploaded — not the same file`);
        fail('local dist/VocalSlice.dmg differs from the uploaded asset — re-upload or re-check on the machine that built it');
        return;
    }

    // stapler is the crisp binary test: no ticket, non-zero exit. Present wherever Xcode CLI tools are.
    const stapled = macCheck(['stapler', 'validate', dmg], 'stapler');
    if (stapled.ok) {
        console.log(`  ok  ${'VocalSlice.dmg'.padEnd(24)} notarization ticket stapled`);
    } else {
        console.log(`  --  ${'VocalSlice.dmg'.padEnd(24)} NO notarization ticket`);
        fail('VocalSlice.dmg is not notarized/stapled — Gatekeeper will warn on the file the site links to');
    }

    if (fs.existsSync(app)) {
        // The app inside the zip is the auto-update payload; Squirrel.Mac rejects a Team ID mismatch.
        const appOk = macCheck(['stapler', 'validate', app], 'stapler');
        console.log(`  ${appOk.ok ? 'ok' : '--'}  ${'Vocal Slice.app'.padEnd(24)} ` +
            (appOk.ok ? 'notarization ticket stapled (auto-update payload)' : 'NO notarization ticket'));
        if (!appOk.ok) fail('the packaged app is not notarized — macOS auto-update fails silently');
    }

    // macOS 14+ ships Apple's own pre-distribution linter, which gives far better reasons than spctl.
    // Absent on older systems, so its absence is a note rather than a failure.
    const sys = spawnSync('syspolicy_check', ['distribution', dmg], { encoding: 'utf8' });
    if (sys.error) {
        notes.push('syspolicy_check unavailable (macOS 14+) — relied on stapler alone');
    } else {
        // It splits its streams: the failure report goes to stdout, the success line to stderr.
        // Reading stdout alone makes a clean artifact look like a failure.
        const out = ((sys.stdout || '') + (sys.stderr || '')).trim();
        const passed = sys.status === 0 && /ready for distribution/i.test(out);
        // Its output is divider-heavy; the first line of substance is the verdict.
        const summary = out.split('\n').map(l => l.trim()).find(l => l && !/^-+$/.test(l)) || 'failed';
        console.log(`  ${passed ? 'ok' : '--'}  ${'syspolicy_check'.padEnd(24)} ` +
            (passed ? 'ready for distribution' : summary));
        if (!passed) {
            for (const line of out.split('\n').filter(l => /Severity: Fatal|Full Error/.test(l))) {
                console.log('        ' + line.trim());
            }
            fail('syspolicy_check says the DMG is not ready for distribution');
        }
    }
}

function tagArg() {
    const hit = process.argv.find(a => a.startsWith('--tag='));
    return hit ? hit.slice(6).replace(/^v?/i, 'v') : 'v' + version();
}

async function main() {
    const tok = token();
    if (!tok) {
        console.error('release-check: no GH_TOKEN (env or electron-builder.env).');
        process.exitCode = 1;
        return;
    }

    const api = (p, accept) => fetch(`https://api.github.com/repos/${OWNER}/${REPO}${p}`, {
        headers: { Authorization: 'Bearer ' + tok, Accept: accept || 'application/vnd.github+json' },
    });

    const tag = tagArg();
    const listed = await api('/releases?per_page=100');
    if (!listed.ok) {
        console.error(`release-check: GitHub API ${listed.status} ${listed.statusText}` +
            (listed.status === 401 ? ' — token rejected. Fine-grained tokens expire; check that first.' : ''));
        process.exitCode = 1;
        return;
    }
    const release = (await listed.json()).find(r => r.tag_name === tag);
    if (!release) {
        console.error(`release-check: no release tagged ${tag}.`);
        process.exitCode = 1;
        return;
    }

    const byName = new Map(release.assets.map(a => [a.name, a]));
    const mb = b => (b / 1048576).toFixed(1) + ' MB';

    console.log(`${tag}   ${release.draft ? 'draft — not visible to users or the updater' : 'PUBLISHED — live to users'}`);
    console.log();
    console.log('assets');
    for (const { name, note } of EXPECTED) {
        const a = byName.get(name);
        if (a) {
            console.log(`  ok  ${name.padEnd(24)} ${mb(a.size).padStart(9)}`);
        } else {
            console.log(`  --  ${name.padEnd(24)} ${'MISSING'.padStart(9)}   ${note}`);
            fail(`${name} missing`);
        }
    }
    for (const a of release.assets) {
        if (!EXPECTED.some(e => e.name === a.name)) notes.push(`extra asset: ${a.name}`);
    }

    // ── Update feeds ─────────────────────────────────────────────────────────────────────────────
    // Draft assets need the token and Accept: application/octet-stream; the browser_download_url 404s
    // while the release is a draft. Verified working against a real draft.
    console.log();
    console.log('update feeds');
    for (const feed of ['latest.yml', 'latest-mac.yml']) {
        const asset = byName.get(feed);
        if (!asset) {
            console.log(`  --  ${feed.padEnd(24)} not uploaded`);
            continue;
        }
        const res = await api(`/releases/assets/${asset.id}`, 'application/octet-stream');
        if (!res.ok) {
            console.log(`  --  ${feed.padEnd(24)} unreadable (${res.status})`);
            fail(`${feed} could not be read`);
            continue;
        }
        const text = await res.text();
        const ver = (text.match(/^version:\s*(\S+)/m) || [])[1];
        const target = (text.match(/^path:\s*(\S+)/m) || [])[1];

        if (ver && 'v' + ver !== tag) {
            fail(`${feed} says version ${ver}, release is ${tag}`);
        }
        // Squirrel.Mac updates from the ZIP. A dmg here means downloads work and updates never arrive.
        if (feed === 'latest-mac.yml' && target && !/\.zip$/i.test(target)) {
            fail(`latest-mac.yml points at "${target}", not a .zip — macOS auto-update would break silently`);
        }
        console.log(`  ok  ${feed.padEnd(24)} version ${ver || '?'} -> ${target || '?'}`);
    }

    // ── macOS signing ────────────────────────────────────────────────────────────────────────────
    console.log();
    console.log('macOS signing');
    checkMacSigning(byName);

    // ── Notes ────────────────────────────────────────────────────────────────────────────────────
    console.log();
    console.log('notes');
    const body = release.body || '';
    const prose = whatsNewProse(body);
    if (!prose) {
        console.log('  --  What\'s new           absent');
        fail("What's new is missing");
    } else if (prose.trim() === SEED) {
        console.log('  --  What\'s new           still the placeholder');
        fail("What's new is still the \"- …\" placeholder — write CHANGELOG.md and run --refresh");
    } else {
        console.log(`  ok  What's new           ${prose.split('\n').filter(l => l.trim()).length} line(s)`);
    }

    const s = body.indexOf(START), e = body.indexOf(END);
    const rows = (s !== -1 && e !== -1) ? parseRows(body.slice(s, e)) : new Map();
    // Every downloadable that was uploaded must have a row. A gap means release-notes.js didn't run on
    // one of the machines — the site promises a SHA-256 per release and it's the only integrity check
    // while Windows is unsigned.
    const uploaded = release.assets.map(a => a.name).filter(n => DOWNLOADABLE.test(n));
    const missingRows = uploaded.filter(n => !rows.has(n));
    if (missingRows.length) {
        console.log(`  --  checksums            ${rows.size} row(s), no row for: ${missingRows.join(', ')}`);
        fail(`no checksum row for ${missingRows.join(', ')} — run "npm run release-notes" on that machine`);
    } else {
        console.log(`  ok  checksums            ${rows.size} row(s), covers all ${uploaded.length} uploaded`);
    }

    console.log();
    for (const n of notes) console.log(`note: ${n}`);
    if (problems.length === 0) {
        console.log(release.draft
            ? 'Ready to publish. Publishing is what ships the update — do it by hand on the release page.'
            : 'Published release looks complete.');
        return;
    }
    console.log(`DO NOT PUBLISH — ${problems.length} problem(s):`);
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = 1;
}

main().catch(err => {
    console.error('release-check failed:', err.message);
    process.exitCode = 1;
});
