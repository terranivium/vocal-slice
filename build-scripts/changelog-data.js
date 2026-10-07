// Parses CHANGELOG.md into structured release data, shared by every surface that shows notes:
// the in-app "What's new" (via changelog.json, written by minify.js) and the public changelog page
// (via changelog-site.js).
//
// CHANGELOG.md stays the single source of truth — see RELEASING.md. Nothing here writes it, and no
// surface is allowed its own copy of the prose, so the app, the site and the GitHub release notes
// can't drift apart.
//
// Section slicing is delegated to release-notes.js rather than reimplemented, so a change to the
// heading format only has to be made once.

const fs = require('fs');
const path = require('path');
const { headingRe, changelogSection } = require('./release-notes.js');

const changelogPath = () => path.join(__dirname, '..', 'CHANGELOG.md');

// "## 1.451.0 — 2026-08-11". Em dash, matching what --promote writes.
const VERSION_HEADING = /^##[ \t]+(\d+\.\d+\.\d+)[ \t]+—[ \t]+(\d{4}-\d{2}-\d{2})[ \t]*$/gm;

// A section is prose paragraphs and/or bullets — 1.432.0 opens with "First public release." before
// its list, so a bullets-only parser would silently drop it. Keep both, in order.
function parseBody(body) {
    const blocks = [];
    for (const raw of body.split(/\n(?=[ \t]*-[ \t])|\n{2,}/)) {
        const text = raw.trim();
        if (!text) continue;
        if (/^-[ \t]/.test(text)) {
            // Continuation lines of a wrapped bullet are indented; fold them back into one line.
            const item = text.replace(/^-[ \t]+/, '').replace(/\s*\n\s*/g, ' ').trim();
            if (blocks.length && blocks.at(-1).type === 'list') blocks.at(-1).items.push(item);
            else blocks.push({ type: 'list', items: [item] });
        } else {
            blocks.push({ type: 'text', text: text.replace(/\s*\n\s*/g, ' ') });
        }
    }
    return blocks;
}

/**
 * Every SHIPPED release, newest first.
 *
 * "## Unreleased" is excluded by default: it describes work that isn't in anyone's hands yet, and
 * the public changelog page is read by people who can't download it. It reaches those users only
 * through the GitHub release body, which release-notes.js writes at build time from that section.
 *
 * `unreleasedAs` is the exception, and it's the packaged app's case. Promotion happens AFTER
 * publishing (see RELEASING.md — the commit that renames the heading would itself bump the build
 * number and make the heading wrong by one), so at build time "## Unreleased" IS the notes for the
 * version being built. Without this the app would ship a "What's new" that stops one release short
 * of itself — including for the post-update toast, which exists to open that very list.
 *
 * @param {{unreleasedAs?: {version: string, date: string}}} [opts] label Unreleased as this build
 * @returns {Array<{version: string, date: string, blocks: Array}>}
 */
function releases({ unreleasedAs = null } = {}) {
    const text = fs.readFileSync(changelogPath(), 'utf8');
    const out = [];

    for (const m of text.matchAll(VERSION_HEADING)) {
        const [, version, date] = m;
        const body = changelogSection(version, text);
        if (!body) continue;                       // heading with an empty section — nothing to show
        out.push({ version, date, blocks: parseBody(body) });
    }

    // Skipped when Unreleased is empty (already promoted, or nothing written yet) and when this
    // version already has a heading of its own — a promoted section is the same prose, and listing
    // it twice would be worse than listing it late.
    if (unreleasedAs?.version && unreleasedAs.date && !out.some(r => r.version === unreleasedAs.version)) {
        const body = changelogSection('Unreleased', text);
        if (body) out.push({ version: unreleasedAs.version, date: unreleasedAs.date, blocks: parseBody(body) });
    }

    // File order is already newest-first, but sort so a hand-edit that inserts a section in the
    // wrong place can't put an old release at the top of the site page.
    return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : cmpVersion(a.version, b.version)));
}

// Numeric, not lexicographic: "1.9.0" must not sort above "1.451.0".
function cmpVersion(a, b) {
    const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
    return 0;
}

// "2026-08-11" -> "11 August 2026". Explicit UTC: a bare `new Date('2026-08-11')` is parsed as
// midnight UTC and would render as the previous day for anyone west of Greenwich.
function humanDate(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
        day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC',
    });
}

// ── Inline markdown ─────────────────────────────────────────────────────────
// CHANGELOG.md uses exactly three inline constructs inside release entries: `code`, **bold** and
// *italic*. Tokenising them HERE, once, is the point: the public changelog page builds HTML strings
// and the in-app "What's new" builds DOM nodes, and when each grew its own idea of what a bullet
// said, both simply rendered the raw asterisks — visibly, on a shipped release.
//
// Deliberately NOT a markdown parser. No links, no nesting, no lists within items, because the file
// uses none of those inside entries. An unmatched marker is left as literal text rather than guessed
// at. Backticks are matched first, so an asterisk inside `a*b` is never mistaken for emphasis.
const INLINE_RE = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;

function inlineSegments(text) {
    const str = String(text ?? '');
    const out = [];
    let last = 0, m;
    INLINE_RE.lastIndex = 0;
    while ((m = INLINE_RE.exec(str)) !== null) {
        if (m.index > last) out.push({ type: 'text', value: str.slice(last, m.index) });
        if (m[1] !== undefined) out.push({ type: 'code', value: m[1] });
        else if (m[2] !== undefined) out.push({ type: 'strong', value: m[2] });
        else out.push({ type: 'em', value: m[3] });
        last = m.index + m[0].length;
    }
    if (last < str.length) out.push({ type: 'text', value: str.slice(last) });
    return out;
}

// The same blocks with every string replaced by its segment list. Used when baking
// static/changelog.json, so the renderer in app.js stays a dumb walker that cannot drift from the page.
function segmentBlocks(blocks) {
    return (blocks || []).map(b => (b.type === 'list'
        ? { ...b, items: b.items.map(inlineSegments) }
        : { ...b, text: inlineSegments(b.text) }));
}

module.exports = { releases, parseBody, humanDate, cmpVersion, headingRe, inlineSegments, segmentBlocks };
