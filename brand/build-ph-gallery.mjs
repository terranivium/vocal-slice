// Lays the press shots onto Product Hunt's 1270x760 gallery canvas.
// Writes ../vocal-slice-web/press/producthunt/NN-name.png.
//
//   node brand/build-ph-gallery.mjs
//
// Pure image composition over the PNGs build-shots.mjs already produced — this does NOT drive the
// app, so it's quick and safe to re-run. Regenerate the sources with `node brand/build-shots.mjs`
// first if the UI has changed; this script only reframes whatever is on disk.
//
// Why it exists: the press shots are deliberately cropped to their content, which leaves most of them
// at aspect ratios nothing like PH's 1.67:1 slot — settings-* at 3.4:1, themes at 4.8:1,
// waveform-detail at 7.8:1. Uploaded raw, PH letterboxes them against its own card colour and the
// carousel reads as a set of mismatched crops. Laying each on the app's own base colour, under a
// headline in the app's own type, makes the set look like one deck.
//
// The numeric prefix is the upload order, and it matters: PH uses the FIRST image as the feed
// thumbnail, at a size where only a full-window shot stays legible.

import fs from 'node:fs';
import path from 'node:path';
import { sharp, SITE } from './lib/app-stage.mjs';
import { SANS, TEXT, esc, wrapText } from './lib/type.mjs';

const SRC = path.join(SITE, 'press', 'shots');
const OUT = path.join(SITE, 'press', 'producthunt');

const W = 1270, H = 760;
const BASE_HEX = '#1e1e2e';                              // Catppuccin Mocha base, same as the app
const BASE = { r: 0x1e, g: 0x1e, b: 0x2e, alpha: 1 };    // ...as sharp wants it
const MARGIN = 40;

// A PH gallery is SWIPED, not read — a viewer decides whether to keep going from the frame alone, and
// a bare screenshot makes them work out what they're looking at. So every frame carries a headline.
//
// The band is free on the settings strips: at 3.4:1 they are width-bound, so reserving 130px off the
// top moves them down without shrinking them at all, and fills space that was empty canvas. It costs
// the two full-window shots 13% (1088 -> 944 wide), which is well worth one legible line of copy.
const BAND = 130;
const HEAD_SIZE = 44;

// Where a shot sits in the slack below the band, 0 = flush under it, 0.5 = centred. The strips are
// far shorter than the box, and centring them left equal gaps above and below — which reads as a shot
// floating unattached to anything. Grouping it with the headline it belongs to and letting the slack
// collect at the bottom looks deliberate instead. Same reasoning as the video's caption placement.
const RISE = 1 / 3;

// Never crop. Filling more of the canvas by letting a strip overflow into a centre crop was tried and
// reverted: on waveform-detail it clipped the right edge mid-waveform and sliced "Start: 2.90" off the
// left, leaving a readout showing End and Duration with no Start — a shot that looks like a bug. The
// strips get scaled to the content width, and the surrounding space carries the headline instead.

// Two of the six shots are deliberately absent, both for the same reason — a wide strip in a 1.67:1
// slot leaves a frame that is mostly nothing:
//
//   · waveform-detail, at 7.8:1, lands as a 152px band. Everything it shows — the drag handles, the
//     duration readout — is already legible in editor-selection and moving in the video.
//   · themes shrinks two windows to ~590px each, at which size every label in them is illegible. It
//     argued for a feature by showing a picture too small to read.
//
// Four strong frames beat six with two duds in them.
//
// Headlines are lifted VERBATIM from the site's own headings in ../vocal-slice-web/index.html — the
// tagline, the "three steps" list, the feature <h3>s. Writing fresh copy here would drift from the
// page a visitor lands on thirty seconds later, and drifting from established wording has already
// been a correction once on this project.
const SHOTS = [
    // the mechanic; the only one that survives thumbnail size, so it carries the tagline
    { name: 'editor-selection', head: 'Cut audio by selecting text.' },
    // the wedge: named clip files, ready to hand over
    { name: 'slices-named', head: 'Export named files.' },
    // local model + GPU. Ahead of the filename template because "runs on your machine" is a reason to
    // care and "filenames follow a template" is a detail for someone already sold.
    { name: 'settings-model', head: 'Nothing leaves your machine.' },
    { name: 'settings-filenames', head: 'Named to your convention.' },
];

const boxW = W - MARGIN * 2, boxH = H - BAND - MARGIN;

/** The headline strip across the top of a frame. Same sans the video narrates in. */
function headline(text) {
    const lines = wrapText(text, boxW, HEAD_SIZE);
    const lh = HEAD_SIZE * 1.25;
    const top = BAND / 2 - ((lines.length - 1) * lh) / 2 + HEAD_SIZE * 0.36;
    return Buffer.from(
        `<svg width="${W}" height="${BAND}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${W}" height="${BAND}" fill="${BASE_HEX}"/>` +
        lines.map((l, i) =>
            `<text x="${W / 2}" y="${(top + i * lh).toFixed(1)}" text-anchor="middle" fill="${TEXT}" ` +
            `font-family="${SANS}" font-size="${HEAD_SIZE}" font-weight="600">${esc(l)}</text>`).join('') +
        `</svg>`);
}

async function frame({ name, head }, i) {
    const file = path.join(SRC, `${name}.png`);
    if (!fs.existsSync(file)) { console.warn(`!! missing ${name}.png — skipped`); return null; }

    const meta = await sharp(file).metadata();
    const fitH = Math.round(boxW * meta.height / meta.width);

    // Whichever dimension binds first, so the whole shot always lands inside the margin box.
    const inner = fitH >= boxH
        ? await sharp(file).resize({ height: boxH }).toBuffer()
        : await sharp(file).resize({ width: boxW }).toBuffer();
    const mode = fitH >= boxH ? 'fit-height' : 'fit-width';

    const im = await sharp(inner).metadata();
    const out = path.join(OUT, `${String(i + 1).padStart(2, '0')}-${name}.png`);
    await sharp({ create: { width: W, height: H, channels: 4, background: BASE } })
        .composite([
            { input: headline(head), left: 0, top: 0 },
            {
                input: inner,
                left: Math.round((W - im.width) / 2),
                top: BAND + Math.round((boxH - im.height) * RISE),
            },
        ])
        .png({ compressionLevel: 9 })
        .toFile(out);

    return { file: path.basename(out), src: `${meta.width}x${meta.height}`, placed: `${im.width}x${im.height}`, mode };
}

fs.mkdirSync(OUT, { recursive: true });

// Stale frames from an earlier run (a dropped shot, a renumbering) would sit in the upload folder
// looking current, so start from empty rather than overwriting in place.
for (const f of fs.readdirSync(OUT).filter(f => f.endsWith('.png'))) fs.unlinkSync(path.join(OUT, f));

const rows = [];
for (const [i, shot] of SHOTS.entries()) {
    const r = await frame(shot, i);
    if (r) rows.push(r);
}

console.log(`\nwrote ${rows.length} gallery frames (${W}x${H}) to ${OUT}`);
for (const r of rows) {
    console.log(`   ${r.file.padEnd(28)} ${r.src.padEnd(11)} → ${r.placed.padEnd(11)} ${r.mode}`);
}
console.log('\n>> LOOK at every frame before uploading. Frame 01 is the feed thumbnail —');
console.log('   check it is still readable when it renders small.');
