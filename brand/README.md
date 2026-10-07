# Brand assets

Everything here is generated from a single source — **`build-icon.js`**. Edit that, not the SVGs.

```bash
node brand/build-icon.js
```

That one command regenerates every SVG below, the PNG previews, and writes the app icons straight
into `static/`.

## Files

| File | Committed | Purpose |
| --- | :---: | --- |
| `build-icon.js` | ✅ | The generator. Geometry, palette and the waveform's amplitude model all live here. |
| `icon-dark.svg` | ✅ | Dark tile, **macOS inset**. The shipped design; source for `AppIcon.icns`. |
| `icon-gradient.svg` | ✅ | Blue→mauve tile, macOS inset. Kept as the alternate — see *Switching tiles*. |
| `icon-dark-fullbleed.svg` | ✅ | Dark tile, **no inset**. Source for `AppIcon.ico` and the web favicon. |
| `icon-gradient-fullbleed.svg` | ✅ | Gradient equivalent of the above. |
| `mark.svg` | ✅ | The mark alone, no tile. Uses `currentColor`, so it inherits text colour — for the website header and any single-colour use. |
| `icon.png` | ❌ | 1024px master, re-derived each build. Gitignored. |
| `preview/` | ❌ | Verification renders at 1024/256/128/64/32/16. Gitignored. |

## Why two insets

The platforms want opposite things, and using one for both makes the icon look wrong somewhere:

- **macOS** — the Big Sur grid expects an 824px tile inside a 1024 canvas (~10% transparent margin);
  the Dock supplies its own spacing.
- **Windows and the web** — taskbar, Explorer and browser tabs expect the artwork to **fill** its
  canvas. Using the macOS inset there renders the icon visibly smaller than neighbouring apps.

Corner radius and mark scale are both derived from the tile size, so the proportions hold at either
inset rather than needing separate hand-tuning.

## Outputs written into the app

`build-icon.js` writes these directly — filenames are fixed because `package.json`
(`build.win.icon` / `build.mac.icon`) and `electron/main.js` (window icon, macOS dock icon) reference
them by path:

- `static/AppIcon.ico` — multi-resolution (16/24/32/48/64/128/256), each size rendered from the
  vector rather than downscaled from one bitmap, built from the **full-bleed** source.
- `static/AppIcon.icns` — built from the **macOS-inset** source via `app-builder` (already present in
  `node_modules`; it's electron-builder's own icon tool).

Note the `.ico` is written by hand rather than by `app-builder`, which rejects sources under 256×256
and so can only emit a single-size icon — that leaves Windows to downscale for the 16px taskbar.

## Outputs written into the website

If the sibling `../vocal-slice-web` checkout exists, the same run also writes the site's brand assets
there, so the site can never drift from the app icon. Skipped silently if it isn't checked out.

- `favicon.svg` (dark tile) / `favicon-light.svg` (gradient tile — the site swaps to it in light
  mode, where a near-black tile sits heavily on a pale page)
- `favicon-16.png`, `favicon-32.png` — fallbacks for browsers without SVG favicon support
- `apple-touch-icon.png` — 180px, **flattened** onto the tile colour, because iOS applies its own
  rounded mask and transparent corners render black
- `og-image.png` — the 1200×630 social card used by `og:image`. The wordmark and tagline are drawn
  as SVG `<text>` and **rasterised here**, so the shipped file is a flat PNG: a link preview never
  gets to load a webfont, and a font reference left in the file would silently fall back.

## Voiceover on the press video

`build-video.mjs` records every caption with the millisecond it appears and writes
`press/video/narration.json`. `build-voiceover.mjs` reads that, speaks each line with Kokoro-82M
(local, offline, Apache-2.0) and lays it on the video's own timeline.

```bash
npm install --prefix brand/voiceover   # once — isolated, does NOT touch the app's node_modules
node brand/build-video.mjs             # films and voices in one pass
node brand/build-voiceover.mjs         # re-voices the existing renders without re-filming
```

The narration is not written in the voiceover script — **it is the caption**. Edit the wording in
`build-video.mjs` and the voice changes with it, because there is only one copy of each sentence.
Where a line has to be *said* differently from how it is *written*, pass `sayIn`'s fourth argument.

Each format keeps its own script and its own cues. They are not interchangeable: 9:16 runs the feed
cut and closes on "Named, ready to deliver." where 16:9 closes on "Re-trim without starting over."

- `VO=0 node brand/build-video.mjs` films silent, for when you're iterating on framing
- `VO_VOICE=bm_fable` picks a different voice (28 available; `af_heart` is the default)
- Re-voicing never re-encodes the picture — the video stream is copied through verbatim
- Takes are cached in `brand/voiceover/cache/` (gitignored); bump `RECIPE` if how they're rendered
  changes, or old takes survive the change

## Switching tiles

`SHIPPED` near the bottom of `build-icon.js` selects which variant is exported:

```js
const SHIPPED = 'icon-dark.svg';   // → 'icon-gradient.svg' to switch
```

Change it and re-run. The gradient tile tested measurably more legible at 16–32px; the dark tile
matches the app's own UI. Both are kept so the choice stays reversible.
