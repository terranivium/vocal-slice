// Prints SHA-256 checksums for the built artifacts as a markdown block, ready to paste into the
// GitHub release notes.
//
//   npm run checksums
//
// Why this exists: the marketing site tells users "every release lists a SHA-256 checksum on its
// release page" — that's the only integrity check available while the Windows build is unsigned, so
// it has to actually be there, and be right, on every release. electron-builder does emit a hash in
// latest.yml, but that's **sha512, base64-encoded**, for the updater's own verification — it is not
// the SHA-256 hex a user gets from `certutil` or `shasum`, so it can't be reused here.
//
// Node's built-in crypto only — no dependency, nothing to install.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const distDir = path.join(__dirname, '..', 'dist');

// Only the artifacts a human downloads. The updater's own files (latest*.yml, *.blockmap) and the
// unpacked build directories aren't things anyone verifies by hand.
const DOWNLOADABLE = /\.(exe|dmg|zip|AppImage|deb)$/i;

function sha256(file) {
    // Streaming rather than readFileSync: these are ~100–200 MB and a universal mac dmg is larger.
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', chunk => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

async function main() {
    if (!fs.existsSync(distDir)) {
        console.error('No dist/ directory — run a build first (npm run build:win / build:mac).');
        process.exit(1);
    }

    const files = fs.readdirSync(distDir)
        .filter(f => DOWNLOADABLE.test(f))
        .filter(f => fs.statSync(path.join(distDir, f)).isFile())
        .sort();

    if (files.length === 0) {
        console.error('No downloadable artifacts in dist/ — run a build first.');
        process.exit(1);
    }

    const rows = [];
    for (const f of files) {
        const full = path.join(distDir, f);
        const st = fs.statSync(full);
        rows.push({ name: f, size: mb(st.size), hash: await sha256(full), mtime: st.mtime });
    }

    // electron-builder never cleans dist/, so artifacts from previous builds linger and would other-
    // wise be hashed straight into the release notes — publishing a checksum for a file you aren't
    // shipping. Listed on stderr (not stdout) so the markdown below still pastes clean.
    const newest = Math.max(...rows.map(r => r.mtime.getTime()));
    const stale = rows.filter(r => newest - r.mtime.getTime() > 60 * 60 * 1000);
    if (stale.length) {
        console.error('\n⚠  These are >1h older than the newest artifact — leftovers from an earlier ' +
                      'build?\n   ' + stale.map(r => r.name).join('\n   ') +
                      '\n   Delete them and re-run, or they end up in the release notes.\n');
    }

    // Emitted as markdown so it pastes straight into the release notes unedited.
    console.log('\n### SHA-256 checksums\n');
    console.log('| File | Size | SHA-256 |');
    console.log('| --- | --- | --- |');
    for (const r of rows) console.log(`| \`${r.name}\` | ${r.size} | \`${r.hash}\` |`);
    console.log('\nVerify:  `certutil -hashfile <file> SHA256`  (Windows)  ·  ' +
                '`shasum -a 256 <file>`  (macOS)\n');
}

main().catch(err => {
    console.error('Checksum generation failed:', err.message);
    process.exit(1);
});
