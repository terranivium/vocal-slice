// Mirrors the Whisper model files the app actually uses out of Hugging Face and into a local
// staging directory, ready to upload as release assets on the `models-v1` tag of
// vocal-slice. Run it once per model-set change; it is NOT part of a normal build.
//
// Why this exists: until now the app fetched weights straight from huggingface.co at runtime, so
// somebody else's URLs decided whether a paying customer's fresh install worked at all. The
// upstream model card even calls the separate ONNX repo "a temporary solution". Mirroring the
// weights onto infrastructure we control removes that dependency; Apache-2.0 (inherited from
// openai/whisper-*) is what makes redistributing them legal, and THIRD-PARTY-NOTICES.md carries
// the attribution.
//
// Two things about GitHub release assets shape the layout below, both verified against a real
// asset on vocal-slice:
//
//   1. Asset names are a FLAT namespace — they cannot contain "/". So HF's nested
//      `onnx/encoder_model.onnx` is flattened to `<model>__onnx__encoder_model.onnx`, and the main
//      process maps back the other way when it serves a model:// request.
//   2. Assets carry NO Access-Control-Allow-Origin header and redirect to a short-lived signed
//      blob URL. A renderer fetch from the file:// page is therefore blocked outright — which is
//      why electron/models.js does the fetching in the main process instead.
//
// Deliberately selective. These repos carry ~30 quantisation variants each (whisper-tiny.en alone
// is 3.5GB of storage on the Hub); the app asks for two or three ONNX files per model — an encoder
// plus one decoder per backend it's offered on — so mirroring the whole repo would multiply the
// upload by an order of magnitude for files nothing ever requests.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

const OUT_DIR = path.join(__dirname, '../dist/models');
const HF = 'https://huggingface.co';
const REVISION = 'main';

// Must stay in step with the <option value> list in static/index.html — two copies of the same
// truth is one too many, but the renderer's list is user-facing text and this one is a build input,
// so they are kept deliberately separate. Everything else (sizes, checksums, which backends a model
// runs on) is derived from the manifest this script writes, so this is the only other place a model
// is named.
//
// dtypes, not filenames. The renderer hands these straight to transformers.js, and the filename is
// derived from them here and in electron/models.js — one source of truth for "what does this model
// load on this backend". Suffixes must match transformers.js's DEFAULT_DTYPE_SUFFIX_MAPPING.
const DTYPE_SUFFIX = {
    fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8',
    uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4',
};

const weightFile = (component, dtype) => `onnx/${component}${DTYPE_SUFFIX[dtype]}.onnx`;

// An fp32 encoder everywhere (it is what produces the audio representation the word-timestamp DTW
// aligns against), and a decoder whose precision depends on the backend: q4 on WebGPU, fp32 on CPU.
//
// fp32 on CPU is a deliberate choice, not a requirement — transformers.js itself defaults WASM to
// q8, and q4 loads and runs there perfectly well. It is measured: on base.en, a q4 decoder on CPU is
// ~47% SLOWER (17.84s vs 12.10s of inference on the same 24s clip) because dequantisation cost
// dominates, the reverse of the GPU case, and slightly less accurate with it. Word timestamps are
// unaffected either way (6.5ms mean delta, 40ms max), so they are not what decides this.
const DEFAULT_WEIGHTS = {
    webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    wasm: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
};

// Medium is the exception, and the reason the map above is per-model at all: it takes q4 on CPU too,
// because fp32 there cannot load. Measured, not assumed. ONNX Runtime Web's WASM build is wasm32
// with a hard 4GiB heap (65536 pages, see static/vendor/ort-wasm-simd-threaded.mjs), and
// transformers.js hands ORT the model as a Uint8Array copied into that heap before it is parsed.
// With Medium's 1.14GiB fp32 encoder already resident, creating the decoder session dies outright:
//
//     Can't create a session. failed to allocate a buffer of size 1828247530.
//
// That is the single contiguous allocation for the fp32 decoder, so it fails at load rather than
// degrading, and no heap budget would rescue it. q4 fits (1.58GiB resident) and transcribes
// correctly, so Medium runs on CPU — slowly, at ~0.13x realtime, but it runs.
//
// A happy consequence: both backends load the same two files, so Medium costs one download whichever
// device you use, and switching between them costs nothing.
const MEDIUM_WEIGHTS = {
    webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
    wasm: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
};

// Every distinct weight file this model needs across all the backends it is offered on. Deduped:
// Medium's two backends name the same files, and mirroring them twice would be wasted.
const onnxFiles = (weights) => [...new Set(
    Object.values(weights).flatMap((components) =>
        Object.entries(components).map(([component, dtype]) => weightFile(component, dtype))))];

// `weights` is which precision each backend loads each model component at, and it decides which
// files get mirrored — a model is offered on exactly the backends listed in its map. Omitted means
// DEFAULT_WEIGHTS, which is what every model but Medium uses.
const MODELS = [
    { id: 'onnx-community/whisper-tiny.en_timestamped' },
    { id: 'onnx-community/whisper-base.en_timestamped' },
    { id: 'onnx-community/whisper-small.en_timestamped' },
    { id: 'onnx-community/whisper-medium.en_timestamped', weights: MEDIUM_WEIGHTS },
    { id: 'onnx-community/whisper-tiny_timestamped' },
    { id: 'onnx-community/whisper-base_timestamped' },
    { id: 'onnx-community/whisper-small_timestamped' },
    { id: 'onnx-community/whisper-medium_timestamped', weights: MEDIUM_WEIGHTS },
];

// Tokeniser / config sidecars. Small (a few MB per model, all of them together), and cheaper to
// mirror wholesale than to discover which ones a given transformers.js version happens to want —
// getting this list one file short fails at runtime, on a user's machine, with a 404.
const SIDECAR_EXT = ['.json', '.txt'];
// ...except the ones that only describe how the repo was built. Nothing loads these.
const SIDECAR_SKIP = new Set(['quantize_config.json']);

const MB = (n) => (n / 1e6).toFixed(1);

// Flat asset name ⇄ nested model path. electron/models.js implements the inverse; if you change
// the separator, change it there too.
function assetName(modelId, filePath) {
    return `${modelId.split('/')[1]}__${filePath.replace(/\//g, '__')}`;
}

async function listFiles(modelId, onnx) {
    const res = await fetch(`${HF}/api/models/${modelId}/tree/${REVISION}?recursive=true`);
    if (!res.ok) throw new Error(`Listing ${modelId} failed: ${res.status} ${res.statusText}`);
    const tree = await res.json();

    const wanted = [];
    for (const entry of tree) {
        if (entry.type !== 'file') continue;
        const p = entry.path;
        const isOnnx = onnx.includes(p);
        const isSidecar = !p.startsWith('onnx/')
            && SIDECAR_EXT.some((ext) => p.endsWith(ext))
            && !SIDECAR_SKIP.has(p);
        // lfs.size is the real byte count for weights; entry.size covers the small text files,
        // which aren't stored in LFS and so have no lfs block at all.
        if (isOnnx || isSidecar) wanted.push({ path: p, size: entry.lfs?.size ?? entry.size ?? 0 });
    }

    const missing = onnx.filter((f) => !wanted.some((w) => w.path === f));
    if (missing.length) {
        // A renamed or re-quantised upstream repo must fail here, loudly, rather than produce a
        // mirror that 404s on a user's machine once the app has already stopped falling back to HF.
        throw new Error(`${modelId} is missing expected weights: ${missing.join(', ')}`);
    }
    return wanted;
}

// Word-level timestamps are the whole product — the app transcribes with `return_timestamps: 'word'`
// and nothing else — and transformers.js can only produce them by DTW over the cross-attention heads
// named in generation_config.json. Without `alignment_heads` it throws outright.
//
// Worth asserting because the naming does not tell you: onnx-community/distil-medium.en_timestamped
// carries the _timestamped suffix and no alignment heads at all, and distil-small.en_timestamped
// carries heads that index decoder layers 6-11 on a model with four of them. Both were considered
// and rejected. A model that can't do word timestamps must fail here, not on a user's machine.
async function assertWordTimestamps(modelId) {
    const url = `${HF}/${modelId}/resolve/${REVISION}/generation_config.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${modelId} has no generation_config.json (${res.status})`);
    const heads = (await res.json()).alignment_heads;

    if (!Array.isArray(heads) || !heads.length) {
        throw new Error(
            `${modelId} declares no alignment_heads, so it cannot produce word-level timestamps. ` +
            `The app has no other transcription mode — do not mirror it.`);
    }
    return heads.length;
}

async function download(modelId, file, destDir) {
    const dest = path.join(destDir, assetName(modelId, file.path));
    if (fs.existsSync(dest) && fs.statSync(dest).size === file.size) {
        return { dest, skipped: true };   // resume a part-finished mirror without re-pulling GBs
    }

    const url = `${HF}/${modelId}/resolve/${REVISION}/${file.path}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} → ${res.status} ${res.statusText}`);

    // Temp + rename, so an interrupted run can't leave a truncated file that the size check above
    // would then happily accept as complete on the next pass.
    const tmp = `${dest}.part`;
    await pipeline(res.body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    return { dest, skipped: false };
}

// Streamed, not readFileSync'd. The biggest file here used to be whisper-small's 616MB decoder,
// which a whole-file read handles without complaint; Medium's encoder is 1.23GB, and reading it
// into a single Buffer to hash it — twice, once per Medium model, partway through a multi-GB run —
// is an allocation worth not making. Same shape as sha256File() in electron/models.js, which
// verifies these very files again on the user's machine.
function sha256(file) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('error', reject)
            .on('data', (chunk) => hash.update(chunk))
            .on('end', () => resolve(hash.digest('hex')));
    });
}

async function main() {
    // --dry-run costs six API calls and no bandwidth. Worth having: a full run is multiple GB, so
    // "what would this pull, and how big is it" should never require pulling it.
    const dryRun = process.argv.includes('--dry-run');
    // --only=tiny.en pulls a single model, for validating the pipeline end to end without
    // committing to the full multi-GB mirror first.
    const only = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1];
    const models = only ? MODELS.filter((m) => m.id.includes(only)) : MODELS;
    if (!models.length) {
        throw new Error(`--only=${only} matched none of: ${MODELS.map((m) => m.id).join(', ')}`);
    }

    if (!dryRun) fs.mkdirSync(OUT_DIR, { recursive: true });
    console.log(dryRun
        ? `Dry run — listing what ${models.length} model(s) would pull\n`
        : `Mirroring ${models.length} model(s) into ${OUT_DIR}\n`);

    const manifest = {};
    let grand = 0;

    for (const { id: modelId, weights = DEFAULT_WEIGHTS } of models) {
        const short = modelId.split('/')[1];
        const heads = await assertWordTimestamps(modelId);
        const files = await listFiles(modelId, onnxFiles(weights));
        const total = files.reduce((n, f) => n + f.size, 0);
        grand += total;
        // Name the decoder precision per backend: it is the thing that varies between models now,
        // and a mirror that quietly picked the wrong one would only show up on a user's machine.
        const dtypes = Object.entries(weights)
            .map(([device, c]) => `${device}:${c.decoder_model_merged}`).join(' ');
        console.log(`${short} — ${files.length} files, ${MB(total)} MB, ${heads} alignment heads, ${dtypes}`);

        if (dryRun) {
            for (const f of files.filter((f) => f.size > 1e6).sort((a, b) => b.size - a.size)) {
                console.log(`   ${MB(f.size).padStart(7)} MB  ${f.path}`);
            }
            continue;
        }

        manifest[short] = { source: `${modelId}@${REVISION}`, weights, bytes: total, files: {} };

        for (const file of files) {
            const { dest, skipped } = await download(modelId, file, OUT_DIR);
            const hash = await sha256(dest);
            manifest[short].files[file.path] = {
                asset: path.basename(dest),
                bytes: fs.statSync(dest).size,
                sha256: hash,
            };
            if (file.size > 1e6) {
                console.log(`   ${skipped ? 'have' : 'got '} ${MB(file.size).padStart(7)} MB  ${file.path}`);
            }
        }
    }

    console.log(`\nTotal: ${MB(grand)} MB across ${models.length} model(s)`);
    if (dryRun) return;

    // The manifest is what electron/models.js verifies downloads against, so it ships INSIDE the
    // app rather than alongside the assets — a manifest fetched from the same host as the files it
    // vouches for would attest to nothing.
    //
    // Merged, not replaced, so a --only run tops up an existing manifest instead of silently
    // reducing the app to one model.
    const manifestPath = path.join(__dirname, '../static/models.json');
    let existing = {};
    try { existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { /* first run */ }
    fs.writeFileSync(manifestPath, JSON.stringify({ ...existing, ...manifest }, null, 2) + '\n');

    console.log(`Manifest: ${manifestPath}`);
    console.log(`\nNext: gh release create models-v1 --repo terranivium/vocal-slice \\`);
    console.log(`        --title "Whisper models v1" --notes "..." ${OUT_DIR}/*`);
}

main().catch((err) => {
    console.error(`\nMirror failed: ${err.message}`);
    process.exit(1);
});
