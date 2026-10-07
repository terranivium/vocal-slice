# Vocal Slice

Transcribe audio on your own machine, then cut clips by selecting text. Free and open source
(GPL-3.0) for Windows and macOS — [vocalslice.com](https://vocalslice.com).

## Download

| Platform | Download |
| --- | --- |
| Windows 10/11 (64-bit) | [VocalSlice-Setup.exe](https://github.com/terranivium/vocal-slice/releases/latest/download/VocalSlice-Setup.exe) |
| macOS 11 and later (universal) | [VocalSlice.dmg](https://github.com/terranivium/vocal-slice/releases/latest/download/VocalSlice.dmg) |

Both links always follow the newest [release](https://github.com/terranivium/vocal-slice/releases).
The installed app updates itself. (`VocalSlice-macOS-update.zip` on the release page is the package the
macOS app updates itself from, not a download.)

### Verifying a download

Every release page lists a **SHA-256 checksum** for each file. Compare it against what you downloaded:

```powershell
certutil -hashfile VocalSlice-Setup.exe SHA256    # Windows
```

```bash
shasum -a 256 VocalSlice.dmg                      # macOS
```

### Signing

The **macOS** build is signed with an Apple Developer ID and notarized by Apple, so it opens normally.

The **Windows** build is not yet code-signed, so SmartScreen shows *"Windows protected your PC —
unknown publisher"* on first run; choose **More info → Run anyway**. That warning reflects the absence
of a certificate, not anything found in the file — the checksum above is how you verify it.

## Features

- 🎯 **Voice Line Extraction** - Find and extract specific dialogue from audio with word-level precision
- ⚡ **WebGPU Powered** - GPU-accelerated processing with Transformers.js
- 🔒 **Complete Privacy** - Audio never leaves your device
- 💻 **Desktop App** - Download and run locally, no hosting needed
- 🌍 **Multilingual Support** - English, Japanese, Chinese, Korean, and 10+ other languages

## Quick Start

### Development

```bash
# Install dependencies
npm install

# If Electron binary fails to install, run:
npm run fix-electron

# Run in development mode (with DevTools)
npm run dev

# Run normally
npm start
```

### Building Installers

```bash
# Build for your current platform
npm run build

# Build for specific platforms
npm run build:win      # Windows — NSIS installer + portable (local only)
npm run build:mac      # macOS (DMG + auto-update ZIP)
npm run build:linux    # Linux (AppImage + DEB)

# Portable, built on demand for manual handout (release:win publishes the installer only)
npm run build:portable
```

**Output:** Installers will be in the `dist/` folder

**Note:** Production builds are minified (and `console.*` is stripped) for a smaller package.
Development builds (`npm run dev`) use the original source for easier debugging.

Release builds are published to this repo's releases by the maintainer — see [RELEASING.md](RELEASING.md).
You don't need any credentials to build and run your own copy.

### First Run

1. Launch the app
2. Whisper model downloads on demand (first time only, 118MB-1.6GB depending on model choice)
3. Models are cached locally for offline use
4. Select audio file and transcribe

## How It Works

1. Electron bundles a Chromium window with WebGPU support
2. Audio transcription runs on your GPU via Transformers.js
3. Select text in transcription to create audio slices
4. Download slices with precise word-level timing

**Privacy:** All processing happens locally on your machine. Nothing is uploaded.

## Performance

Indicative figures from ad-hoc runs, not a reproducible benchmark — there is no benchmark harness in
the repo and no recorded hardware or methodology. Treat them as rough, and don't quote them in
marketing copy.

GPU mode, Whisper Tiny:

| File Length | Speed | GPU Type |
|-------------|-------|----------|
| 27 seconds | **19.5x realtime** | Modern dGPU |
| 29 minutes | **8-9x realtime** | Modern dGPU |
| Small files | 5-10x realtime | Apple Silicon |
| Small files | 1-3x realtime | Integrated GPU |

**CPU mode** (fallback for systems without WebGPU), 24s clip on a 12-core machine, threads set to
half the cores:

| Model | Single-threaded | Multi-threaded |
|-------|-----------------|----------------|
| Base EN | 1.99x realtime | **4.00x realtime** |
| Medium EN | 0.14x realtime | **0.40x realtime** |

Threads come from `SharedArrayBuffer`, which `electron/main.js` un-gates with a command-line switch —
see the comment there for why that is safe here and what it trades. The CPU path still blocks the
window for the duration of a run; that is a separate problem, documented at the top of
`static/js/app.js`.

## Available Models

All models support **word-level timestamps** for precise audio slicing — that's why they're the
`onnx-community/*_timestamped` conversions rather than the stock ones, and why a model without
`alignment_heads` can't be used here at all.

Sizes are the GPU download. For most models the CPU path fetches a larger fp32 decoder instead of a
quantised one, so it costs more there; Medium is the exception and costs the same either way. The
picker shows the real figure for the machine it's running on, taken from the manifest in
`static/models.json`.

| Model | GPU download | Speed | Quality | Languages |
|-------|--------------|-------|---------|-----------|
| Whisper Tiny EN | 118MB | Fastest | Good | English only |
| Whisper Base EN | 201MB | Fast | Better | English only |
| Whisper Small EN | 563MB | Balanced | Great | English only |
| Whisper Medium EN | 1.6GB | Slowest | Best | English only |
| Whisper Tiny Multilingual | 118MB | Fastest | Good | 99 languages |
| Whisper Base Multilingual | 201MB | Fast | Better | 99 languages |
| Whisper Small Multilingual | 563MB | Balanced | Great | 99 languages |
| Whisper Medium Multilingual | 1.6GB | Slowest | Best | 99 languages |

**Medium loads a quantised decoder on CPU**, where the others use fp32. Not a preference — fp32
cannot load there at all: ONNX Runtime Web's WASM build is wasm32 with a hard 4GiB heap, and with
Medium's 1.14GiB encoder already resident the 1.70GiB decoder allocation fails outright
(`failed to allocate a buffer of size 1828247530`). The quantised decoder fits, and is the same file
the GPU path uses — so Medium costs one download on either device, and switching between them costs
nothing.

The other models keep fp32 on CPU because quantising there is measurably worse: on Base EN a q4
decoder was ~47% slower (dequantisation cost dominates on CPU, the reverse of the GPU case) and
slightly less accurate. Word-level timestamps were unaffected either way, so they aren't what decides
it. Expect Medium on CPU to run at a fraction of realtime.

### The window freezes while transcribing on CPU

Known, and currently unavoidable. ONNX Runtime builds and runs the session on the main thread, so on
the CPU backend the renderer is blocked for the whole of both the model load and the inference — no
repaint, no progress, no cancel. Measured on an M1 with a 24-second clip: ~97s frozen on Medium, and
the same at 10–20s on Base and Small. The GPU path is unaffected; it dispatches to the GPU and awaits.
The app says so before it happens (Settings → Transcription, and on the loading card), because an app
that stops responding without warning reads as a crash.

Two things stand in the way of fixing it, and both come from the renderer being a `file://` page:

- `env.backends.onnx.wasm.proxy = true` would move the work to a worker, but ORT builds that worker by
  **fetching its own script** and making a blob URL of it — and `fetch()` is blocked on `file://`. It's
  the same wall that put the models behind `model://`.
- Threads need `crossOriginIsolated`, which a `file://` page can never be, so the runtime forces
  `numThreads = 1` — CPU inference is single-threaded regardless of core count.

Both would be answered by serving the renderer from a privileged scheme whose handler can send
COOP/COEP headers, which `electron/models.js` already demonstrates. The price is changing the page's
origin: that orphans `localStorage` (~15 keys — settings, theme, session, transcription cache) and so
needs a one-shot migration. Nothing else lives in web storage any more — there is no IndexedDB, and
models are ordinary files on disk.

Weights are mirrored onto our own GitHub release (`models-v1` on `vocal-slice`), downloaded
by the main process on demand, verified against SHA-256 checksums that ship inside the app, and
cached locally. See `electron/models.js` and `build-scripts/mirror-models.js`.

## System Requirements

- **Windows:** 10/11 64-bit (WebGPU via Direct3D 12)
- **macOS:** 11 Big Sur and later — Apple Silicon runs natively (universal binary); Intel Macs need a Metal-capable GPU
- **Linux:** modern GPU with Vulkan support

## Project Structure

```
vocal-slice/
├── electron/          # Electron main process
│   ├── main.js       # App window & lifecycle
│   ├── models.js     # Model download + verification
│   └── preload.js    # Security bridge
├── static/           # Frontend (HTML/CSS/JS)
│   ├── index.html
│   ├── styles.css
│   └── js/app.js     # The whole renderer
├── build-scripts/    # Packaging, notices, release tooling
├── package.json      # Dependencies & build config
└── dist/            # Built installers (generated)
```

## Tech Stack

- **Framework:** Electron (Chromium + Node.js)
- **Frontend:** Vanilla JavaScript + Transformers.js v4.2.0
- **AI Model:** OpenAI Whisper (runs in-app via WebGPU)
- **Build Tool:** electron-builder

## Why Desktop App?

- No hosting costs
- Works completely offline (after model download)
- Audio and transcripts never leave the machine — no uploads, no telemetry
- Native performance with WebGPU
- Familiar install experience for users

## Credits

- [OpenAI Whisper](https://github.com/openai/whisper)
- [Transformers.js](https://github.com/xenova/transformers.js)
- [Electron](https://www.electronjs.org/)
- [Hugging Face](https://huggingface.co)

## Support

Questions or problems: open an [issue](https://github.com/terranivium/vocal-slice/issues), or email
`wesley@vocalslice.com`.

## License

Vocal Slice is free software, licensed under the [GNU General Public License v3.0](LICENSE).
Copyright © 2026 Wesley Scott. The third-party components it bundles, and their licenses, are listed in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
