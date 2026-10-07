// Captures the marketing / press screenshot gallery from the real app.
// Writes ../vocal-slice-web/press/shots/{*.png,*.webp}.
//
//   node brand/build-shots.mjs
//
// Same principle as build-demo.mjs and build-icon.js: generated from the running app, so a shot can
// never show a screen that no longer exists. Everything filmed is the app's OWN bundled demo
// (window.loadDemo) — a public-domain LibriVox clip with a pre-baked transcription (see
// static/onboarding/CREDITS.md) — so the gallery is licence-clean and deterministic.
//
// The wedge shot is `slices-named`: Vocal Slice's real differentiator is that it hands you cut,
// individually-NAMED clip files, which is the job VO artists currently do by hand with region markers
// in Reaper. That shot has to show several slices with templated filenames, so this script creates
// four real slices from four different phrases rather than staging one.
//
// Runs against a throwaway user-data dir (see openStage's `isolated`), so it never touches — or
// photographs — your real session. That guard exists because it didn't at first: an early run shot a
// slice list still holding a leftover "test.wav" from the operator's own session.

import fs from 'node:fs';
import path from 'node:path';
import { openStage, sharp, wait, SITE } from './lib/app-stage.mjs';

const OUT = path.join(SITE, 'press', 'shots');
const VIEW_W = 1440, VIEW_H = 900, DPR = 2;
const FONT = '22px';          // bumped for legibility when a 2x shot is displayed scaled down
const WEB_WIDTH = 1400;       // downscaled webp for use on the site itself

// Four phrases from the bundled demo transcript, chosen to produce distinct, readable slugs.
// Kept short enough that the app's slug doesn't truncate mid-word in the list.
const PHRASES = [
    'None was greater than the great Conkabar',
    'So fair was his realm',
    'the sweetest songs of Aaron',
    'a warrior, and harper dear unto the king',
];

// Light + dark, to show the app is themeable. The site is dark-only; the app is not.
const THEME_MONTAGE = ['theme-mocha', 'theme-macchiato', 'theme-latte'];

const stage = await openStage({ width: VIEW_W, height: VIEW_H, dpr: DPR });
const shots = [];

async function save(name, buf) {
    await sharp(buf).png({ compressionLevel: 9 }).toFile(path.join(OUT, `${name}.png`));
    await sharp(buf).resize({ width: WEB_WIDTH }).webp({ quality: 88 }).toFile(path.join(OUT, `${name}.webp`));
    const { width, height } = await sharp(buf).metadata();
    shots.push({ name, width, height, kb: (buf.length / 1024).toFixed(0) });
}

const setTheme = cls => stage.ev(`(() => { const b=document.body;
    b.className = b.className.replace(/theme-[\\w-]+/g, '').trim() + ' ' + ${JSON.stringify(cls)};
    if (typeof window.redrawWaveform === 'function') window.redrawWaveform(); })()`);

try {
    fs.mkdirSync(OUT, { recursive: true });

    const len = await stage.loadDemo();
    const priorFont = await stage.setFont(FONT);
    console.log(`transcript ${len} chars; font ${priorFont} → ${FONT} (will restore)`);

    // ── 1. Main editing view, phrase selected, waveform locked on ─────────────
    const hero = await stage.findPhrase(PHRASES[1]);
    await stage.setSel(hero.s, hero.e);
    await wait(1200);
    const editor = await stage.shoot();
    await save('editor-selection', editor);

    // ── 2. Waveform close-up — crop the real waveform out of the full frame ────
    // Geometry is reported in viewport CSS px; the capture is at DPR, so scale before extracting.
    const geo = await stage.geometry();
    const pad = 12;
    await save('waveform-detail', await sharp(editor).extract({
        left: Math.max(0, Math.round((geo.wf.x - pad) * DPR)),
        top: Math.max(0, Math.round((geo.wf.y - pad) * DPR)),
        width: Math.round((geo.wf.w + pad * 2) * DPR),
        height: Math.round((geo.wf.h + pad * 2) * DPR),
    }).toBuffer());

    // ── 3. Slices tab with templated filenames — THE wedge shot ───────────────
    // Real slices via the app's own createSlice(), so the names in the list are genuinely what the
    // filename template produces rather than mocked text.
    for (const phrase of PHRASES) {
        const r = await stage.findPhrase(phrase);
        await stage.setSel(r.s, r.e);
        await wait(700);
        await stage.ev(`window.createSlice()`, { awaitPromise: true });
        await wait(900);
    }
    await stage.ev(`document.querySelectorAll('#toast-container .toast').forEach(t=>t.remove())`);
    await stage.tab('slices');
    await wait(900);
    await save('slices-named', await stage.shoot());

    // ── 4 & 5. Settings panels ────────────────────────────────────────────────
    // Cropped to content: a settings panel occupies the top third of the window, so a full-window
    // grab is mostly empty background — fine on screen, weak in a gallery or a PH carousel.
    const settingsShot = async (name) => {
        const bottom = await stage.value(`(() => {
            const els = [...document.querySelectorAll('.settings-nav-btn, .settings-panel.active *')];
            return els.reduce((m, el) => {
                const r = el.getBoundingClientRect();
                return r.height ? Math.max(m, r.bottom) : m;
            }, 0);
        })()`);
        const h = Math.round((bottom + 28) * DPR);
        await save(name, await sharp(await stage.shoot())
            .extract({ left: 0, top: 0, width: VIEW_W * DPR, height: Math.min(h, VIEW_H * DPR) })
            .toBuffer());
    };

    await stage.panel('export');        // slice filename template + tokens
    await settingsShot('settings-filenames');

    await stage.panel('transcription'); // Whisper model + language + device
    await settingsShot('settings-model');

    // ── 6. Theme montage ──────────────────────────────────────────────────────
    await stage.tab('transcription');
    await wait(500);
    const tiles = [];
    for (const t of THEME_MONTAGE) {
        await setTheme(t);
        await wait(700);
        tiles.push(await stage.shoot());
    }
    const tileW = Math.round(VIEW_W * DPR / THEME_MONTAGE.length);
    const resized = await Promise.all(tiles.map(b => sharp(b).resize({ width: tileW }).toBuffer()));
    const tileMeta = await sharp(resized[0]).metadata();
    await save('themes', await sharp({
        create: {
            width: tileW * THEME_MONTAGE.length, height: tileMeta.height,
            channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    }).composite(resized.map((input, i) => ({ input, left: tileW * i, top: 0 })))
        .png().toBuffer());

    await stage.restoreFont(priorFont);

    console.log(`\nwrote ${shots.length} shots to ${OUT}`);
    for (const s of shots) console.log(`   ${s.name.padEnd(20)} ${s.width}x${s.height}  ${s.kb} KB`);
    console.log('\n>> LOOK at every PNG before using it: no coach overlay, no personal paths.');
} catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
} finally {
    stage.close();
}
