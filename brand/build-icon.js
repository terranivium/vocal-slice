// Generates the Vocal Slice icon set from one geometry + amplitude model.
//
// Why a generator: the waveform needs ~30 bars with *irregular*, speech-like amplitudes — that's
// what makes a shape read as audio rather than as an abstract sound glyph. Hand-writing that
// across several variant files is unmaintainable and drifts out of sync. Here bar count,
// amplitude character, palette and the simplified small-size variant are all one edit.
//
//   node brand/build-icon.js          → writes SVGs + PNG previews
//
// Output: brand/*.svg (vector masters) and brand/preview/*.png (verification renders).

const fs = require('fs');
const path = require('path');

const BRAND = __dirname;
const PREVIEW = path.join(BRAND, 'preview');

// ── Palette (the app's Catppuccin tokens — static/styles.css) ──────────────────
const C = {
    blue: '#89B4FA',
    mauve: '#CBA6F7',
    base: '#1E1E2E',
    baseHi: '#282839',
    mantle: '#181825',
    crust: '#11111B',
    text: '#CDD6F4',
    white: '#FFFFFF',
};

// ── Canvas / tile: the macOS Big Sur app-icon grid ────────────────────────────
const SIZE = 1024;
// Tile padding is PLATFORM-SPECIFIC and the two conventions are opposites:
//   macOS  — the Big Sur grid expects an 824 tile in a 1024 canvas (inset 100), because the Dock
//            adds its own spacing. That's the reference the proportions below are derived from.
//   Windows/web — taskbar, Explorer and browser tabs expect the artwork to FILL its canvas. Using
//            the macOS inset there renders the icon visibly smaller than neighbouring apps.
// Radius and mark scale must both be derived from the tile size, or a full-bleed tile ends up with
// macOS-sized corners and a mark adrift in the middle of it.
const MAC_INSET = 100;
const REF_TILE = SIZE - MAC_INSET * 2;   // 824 — the reference all ratios are expressed against
const RADIUS_RATIO = 185 / REF_TILE;     // 0.2245
const MARK_SCALE = 0.86;                 // mark ≈67% of the reference tile

function tile(inset) {
    const w = SIZE - inset * 2;
    return { x: inset, y: inset, w, r: r2(w * RADIUS_RATIO), scale: r2(MARK_SCALE * (w / REF_TILE)) };
}
const MID = SIZE / 2;

// ── Amplitude model ───────────────────────────────────────────────────────────
// A real speech waveform is not a smooth symmetric lens. It's syllabic: bursts that attack fast
// and decay, separated by dips, all under a broader envelope. We build exactly that, from a
// seeded PRNG so the result is organic but reproducible.
function mulberry32(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function amplitudes(n, seed) {
    const rnd = mulberry32(seed);
    const out = [];

    // Syllable centres: distinct peaks across the wave, each with its own strength and width.
    // Lobes are kept NARROW on purpose — wide ones overlap, sum into a plateau, and the result
    // reads as a solid block instead of speech.
    const syllables = [];
    const count = 6;
    for (let i = 0; i < count; i++) {
        syllables.push({
            pos: (i + 0.3 + rnd() * 0.4) / count,
            strength: 0.55 + rnd() * 0.45,
            width: 0.035 + rnd() * 0.04,
        });
    }

    for (let i = 0; i < n; i++) {
        const t = i / (n - 1);

        // Sum of narrow lobes: wide lobes overlap into a featureless plateau, but taking only the
        // peak of them leaves sparse spikes with dead valleys. Narrow lobes summed, over a
        // constant body, gives mass everywhere *and* visible peaks — which is what speech does.
        let v = 0;
        for (const s of syllables) {
            const d = (t - s.pos) / s.width;
            v += s.strength * Math.exp(-d * d);
        }
        v = 0.3 + 0.8 * v;

        // Broad envelope so the wave tapers at both ends instead of stopping abruptly
        const envelope = Math.pow(Math.sin(Math.PI * Math.min(1, Math.max(0, t))), 0.4);

        // Fine grain: adjacent samples in real audio differ noticeably — this is what sells it
        // close up, and a timid range here is what made the first pass look mechanical.
        const grain = 0.72 + rnd() * 0.5;

        out.push(Math.min(1, v * envelope * grain));
    }

    // Normalise so the tallest bar always hits full height regardless of seed
    const max = Math.max(...out);
    return out.map(v => Math.max(0.06, v / max));
}

// ── Layout ────────────────────────────────────────────────────────────────────
// Bars are laid out either side of a cut gap wide enough for the I-beam's CAPS (not just its
// stem — sizing the gap for the stem alone makes the caps collide with the neighbouring bars).
function layout({ bars, barW, gap, cutGap, maxHalf, cutAt, seed }) {
    const amps = amplitudes(bars, seed);
    const pitch = barW + gap;
    const leftCount = cutAt;
    const rightCount = bars - cutAt;

    const leftW = leftCount * barW + (leftCount - 1) * gap;
    const rightW = rightCount * barW + (rightCount - 1) * gap;
    const totalW = leftW + cutGap + rightW;
    const startX = MID - totalW / 2;

    const list = amps.map((a, i) => {
        const x = i < cutAt
            ? startX + i * pitch
            : startX + leftW + cutGap + (i - cutAt) * pitch;
        const half = Math.max(barW / 2, a * maxHalf);
        return { x, y: MID - half, w: barW, h: half * 2, r: barW / 2, before: i < cutAt };
    });

    return { list, startX, endX: startX + totalW, cutCentre: startX + leftW + cutGap / 2 };
}

// ── SVG emission ──────────────────────────────────────────────────────────────
const rect = b => `<rect x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}" rx="${r2(b.r)}"/>`;
const r2 = n => Math.round(n * 100) / 100;

// The I-beam mouse pointer, drawn with BRACKETED SERIFS: the caps stay continuous, but the stem
// flares smoothly into them via a curved bracket rather than meeting at a hard T-junction. That's
// the typographic serif "I" — refined up close, and it degrades to a plain caret when small.
//
// Earlier attempts and why they were wrong:
//   • solid rect caps      → a hard T-junction; reads as a capital "I", not a cursor
//   • caps split by a gap  → the segments read as detached fragments at high resolution
//
// This has to be ONE closed path: the bracket is a curve joining stem to cap, which can't be
// expressed as overlapping rectangles. Traced clockwise from the top-left of the upper cap.
function iBeam(cx, halfH, stemW, capW, capH, fill, bracket = 18, corner = 9, capCurve = 11, slant = 0) {
    const t = MID - halfH;              // outer edge, top cap (at its ENDS)
    const b = MID + halfH;              // outer edge, bottom cap (at its ENDS)
    const tc = t + capH;                // inner edge, top cap
    const bc = b - capH;                // inner edge, bottom cap
    const sL = cx - stemW / 2, sR = cx + stemW / 2;
    const cL = cx - capW / 2, cR = cx + capW / 2;
    // Guard: with a short mark the two brackets would cross and turn the path inside out.
    const br = Math.min(bracket, (bc - tc) / 2 - 1);
    const cr = Math.min(corner, capH / 2);
    // Windows' text-select cursor doesn't have flat serifs — the outer edge dips in the middle so
    // the ends lift, making the cap flare. Control points are offset 2× the sag because a quadratic
    // only reaches half way to its control point.
    const cc = capCurve * 2;

    const d = [
        `M ${r2(cL)} ${r2(t + cr)}`,
        `Q ${r2(cL)} ${r2(t)} ${r2(cL + cr)} ${r2(t)}`,
        `Q ${r2(cx)} ${r2(t + cc)} ${r2(cR - cr)} ${r2(t)}`,          // outer edge, sagging
        `Q ${r2(cR)} ${r2(t)} ${r2(cR)} ${r2(t + cr)}`,
        `L ${r2(cR)} ${r2(tc - cr)}`, `Q ${r2(cR)} ${r2(tc)} ${r2(cR - cr)} ${r2(tc)}`,
        `L ${r2(sR + br)} ${r2(tc)}`, `Q ${r2(sR)} ${r2(tc)} ${r2(sR)} ${r2(tc + br)}`,
        `L ${r2(sR)} ${r2(bc - br)}`, `Q ${r2(sR)} ${r2(bc)} ${r2(sR + br)} ${r2(bc)}`,
        `L ${r2(cR - cr)} ${r2(bc)}`, `Q ${r2(cR)} ${r2(bc)} ${r2(cR)} ${r2(bc + cr)}`,
        `L ${r2(cR)} ${r2(b - cr)}`,
        `Q ${r2(cR)} ${r2(b)} ${r2(cR - cr)} ${r2(b)}`,
        `Q ${r2(cx)} ${r2(b - cc)} ${r2(cL + cr)} ${r2(b)}`,          // outer edge, rising
        `Q ${r2(cL)} ${r2(b)} ${r2(cL)} ${r2(b - cr)}`,
        `L ${r2(cL)} ${r2(bc + cr)}`, `Q ${r2(cL)} ${r2(bc)} ${r2(cL + cr)} ${r2(bc)}`,
        `L ${r2(sL - br)} ${r2(bc)}`, `Q ${r2(sL)} ${r2(bc)} ${r2(sL)} ${r2(bc - br)}`,
        `L ${r2(sL)} ${r2(tc + br)}`, `Q ${r2(sL)} ${r2(tc)} ${r2(sL - br)} ${r2(tc)}`,
        `L ${r2(cL + cr)} ${r2(tc)}`, `Q ${r2(cL)} ${r2(tc)} ${r2(cL)} ${r2(tc - cr)}`,
        'Z',
    ].join(' ');

    // Italic lean. skewX is applied about the mark's own centre so it tilts in place rather than
    // sliding sideways. The angle is NEGATED because SVG's y-axis points down — a positive skewX
    // would push the bottom right, giving a backslant.
    const tilt = slant
        ? ` transform="translate(${r2(cx)} ${MID}) skewX(${-slant}) translate(${r2(-cx)} ${-MID})"`
        : '';

    return `    <g fill="${fill}"${tilt}>
        <path d="${d}"/>
    </g>`;
}

function buildTileIcon({ gradientTile, geo, detail, inset = MAC_INSET }) {
    const T = tile(inset);
    const { list, startX, endX, cutCentre } = geo;
    const before = list.filter(b => b.before).map(rect).join('\n            ');
    const after = list.filter(b => !b.before).map(rect).join('\n            ');

    // No selection band: a rect behind the post-cursor bars read as a hard-edged box running to
    // the tile edge — an artefact, not depth. The dim/bright split already carries the meaning.

    // Optical weight compensation (irradiation). The cursor flips polarity between variants: it's
    // light-on-dark in the dark tile but dark-on-light in the gradient one. Light shapes bleed
    // outward against a dark ground and read THICKER, so identical geometry looks thinner on the
    // gradient tile. Nudge the dark-on-light cursor heavier so the two read as equal weight — the
    // same reason type foundries ship lighter weights for reversed-out text.
    const optical = gradientTile ? 1.1 : 1;

    const waveFill = gradientTile ? C.white : 'url(#wave)';
    const dimFill = gradientTile ? C.base : 'url(#wave)';
    const dimOpacity = gradientTile ? 0.3 : 0.42;
    const beamFill = gradientTile ? C.base : C.text;

    const tileFill = gradientTile
        ? `<linearGradient id="tile" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.mauve}"/></linearGradient>`
        : `<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.baseHi}"/><stop offset="1" stop-color="${C.mantle}"/></linearGradient>`;

    // Vertical sheen on the bars so they read as forms, not flat rectangles.
    const waveGrad = `<linearGradient id="wave" x1="${r2(startX)}" y1="0" x2="${r2(endX)}" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.mauve}"/>
        </linearGradient>`;

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}" role="img" aria-label="Vocal Slice">
    <title>Vocal Slice</title>
    <!-- GENERATED by brand/build-icon.js — edit that, not this file.
         ${detail} variant, ${gradientTile ? 'gradient' : 'dark'} tile. -->
    <defs>
        ${tileFill}
        ${waveGrad}
        <linearGradient id="sheen" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="#FFFFFF" stop-opacity="0.12"/>
            <stop offset="0.45" stop-color="#FFFFFF" stop-opacity="0"/>
        </linearGradient>
    </defs>

    <rect x="${T.x}" y="${T.y}" width="${T.w}" height="${T.w}" rx="${T.r}" fill="url(#tile)"/>
    <!-- Subtle top rim: modern app-icon convention, not a bevel. -->
    <rect x="${T.x}" y="${T.y}" width="${T.w}" height="${T.w}" rx="${T.r}" fill="url(#sheen)"/>

    <g transform="translate(${MID} ${MID}) scale(${T.scale}) translate(-${MID} -${MID})">
        <g fill="${dimFill}" opacity="${dimOpacity}">
            ${before}
        </g>
        <g fill="${waveFill}">
            ${after}
        </g>

${iBeam(cutCentre, Math.max(...list.map(b => b.h)) / 2 + 54, r2(24 * optical), 108, r2(24 * optical), beamFill, 18, 9, 11, SLANT)}
    </g>
</svg>
`;
}

function buildMark(geo) {
    const { list, cutCentre } = geo;
    const minX = Math.min(...list.map(b => b.x));
    const maxX = Math.max(...list.map(b => b.x + b.w));
    const halfH = Math.max(...list.map(b => b.h)) / 2 + 54;
    const minY = MID - halfH, vbW = maxX - minX, vbH = halfH * 2;

    const before = list.filter(b => b.before).map(rect).join('\n            ');
    const after = list.filter(b => !b.before).map(rect).join('\n            ');

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r2(vbW)} ${r2(vbH)}" width="${r2(vbW)}" height="${r2(vbH)}" role="img" aria-label="Vocal Slice">
    <title>Vocal Slice</title>
    <!-- GENERATED by brand/build-icon.js. Standalone mark, no tile.
         Uses currentColor so it inherits surrounding text colour. -->
    <g transform="translate(${r2(-minX)},${r2(-minY)})" fill="currentColor">
        <g opacity="0.34">
            ${before}
        </g>
        <g>
            ${after}
        </g>
${iBeam(cutCentre, halfH, 24, 108, 24, 'currentColor', 18, 9, 11, SLANT)}
    </g>
</svg>
`;
}

// ── The mark ──────────────────────────────────────────────────────────────────
// One design at every size. A denser ~29-bar version was trialled as a separate "detailed"
// master for large sizes, but the simpler nine-bar mark reads as more confident and deliberate
// large *and* survives 16px — so the size-specific variant scheme was dropped entirely.
//
// Width is chosen so the mark lands at ~67% of the 824 tile after the 0.86 scale:
//   4*40 + 3*24 + 110 + 5*40 + 4*24 = 638 → 549 scaled → ~138px margin each side
// cutGap must exceed the I-beam cap width (82) plus clearance, or the caps collide with the bars.
const SLANT = 0;    // upright. An italic lean was tried and rejected: it read as an italic serif
                    // 'I' rather than a UI cursor, and the lean forced cutGap so wide that the two
                    // halves of the waveform drifted apart.
const MARK = { bars: 9, barW: 40, gap: 24, cutGap: 110, maxHalf: 205, cutAt: 4, seed: 20260719 };

const targets = [
    { file: 'icon-dark.svg', gradientTile: false, cfg: MARK },
    { file: 'icon-gradient.svg', gradientTile: true, cfg: MARK },
];

fs.mkdirSync(PREVIEW, { recursive: true });

for (const t of targets) {
    const geo = layout(t.cfg);
    fs.writeFileSync(path.join(BRAND, t.file), buildTileIcon({ gradientTile: t.gradientTile, geo, detail: 'flat' }));
    console.log('  ' + t.file);
}

// Full-bleed variants for Windows + web, where the artwork is expected to fill its canvas.
for (const t of targets) {
    const geo = layout(t.cfg);
    const file = t.file.replace('.svg', '-fullbleed.svg');
    fs.writeFileSync(path.join(BRAND, file),
        buildTileIcon({ gradientTile: t.gradientTile, geo, detail: 'full-bleed', inset: 0 }));
    console.log('  ' + file);
}
fs.writeFileSync(path.join(BRAND, 'mark.svg'), buildMark(layout(MARK)));
console.log('  mark.svg');

// ── ICO writer ────────────────────────────────────────────────────────────────
// app-builder can't produce a multi-resolution .ico: it rejects any source under 256×256
// (ERR_ICON_TOO_SMALL) and emits a single 256px entry, leaving Windows to downscale for the 16px
// taskbar — visibly worse than a purpose-rendered small bitmap. The container is simple, so we
// write it ourselves. Entries are PNG-encoded, which Windows has accepted since Vista (this app
// requires Win10+).
//
// Layout: ICONDIR{reserved:0, type:1, count} then one 16-byte ICONDIRENTRY per image, then the
// image data. Width/height of 256 are stored as 0.
function writeIco(images, outPath) {
    const HEADER = 6, ENTRY = 16;
    const dir = Buffer.alloc(HEADER + ENTRY * images.length);
    dir.writeUInt16LE(0, 0);                 // reserved
    dir.writeUInt16LE(1, 2);                 // type: 1 = icon
    dir.writeUInt16LE(images.length, 4);

    let offset = dir.length;
    images.forEach(({ size, data }, i) => {
        const o = HEADER + i * ENTRY;
        dir.writeUInt8(size >= 256 ? 0 : size, o);      // width  (0 means 256)
        dir.writeUInt8(size >= 256 ? 0 : size, o + 1);  // height (0 means 256)
        dir.writeUInt8(0, o + 2);            // palette size (0 = no palette)
        dir.writeUInt8(0, o + 3);            // reserved
        dir.writeUInt16LE(1, o + 4);         // colour planes
        dir.writeUInt16LE(32, o + 6);        // bits per pixel
        dir.writeUInt32LE(data.length, o + 8);
        dir.writeUInt32LE(offset, o + 12);
        offset += data.length;
    });

    fs.writeFileSync(outPath, Buffer.concat([dir, ...images.map(i => i.data)]));
}

// ── Social card (Open Graph) ──────────────────────────────────────────────────
// 1200×630 is the size Slack/X/Discord/LinkedIn all crop to. Generated here rather than hand-made
// so it can't drift from the icon.
//
// The text is drawn as SVG <text> and RASTERISED at build time, so the shipped artefact is a flat
// PNG — a link preview has no chance to load a webfont, and any font reference in the file itself
// would silently fall back to whatever the renderer had. Georgia is used because it's the app's
// default transcription font and the site's display face; it ships with both Windows and macOS.
function buildSocialCard() {
    const W = 1200, H = 630;
    // The icon + text block is ~870 wide, so it's offset to sit centred in the 1200 canvas rather
    // than hugging the left edge. Link-preview crops also bite at the edges, so central is safer.
    const cardX = 445;   // text column starts right of the icon

    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
    <defs>
        <!-- Darker than the icon tile (baseHi→mantle) so the dark mark floats clear of the card
             rather than blending into it — the brand is dark-only, so the card is deep-dark too. -->
        <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stop-color="${C.crust}"/><stop offset="1" stop-color="#0a0a10"/>
        </linearGradient>
        <linearGradient id="ink" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stop-color="${C.blue}"/><stop offset="1" stop-color="${C.mauve}"/>
        </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <!-- Accent rule along the bottom: the app's signature gradient, so the card is recognisably
         the same family as the site header without needing a second logo. -->
    <rect x="0" y="${H - 8}" width="${W}" height="8" fill="url(#ink)"/>
    <!-- Brand-gradient ring framing the (dark) icon composited on top at (135,176) 300×300 — its
         visible mac-inset tile sits ~29px in with ~54px corners; the ring frames it with a small gap. -->
    <rect x="157" y="198" width="256" height="256" rx="61" fill="none" stroke="url(#ink)" stroke-width="4" opacity="0.85"/>

    <text x="${cardX}" y="250" font-family="Georgia, 'Times New Roman', serif" font-size="76" fill="url(#ink)">Vocal Slice</text>
    <text x="${cardX}" y="316" font-family="Georgia, 'Times New Roman', serif" font-size="38" fill="${C.text}" opacity="0.86">Cut audio by selecting text.</text>
    <!-- The mechanic, not the privacy line that used to sit here: in a feed this card renders beside
         the page's og:description, which already carries "transcribe locally … fully offline", so the
         image was repeating in a picture what the text next to it said. -->
    <text x="${cardX}" y="376" font-family="Georgia, 'Times New Roman', serif" font-size="27" fill="${C.text}" opacity="0.55">Highlight a phrase. Export the clip.</text>
    <text x="${cardX}" y="458" font-family="Consolas, 'DejaVu Sans Mono', monospace" font-size="24" fill="${C.blue}" opacity="0.75">vocalslice.com</text>
</svg>
`;
}

// ── Shipped icon variant ──────────────────────────────────────────────────────
// Both tiles are kept so switching is a one-line change; this picks which one is exported to
// static/AppIcon.* and the site favicon.
const SHIPPED = 'icon-dark.svg';

// ── Renders + app icon export ─────────────────────────────────────────────────
(async () => {
    let sharp;
    try {
        sharp = require('sharp');
    } catch {
        console.log('\n(sharp not available — SVGs written, skipping PNG output)');
        return;
    }

    for (const t of targets) {
        const svg = fs.readFileSync(path.join(BRAND, t.file));
        // Every variant renders large as well as small, so the design can be judged as a full-size
        // icon and checked for small-size legibility in the same pass.
        for (const s of [1024, 256, 128, 64, 32, 16]) {
            await sharp(svg, { density: 500 }).resize(s, s).png()
                .toFile(path.join(PREVIEW, `${t.file.replace('.svg', '')}-${s}.png`));
        }
    }
    console.log('\nPNG previews → brand/preview/');

    // 1024 master that every platform icon derives from.
    const master = path.join(BRAND, 'icon.png');
    await sharp(fs.readFileSync(path.join(BRAND, SHIPPED)), { density: 500 })
        .resize(1024, 1024).png().toFile(master);
    console.log(`\nmaster  → brand/icon.png (from ${SHIPPED})`);

    // .ico / .icns via app-builder — electron-builder's own icon converter, already in
    // node_modules. Using it means no extra dependency and output identical to what packaging
    // would generate itself. (ImageMagick is NOT available here: `convert` on Windows is the
    // FAT→NTFS filesystem tool, not the image one.)
    const { execFileSync } = require('child_process');
    const exe = path.join(BRAND, '..', 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');
    if (!fs.existsSync(exe)) {
        console.log('\n(app-builder not found — skipping .ico/.icns; SVG + PNG are still written)');
        return;
    }

    const staticDir = path.join(BRAND, '..', 'static');
    const tmp = path.join(BRAND, '.icon-tmp');
    fs.mkdirSync(tmp, { recursive: true });

    // Filenames must stay AppIcon.ico / AppIcon.icns — they're referenced by package.json's
    // build.win.icon / build.mac.icon AND at runtime in electron/main.js (BrowserWindow icon and
    // app.dock.setIcon). Only the contents change.

    // Windows: multi-resolution .ico, each size rendered from the vector rather than downscaled.
    // Uses the FULL-BLEED source — the macOS-inset tile leaves ~10% transparent margin, which makes
    // the icon read visibly smaller than neighbouring apps in the taskbar.
    const svgBuf = fs.readFileSync(path.join(BRAND, SHIPPED.replace('.svg', '-fullbleed.svg')));
    const images = [];
    for (const size of [16, 24, 32, 48, 64, 128, 256]) {
        images.push({ size, data: await sharp(svgBuf, { density: 500 }).resize(size, size).png().toBuffer() });
    }
    writeIco(images, path.join(staticDir, 'AppIcon.ico'));
    console.log(`        → static/AppIcon.ico (${images.map(i => i.size).join('/')})`);

    // Web favicons, written into the sibling site repo so there's one source of truth rather than a
    // duplicated SVG that drifts. Skipped silently if the sibling isn't checked out.
    const web = path.join(BRAND, '..', '..', 'vocal-slice-web');
    if (fs.existsSync(web)) {
        // An SVG favicon scales perfectly and is one small file; PNGs cover older browsers.
        // The site is dark-only, so only the dark tile ships — no light-mode gradient variant.
        fs.copyFileSync(path.join(BRAND, SHIPPED.replace('.svg', '-fullbleed.svg')), path.join(web, 'favicon.svg'));
        for (const s of [16, 32]) {
            await sharp(svgBuf, { density: 500 }).resize(s, s).png().toFile(path.join(web, `favicon-${s}.png`));
        }
        // apple-touch-icon must be opaque: iOS applies its own rounded mask, and transparent corners
        // render black. Flatten onto the tile colour so the mask has something to cut into.
        await sharp(svgBuf, { density: 500 }).resize(180, 180)
            .flatten({ background: C.base }).png().toFile(path.join(web, 'apple-touch-icon.png'));
        console.log('        → vocal-slice-web/ favicon.svg, favicon-16/32.png, apple-touch-icon.png');

        // Social card. The icon is composited as a raster rather than nested as SVG-in-SVG, which
        // renderers handle inconsistently. The MAC-INSET tile is right here: unlike a taskbar, the
        // card has plenty of room, and the inset gives the mark breathing space beside the text.
        const cardIcon = await sharp(fs.readFileSync(path.join(BRAND, 'icon-dark.svg')), { density: 500 })
            .resize(300, 300).png().toBuffer();
        // density 72 keeps the SVG at its authored 1200×630; a higher density rescales the canvas
        // and the composite offsets below — which are in output pixels — would no longer line up.
        await sharp(Buffer.from(buildSocialCard()), { density: 72 })
            .resize(1200, 630)
            .composite([{ input: cardIcon, top: 176, left: 135 }])
            .png().toFile(path.join(web, 'og-image.png'));
        console.log('        → vocal-slice-web/og-image.png (1200×630)');
    } else {
        console.log('        (sibling vocal-slice-web not found — skipped favicons)');
    }

    // macOS: app-builder handles .icns, which is a more involved container.
    try {
        const res = execFileSync(exe, ['icon', '--format', 'icns', '--input', master, '--out', tmp],
            { encoding: 'utf8' });
        const produced = (JSON.parse(res).icons || []).map(i => i.file).find(f => f.toLowerCase().endsWith('.icns'));
        if (!produced) throw new Error('no icns in app-builder output');
        fs.copyFileSync(produced, path.join(staticDir, 'AppIcon.icns'));
        console.log('        → static/AppIcon.icns');
    } catch (e) {
        console.error(`  ! icns failed: ${e.message}`);
    }
    fs.rmSync(tmp, { recursive: true, force: true });
})();
