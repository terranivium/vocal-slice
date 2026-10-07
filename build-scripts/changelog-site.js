// Generates ../vocal-slice-web/changelog.html from CHANGELOG.md.
//
// Run by hand — `npm run changelog:site` — when closing a release out, NOT from release:win/mac.
// The site is a separate repo needing its own commit and push, and both release machines writing
// into a sibling checkout mid-build would race (the Mac may not even have it cloned).
//
// Writing into the sibling repo mirrors brand/build-icon.js, including its graceful skip when the
// sibling isn't there.
//
// The page is deliberately plain HTML against the site's existing styles.css: the site's one hard
// rule is that the cookieless analytics beacon is its ONLY external request, so no fonts, no CDN,
// no embeds.

const fs = require('fs');
const path = require('path');
const { releases, humanDate, inlineSegments } = require('./changelog-data');

const WEB = path.join(__dirname, '..', '..', 'vocal-slice-web');
const OUT = path.join(WEB, 'changelog.html');

const RELEASES_URL = 'https://github.com/terranivium/vocal-slice/releases';
const DL_WIN = `${RELEASES_URL}/latest/download/VocalSlice-Setup.exe`;
const DL_MAC = `${RELEASES_URL}/latest/download/VocalSlice.dmg`;

// The notes are our own prose, but they contain quotes and dashes and will one day contain a "<".
const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Inline markdown (**bold**, `code`, *italic*) -> HTML, escaping each piece as it goes. Escaping the
// whole string wholesale is what published "**Vocal Slice is now a one-time purchase.**" with the
// asterisks showing. Tokenising lives in changelog-data.js so this and the in-app renderer in app.js
// cannot drift apart on what a bullet says.
const inline = (s) => inlineSegments(s).map((seg) => (
    seg.type === 'code' ? `<code>${esc(seg.value)}</code>`
        : seg.type === 'strong' ? `<strong>${esc(seg.value)}</strong>`
            : seg.type === 'em' ? `<em>${esc(seg.value)}</em>`
                : esc(seg.value)
)).join('');

function renderBlocks(blocks, indent) {
    const pad = ' '.repeat(indent);
    return (blocks || []).map(b => b.type === 'list'
        ? `${pad}<ul>\n${b.items.map(i => `${pad}    <li>${inline(i)}</li>`).join('\n')}\n${pad}</ul>`
        : `${pad}<p>${inline(b.text)}</p>`
    ).join('\n');
}

function render(all) {
    const [latest, ...earlier] = all;
    const desc = `What's new in Vocal Slice — release notes for version ${latest.version} and every version before it.`;

    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Changelog — Vocal Slice</title>
<meta name="description" content="${esc(desc)}">
<meta name="color-scheme" content="dark">
<link rel="stylesheet" href="styles.css">

<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="icon" href="favicon-32.png" sizes="32x32" type="image/png">
<link rel="icon" href="favicon-16.png" sizes="16x16" type="image/png">
<link rel="apple-touch-icon" href="apple-touch-icon.png">

<link rel="canonical" href="https://vocalslice.com/changelog.html">
<meta property="og:title" content="Changelog — Vocal Slice">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:url" content="https://vocalslice.com/changelog.html">
<meta property="og:site_name" content="Vocal Slice">
<meta property="og:image" content="https://vocalslice.com/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
</head>
<body>

<header class="site-header">
    <div class="wrap">
        <a class="brand" href="/">
            <span class="brand-mark" aria-hidden="true"></span>
            Vocal Slice
        </a>
        <nav class="nav" aria-label="Primary">
            <a href="/#features">Features</a>
            <a href="/#open-source">Open source</a>
        </nav>
    </div>
</header>

<main class="doc">
    <div class="wrap prose">
        <h1>What's new</h1>
        <p class="updated">Vocal Slice updates itself, so you'll get these automatically.</p>

        <section class="release release-latest" aria-labelledby="v${esc(latest.version)}">
            <h2 id="v${esc(latest.version)}">
                ${esc(latest.version)}
                <span class="release-date">${esc(humanDate(latest.date))}</span>
                <span class="release-tag">Latest</span>
            </h2>
${renderBlocks(latest.blocks, 12)}
            <div class="btn-row">
                <a class="btn btn-primary" href="${DL_WIN}">Download for Windows</a>
                <a class="btn btn-ghost" href="${DL_MAC}">Download for macOS</a>
            </div>
        </section>

        <h2 class="release-history-heading">Earlier releases</h2>
${earlier.map(r => `        <section class="release" aria-labelledby="v${esc(r.version)}">
            <h3 id="v${esc(r.version)}">
                ${esc(r.version)}
                <span class="release-date">${esc(humanDate(r.date))}</span>
            </h3>
${renderBlocks(r.blocks, 12)}
        </section>`).join('\n')}

        <p class="release-footnote">
            Every release, with checksums for each download, is listed on
            <a href="${RELEASES_URL}" rel="noopener">GitHub</a>.
        </p>
    </div>
</main>

<footer class="site-footer">
    <div class="wrap">
        <span>© 2026 Wesley Scott. Vocal Slice is free software under the <a href="https://github.com/terranivium/vocal-slice/blob/HEAD/LICENSE">GPL-3.0</a>.</span>
        <span class="footer-links">
            <a href="/">Home</a>
            <a href="privacy.html">Privacy</a>
            <a href="mailto:wesley@vocalslice.com">Support</a>
        </span>
    </div>
</footer>

<!-- Cookieless page-view counting; same token and rules as the home page. See NOTES.md. -->
<script type="module" src="https://static.cloudflareinsights.com/beacon.min.js"
        data-cf-beacon='{"token": "4faf8a26384b48ff875bfce5d0a9c8f1"}'></script>

<!-- Carries an inbound campaign back to the home page. Stateless: no cookie, no storage. -->
<script>
(function () {
    if (!location.search) return;
    var links = document.querySelectorAll('a[href="/"], a[href^="/#"]');
    for (var i = 0; i < links.length; i++) {
        var href = links[i].getAttribute('href');
        var hash = href.indexOf('#');
        links[i].setAttribute('href', hash === -1
            ? '/' + location.search
            : '/' + location.search + href.slice(hash));
    }
})();
</script>

</body>
</html>
`;
}

function main() {
    if (!fs.existsSync(WEB)) {
        console.log('changelog-site: sibling vocal-slice-web not found — skipped.');
        return;
    }
    const all = releases();
    if (!all.length) {
        console.error('changelog-site: no released versions in CHANGELOG.md — nothing to write.');
        process.exitCode = 1;
        return;
    }
    fs.writeFileSync(OUT, render(all));
    console.log(`changelog-site: vocal-slice-web/changelog.html — ${all.length} release(s), newest ${all[0].version}.`);
    console.log('   separate repo: review, commit and push it there.');
}

if (require.main === module) main();

module.exports = { render, main };
