// Fills in the GitHub release description after `--publish` has uploaded this machine's artifacts.
//
//   node build-scripts/release-notes.js               (chained onto npm run release:win / release:mac)
//   node build-scripts/release-notes.js --refresh     re-pull the in-flight release's notes
//   node build-scripts/release-notes.js --notes=1.421.0   rewrite ONE release's notes, nothing else
//   node build-scripts/release-notes.js --promote     close a shipped version out in CHANGELOG.md
//
// Writes two things: a SHA-256 table for this machine's artifacts, and "What's new" lifted from
// CHANGELOG.md.
//
// CHANGELOG.md is authoritative for every release, past and present — notes are never written in the
// GitHub UI, so the two can't diverge. --notes is how an already-published release gets corrected.
//
// electron-builder uploads assets but leaves the release body empty, and vocalslice.com promises
// "every release lists a SHA-256 checksum on its release page" — the only integrity check users have
// while the Windows build is unsigned. Doing that by hand is exactly the step that gets forgotten.
//
// Why not electron-builder's own `releaseInfo.releaseNotesFile`:
//   1. Checksums come FROM the built artifacts, but that file is read during the same build — the
//      hashes would have to exist before the binaries do.
//   2. Windows and macOS publish from different machines. A notes file means whoever runs last
//      overwrites the body, and neither machine ever holds the other's artifacts, so a combined
//      table is impossible.
// Hence: patch the body over the API afterwards, merging each machine's rows into one table.
//
// This never publishes the draft — that stays a deliberate manual gate.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const distDir = path.join(root, 'dist');

const OWNER = 'terranivium';
const REPO = 'vocal-slice';

// Only files a human downloads; the updater's own yml/blockmap aren't verified by hand.
const DOWNLOADABLE = /\.(exe|dmg|zip|AppImage|deb)$/i;

// Two independent blocks, with deliberately different fill rules.
//
//   checksums — ALWAYS regenerated, merging rows by filename so each machine adds its own artifacts.
//   whatsnew  — written only when ABSENT (or with --refresh). Once it exists, generated or hand-typed,
//               it is never touched again: the second machine must not clobber notes you just edited.
//
// Anything outside both marker pairs is preserved untouched.
const START = '<!-- checksums:start -->';
const END = '<!-- checksums:end -->';
const WN_START = '<!-- whatsnew:start -->';
const WN_END = '<!-- whatsnew:end -->';

// Records the source commit this release was built from, so the NEXT release has a diff range.
// electron-builder doesn't record one — a release's `target_commitish` is just the default branch
// ("main") at upload time, not the commit that was built. HTML comments don't render on GitHub.
const COMMIT_RE = /<!--\s*vs:commit\s+([0-9a-f]{7,40})\s*-->/;

const MAX_BULLETS = 12;

// --flag  -> true, --flag=value -> "value", absent -> undefined
function flag(name) {
    const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
    if (hit === undefined) return undefined;
    const eq = hit.indexOf('=');
    return eq === -1 ? true : hit.slice(eq + 1);
}

const refresh = flag('refresh') !== undefined;   // re-pull the in-flight release's notes
const notesArg = flag('notes');                  // notes-only, any release (see notesOnly)
const promoteArg = flag('promote');              // local CHANGELOG heading rename

const stripV = v => String(v).replace(/^v/i, '');

function token() {
    if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
    // electron-builder injects this when it runs, but the script also has to work standalone.
    try {
        const env = fs.readFileSync(path.join(root, 'electron-builder.env'), 'utf8');
        const m = env.match(/^\s*GH_TOKEN\s*=\s*(\S+)/m);
        if (m) return m[1];
    } catch { /* no env file */ }
    return null;
}

// Same derivation as build-scripts/pack.js, so the tag always matches what was published.
function version() {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const major = String(pkg.version).split('.')[0] || '1';
    let build = '';
    try {
        build = JSON.parse(fs.readFileSync(path.join(root, 'static/build-info.json'), 'utf8')).buildNumber;
    } catch { /* no build-info */ }
    return (build && build !== 'unknown') ? `${major}.${build}.0` : String(pkg.version);
}

function sha256(file) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        fs.createReadStream(file).on('error', reject)
            .on('data', c => h.update(c)).on('end', () => resolve(h.digest('hex')));
    });
}

const mb = b => (b / 1024 / 1024).toFixed(1) + ' MB';
// Pull existing rows back out of the body so the other platform's entries survive. Keyed by
// filename, so re-running a machine updates its own rows instead of duplicating them.
//
// Split on /\r?\n/, NOT '\n'. Editing a release in the GitHub web UI rewrites the whole body as CRLF,
// and with a bare '\n' split every line keeps a trailing \r, so the `\|$` anchor never matches and this
// returns ZERO rows from a body that visibly has them. That is not cosmetic: the caller then rebuilds
// the block from local dist/ alone, silently dropping the other machine's artifacts — the exact
// merge-by-filename behaviour this function exists to provide — and taking any hand-written prose
// inside the block with it. It also made release-check report "0 row(s)" against a correct release.
function parseRows(block) {
    const rows = new Map();
    for (const line of block.split(/\r?\n/)) {
        const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*`([0-9a-f]{64})`\s*\|$/);
        if (m) rows.set(m[1], { name: m[1], size: m[2], hash: m[3] });
    }
    return rows;
}

function renderBlock(rows) {
    const sorted = [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
    return [
        START,
        '',
        '### Which file?',
        '',
        '- **Windows** — `VocalSlice-Setup.exe`',
        '- **macOS** — `VocalSlice.dmg`, then drag Vocal Slice to Applications. ' +
        '`VocalSlice-macOS-update.zip` is the package the app updates itself from — not a manual download.',
        '',
        '### SHA-256 checksums',
        '',
        '| File | Size | SHA-256 |',
        '| --- | --- | --- |',
        ...sorted.map(r => `| \`${r.name}\` | ${r.size} | \`${r.hash}\` |`),
        '',
        'Verify: `certutil -hashfile <file> SHA256` (Windows) · `shasum -a 256 <file>` (macOS)',
        '',
        '---',
        '',
        "Windows isn't code-signed yet, so SmartScreen warns on first run — choose **More info → Run " +
        'anyway**; the checksum above is how you verify the download. macOS is signed and notarized.',
        END,
    ].join('\n');
}

const SEED = '- …';

function git(args) {
    const r = require('child_process').spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return r.status === 0 ? r.stdout.trim() : null;
}

const changelogPath = () => path.join(root, 'CHANGELOG.md');

function readChangelog() {
    try {
        return fs.readFileSync(changelogPath(), 'utf8');
    } catch {
        return null;
    }
}

// Matches a section heading: "## Unreleased", or "## 1.421.0" with an optional " — 2026-07-22" suffix.
// A version must be followed by a boundary so "1.42" can't match "## 1.421.0".
function headingRe(name) {
    return name.toLowerCase() === 'unreleased'
        ? /^##[ \t]+Unreleased[ \t]*$/mi
        : new RegExp(`^##[ \\t]+${name.replace(/\./g, '\\.')}(?![\\d.])[^\\n]*$`, 'm');
}

// Source 1 — a CHANGELOG section, used verbatim. `name` is "Unreleased" or a version like "1.421.0".
//
// Why "Unreleased" rather than a version heading while a release is in flight: the version is
// 1.{git rev-list --count HEAD}.0, so the very commit that renamed a heading to the version would bump
// the count and make it wrong by one. --promote renames it AFTER publishing instead.
function changelogSection(name, text) {
    const src = text !== undefined ? text : readChangelog();
    if (!src) return null;
    const h = src.match(headingRe(name));
    if (!h) return null;
    const rest = src.slice(h.index + h[0].length);
    const nextHeading = rest.search(/^##[ \t]+/m);
    return (nextHeading === -1 ? rest : rest.slice(0, nextHeading)).trim() || null;
}

const changelogUnreleased = () => changelogSection('Unreleased');

// Source 2 — commits since the previous release. A fallback, not the intent: commit subjects here are
// terse internal notes ("filename changes", "licensing work"), so this exists to keep a release moving
// when the CHANGELOG wasn't updated, and it warns on stderr when used.
function commitsSince(sha) {
    const out = git(['log', `${sha}..HEAD`, '--no-merges', '--pretty=%s']);
    if (out === null) return null;
    const seen = new Set();
    const bullets = [];
    for (const line of out.split('\n')) {
        const s = line.trim();
        if (!s || seen.has(s.toLowerCase())) continue;
        seen.add(s.toLowerCase());
        bullets.push('- ' + s.charAt(0).toUpperCase() + s.slice(1));
        if (bullets.length >= MAX_BULLETS) break;
    }
    return bullets.length ? bullets.join('\n') : null;
}

function renderWhatsNew(content, sha) {
    return [
        WN_START,
        '',
        "## What's new",
        '',
        content,
        '',
        `<!-- vs:commit ${sha || 'unknown'} -->`,
        WN_END,
    ].join('\n');
}

// The whole block, minus the markers and the commit marker.
function whatsNewText(body) {
    const s = (body || '').indexOf(WN_START), e = (body || '').indexOf(WN_END);
    if (s === -1 || e === -1) return null;
    return body.slice(s + WN_START.length, e).replace(COMMIT_RE, '').trim();
}

// Just the prose, with the "## What's new" heading stripped — this is what compares like-for-like
// against a CHANGELOG section. Comparing against whatsNewText() instead is what made the earlier
// stale-CHANGELOG guard dead code: it could never equal a section that carries no heading.
function whatsNewProse(body) {
    const text = whatsNewText(body);
    return text === null ? null : text.replace(/^##[ \t]+What's new[ \t]*\n+/i, '').trim();
}

// An old release's marker must survive a --notes edit: it records the commit THAT release was built
// from, and the next release derives its diff range from it. Stamping HEAD here would corrupt that.
function existingCommit(body) {
    return ((body || '').match(COMMIT_RE) || [])[1] || null;
}

// ── --notes[=version] ────────────────────────────────────────────────────────────────────────────
// Rewrites ONE release's "What's new" from its CHANGELOG section, and nothing else.
//
// This deliberately shares no code with the checksum path. The table is derived from whatever sits in
// dist/, so running the normal flow against, say, v1.421.0 six weeks later would republish that
// release's checksums as hashes of the CURRENT build — wrong SHA-256s for binaries people already
// downloaded, against a site that promises they're verifiable. Separation here is structural, not a
// flag that could be passed wrongly.
async function notesOnly(arg, api, all, patch) {
    const ver = stripV(typeof arg === 'string' && arg ? arg : version());
    const tag = 'v' + ver;
    const release = all.find(r => r.tag_name === tag);
    if (!release) {
        console.error(`release-notes: no release tagged ${tag}.`);
        console.error('  known tags: ' + (all.map(r => r.tag_name).join(', ') || '(none)'));
        return;
    }

    // A released version reads from its own heading. "## Unreleased" is only correct for the version
    // currently being built — an older release's notes were promoted out of Unreleased long ago.
    let content = changelogSection(ver);
    let from = `CHANGELOG.md (## ${ver})`;
    if (!content && ver === version()) {
        content = changelogUnreleased();
        from = 'CHANGELOG.md (## Unreleased)';
    }
    if (!content) {
        console.error(`release-notes: CHANGELOG.md has no "## ${ver}" section` +
            (ver === version() ? ' and no "## Unreleased" content.' : '.'));
        return;
    }

    const body = release.body || '';
    // Keep the release's own commit marker. It records the commit THAT release was built from, and the
    // next release derives its diff range from it — stamping HEAD here would corrupt that.
    const wn = renderWhatsNew(content, existingCommit(body) || git(['rev-parse', 'HEAD']));
    const has = body.includes(WN_START) && body.includes(WN_END);
    const next = has
        ? body.slice(0, body.indexOf(WN_START)) + wn + body.slice(body.indexOf(WN_END) + WN_END.length)
        : (wn + '\n\n' + body.trimStart()).trimEnd() + '\n';

    if (next === body) {
        console.log(`release-notes: ${tag} already matches ${from}.`);
        return;
    }
    await patch(release, next);
    console.log(`release-notes: ${tag} — What's new <- ${from}`);
    console.log(`   checksums untouched · draft=${release.draft} · commit marker preserved`);
}

// ── --promote[=version] ──────────────────────────────────────────────────────────────────────────
// Local file edit only. The notes already live in the md, so there is nothing to pull back: this just
// closes out the shipped version and opens a fresh, EMPTY "## Unreleased". Empty is deliberate —
// changelogSection() returns null for it, so the next release correctly warns that nothing was written
// rather than silently republishing these notes.
function promote(ver, date) {
    const text = readChangelog();
    if (text === null) {
        console.error('release-notes: no CHANGELOG.md.');
        return;
    }
    if (changelogSection(ver, text) !== null || headingRe(ver).test(text)) {
        console.error(`release-notes: CHANGELOG.md already has a "## ${ver}" section — nothing to do.`);
        return;
    }
    const h = text.match(headingRe('Unreleased'));
    if (!h) {
        console.error('release-notes: CHANGELOG.md has no "## Unreleased" heading to promote.');
        return;
    }
    const heading = `## ${ver} — ${date}`;
    // Match the file's own line endings. CHANGELOG.md is CRLF on Windows, so splicing a bare \n
    // left it with two mixed endings and a normalisation step to remember after every release.
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const out = text.slice(0, h.index) + `## Unreleased${nl}${nl}${heading}` + text.slice(h.index + h[0].length);
    fs.writeFileSync(changelogPath(), out);

    const moved = (changelogSection(ver, out) || '').split('\n').filter(l => l.trim()).length;
    console.log(`release-notes: CHANGELOG.md — "## Unreleased" -> "${heading}" (${moved} line(s)).`);
    console.log('   a fresh empty "## Unreleased" is above it. Not committed — review the diff.');
}

async function main() {
    const tok = token();
    if (!tok) {
        console.error('release-notes: no GH_TOKEN (env or electron-builder.env) — skipping.');
        return;                              // don't fail the build over notes
    }

    const api = (p, init) => fetch(`https://api.github.com/repos/${OWNER}/${REPO}${p}`, {
        ...init,
        headers: { Authorization: 'Bearer ' + tok, Accept: 'application/vnd.github+json', ...(init || {}).headers },
    });

    // Drafts are only listed on the authenticated collection endpoint, not /releases/tags/:tag.
    const listed = await api('/releases?per_page=100');
    if (!listed.ok) throw new Error(`GitHub API ${listed.status} ${listed.statusText}`);
    const all = await listed.json();

    // tag_name MUST be resent. A draft has no real git tag yet, and PATCHing without it makes GitHub
    // drop the association — the release comes back as `untagged-<hash>`. electron-builder then can't
    // find it by tag, so the second machine would create a SECOND draft instead of joining this one.
    // (Observed exactly that before this line existed.)
    const patch = async (rel, body) => {
        const res = await api(`/releases/${rel.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ body, tag_name: rel.tag_name }),
        });
        if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}: ${await res.text()}`);
    };

    if (promoteArg !== undefined) {
        if (typeof promoteArg === 'string' && promoteArg) {
            return promote(stripV(promoteArg), new Date().toISOString().slice(0, 10));
        }
        const newest = all.filter(r => !r.draft)[0] || all[0];
        if (!newest) {
            console.error('release-notes: no releases to promote.');
            return;
        }
        const date = (newest.published_at || new Date().toISOString()).slice(0, 10);
        return promote(stripV(newest.tag_name), date);
    }

    if (notesArg !== undefined) return notesOnly(notesArg, api, all, patch);

    if (!fs.existsSync(distDir)) {
        console.error('release-notes: no dist/ — run a build first.');
        return;
    }

    const tag = 'v' + version();
    const release = all.find(r => r.tag_name === tag);
    if (!release) {
        console.error(`release-notes: no release tagged ${tag} — publish first.`);
        return;
    }

    // Everything else, newest first — the diff range and the stale-CHANGELOG check both come from here.
    const others = all.filter(r => r.id !== release.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    // Hash only artifacts that are ACTUALLY on the release. dist/ can hold more than was published —
    // e.g. the Windows portable (built for manual handout via `build:portable`, deliberately not
    // uploaded) or a stale artifact from a previous build. The checksum table must list exactly what a
    // user can download, so intersect the local dist/ files with the release's own assets.
    const published = new Set(release.assets.map(a => a.name));
    const local = fs.readdirSync(distDir)
        .filter(f => DOWNLOADABLE.test(f) && published.has(f) && fs.statSync(path.join(distDir, f)).isFile());
    if (local.length === 0) {
        console.error('release-notes: no published downloadable artifacts in dist/ to checksum.');
        return;
    }

    const body = release.body || '';
    let next = body;
    let wnSource = null;

    // ── What's new ───────────────────────────────────────────────────────────────────────────────
    // Written only when absent, so the Mac run is a no-op here and a hand-edit between runs survives.
    const hasWn = next.includes(WN_START) && next.includes(WN_END);
    if (!hasWn || refresh) {
        let content = changelogUnreleased();
        if (content) {
            wnSource = 'CHANGELOG.md (## Unreleased)';
        } else {
            const prev = others.find(r => COMMIT_RE.test(r.body || ''));
            const prevSha = prev && (prev.body.match(COMMIT_RE) || [])[1];
            content = prevSha && commitsSince(prevSha);
            if (content) {
                wnSource = `git log ${prevSha.slice(0, 7)}..HEAD`;
                console.error(
                    `release-notes: CHANGELOG.md has no "## Unreleased" content — fell back to commit\n` +
                    `  subjects since ${prev.tag_name}. These read as internal notes, not release notes.\n` +
                    `  Write the CHANGELOG and re-run with --refresh before publishing.`);
            } else {
                content = SEED;
                wnSource = 'placeholder';
                console.error('release-notes: no CHANGELOG content and no previous release to diff — ' +
                    'seeded a placeholder. Fill in "What\'s new" before publishing.');
            }
        }

        // Stale "## Unreleased" is the real failure mode of this flow: forget to promote the heading
        // and the next release silently republishes the last one's notes. Compare PROSE — comparing
        // whatsNewText() made this dead code, since it carries a "## What's new" heading the CHANGELOG
        // section never has, so the two could never be equal.
        const lastPublished = others.find(r => !r.draft);
        if (lastPublished && whatsNewProse(lastPublished.body) === content) {
            console.error(`release-notes: WARNING — these notes are identical to ${lastPublished.tag_name}.\n` +
                `  The CHANGELOG's "## Unreleased" was probably never promoted after that release.\n` +
                `  Run: npm run changelog:promote`);
        }

        const wn = renderWhatsNew(content, git(['rev-parse', 'HEAD']));
        next = hasWn
            ? next.slice(0, next.indexOf(WN_START)) + wn + next.slice(next.indexOf(WN_END) + WN_END.length)
            : (wn + '\n\n' + next.trimStart()).trimEnd() + '\n';
    } else {
        // The block already exists and we're leaving it alone. CHANGELOG.md is the source of truth, so
        // a difference here means someone typed into the GitHub UI — say so rather than let it drift.
        const changelog = changelogUnreleased();
        if (changelog && whatsNewProse(next) !== changelog) {
            console.error(`release-notes: note — ${tag}'s "What's new" differs from CHANGELOG.md.\n` +
                `  CHANGELOG.md is authoritative; run with --refresh to push it over the release page.`);
        }
    }

    // ── Checksums ────────────────────────────────────────────────────────────────────────────────
    // Indices are recomputed here: the splice above may have shifted them.
    const s = next.indexOf(START), e = next.indexOf(END);
    const rows = (s !== -1 && e !== -1) ? parseRows(next.slice(s, e)) : new Map();

    for (const f of local) {
        const full = path.join(distDir, f);
        rows.set(f, { name: f, size: mb(fs.statSync(full).size), hash: await sha256(full) });
    }

    const block = renderBlock(rows);
    next = (s !== -1 && e !== -1)
        ? next.slice(0, s) + block + next.slice(e + END.length)
        : (next.trim() ? next.trimEnd() + '\n\n' : '') + block + '\n';

    if (next === body) {
        console.log('release-notes: body already up to date.');
        return;
    }

    await patch(release, next);

    console.log(`release-notes: ${tag} updated — ${rows.size} checksum row(s):`);
    for (const r of [...rows.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        console.log(`   ${r.name.padEnd(26)} ${r.size.padStart(8)}  ${r.hash.slice(0, 16)}…`);
    }
    if (wnSource) console.log(`   what's new  <- ${wnSource}`);
    else console.log("   what's new  unchanged (already written — use --refresh to re-pull)");
    console.log(`   draft=${release.draft} (unchanged — publishing stays manual)`);

    if (wnSource && wnSource.startsWith('CHANGELOG')) {
        console.log('\n   After publishing, close the version out:  npm run changelog:promote');
    }
}

if (require.main === module) {
    main().catch(err => {
        console.error('release-notes failed:', err.message);
        process.exitCode = 1;
    });
} else {
    // Requiring the file exposes the pure helpers for testing without touching a real release.
    module.exports = {
        version, token, changelogSection, changelogUnreleased, commitsSince,
        whatsNewText, whatsNewProse, renderWhatsNew, existingCommit, headingRe, promote, parseRows,
        OWNER, REPO, DOWNLOADABLE, START, END, WN_START, WN_END, SEED, COMMIT_RE,
    };
}
