// Shared harness for filming the real app over CDP.
//
// Extracted from build-demo.mjs so the hero animation, the product video and the screenshot gallery
// all drive the app the same way. Everything here is capture-agnostic: it launches the app, puts it
// in a known, personal-data-free state, and exposes the primitives (geometry, mouse, selection,
// screenshot) that a capture script composes into a shot. Encoding and choreography stay in the
// callers, because that's what actually differs between them.
//
// The point of driving the running app rather than mocking a UI is that site assets can't drift into
// showing a screen that no longer exists — the same reason build-icon.js generates the icon.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { findTarget, connect, cleanEnv } from '../../.claude/skills/run-vocal-slice/cdp.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SITE = path.join(REPO, '..', 'vocal-slice-web');

const require = createRequire(import.meta.url);
export const sharp = require(path.join(REPO, 'node_modules', 'sharp'));

// Resolved from path.txt rather than assumed — see the ELECTRON_RUN_AS_NODE gotcha in SKILL.md.
const ELECTRON = path.join(REPO, 'node_modules/electron/dist',
    fs.readFileSync(path.join(REPO, 'node_modules/electron/path.txt'), 'utf8').trim());

export const wait = ms => new Promise(r => setTimeout(r, ms));
export const lerp = (a, b, p) => a + (b - a) * p;

const THEMES = ['theme-latte', 'theme-latte-soft', 'theme-frappe', 'theme-macchiato', 'theme-mocha'];

/**
 * Launch the app, attach CDP and settle it into a filmable state.
 *
 * Returns a stage: thin wrappers over the protocol plus the app-specific knowledge (which ids
 * matter, how to select transcript text) that every capture script would otherwise duplicate.
 */
export async function openStage({
    width = 960, height = 740, dpr = 2,
    port = Number(process.env.CDP_PORT || 9225),
    theme = 'theme-mocha',
    bootMs = 5000,
    isolated = true,
} = {}) {
    // Run against a throwaway user-data dir by default. Without this the app restores the operator's
    // real session — which meant an early gallery run shot a slice list containing THEIR leftover
    // "test.wav", i.e. a personal filename baked into a press asset. Isolation also makes captures
    // reproducible: no inherited slices, no inherited theme, no inherited loaded file.
    const profile = isolated
        ? fs.mkdtempSync(path.join(os.tmpdir(), 'vocal-slice-capture-'))
        : null;

    const args = ['.', `--remote-debugging-port=${port}`];
    if (profile) args.push(`--user-data-dir=${profile}`);

    const child = spawn(ELECTRON, args, { cwd: REPO, env: cleanEnv(), stdio: 'ignore' });
    child.on('error', e => { console.error('SPAWN FAILED:', e.message); process.exit(1); });
    console.log(`launched app, pid ${child.pid}${profile ? ' (isolated profile)' : ''}`);

    let cdp;
    try {
        const t = await findTarget(port, { timeoutMs: 45000, match: t => !t.url.startsWith('devtools://') });
        cdp = await connect(t.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await wait(bootMs);   // renderer boot, session restore, first paint
    } catch (err) {
        child.kill();
        throw err;
    }

    const ev = (expression, opts = {}) => cdp.send('Runtime.evaluate', { expression, ...opts });

    // Runtime.evaluate reports a page-side throw in exceptionDetails and leaves result.value
    // undefined — it is NOT a transport error, so nothing rejects. Reading .value alone therefore
    // turns any exception in injected code into a silent undefined, and the caller falls over
    // somewhere unrelated: a null-deref inside findPhrase surfaced as "Cannot read properties of
    // undefined (reading 'found')" at the call site, pointing nowhere near the real fault.
    const value = async (expression, opts = {}) => {
        const r = await ev(expression, { returnByValue: true, ...opts });
        if (r.exceptionDetails) {
            const d = r.exceptionDetails;
            const msg = d.exception?.description || d.exception?.value || d.text;
            throw new Error(`page threw: ${msg}\n   in: ${expression.trim().split('\n')[0]} …`);
        }
        return r.result.value;
    };

    const stage = {
        cdp, child, port,
        ev, value,

        async setViewport({ width: w, height: h, dpr: d } = {}) {
            await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: w ?? width, height: h ?? height, deviceScaleFactor: d ?? dpr, mobile: false,
            });
            await wait(600);
            // Without focus emulation the text selection renders grey (or not at all) — the whole
            // point of most shots is a visible blue selection.
            await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
            await wait(200);
        },

        /**
         * Force a theme and drop the first-run coach overlay.
         * Deliberately does NOT write to storage, so the user's own saved theme survives a capture run.
         */
        async prepare() {
            await ev(`(() => {
                // Native modals hang an automated run — nobody is there to click OK, and the capture
                // just stops. Same family as the main-process exception dialog noted in SKILL.md.
                // Answering yes is right for every prompt a capture can reach (clearSession's
                // "are you sure", handleTranscribe's CPU-fallback confirm).
                window.confirm = () => true;
                window.alert = () => {};

                const b = document.body;
                b.classList.remove(${THEMES.map(t => JSON.stringify(t)).join(',')});
                b.classList.add(${JSON.stringify(theme)});
                // An isolated profile is a FIRST run, so the coach-mark tour starts itself. Mark it
                // seen as well as removing it, or it reappears part-way through a capture.
                window.markOnboardingSeen?.();
                document.querySelector('.coach-root')?.remove();
                if (typeof window.redrawWaveform === 'function') window.redrawWaveform();
            })()`);
        },

        /** Load the bundled public-domain demo clip + its pre-baked transcription. */
        async loadDemo() {
            const ok = await value(`window.loadDemo ? window.loadDemo() : Promise.resolve(false)`,
                { awaitPromise: true });
            if (!ok) throw new Error('window.loadDemo() returned false — is onboarding/demo.{wav,json} present?');
            await wait(1500);
            const len = await value(`(() => { document.querySelector('.coach-root')?.remove();
                const ta=document.getElementById('transcription-text'); return ta?ta.value.trim().length:0; })()`);
            if (!len) throw new Error('demo transcript is empty after loadDemo');
            return len;
        },

        /**
         * Set the transcript font size, returning the previous value so callers can restore it.
         *
         * Throws on a size the control doesn't offer. Assigning an absent value to a <select> silently
         * leaves it empty rather than erroring, so build-video.mjs asked for 26px for two years and
         * filmed every landscape cut at the 18px default without one line of output saying so. The
         * options are a fixed list in index.html — 11-24px in steps, then 28px.
         */
        async setFont(size) {
            const r = await value(`(() => { const s = document.getElementById('font-size-select');
                const prior = s.value;
                s.value = ${JSON.stringify(size)};
                if (s.value !== ${JSON.stringify(size)}) {
                    s.value = prior;
                    return { ok: false, offers: [...s.options].map(o => o.value) };
                }
                updateTranscriptionStyle();
                return { ok: true, prior }; })()`);
            if (!r.ok) throw new Error(`font-size-select has no ${size} — it offers ${r.offers.join(', ')}`);
            await wait(400);
            return r.prior;
        },
        async restoreFont(prior) {
            await ev(`(() => { const s=document.getElementById('font-size-select');
                s.value=${JSON.stringify(prior)}; updateTranscriptionStyle(); })()`);
        },

        /**
         * Locate a phrase in the transcript.
         *
         * Exact match first, then a normalised one — case, punctuation and run-length of whitespace
         * are all things live Whisper output varies on, and build-video.mjs now films a real
         * transcription rather than the pre-baked demo.json, so "So fair was his realm, Poet sang"
         * has to match "so fair was his realm poet sang". The normalised pass keeps a per-character
         * map back to the original string, because the caller needs indices into `.value` for
         * setSelectionRange.
         *
         * `required` throws instead of falling back. Pass it whenever the phrase was chosen rather
         * than incidental: silently selecting the opening words instead would film an arbitrary
         * selection into a press asset and nothing downstream would notice. `quiet` suppresses the
         * fallback warning, for callers working through a list of candidates where a miss is expected.
         */
        async findPhrase(phrase, { required = false, quiet = false } = {}) {
            const range = await value(`(() => {
                const v = document.getElementById('transcription-text').value;
                const want = ${JSON.stringify(phrase)};

                const at = v.indexOf(want);
                if (at !== -1) return { s: at, e: at + want.length, phrase: want, found: true, exact: true };

                // Normalise to lowercase alphanumerics + single spaces, recording the source index of
                // every character kept so the match can be projected back.
                const map = [];
                let norm = '', space = true;
                for (let i = 0; i < v.length; i++) {
                    const c = v[i];
                    if (/[a-z0-9]/i.test(c)) { norm += c.toLowerCase(); map.push(i); space = false; }
                    else if (!space) { norm += ' '; map.push(i); space = true; }
                }
                const w = want.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
                const k = w ? norm.indexOf(w) : -1;
                if (k !== -1) {
                    const s = map[k], e = map[k + w.length - 1] + 1;
                    return { s, e, phrase: v.slice(s, e), found: true, exact: false };
                }

                // Fallback: the first few words, so a caller that tolerates a miss still gets a
                // usable range. An empty transcript matches nothing, and dereferencing m[0] there
                // used to throw inside the page — reported as an undefined result, which is a much
                // worse failure than saying the transcript is empty.
                const m = v.match(/\\S+(?:\\s+\\S+){0,6}/);
                if (!m) return { s: 0, e: 0, phrase: '', found: false, empty: true };
                return { s: v.indexOf(m[0]), e: v.indexOf(m[0]) + m[0].length, phrase: m[0], found: false };
            })()`);
            if (!range.found) {
                if (range.empty) throw new Error('the transcript is EMPTY — nothing was loaded to film');
                if (required) throw new Error(`phrase not in transcript: ${JSON.stringify(phrase)}`);
                if (!quiet) console.warn('!! phrase not found — falling back to opening words.');
            } else if (!range.exact) {
                console.log(`   phrase matched loosely → ${JSON.stringify(range.phrase)}`);
            }
            return range;
        },

        /**
         * Select transcript text. The synthetic mouseup is what makes the app treat this as a real
         * user selection, so the waveform window and highlight follow.
         */
        setSel(from, to) {
            return ev(`(() => { const ta=document.getElementById('transcription-text'); ta.focus();
                ta.setSelectionRange(${from},${to});
                ta.dispatchEvent(new MouseEvent('mouseup',{bubbles:true})); })()`);
        },

        /** Bounding rect of one element, in viewport CSS px. */
        rect(id) {
            return value(`(() => { const el=document.getElementById(${JSON.stringify(id)}); if(!el) return null;
                const r=el.getBoundingClientRect();
                return {x:r.left,y:r.top,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; })()`);
        },

        /** The rects + waveform handle positions a capture needs to aim a drag or a camera. */
        async geometry() {
            const geo = await value(`(() => {
                const R = id => { const el=document.getElementById(id); if(!el) return null;
                    const r=el.getBoundingClientRect();
                    return {x:r.left,y:r.top,w:r.width,h:r.height,right:r.right,bottom:r.bottom}; };
                const s=document.getElementById('waveform-start-handle').getBoundingClientRect();
                const e=document.getElementById('waveform-end-handle').getBoundingClientRect();
                return { tc:R('transcription-content'), wf:R('transcription-waveform-section'),
                         cs:R('create-slice-btn'),
                         startX:s.left+s.width/2, endX:e.left+e.width/2, hy:e.top+e.height/2 };
            })()`);
            if (!geo.cs) throw new Error('missing create-slice geometry');
            return geo;
        },

        mouse(type, x, y, buttons = 1) {
            return cdp.send('Input.dispatchMouseEvent',
                { type, x, y, button: buttons ? 'left' : 'none', buttons, clickCount: buttons ? 1 : 0 });
        },

        /**
         * Drag along the waveform, running the app's real onDrag() so the band, handles, duration
         * readout and transcript highlight all follow. `onStep` fires after each move, which is where
         * a caller grabs a frame.
         */
        async drag(fromX, toX, y, steps, settleMs = 40, onStep = null) {
            await this.mouse('mousePressed', fromX, y);
            for (let i = 1; i <= steps; i++) {
                await this.mouse('mouseMoved', lerp(fromX, toX, i / steps), y);
                await wait(settleMs);
                if (onStep) await onStep(i);
            }
            await this.mouse('mouseReleased', toX, y);
        },

        /** Switch main tab / settings panel. Both are real functions on window (see app.js). */
        async tab(name) { await ev(`switchTab(${JSON.stringify(name)})`); await wait(400); },
        async panel(name) {
            await ev(`switchTab('settings')`);
            await wait(250);
            await ev(`switchSettingsPanel(${JSON.stringify(name)})`);
            await wait(500);
        },

        /** Raw PNG of the current window. */
        async shoot() {
            const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
            return Buffer.from(r.data, 'base64');
        },

        close() {
            try { cdp.close(); } catch { /* already gone */ }
            child.kill();
            // Best-effort: the app may still hold file handles for a moment after kill(), and a
            // leftover temp profile is harmless compared with failing the run over it.
            if (profile) {
                try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); }
                catch { /* leave it in temp */ }
            }
        },
    };

    await stage.setViewport({ width, height, dpr });
    await stage.prepare();
    return stage;
}
