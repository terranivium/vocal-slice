// Films the product video from the real app, in three aspect ratios.
// Writes ../vocal-slice-web/press/video/{vocal-slice.mp4,.webm,-1x1.mp4,-9x16.mp4,cuts.json}.
//
//   node brand/build-video.mjs
//
// Shares the CDP harness with build-demo.mjs and build-shots.mjs (lib/app-stage.mjs), so what's
// filmed is the app's OWN bundled public-domain demo (window.loadDemo) driving its OWN real
// interactions — the drags run the app's actual onDrag(). Nothing is mocked.
//
// ── Why there is no camera ───────────────────────────────────────────────────────────────────────
//
// An earlier version captured once in landscape and cropped that capture to produce each format.
// Every framing problem it had came from that one decision: crop loosely and the app sits small
// inside its own edges; crop tighter and the transcript is cut through the middle of a word; frame
// the waveform and one of the two handles falls outside; frame both handles and no zoom is possible.
// Cropping a landscape UI into a portrait frame is lossy by construction, so each fix just moved the
// loss somewhere else.
//
// So: NO CROPPING. Each format sizes the app viewport to its own aspect and captures separately, and
// the app's own flex layout fills the frame. The waveform then spans the full window width in every
// format, which means BOTH HANDLES ARE IN FRAME BY CONSTRUCTION rather than by careful framing.
// Motion comes from the app itself — the highlight sweeping across, handles dragging, the toast.
//
// Three things in the app make this safe, all verified before this was written:
//   · static/styles.css has no media queries — the layout is flex, with no breakpoints to fall off.
//   · The waveform has a ResizeObserver that redraws and calls updateHandlePositions() (app.js).
//   · .transport-controls is width:fit-content inside a flex-wrap:wrap parent, so it wraps at 800px
//     rather than overflowing.
//
// Do NOT "compact" the transcript box by setting #transcription-content to flex:0 0 auto. It is
// flex:1 in the stylesheet and fills the tab on its own; forcing it left a dead strip along the
// bottom of every frame, which looked like the app failing to fill the video.
//
// Frames carry a DURATION rather than being captured in real time, so a static beat is one held
// frame and only a sweep or a drag needs many. ffmpeg's concat demuxer replays the timing.
//
// ── Two things the first cut got wrong, both measured rather than guessed ────────────────────────
//
// The Short retained well (0:44 average on a 30s video — people looped it) but 80.5% swiped away, so
// four in five never reached the mechanic. Pulling frames out of the encode showed why:
//
//   1. IT UNDER-SOLD THE MECHANIC. The transcript and the waveform drive EACH OTHER, and only one
//      direction was presented as a feature; the return leg was framed as "fine-tune the edges" and
//      existed in the landscape cut alone. The `link` beat now shows both, in every format.
//   2. THE EYE READ THE APP, NOT THE CAPTION. The transcript is narrative prose, and reading prose is
//      involuntary, so a caption changing beside it lost every time. Fixed by making the caption
//      bigger, moving it up against the app, writing every caption as a standalone line of five words
//      or fewer (the old ones ran on from each other, which a swiping viewer never saw the start of),
//      and giving each one an ENTRANCE — see sayIn().
//
// 9:16 also stopped sharing the landscape choreography. A feed video carries fewer ideas.
//
// ── Since amended, deliberately: the CAPTIONS no longer state the return leg ─────────────────────
//
// The four captions that narrated the link ran 12.7s of a 28.8s body — 44% of the video, four
// caption changes on one idea — and read busy. They are now two: "Highlight text to make an audio
// selection." and "Fine-tune with the waveform handles."
//
// Read finding 1 above as still true of the FILMING and no longer true of the WORDS. The return leg
// is shown exactly as before, in every format: the drag still visibly pulls words back out of the
// transcript highlight, and the hold that made that readable is still there as a plain shoot().
// Only the caption naming it is gone — and "fine-tune", the framing finding 1 was written against,
// is deliberately back. That was a considered call to cut caption churn, not an oversight, and the
// finding is kept intact rather than rewritten so the experiment and its reversal are both on
// record. If retention drops on the next Short, this is the first thing to put back.
//
// ── Two things tried and rejected, so they don't get re-attempted ────────────────────────────────
//
// FILMING A REAL TRANSCRIPTION. It works: loadDemo() leaves the clip in currentFile and
// handleTranscribe() needs nothing else, so the app genuinely decodes on camera in ~8s with spinner,
// progress bar and words streaming in. What lands is the problem — tiny.en on 19th-century Celtic
// proper nouns gives "Nunn was greater than the great conquer bar" and "dwelt fellam", and that would
// sit on screen for the whole video. demo.json's text is clean.
//
// BLURRING THE TRANSCRIPT while a caption landed. Effective and genuinely jarring: a fast ramp on the
// largest element in frame, repeated every beat, with no motivation anywhere in the app — it read as
// a glitch, and it also hid the transcript highlight during the one beat that is about the transcript
// highlight. Animating the caption gets the same attention for none of the cost, because the app is
// already still at that moment, so the caption becomes the only thing moving.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openStage, sharp, wait, SITE } from './lib/app-stage.mjs';
import { ff } from './lib/ffmpeg.mjs';
import { SERIF, SANS, TEXT, SUBTEXT, OVERLAY, esc, wrapText } from './lib/type.mjs';
import * as vo from './build-voiceover.mjs';

const OUT = path.join(SITE, 'press', 'video');

// The app is captured at 1.35x and downsampled, so nothing is ever blown up.
const DPR = 1.35;

// Beats each format plays. 9:16 is a feed video, so it ends on the named files and gets out; the
// re-trim is a refinement a viewer who has not decided to care yet does not need, and it earns its
// place only in the longer landscape cut.
//
// `link` is in BOTH lists on purpose. It is the product — the transcript and the waveform drive each
// other — not a detail, and the vertical cut was the one missing it.
//
// The Settings naming panel is gone from every format: ~65% empty frame even in landscape, and it
// ended the landscape cut on the weakest shot in it. The Slices tab covers naming better anyway, by
// showing the finished filenames rather than the template that produced them.
//
// `jump` was dropped when the selection beat went from two captions to one — the waveform snapping
// is now held under the `select` caption rather than getting a caption of its own, so no cut carries
// that label and listing it here would document a beat that no longer exists.
const FULL = ['select', 'link', 'create', 'edit'];
const FEED = ['select', 'link', 'create', 'slices'];

// appW/appH are CSS px; multiplied by DPR they are exactly the app area in the output frame.
// Heights were chosen against the real layout: below ~700 CSS the transcript can't hold the demo
// text, and at 889 the 9:16 text fills the pane without leaving it half empty.
//
// FONT must be a size #font-size-select actually offers — 11-24px in steps, then 28px. It is a plain
// <select>, and assigning a value it does not have leaves it EMPTY rather than erroring, at which
// point updateTranscriptionStyle() clears the font-size property and the transcript silently falls
// back to the stylesheet default. This config asked for 26px and every landscape video ever built
// shipped at that default instead. setFont() now throws rather than letting it pass. 28px matches
// DEMO_FONT in build-demo.mjs, so the hero animation and the video set the transcript identically.
const FONT = '28px';
const FORMATS = [
    { id: '16x9', W: 1920, H: 1080, appW: 1422, appH: 704, beats: FULL, file: 'vocal-slice.mp4' },
    { id: '1x1', W: 1080, H: 1080, appW: 800, appH: 700, beats: FULL, file: 'vocal-slice-1x1.mp4' },
    { id: '9x16', W: 1080, H: 1920, appW: 800, appH: 889, beats: FEED, file: 'vocal-slice-9x16.mp4' },
];

// Candidates, not one string: the transcript is now live model output rather than demo.json, so the
// exact wording is the model's to decide and it does not match the pre-baked text word for word
// ("So fair was his realm that poets sang" for "So fair was his realm Poet sang"). First match wins.
// findPhrase normalises case and punctuation, so only real wording differences need listing here.
const PHRASE = process.env.DEMO_PHRASE ? [process.env.DEMO_PHRASE] : [
    'So fair was his realm that poets sang',
    'So fair was his realm Poet sang',
];
const EXTRA_PHRASES = [
    ['the sweetest songs', 'the sweetest songs of Aaron'],
    ['a warrior, and harper dear unto the king', 'harper dear unto the king'],
    ['with his chief lords would visit the castle', 'his chief lords would visit'],
];

/** First candidate present in the transcript. `required` throws if none are. */
async function pick(stage, candidates, required = false) {
    for (const c of candidates) {
        const r = await stage.findPhrase(c, { quiet: true });   // a miss here just means "try the next"
        if (r.found) return r;
    }
    if (required) throw new Error(`none of these are in the transcript: ${JSON.stringify(candidates)}`);
    return { found: false };
}

const FRAME_MS = 55;
const SWEEP_FRAMES = 26;    // frames the text-selection sweep takes

// How far in the `link` beat pulls the end handle, and how slowly. 0.5, not the 0.75 this started at:
// at 0.75 exactly ONE word leaves the transcript highlight, which demonstrates nothing. At 0.5 half
// the phrase drops out and the point — that the waveform drives the text, not just the reverse — is
// unmissable. 20 frames rather than 14 so it is slow enough to follow.
const TRIM_FRAC = 0.5;
const TRIM_FRAMES = 20;

// Caption entrance. The app is already still while a caption changes, so animating the caption makes
// it the only thing moving in frame — a stronger attractor than size or contrast, and unlike blurring
// the transcript it never touches the app, so nothing can read as a glitch.
const CAP_IN = [0, 0.25, 0.55, 0.8, 1];    // opacity ramp for the incoming caption
const CAP_OUT = [0.45, 0];                 // and for the outgoing one
const CAP_RISE = 0.4;                      // how far it rises, as a fraction of the font size

// The title card's line. Named because it's used twice — rendered onto the card, and spoken.
const HOOK = 'Cut audio by selecting text.';
const HOOK_LEAD_MS = 300;

// The end card's entry in the concat list. It is on screen for TWICE this: the concat demuxer needs
// the final entry repeated to give it a duration (see the concat.txt write below), so the repeat
// plays too. Measured — a 28.56s body plus END_MS here produces a 35.37s file.
const END_MS = 3400;

// Spoken over the end card, and nowhere on it. This is the only line in the video that names the
// audience; the site's features section carries the same four in the same order.
const OUTRO = 'For podcasters, video editors and voiceover artists. Free and open source.';
const OUTRO_LEAD_MS = 600;   // let the card arrive before anything is said over it

// ── Caption band ─────────────────────────────────────────────────────────────
/**
 * Caption type size. Large enough to hold its own against seven lines of transcript — per glyph the
 * caption always won, but on total mass it did not, and mass is what the eye weighs. 16:9 runs a
 * little smaller because its band is only ~130px tall.
 */
const capSize = fmt => (fmt.id === '16x9' ? 54 : 58);

/**
 * The band under the app. On 9:16 it is deliberately tall — the app can't fill a 1920px frame at a
 * readable width, so rather than stretch it, the remainder becomes branded space carrying the
 * caption and a standing wordmark.
 *
 * The wordmark was briefly dropped as a third block of text competing with the caption. It isn't the
 * one that was doing the damage — the transcript was, and blurring it during captions is what fixed
 * that. Without the wordmark the tall band is ~500px of nothing under a single line, so it stays.
 */
function captionBand(text, fmt, bg, { opacity = 1, dy = 0 } = {}) {
    const h = fmt.H - Math.round(fmt.appH * DPR);
    const size = capSize(fmt);
    const lines = wrapText(text, fmt.W, size);
    const lh = size * 1.3;
    const tall = h > 400;
    // Sit the caption right up under the app on a tall band, so it groups with the thing it is
    // describing. At 0.22 it floated ~158px clear of the app in a 720px band and read as a separate
    // region the eye had to travel to.
    // Headroom on the SHORT bands is thin when a caption wraps. Measured on 1:1 (h=135, two lines at
    // 58): the second baseline lands 8px off the frame edge, which is fine for "selection." or
    // "handles." and would not be for a line ending in a descender — g, j, p, q, y need ~12px. Nothing
    // wraps on 16:9 (62 chars fit one line) and 9:16's band is ~720px, so this is a 1:1 concern only.
    // If a two-line 1:1 caption ever ends in a descender, drop capSize for that format rather than
    // nudging this centre — moving the block up pushes it into the app instead.
    const capCentre = tall ? h * 0.14 : h / 2;
    const top = capCentre - ((lines.length - 1) * lh) / 2 + size * 0.36;

    // Captions are narration, so they take the sans — which also keeps them distinct from the serif
    // transcript text sitting directly above them in frame.
    // opacity/dy animate ONLY the caption. The wordmark below is a standing element of the band and
    // must not move with it.
    const caption = opacity <= 0 ? '' : lines.map((l, i) =>
        `<text x="${fmt.W / 2}" y="${(top + i * lh + dy).toFixed(1)}" text-anchor="middle" fill="${TEXT}" ` +
        `fill-opacity="${opacity.toFixed(3)}" ` +
        `font-family="${SANS}" font-size="${size}" font-weight="600">${esc(l)}</text>`).join('');

    const mark = tall
        ? `<text x="${fmt.W / 2}" y="${(h * 0.74).toFixed(1)}" text-anchor="middle" fill="${TEXT}" ` +
          `font-family="${SERIF}" font-size="60" font-weight="700">Vocal Slice</text>` +
          `<text x="${fmt.W / 2}" y="${(h * 0.83).toFixed(1)}" text-anchor="middle" fill="${SUBTEXT}" ` +
          `font-family="${SANS}" font-size="34">vocalslice.com</text>`
        : '';

    return Buffer.from(
        `<svg width="${fmt.W}" height="${h}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${fmt.W}" height="${h}" fill="${bg}"/>${caption}${mark}</svg>`);
}

const endScale = fmt => Math.min(fmt.W / 1920, fmt.H / 1080) * (fmt.id === '16x9' ? 1 : 1.45);

function endCardSvg(fmt, bg) {
    const cx = fmt.W / 2, cy = fmt.H / 2, s = endScale(fmt);
    return Buffer.from(
        `<svg width="${fmt.W}" height="${fmt.H}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${fmt.W}" height="${fmt.H}" fill="${bg}"/>` +
        // Three lines, not four. Baselines are spaced for that — dropping the old tagline out of the
        // middle without re-spacing would have left a hole and pushed the block off centre.
        `<text x="${cx}" y="${cy + 10 * s}" text-anchor="middle" fill="${TEXT}" ` +
        `font-family="${SERIF}" font-size="${(84 * s).toFixed(0)}" font-weight="700">Vocal Slice</text>` +
        `<text x="${cx}" y="${cy + 90 * s}" text-anchor="middle" fill="${SUBTEXT}" ` +
        `font-family="${SANS}" font-size="${(40 * s).toFixed(0)}">vocalslice.com</text>` +
        // The end card's job is to get someone to try it: "free and open source" is the whole ask.
        `<text x="${cx}" y="${cy + 170 * s}" text-anchor="middle" fill="${OVERLAY}" ` +
        `font-family="${SANS}" font-size="${(30 * s).toFixed(0)}">` +
        `Free and open source  ·  Mac &amp; Windows</text></svg>`);
}

/**
 * The brand mark, centred, with its BASE `gap`·s above the frame's midline — so a card can place its
 * text block from the midline down and the two stay as one lockup.
 *
 * 80 on the end card, not the 110 it started at: the text block below is three lines now rather than
 * four, so the mark sits closer in to keep the whole thing centred.
 */
async function cardMark(fmt, gap = 80) {
    const src = path.join(SITE, 'favicon.svg');
    if (!fs.existsSync(src)) { console.warn('!! favicon.svg missing — card will have no mark.'); return null; }
    const s = endScale(fmt);
    const size = Math.round(190 * s);
    const input = await sharp(src, { density: 400 }).resize({ width: size }).png().toBuffer();
    return { input, left: Math.round((fmt.W - size) / 2), top: Math.round(fmt.H / 2 - gap * s - size) };
}

/**
 * The opening card: the mark over the hook line, on the brand colour.
 *
 * The video used to cut cold into the app UI, which is a dense desktop screen and the weakest
 * possible first frame for a feed — there is nothing for the eye to land on. One simple thing first,
 * then the app, and it bookends the end card so the video is topped and tailed the same way.
 */
function openCardSvg(fmt, bg, text) {
    const s = endScale(fmt);
    const size = Math.max(capSize(fmt), Math.round(70 * s));
    const lines = wrapText(text, fmt.W, size);
    const lh = size * 1.3;
    const top = fmt.H / 2 + 55 * s;
    return Buffer.from(
        `<svg width="${fmt.W}" height="${fmt.H}" xmlns="http://www.w3.org/2000/svg">` +
        `<rect width="${fmt.W}" height="${fmt.H}" fill="${bg}"/>` +
        lines.map((l, i) =>
            `<text x="${fmt.W / 2}" y="${(top + i * lh).toFixed(1)}" text-anchor="middle" fill="${TEXT}" ` +
            `font-family="${SANS}" font-size="${size}" font-weight="600">${esc(l)}</text>`).join('') +
        `</svg>`);
}

// ── Film one format ──────────────────────────────────────────────────────────
async function film(fmt, tmp) {
    const appPx = { w: Math.round(fmt.appW * DPR), h: Math.round(fmt.appH * DPR) };
    const dir = path.join(tmp, fmt.id);
    fs.mkdirSync(dir, { recursive: true });

    const on = name => fmt.beats.includes(name);

    const stage = await openStage({ width: fmt.appW, height: fmt.appH, dpr: DPR });
    const frames = [];
    const cuts = [];
    // Every caption, with the millisecond it starts appearing — this IS the voiceover script.
    // See build-voiceover.mjs for why the words are collected here rather than written there.
    const narration = [];
    let caption = '', elapsed = 0, bg = '#181825';

    try {
        bg = await stage.value(`(() => { const c = getComputedStyle(document.body).backgroundColor;
            const [r,g,b] = c.match(/\\d+/g).map(Number);
            return '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join(''); })()`) || bg;

        await stage.loadDemo();
        const priorFont = await stage.setFont(FONT);

        /** The app as currently laid out, sized to its area in the output frame. */
        const grabApp = async () => sharp(await stage.shoot())
            .resize({ width: appPx.w, height: appPx.h, fit: 'fill' }).toBuffer();

        /** The finished frame for an app capture plus a caption band, not yet written. */
        const compose = (app, band) => sharp({
            create: { width: fmt.W, height: fmt.H, channels: 4, background: bg },
        }).composite([
            { input: app, left: 0, top: 0 },
            { input: captionBand(caption, fmt, bg, band), left: 0, top: appPx.h },
        ]).png().toBuffer();

        /** Commit a finished frame and give it `ms` of screen time. */
        function write(buf, ms) {
            const file = `f${String(frames.length).padStart(5, '0')}.png`;
            fs.writeFileSync(path.join(dir, file), buf);
            frames.push({ file, ms });
            elapsed += ms;
        }

        const emit = async (app, band, ms) => write(await compose(app, band), ms);

        /** One video frame of the app as it is right now. */
        const shoot = async ms => emit(await grabApp(), {}, ms);

        /**
         * `spoken` overrides what the voiceover reads, for the rare case where the written line and
         * the said line can't be the same string — an abbreviation, a URL. Leave it off and the
         * voice reads the caption verbatim, which is what keeps the two from drifting apart.
         *
         * The cue is this moment — the start of the caption's fade-in, not the end of it. The voice
         * then leads the text settling by a couple of frames, which is how the two read as one beat
         * rather than as a caption being narrated after the fact.
         */
        const say = (text, label, spoken) => {
            caption = text;
            narration.push({ atMs: elapsed, text, ...(spoken ? { spoken } : {}) });
            if (label) cuts.push({ label, atMs: elapsed });
        };

        /**
         * Bring a new caption in: the old one fades out, the new one fades up and rises to rest.
         *
         * Every frame of the entrance composites the SAME app capture. That is the point rather than
         * an optimisation — if the app is re-screenshotted per frame the caret blinks and the waveform
         * repaints underneath, and "the only thing moving is the caption" stops being true.
         */
        async function sayIn(text, holdMs, label, spoken) {
            const app = await grabApp();
            const rise = capSize(fmt) * CAP_RISE;

            if (caption) for (const o of CAP_OUT) await emit(app, { opacity: o }, FRAME_MS);
            say(text, label, spoken);
            for (const o of CAP_IN) await emit(app, { opacity: o, dy: (1 - o) * rise }, FRAME_MS);
            await emit(app, {}, holdMs);
        }

        // ── 1 · title card, then dissolve into the app ───────────────────────
        // The hook lives on the card and nowhere else, so it never has to jump from the middle of the
        // frame down into the caption band mid-dissolve. loadDemo has already left a default
        // selection in place, so the app is a working screen the instant it appears — nothing here is
        // waiting for a selection to exist.
        const card = await sharp(openCardSvg(fmt, bg, HOOK))
            .composite([await cardMark(fmt, 40)].filter(Boolean)).png().toBuffer();
        cuts.push({ label: 'hook', atMs: elapsed });
        // The hook is the one line that lives on the card rather than in the caption band, so it has
        // to be added to the script by hand. HOOK_LEAD_MS holds the voice off the very first frame —
        // starting on 0 sounds like the file was cut into, and the card needs a beat to be read.
        narration.push({ atMs: elapsed + HOOK_LEAD_MS, text: HOOK });
        write(card, 1200);

        // Fade DOWN to the brand colour and then UP into the app, rather than cross-dissolving one
        // into the other. A straight dissolve ghosts the card's mark and hook text across the
        // waveform and the transcript for the middle of the transition, which reads as a rendering
        // fault rather than a cut. Going through a plain frame means they never share one.
        const first = await compose(await grabApp(), {});
        const over = async (top, o) => sharp({
            create: { width: fmt.W, height: fmt.H, channels: 4, background: bg },
        }).composite([{ input: await sharp(top).removeAlpha().ensureAlpha(o).png().toBuffer() }])
            .png().toBuffer();

        for (const o of [0.55, 0.2]) write(await over(card, o), FRAME_MS);
        for (const o of [0.35, 0.7]) write(await over(first, o), FRAME_MS);
        write(first, 700);

        // ── 2 · the step that isn't filmed ───────────────────────────────────
        // Opening a file is STATED rather than shown. Filming it was tried twice — a real Whisper run,
        // then a withheld transcript — and both spent the opening seconds on an app sitting empty,
        // which is exactly what a feed viewer swipes past. A caption over a working app costs nothing
        // and answers the same question.
        //
        // ONE caption. This ran as two for a while — "Load your own recording." then "Your audio never
        // leaves your device." — because the line before that welded both ideas together with an em
        // dash ("Load your own recording — it all runs locally"), at eight words and with "it all"
        // having no antecedent on screen. The em-dash version is not worth going back to.
        //
        // The privacy caption was then CUT, and the reason is worth keeping: this beat has no app
        // action, so a caption here is a static frame — sayIn holds the same capture for its whole
        // hold. Two static beats back to back put ~4s of frozen UI in the opening, which is the one
        // stretch of the video that cannot afford to be dull. Privacy is carried by the site, which
        // words it identically ("Your audio never leaves your device." — index.html, store-copy.md);
        // it is NOT stated anywhere in the video now. If it has to come back, put it in the spoken
        // outro over the end card, which is static by nature and already has room — not here.
        //
        // "your own" is load-bearing: what is on screen is the bundled demo clip, and without it a
        // viewer can reasonably assume the transcript is canned rather than something they would get
        // from their own audio.
        //
        // "voice", not just "recording": the product is called Vocal Slice and the word appeared
        // nowhere in the video or on the site, which left the name unearned and the tool reading as a
        // general audio editor. Five words, so it still holds the caption budget. 1600 rather than
        // 1400 because the extra word pushes the spoken take past a 1400 hold's window.
        await sayIn('Load your own voice recording.', 1600, 'open');

        // required: a silent fallback to the opening words would film an arbitrary selection into a
        // press asset, and nothing downstream would catch it.
        const range = await pick(stage, PHRASE, true);

        // ── 2 · text drives the waveform ─────────────────────────────────────
        // Step the range forward so the highlight sweeps like a real drag-select, dispatching mouseup
        // only at the end — firing it every step would make the waveform thrash instead of snapping.
        await sayIn('Highlight text to make an audio selection.', 900, 'select');
        for (let i = 1; i <= SWEEP_FRAMES; i++) {
            const to = Math.round(range.s + (range.e - range.s) * (i / SWEEP_FRAMES));
            await stage.ev(`(() => { const ta = document.getElementById('transcription-text');
                ta.focus(); ta.setSelectionRange(${range.s}, ${to}); })()`);
            await shoot(FRAME_MS);
        }

        await stage.setSel(range.s, range.e);   // commit → the waveform snaps to the span
        await wait(1000);
        // A plain hold, not a caption. The snap is the payoff of the beat and it used to get its
        // screen time from the 'The waveform follows.' caption's 2800ms hold — drop the caption
        // without replacing the hold and the thing the beat exists to show flashes past. Shorter than
        // 2800 because it no longer has to keep a line on screen long enough to read.
        await shoot(2200);

        const geo = await stage.geometry();
        const csx = geo.cs.x + geo.cs.w / 2, csy = geo.cs.y + geo.cs.h / 2;

        // ── 3 · and the waveform drives the text ─────────────────────────────
        // The return leg, and the reason this beat exists at all. The app's real onDrag runs
        // throughout, so the band, the duration readout AND the transcript highlight follow the
        // handle — pulling the end handle to TRIM_FRAC visibly takes words back out of the highlight.
        //
        // The caption says "fine-tune" and this is more than that. That mismatch is deliberate — see
        // the amendment in the header — so the beat has to carry the idea on the picture alone. Which
        // is why the drag distance, the real onDrag and the payoff hold below are now the whole of it:
        // shorten any of them and nothing anywhere states what the waveform is doing to the text.
        //
        // A nudge, in and back out, rather than a retract-then-regrow: it starts and ends on the full
        // phrase, so the slice created next still matches the words that were highlighted.
        if (on('link')) {
            const trimX = geo.startX + (geo.endX - geo.startX) * TRIM_FRAC;
            await sayIn('Fine-tune with the waveform handles.', 700, 'link');
            await stage.drag(geo.endX, trimX, geo.hy, TRIM_FRAMES, 40, () => shoot(FRAME_MS));
            // The payoff frame: held long enough to see the highlight SHORTEN as the handle moves.
            // Was a caption ('The words follow.'); now a plain hold, for the same reason as the snap
            // above — the moment still needs its time on screen, it just isn't narrated any more.
            await shoot(1600);
            await stage.drag(trimX, geo.endX, geo.hy, TRIM_FRAMES, 40, () => shoot(FRAME_MS));
            await wait(200);
            await shoot(1500);
        }

        // ── 4 · create ───────────────────────────────────────────────────────
        await sayIn('Create the slice.', 800, 'create');
        await stage.mouse('mouseMoved', csx, csy, 0); await wait(80); await shoot(500);
        await stage.mouse('mousePressed', csx, csy); await wait(60); await shoot(220);
        await stage.mouse('mouseReleased', csx, csy);
        for (let i = 0; i < 6; i++) { await wait(80); await shoot(i === 5 ? 1500 : 110); }

        // A few more, so the Slices tab reads as a real delivery batch rather than one example.
        // Not `required` — these are garnish, and against a changed transcript a miss should cost one
        // slice off the batch rather than the whole run.
        for (const candidates of EXTRA_PHRASES) {
            const r2 = await pick(stage, candidates);
            if (!r2.found) continue;
            await stage.setSel(r2.s, r2.e);
            await wait(600);
            await stage.ev(`window.createSlice()`, { awaitPromise: true });
            await wait(700);
        }
        await stage.ev(`document.querySelectorAll('#toast-container .toast').forEach(t=>t.remove())`);

        await stage.tab('slices');
        await wait(900);

        // ── 5a · the named files (feed cut closes here) ──────────────────────
        // A plain statement of what the shot shows — a BATCH, not one file — because this is the last
        // thing a feed viewer sees, and every other caption in the video is a flat statement of the
        // mechanic. "Named, ready to deliver." was the one that wasn't: it never said named HOW, and
        // it borrowed a client-delivery framing the site's copy never uses. Don't restore the
        // flourish. "already" is the payoff — the naming happened without you.
        //
        // The spoken line reaches the export idea the four-word caption has no room for. This is the
        // only beat where the voice and the caption deliberately differ.
        if (on('slices')) {
            await sayIn('Every clip, already named.', 2600, 'slices',
                'Every clip, already named and ready to export.');
        }

        // ── 5b · re-trim in place (landscape ends here) ──────────────────────
        // The batch of named files stays visible behind the editor here.
        if (on('edit')) {
            await stage.ev(`document.querySelector('#slices-list .slice-item .slice-edit-btn')?.click()`);
            await wait(1100);
            await sayIn('Re-trim without starting over.', 2000, 'edit');

            const eg = await stage.value(`(() => {
                const e = document.getElementById('edit-waveform-end-handle');
                const s = document.getElementById('edit-waveform-start-handle');
                if (!e || !s) return null;
                const er = e.getBoundingClientRect(), sr = s.getBoundingClientRect();
                return { endX: er.left + er.width/2, startX: sr.left + sr.width/2, y: er.top + er.height/2 };
            })()`);
            if (eg) {
                await stage.drag(eg.endX, eg.startX + (eg.endX - eg.startX) * 0.62, eg.y, 14, 40,
                    () => shoot(FRAME_MS));
                // The video ENDS on this frame — editor still open, handle where the drag left it —
                // and cuts straight to the end card.
                //
                // It used to click Update and film the result, on the reasoning that committing
                // rather than cancelling proved the edit stuck. What that actually put on screen was
                // the editor collapsing back to the plain list for a little over a second: the
                // weakest shot in the cut, in the last position, where it decides how the whole thing
                // lands. Nothing is lost by dropping it, because the edit is already visibly sticking
                // INSIDE the editor — the app's real onDrag updates End and Duration live as the
                // handle moves, so the readout has counted itself down before this frame is held.
                await shoot(2400);
            } else {
                console.warn('!! edit-waveform handles not found — skipping the re-trim drag.');
                await shoot(1800);
            }
        }

        await stage.restoreFont(priorFont);
    } finally {
        stage.close();
    }

    // ── End card ─────────────────────────────────────────────────────────────
    // The mark is composited rather than <image>-referenced from the SVG, because an external href
    // inside an SVG isn't resolved by the rasteriser.
    const endFile = `f${String(frames.length).padStart(5, '0')}.png`;
    const mark = await cardMark(fmt);
    await sharp(endCardSvg(fmt, bg)).composite(mark ? [mark] : []).png()
        .toFile(path.join(dir, endFile));
    frames.push({ file: endFile, ms: END_MS });

    // The card holds the screen for ~2×END_MS with nothing said over it, which in a narrated video is
    // the only room left to say who this is for. The body can't carry it: captions are five words by
    // measured necessity, and the opening — the one stretch a new idea would have to go in — is where
    // the swipe-away was measured.
    //
    // Voice only, deliberately. A fourth line of text would reach muted viewers, but the card went
    // from four lines to three and its baselines and cardMark's gap were re-spaced for three (see
    // endCardSvg) — so putting one back is a design change, not a copy change.
    narration.push({ atMs: elapsed + OUTRO_LEAD_MS, text: OUTRO, voiceOnly: true });

    // ── Encode ───────────────────────────────────────────────────────────────
    // Relative filenames with cwd=dir so no Windows path needs escaping in the concat list. The last
    // entry is repeated without a duration — ffmpeg's documented way to time the final frame.
    fs.writeFileSync(path.join(dir, 'concat.txt'),
        frames.map(f => `file '${f.file}'\nduration ${(f.ms / 1000).toFixed(3)}`).join('\n') +
        `\nfile '${frames[frames.length - 1].file}'\n`);

    // ── Voice ────────────────────────────────────────────────────────────────
    // Built before the encode so the bed can go in as a second input, rather than muxed on after in
    // a pass that would have to copy the file again. Silent if the model isn't installed — the video
    // is the deliverable and it must never fail for want of a voice.
    //
    // The bed is sized to elapsed + the end card, NOT to elapsed. `elapsed` counts the body only —
    // the end card is pushed straight into `frames` above without going through write(), so it never
    // increments it. buildTrack sizes the last line's window as total - atMs, so passing `elapsed`
    // here would hand the outro a negative window and squeeze it to nothing.
    const audioMs = elapsed + END_MS * 2;
    let bed = null;
    if (VOICE_ON && vo.available()) {
        bed = path.join(dir, 'voice.wav');
        const fitted = await vo.buildTrack(narration, bed, audioMs);
        if (fitted) vo.report(fmt.id, fitted); else bed = null;   // nothing said → encode silent
    }
    // No -shortest: the bed ends before the end card does, and -shortest would cut the video to it.
    const audio = bed ? ['-i', bed, '-map', '0:v:0', '-map', '1:a:0'] : [];

    // format=yuv420p is required, not cosmetic: the source PNGs carry alpha, which reaches the
    // encoder as gbrap and libvpx-vp9 refuses to open on it.
    ff(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', ...audio,
        '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '18',
        ...(bed ? ['-c:a', 'aac', '-b:a', '128k'] : []),
        '-preset', 'medium', '-movflags', '+faststart', path.join(OUT, fmt.file)], dir);

    if (fmt.id === '16x9') {
        ff(['-f', 'concat', '-safe', '0', '-i', 'concat.txt', ...audio,
            '-vf', 'fps=30,format=yuv420p', '-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0',
            ...(bed ? ['-c:a', 'libopus', '-b:a', '96k'] : []),
            '-row-mt', '1', path.join(OUT, 'vocal-slice.webm')], dir);
    }

    console.log(`   ${fmt.id.padEnd(5)} ${frames.length} frames · ${(elapsed / 1000).toFixed(1)}s` +
        `${bed ? ' · voiced' : ''}`);
    return { totalMs: elapsed, audioMs, cuts, narration };
}

// ── Run ──────────────────────────────────────────────────────────────────────
// VO=0 films silent without uninstalling anything — for when you're iterating on framing and don't
// want to wait on synthesis.
const VOICE_ON = process.env.VO !== '0';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'vocal-slice-video-'));
try {
    fs.mkdirSync(OUT, { recursive: true });

    if (VOICE_ON && !vo.available()) console.log(`   ${vo.INSTALL_HINT}\n`);

    // cuts.json describes the LANDSCAPE timeline: the beats are no longer identical across formats
    // (9:16 runs a shorter cut), and 16:9 is the one the site and the Product Hunt gallery use.
    let meta = null;
    const narration = [];
    for (const fmt of FORMATS) {
        const m = await film(fmt, TMP);
        if (fmt.id === '16x9') meta = m;
        // Every format keeps its OWN script — they do not share one. See build-voiceover.mjs.
        // totalMs here is the AUDIO length (body + end card), not cuts.json's body-only figure — the
        // last line is spoken over the end card, and a standalone re-voice has to size its window
        // against the same total the film run did or it will clip the outro.
        narration.push({
            id: fmt.id, totalMs: m.audioMs, lines: m.narration,
            files: fmt.id === '16x9' ? [fmt.file, 'vocal-slice.webm'] : [fmt.file],
        });
    }

    fs.writeFileSync(path.join(OUT, 'cuts.json'), JSON.stringify({ totalMs: meta.totalMs, cuts: meta.cuts }, null, 2));
    // Written whether or not the voice was built, so `node brand/build-voiceover.mjs` can voice
    // these renders later without re-filming them.
    fs.writeFileSync(path.join(OUT, 'narration.json'),
        JSON.stringify({ voice: vo.VOICE, formats: narration }, null, 2));
    console.log();
    for (const f of fs.readdirSync(OUT).sort()) {
        console.log(`   ${f.padEnd(26)} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} KB`);
    }
    console.log('\n>> WATCH all three end to end before posting them.');
} catch (err) {
    console.error('FAILED:', err.message, '\n', err.stack);
    process.exitCode = 1;
} finally {
    fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3 });
}
