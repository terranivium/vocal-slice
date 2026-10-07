// Whisper model delivery — main process. Serves model files to the renderer over a `model://`
// protocol, fetching them from our own release assets on first use and caching them on disk.
//
// Why this is not just a URL change in the renderer
// ────────────────────────────────────────────────
// The app used to fetch weights straight from huggingface.co, which meant somebody else's URLs
// decided whether a paying customer's fresh install worked. Pointing transformers.js at our own
// host instead (`env.remoteHost`) is a one-line change that does NOT work, for two reasons both
// verified against a real asset on vocal-slice:
//
//   1. GitHub release assets send no Access-Control-Allow-Origin header, and the renderer is a
//      file:// page — a null origin. Every fetch would be blocked by CORS. The main process is not
//      subject to CORS, so the fetch has to happen here.
//   2. Asset names are a flat namespace (no "/"), so HF's nested `onnx/encoder_model.onnx` layout
//      can't be mirrored as-is. build-scripts/mirror-models.js flattens it to
//      `<model>__onnx__encoder_model.onnx`; assetFor() below is the inverse.
//
// Serving over a custom protocol also solves the problem that made allowLocalModels `false` in the
// first place: Chromium blocks fetch() on file://, so a local *path* was never enough — the models
// needed a real origin. `model://` gives them one.
//
// Why not move the whole renderer to an app:// origin, which would fix that too: it would silently
// orphan every existing user's localStorage, IndexedDB and Cache storage — their sessions, their
// settings, and every model they had already downloaded. Same-origin is what keeps that reachable.
//
// What is trusted, and what isn't
// ───────────────────────────────
// static/models.json ships INSIDE the app and lists every file the app may request, with its size
// and SHA-256. It is the allowlist as well as the checksum table: a `model://` request for anything
// not in it is a 404, so a bug or a crafted URL in the renderer can't turn this into a general-
// purpose downloader. The manifest deliberately does NOT travel with the assets — a checksum file
// fetched from the same host as the files it vouches for would attest to nothing.

const { app, protocol, net } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');

const SCHEME = 'model';

// The tag is pinned, and deliberately separate from the app's own releases: model assets must not
// churn every time the app ships. A new model set means a new tag (models-v2) and a manifest
// update, both of which travel inside the app that expects them.
const RELEASE_BASE =
    'https://github.com/terranivium/vocal-slice/releases/download/models-v1/';

// ── Where files come from, in order ─────────────────────────────────────────
// Ours first, Hugging Face only if ours can't be reached. The ORDER is the whole point: it decides
// what happens for everyone, not just in emergencies. With ours first the third party is contacted
// approximately never; reversed, every user would still fetch from huggingface.co on first run and
// the dependency this module exists to remove would be right back.
//
// The failure this defends against is not really a GitHub outage — it's a corporate or studio
// network that blocks github.com, which is entirely plausible in the NDA-bound environments this
// app is sold into.
//
// This is safe in a way the app's original arrangement was not: every download is checked against
// the SHA-256 in static/models.json, which ships INSIDE the app. Hugging Face cannot serve different
// weights without failing verification. Same source as before, under guarantees it never had.
//
// If a third source is ever added (R2 at models.vocalslice.com is the obvious one), it belongs
// between these two — another host we control outranks one we don't.
const SOURCES = [
    {
        name: 'vocalslice',
        url: (model, file, entry) => RELEASE_BASE + entry.asset,
    },
    {
        name: 'huggingface',
        // Rebuilt from the manifest's own `source` ("onnx-community/whisper-…@main"), which
        // build-scripts/mirror-models.js records precisely so this needs no second source of truth
        // for where a file originally came from.
        url: (model, file) => {
            const source = manifest[model]?.source;
            if (!source) return null;   // nothing recorded — skip this source rather than guess
            const [repo, revision = 'main'] = source.split('@');
            return `https://huggingface.co/${repo}/resolve/${revision}/${file}`;
        },
    },
];

// Written by `npm run models:mirror`. Absent in a dev tree that has never mirrored — the app still
// starts, and every model request 404s with a clear message rather than crashing at import time.
let manifest = {};
try {
    manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../static/models.json'), 'utf8'));
} catch {
    console.warn('models: no static/models.json — run `npm run models:mirror`');
}

const modelsRoot = () => path.join(app.getPath('userData'), 'models');

// Registered before app.ready (see main.js). `supportFetchAPI` is the one that matters —
// transformers.js loads every model file with fetch(), and without it the scheme is invisible to
// it. `stream: true` keeps a 615MB decoder from being buffered whole before the renderer sees a
// byte, which is also what keeps the existing download progress bar meaningful.
function registerScheme() {
    protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    }]);
}

// `model://models/onnx-community/whisper-tiny.en_timestamped/onnx/encoder_model.onnx`
//   → { model: 'whisper-tiny.en_timestamped', file: 'onnx/encoder_model.onnx' }
//
// transformers.js builds the URL as env.localModelPath + modelId + '/' + file, and modelId carries
// an org prefix ("onnx-community/whisper-…"). So the path has a variable shape: a fixed "models"
// host, then org, then model, then the file — and a model id without an org would have one segment
// fewer.
//
// Rather than counting segments, find the first one the manifest knows and treat everything after
// it as the file path. That is robust to the prefix changing and, more usefully, means an unknown
// model can't be mistaken for a file path belonging to a known one.
function parse(url) {
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        return null;
    }
    const segments = decodeURIComponent(parsed.pathname).replace(/^\/+/, '').split('/');
    // Nothing here should ever contain a traversal, but this is a path built from renderer input
    // that ends up joined onto a real directory — refuse rather than reason about it.
    if (segments.includes('..') || segments.some((s) => !s)) return null;

    const at = segments.findIndex((s) => Object.hasOwn(manifest, s));
    if (at === -1) return null;

    const file = segments.slice(at + 1).join('/');
    if (!file) return null;
    return { model: segments[at], file };
}

function entryFor(model, file) {
    return manifest[model]?.files?.[file] || null;
}

const localPath = (model, file) => path.join(modelsRoot(), model, file);

function contentType(file) {
    if (file.endsWith('.json')) return 'application/json';
    if (file.endsWith('.txt')) return 'text/plain';
    return 'application/octet-stream';   // .onnx
}

function sha256File(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

// A cached file counts as present only at exactly the size the manifest expects. A truncated
// download — the machine slept, the process was killed — is otherwise indistinguishable from a
// complete one, and would be served happily until the ONNX parser choked on it.
function cached(model, file, entry) {
    try {
        return fs.statSync(localPath(model, file)).size === entry.bytes;
    } catch {
        return false;
    }
}

// Download progress, main → renderer.
//
// This is needed because of the verify-then-serve order below: the renderer's own fetch of the
// finished local file completes almost instantly, so from its point of view there is no download to
// report — all the waiting happens here, before it sees a single byte. Without this the app would
// sit silent for minutes on a 615MB decoder. transformers.js's own progress_callback cannot cover
// it, so the renderer listens for these instead (see onModelProgress in preload.js).
//
// Emitted at whole percents only: a 615MB file arrives in tens of thousands of chunks, and the
// renderer redraws on every one of them.
let progressTarget = null;
function setProgressTarget(webContents) {
    progressTarget = webContents;
}

function emitProgress(payload) {
    if (progressTarget && !progressTarget.isDestroyed()) {
        progressTarget.send('model-progress', payload);
    }
}

// Counts bytes through the pipeline without buffering them. A Transform that passes chunks along
// untouched is the cheapest place to do this — the alternative, polling the .part file's size on a
// timer, reports whatever the OS has flushed rather than what has actually arrived.
function progressMeter(file, total, source) {
    let seen = 0;
    let lastPercent = -1;
    return new Transform({
        transform(chunk, _enc, done) {
            seen += chunk.length;
            const percent = total ? Math.floor((seen / total) * 100) : 0;
            if (percent !== lastPercent) {
                lastPercent = percent;
                emitProgress({ file, percent, loaded: seen, total, source });
            }
            done(null, chunk);
        },
    });
}

// Downloads one file from one source and leaves it in place only if it verifies. Throwing means
// "this source didn't work" — the caller decides whether to try another.
async function fetchFrom(url, model, file, entry, sourceName) {
    // net.fetch, not global fetch: it goes through Chromium's stack, so it follows GitHub's redirect
    // chain to the signed blob URL and honours the app's proxy configuration.
    const res = await net.fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);

    const dest = localPath(model, file);
    // Source-specific temp name, so two sources being tried for the same file can never write over
    // each other's partial download.
    const tmp = `${dest}.${sourceName}.part`;
    fs.mkdirSync(path.dirname(dest), { recursive: true });

    emitProgress({ file, percent: 0, loaded: 0, total: entry.bytes, source: sourceName });
    try {
        await pipeline(
            Readable.fromWeb(res.body),
            progressMeter(file, entry.bytes, sourceName),
            fs.createWriteStream(tmp),
        );

        // Hashing 615MB takes long enough to look like a hang after the bar has just reached 100%,
        // so the renderer gets told what's happening rather than being left at a full bar.
        emitProgress({
            file, percent: 100, loaded: entry.bytes, total: entry.bytes,
            verifying: true, source: sourceName,
        });
        const size = fs.statSync(tmp).size;
        const hash = await sha256File(tmp);
        if (size !== entry.bytes || hash !== entry.sha256) {
            throw new Error(`failed verification (${size} bytes, sha256 ${hash.slice(0, 12)}…)`);
        }
        // Rename last: until this point a killed process leaves only a .part, which cached()
        // ignores, so the next launch re-downloads instead of serving a half file.
        fs.renameSync(tmp, dest);
        return dest;
    } catch (err) {
        // Never leave a rejected download behind — cached() only checks size, so a wrong-but-
        // right-length file would otherwise be served forever.
        try { fs.unlinkSync(tmp); } catch { /* already gone */ }
        throw err;
    }
}

// One fetch per file even if the renderer asks twice (a retry after an error, two pipelines racing
// on startup). The second caller waits on the first rather than opening a second 615MB download.
const inFlight = new Map();

async function fetchToDisk(model, file, entry) {
    const key = `${model}/${file}`;
    if (inFlight.has(key)) return inFlight.get(key);

    const job = (async () => {
        const failures = [];

        for (const source of SOURCES) {
            const url = source.url(model, file, entry);
            if (!url) continue;
            try {
                await fetchFrom(url, model, file, entry, source.name);
                if (failures.length) {
                    // Local log only — user-initiated diagnostics can show it. Nothing is transmitted.
                    console.log(`models: ${file} came from ${source.name} after ${failures.join('; ')}`);
                }
                emitProgress({
                    file, percent: 100, loaded: entry.bytes, total: entry.bytes,
                    done: true, source: source.name,
                });
                return localPath(model, file);
            } catch (err) {
                // Move on for BOTH a transport failure and a verification failure: a corrupt or
                // truncated file from one host is worth retrying at the other. If the manifest
                // itself is wrong, every source fails verification and the error surfaces honestly
                // rather than one host being blamed for it.
                failures.push(`${source.name}: ${err.message}`);
            }
        }
        throw new Error(failures.join(' | ') || `No source available for ${file}`);
    })().finally(() => inFlight.delete(key));

    inFlight.set(key, job);
    return job;
}

// Fetch fully, verify, then serve from disk — never a tee of the live network stream into the
// renderer. Teeing would start the model loading a few seconds sooner, but it hands over bytes that
// haven't been checked yet, which is exactly what shipping checksums is meant to prevent.
//
// The cost of that order is that the renderer's fetch blocks here, silently, for however long the
// download takes — transformers.js sees one slow request and has nothing to report. That is what
// the model-progress IPC above exists to cover; the two must stay together, because removing the
// progress events would turn a long download back into an apparent hang.
async function handle(request) {
    const parsed = parse(request.url);
    // parse() fails when the URL names no model the manifest knows, which is a 404 rather than a
    // 400: the URL is well-formed, we just don't serve it. Either way nothing reaches the network —
    // an unrecognised request is refused before any fetch is considered.
    if (!parsed) return new Response(`Not a known model: ${request.url}`, { status: 404 });

    const { model, file } = parsed;
    const entry = entryFor(model, file);
    if (!entry) return new Response(`Unknown model file: ${model}/${file}`, { status: 404 });

    try {
        if (!cached(model, file, entry)) await fetchToDisk(model, file, entry);
    } catch (err) {
        console.error('models:', err.message);
        return new Response(`Could not fetch ${file}: ${err.message}`, { status: 502 });
    }

    const dest = localPath(model, file);
    return new Response(Readable.toWeb(fs.createReadStream(dest)), {
        status: 200,
        headers: { 'content-type': contentType(file), 'content-length': String(entry.bytes) },
    });
}

function register() {
    protocol.handle(SCHEME, handle);
}

// ── Storage panel ───────────────────────────────────────────────────────────
// Replaces the Cache-API accounting the panel used to do by parsing Hugging Face URLs. Sizes come
// from the filesystem, so a model that is half-downloaded reports what it actually occupies rather
// than what it will eventually be.
function dirSize(dir) {
    let total = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
    }
    return total;
}

// Which precision each backend loads each component at. Mirrors the map in
// build-scripts/mirror-models.js, which is what decides the files actually mirrored — change one,
// change the other. Suffixes match transformers.js's DEFAULT_DTYPE_SUFFIX_MAPPING.
//
// Models mirrored before this map existed carry no `weights`, and DEFAULT_WEIGHTS is exactly what
// they were mirrored with, so they need no re-mirroring to be read correctly here.
const DTYPE_SUFFIX = {
    fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8',
    uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4',
};

const DEFAULT_WEIGHTS = {
    webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    wasm: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
};

// The weight files this model loads on this backend, or [] if it isn't offered there at all.
function weightPaths(model, device) {
    const components = (manifest[model]?.weights || DEFAULT_WEIGHTS)[device];
    if (!components) return [];
    return Object.entries(components)
        .map(([component, dtype]) => `onnx/${component}${DTYPE_SUFFIX[dtype]}.onnx`);
}

// What a given device actually pulls down. Not the same as the model's total size: the tokeniser
// sidecars are shared, but a machine only fetches the weight files its backend uses — and for most
// models that means one of the two mirrored decoder precisions, not both.
//
// This exists because the model picker's labels were wrong in a way users could act on: "Whisper
// Small (~500MB)" downloads 586MB on a GPU and 968MB on a CPU. Sizes computed here replace those
// hardcoded guesses at runtime.
//
// Anything outside onnx/ is a sidecar and always counts; anything inside it counts only if this
// backend actually loads it.
function downloadBytes(model, device) {
    const files = manifest[model]?.files || {};
    const wanted = new Set(weightPaths(model, device));
    return Object.entries(files)
        .filter(([file]) => !file.startsWith('onnx/') || wanted.has(file))
        .reduce((sum, [, entry]) => sum + entry.bytes, 0);
}

// The files that make a model usable on a given backend, and between them essentially all of its
// size. If they are all on disk at the right length, choosing this model costs no meaningful
// download — which is the question the picker's label is answering. A model not offered on this
// backend has no such files, and is never ready there.
function hasWeights(model, device) {
    const files = manifest[model]?.files || {};
    const paths = weightPaths(model, device);
    return paths.length > 0 && paths.every((file) => {
        const entry = files[file];
        return entry ? cached(model, file, entry) : false;
    });
}

function list() {
    const root = modelsRoot();
    return Object.keys(manifest).map((model) => {
        const dir = path.join(root, model);
        let bytes = 0;
        try { bytes = dirSize(dir); } catch { /* never downloaded */ }
        const expected = manifest[model].bytes || 0;
        return {
            id: model,
            bytes,
            expected,
            // Which backends this model is offered on — derived, not stored: it is exactly the
            // backends its weights map names. The renderer disables the rest in the picker; if that
            // gate were ever bypassed, handle() would 404 the unmirrored file anyway.
            devices: Object.keys(manifest[model].weights || DEFAULT_WEIGHTS),
            // The dtypes the renderer hands to transformers.js, so the pipeline is built with the
            // same precisions this file just costed and checked. Without this the two could disagree
            // and the app would silently download one thing and try to load another.
            dtypes: manifest[model].weights || DEFAULT_WEIGHTS,
            download: { webgpu: downloadBytes(model, 'webgpu'), wasm: downloadBytes(model, 'wasm') },
            // Whether this model is usable on each backend WITHOUT another download.
            //
            // Deliberately judged on the weights alone, not on every file in the manifest.
            // transformers.js only requests the tokeniser sidecars it actually needs, so a perfectly
            // working model routinely has a file or two of the thirteen missing — measured, 116.7MB
            // present against 118.2MB listed. An "every file present" test would therefore never be
            // satisfied, and the UI would call a downloaded model a pending download forever.
            ready: {
                webgpu: hasWeights(model, 'webgpu'),
                wasm: hasWeights(model, 'wasm'),
            },
        };
    });
}

function remove(model) {
    if (!manifest[model]) return false;   // only ever delete something we put there
    fs.rmSync(path.join(modelsRoot(), model), { recursive: true, force: true });
    return true;
}

module.exports = { registerScheme, register, setProgressTarget, list, remove, modelsRoot, SCHEME };
