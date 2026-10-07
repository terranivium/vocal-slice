// Captures the hero demo for the marketing site: real footage of the app responding to a real text
// selection, shot as a cinematic camera move and with the site's tilt BAKED IN for maximum quality.
// Writes ../vocal-slice-web/{demo.webp,demo-still.png}.
//
//   node brand/build-demo.mjs
//
// Same spirit as build-icon.js — site assets are generated from the source of truth (the running app)
// so they can't drift into showing a UI that no longer exists. What's filmed is the app's OWN bundled
// demo (window.loadDemo): a public-domain clip + pre-baked transcription, so it's self-contained and
// deterministic. Nothing is faked: the waveform end-handle drag runs the app's real onDrag(), so the
// band, handles, duration readout and transcript highlight all follow the selection.
//
// The launch/prepare/geometry/drag plumbing lives in lib/app-stage.mjs, shared with build-video.mjs
// and build-shots.mjs. What stays here is the part that is specific to the hero: the choreography and
// the tilt bake.
//
// Two stages:
//   1. CAMERA — drive the app and grab a moving `clip` that pans/zooms across three beats: full UI →
//      push in on the transcript selection + waveform (where the drag plays) → pan to Create Slice →
//      pull back to the full UI. Captured at high DPR so the zoomed beats stay crisp. Output: flat
//      frames, all the same aspect/size.
//   2. TILT — blow away the app DOM, drop each flat frame into an <img> with the exact perspective tilt
//      + drop-shadow the site used to do in CSS, and screenshot it on a transparent backdrop. The site
//      then shows a FLAT <img>: the angle and the motion are baked, so there's no browser 3D warp.

import fs from 'node:fs';
import path from 'node:path';
import { openStage, sharp, wait, lerp, SITE } from './lib/app-stage.mjs';

// ── App capture geometry ────────────────────────────────────────────────────
const VIEW_W = 960;
const VIEW_H = 740;
const CAM_ASPECT = VIEW_W / VIEW_H;   // flat-frame aspect (= full window) → no distortion on resize
const CAP_DPR = 2;                    // capture DPR (static camera — no zoom, so 2x is plenty)
const DEMO_FONT = '28px';             // large, legible transcript size; set explicitly, restored after
const DEMO_PHRASE = process.env.DEMO_PHRASE || 'So fair was his realm Poet sang its beauty';
const SHORT_FRAC = 0.16;              // where the drag opens, as a fraction from phrase start toward end

// ── Tilt bake (must match the angle the site previously applied in CSS) ───────
const IMG_W = 820;                    // compositor image width in CSS px
const STAGE_DPR = 2;                  // compositor capture DPR
const FLAT_W = IMG_W * STAGE_DPR;     // flat-frame width = exactly what the compositor <img> needs
const FLAT_H = Math.round(FLAT_W / CAM_ASPECT);
const TILT = 'perspective(1600px) rotateY(-13deg) rotateX(2.5deg) rotate(-0.5deg)';
// Only the TILT is baked. The drop-shadow is added by the site as a CSS filter on the flat baked
// image — that keeps the content crisp (no 3D warp of text) AND the shadow smooth (baking a big soft
// shadow into a lossy webp bands badly and bloats the file). So the margins here need only clear the
// tilt's near edge, not a shadow.
const STAGE_MX = 64, STAGE_MY = 48;   // small transparent margin around the tilted image
const OUT_WIDTH = 1000;               // final webp width (displayed ~480px, so this is already ~2x)

// ── Timeline (frame counts per beat; delays in ms) ────────────────────────────
const FRAME_DELAY = 55;
const SETTLE_MS = 40;
// Holds are single frames with a long delay — cheaper than many identical frames and avoids the
// encoder silently coalescing duplicates (which desyncs the delay list).
const HOLD_FULL_MS = 520, HOLD_SETTLE_MS = 480, HOLD_CONFIRM_MS = 900;
const SEG = {
    grow: 22,        // B: drag grows the selection onto the phrase
    confirm: 8,      // C: green flash + toast after the Create Slice click plays out
    reset: 16,       // D: reverse-drag the selection back to short (→ seamless loop)
};

const stage = await openStage({ width: VIEW_W, height: VIEW_H, dpr: CAP_DPR });

try {
    const len = await stage.loadDemo();
    const priorFont = await stage.setFont(DEMO_FONT);
    console.log(`font ${priorFont} → ${DEMO_FONT} (will restore)`);

    const range = await stage.findPhrase(DEMO_PHRASE);
    console.log(`transcript ${len} chars; phrase ${JSON.stringify(range.phrase)}`);

    // Establish the full-phrase selection first (sets the waveform window that bounds the drag).
    await stage.setSel(range.s, range.e);
    await wait(1200);

    const geo = await stage.geometry();
    const csx = geo.cs.x + geo.cs.w / 2, csy = geo.cs.y + geo.cs.h / 2;

    // ── Stage 1: capture flat, full-window frames (static camera) ─────────────
    const flats = [];   // { buf, delay }
    const shoot = async (delay) => {
        const buf = await sharp(await stage.shoot())
            .resize({ width: FLAT_W, height: FLAT_H, fit: 'fill' }).png().toBuffer();
        flats.push({ buf, delay });
    };

    const shortX = geo.startX + (geo.endX - geo.startX) * SHORT_FRAC;

    // Setup (not filmed): retract the end handle to the short opening selection.
    await stage.drag(geo.endX, shortX, geo.hy, 8, SETTLE_MS);
    await wait(200);

    // A) full UI, short selection (single held frame — this is also the loop's first frame).
    await shoot(HOLD_FULL_MS);

    // B) grow the selection onto the phrase by dragging the end handle shortX→endX.
    await stage.drag(shortX, geo.endX, geo.hy, SEG.grow, SETTLE_MS, () => shoot(FRAME_DELAY));
    await wait(150);

    // settle on the finished selection.
    await shoot(HOLD_SETTLE_MS);

    // C) the Create Slice click. Move onto the button (it lifts), press (it depresses), release — the
    //    delegated click handler runs createSlice(), which flashes the button green and slides in the
    //    "Slice created" toast. Capture the hover, the press, then the confirmation as it plays out.
    await stage.mouse('mouseMoved', csx, csy, 0); await wait(60); await shoot(120);   // hover lift
    await stage.mouse('mousePressed', csx, csy); await wait(50); await shoot(90);     // pressed
    await stage.mouse('mouseReleased', csx, csy);                                     // → createSlice()
    for (let i = 0; i < SEG.confirm; i++) { await wait(70); await shoot(i === SEG.confirm - 1 ? HOLD_CONFIRM_MS : 80); }

    // D) reset for a seamless loop: clear the confirmation, move the cursor off, and reverse-drag the
    //    selection back to the short opening state so the last frame matches frame A.
    await stage.ev(`(() => { document.querySelectorAll('#toast-container .toast').forEach(t=>t.remove());
        const b=document.getElementById('create-slice-btn'); if(b) b.style.background=''; })()`);
    await stage.mouse('mouseMoved', geo.endX, geo.hy, 0);   // cursor off the button
    await stage.drag(geo.endX, shortX, geo.hy, SEG.reset, SETTLE_MS, () => shoot(FRAME_DELAY));

    // Restore the user's font BEFORE we destroy the DOM for compositing.
    await stage.restoreFont(priorFont);
    console.log(`stage 1: ${flats.length} flat frames; font restored to ${priorFont}`);

    // ── Stage 2: bake the tilt + drop-shadow, transparent backdrop ────────────
    const STAGE_W = IMG_W + STAGE_MX * 2, STAGE_H = Math.round(IMG_W / CAM_ASPECT) + STAGE_MY * 2;
    await stage.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: STAGE_W, height: STAGE_H, deviceScaleFactor: STAGE_DPR, mobile: false,
    });
    await stage.cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await stage.ev(`(() => {
        document.documentElement.style.cssText = 'margin:0;background:transparent';
        document.body.style.cssText = 'margin:0;background:transparent;width:${STAGE_W}px;height:${STAGE_H}px;'
            + 'display:flex;align-items:center;justify-content:center;overflow:hidden';
        document.body.innerHTML = '<img id="__c" style="width:${IMG_W}px;height:auto;display:block;'
            + 'transform:${TILT}">';   // tilt only — the site adds the shadow as a CSS filter
    })()`);
    await wait(120);

    const setImg = dataUrl => stage.ev(
        `new Promise(res => { const i=document.getElementById('__c');
            i.onload=()=>requestAnimationFrame(()=>requestAnimationFrame(()=>res(true))); i.src=${JSON.stringify(dataUrl)}; })`,
        { awaitPromise: true });

    const tilted = [];
    for (const f of flats) {
        await setImg('data:image/png;base64,' + f.buf.toString('base64'));
        tilted.push(await stage.shoot());
    }
    console.log(`stage 2: ${tilted.length} tilted frames`);

    // ── Encode ────────────────────────────────────────────────────────────────
    const delays = flats.map(f => f.delay);

    // Trim the transparent margin down to the tilted window's bounding box — otherwise the UI floats
    // small inside empty space on the site. The window geometry is identical across frames, so compute
    // the box once (from frame 0) and extract the SAME region from every frame to keep them uniform.
    // (The site's drop-shadow is a CSS filter, so it needs no image margin here.)
    const t0 = await sharp(tilted[0]).trim({ threshold: 1 }).toBuffer({ resolveWithObject: true });
    const box = { left: -(t0.info.trimOffsetLeft || 0), top: -(t0.info.trimOffsetTop || 0),
                  width: t0.info.width, height: t0.info.height };
    const scaled = [];
    for (const b of tilted) scaled.push(await sharp(b).extract(box).resize({ width: OUT_WIDTH }).png().toBuffer());

    const webp = await sharp(scaled, { join: { animated: true } })
        .webp({ loop: 0, delay: delays, quality: 82, effort: 6, alphaQuality: 100 })
        .toBuffer();

    fs.mkdirSync(SITE, { recursive: true });
    fs.writeFileSync(path.join(SITE, 'demo.webp'), webp);

    // Still fallback: the settled selection-on-waveform frame (just after beat B) — the clearest shot.
    const stillIdx = 1 + SEG.grow;   // frame A (1) + the grow segment → the settle frame
    await sharp(scaled[Math.min(stillIdx, scaled.length - 1)]).png({ compressionLevel: 9 })
        .toFile(path.join(SITE, 'demo-still.png'));

    const meta = await sharp(webp, { animated: true }).metadata();
    console.log(`demo.webp      ${meta.width}x${meta.pageHeight}  ${meta.pages} frames  ${(webp.length / 1024).toFixed(0)} KB`);
    console.log(`>> set index.html <img> to width="${meta.width}" height="${meta.pageHeight}"`);
    if (!meta.pages || meta.pages < 2) throw new Error('encoded file is not animated');
} catch (err) {
    console.error('FAILED:', err.message);
    process.exitCode = 1;
} finally {
    stage.close();
}
