---
name: run-vocal-slice
description: Launch, drive and screenshot the Vocal Slice Electron app and the vocal-slice-web marketing site. Use when asked to run or start the app, take a screenshot of the app or the landing page, visually check a UI change, or verify how the site renders across themes, mobile widths, Windows/macOS, or with JavaScript disabled.
---

Vocal Slice is an Electron app; the marketing site lives in the sibling `../vocal-slice-web` repo.
Both are driven the same way: **a plain Node script talking Chrome DevTools Protocol over a socket.**

Nothing here needs installing. Node 22+ has global `fetch` and `WebSocket`, so the CDP client is
~50 lines with no dependencies. **Never run `npm install` in this repo** — see `CLAUDE.md`.

Screenshots go to the OS temp dir — `%TEMP%\vocal-slice-shots` on Windows, `$TMPDIR/vocal-slice-shots`
on macOS (override with `SHOT_DIR`) — deliberately outside the repo so they can't be committed.

Both platforms work. The scripts resolve the repo root with `fileURLToPath()` and find the Electron
binary via `node_modules/electron/path.txt`, so nothing is hardcoded per platform.

## The site — batch, all five variants

```bash
node .claude/skills/run-vocal-slice/shots.mjs
```

Captures full-page PNGs of `../vocal-slice-web/index.html` as:

| Variant | Width | Scheme | Platform | What it's for |
| --- | --- | --- | --- | --- |
| `desktop-dark-win` | 1280 | dark | Windows | the default look |
| `desktop-light-win` | 1280 | light | Windows | Latte palette holds up |
| `desktop-dark-mac` | 1280 | dark | macOS | Mac download button; Windows-only blocks hidden |
| `mobile-dark-win` | 420 | dark | Windows | wrapping and overflow |
| `nojs-dark-win` | 1280 | dark | Windows | **both** download buttons show — the safe-failure state |

Pass a path or URL as the first argument to shoot something else.

The `nojs` row is the one that earns its keep: the site hides one download button via JS platform
detection, and the no-JS fallback showing *both* is the property that stops a visitor being stranded
with no way to download. Normal browsing never reveals it.

## The app — REPL

Interactive, or piped for a scripted run — both work:

```bash
node .claude/skills/run-vocal-slice/drive.mjs
> launch                 # ~6s; a real window appears on the desktop
> panel storage          # Settings → Storage
> wait 800               # let the panel's async content land
> ss settings-storage    # → <tmp>/vocal-slice-shots/settings-storage.png
> quit
```

```bash
printf 'launch\npanel storage\nwait 800\nss storage\nquit\n' \
  | node .claude/skills/run-vocal-slice/drive.mjs
```

| command | what it does |
| --- | --- |
| `launch` | start the app, attach CDP, wait for first paint |
| `ss [name]` | screenshot the window |
| `panel <name>` | Settings tab **+** `switchSettingsPanel(name)`; prints the active panel id |
| `tab <name>` | `switchTab(name)` — `transcription`, `slices`, `settings` |
| `wait <ms>` | pause before capturing |
| `click <css-sel>` | DOM `.click()` on a selector |
| `eval <js>` | evaluate in the renderer, print the result |
| `text [css-sel]` | print `innerText` |
| `quit` | close the app and exit |

`switchTab` and `switchSettingsPanel` are real functions on `window`
([static/js/app.js:3772](../../../static/js/app.js#L3772)), which is what makes panel screenshots
possible without clicking through by hand.

Three things to expect when driving it this way:

- **`panel` must switch the Settings tab too.** Calling `switchSettingsPanel` alone updates a pane
  that isn't on screen, so the screenshot silently shows whatever tab was already open. `panel` does
  both, and prints the resulting panel id so you can tell it worked.
- **The tab highlight won't move.** These functions take an optional `clickedElement` to move the
  underline; driven programmatically there isn't one, so the header can show "Transcription"
  highlighted while a Settings panel is displayed. It's a driving artefact, not a bug in the app.
- **The app restores your last session** — loaded file, transcript, slices. Captures are not a clean
  empty state. `Settings → Storage → Clear Session Data` resets it if you need one.

## Look at the output

```bash
node .claude/skills/run-vocal-slice/crop.mjs desktop-dark-win.png bottom 1750
```

A full-page capture is often 1280×4900; viewed whole it scales to illegibility. Crop to the region
first. **Then actually open the image.** A blank frame is a failure to launch, not a pass — this
harness exists to catch things reasoning about the code does not.

## Gotchas

Every one of these cost real time.

- **`ELECTRON_RUN_AS_NODE=1` is set in the agent environment.** With it set, Electron's binary
  deliberately behaves as plain Node: `--version` reports the *bundled* Node version and
  `require('electron')` fails. It looks exactly like a corrupt install — it isn't. `cleanEnv()` in
  `cdp.mjs` strips it. The tell: the Electron binary's `--version` printing a *different* Node
  version than `node --version` proves the binary is fine and merely running in Node mode.

  This bites outside the harness too. `npm start` dies at `require('electron-updater')` with
  `Cannot read properties of undefined (reading 'getVersion')` — `require('electron')` returned no
  `app`. A *packaged* `.app` is worse: it exits 0, silently, with no output at all. Neither is a
  signing, entitlements or install problem. Always launch through this harness, or clear the
  variable first.

- **Never write the driver as an Electron main script.** On Windows, Electron is a GUI-subsystem
  binary, so `console.log` never reaches a piped stdout and failures become completely silent. macOS
  doesn't have that specific problem, but drive it from outside over CDP on both — one code path.

- **An unhandled exception in Electron's main process opens a blocking modal dialog.** In an
  automated run nobody clicks OK, so it hangs until killed *and* pops a window on the user's screen.

- **Attach to a non-`devtools://` target.** Both the app and the browser expose inspector targets;
  grabbing the wrong one drives the inspector, not the app.

- **Full-page capture needs `Page.getLayoutMetrics` + `captureScreenshot { captureBeyondViewport }`.**
  A very tall window does not work — Windows clamps window height to the screen.

- **Set UA, device metrics and emulated media *before* navigating.** The page reads the UA on load,
  so overriding afterwards tests nothing.

- **`Emulation.setScriptExecutionDisabled` is sticky.** Run the no-JS variant last (or reset it), or
  later variants silently inherit it and quietly invalidate their own results.

- **Wait past the load-in animations** before capturing the site — `wave-in` is 0.75s and `band-in`
  ends at 1.0s, so `shots.mjs` waits 1200ms. Capturing early yields half-drawn frames.

- **The app window really does appear.** `electron/main.js` shows it on `ready-to-show`. Expect it;
  `quit` closes it.

## Troubleshooting

- **`no matching page target on :PORT`** — the error prints the targets it *did* see. Empty list
  means the process never started: check `ELECTRON_RUN_AS_NODE`, then that the browser path in
  `shots.mjs` exists (`BROWSER=<path>` overrides).
- **Screenshot is blank or half-rendered** — increase the wait after `launch` / `Page.loadEventFired`.
- **Stray processes after a crash** — `Get-Process electron | Stop-Process -Force` (PowerShell).
