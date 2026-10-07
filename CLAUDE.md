# Vocal Slice — working notes

Electron app that transcribes audio locally and lets you cut clips by selecting text. Free and open
source (GPL-3.0) since 2.x; the public repo is `terranivium/vocal-slice`, which holds both the source and
the releases.
Renderer in `static/`, main process in `electron/`, brand assets generated from `brand/build-icon.js`.

## Hard constraints

- **Never run `npm install` / `npm ci`.** It breaks the local Electron install. If a dependency
  genuinely has to change, say so and let the user run it; `npm run fix-electron` is the recovery.
  The one exception is `npm install --prefix brand/voiceover`, which installs the press-video
  text-to-speech into its own tree and cannot touch the app's `node_modules` — still the user's to
  run, but it is not the dangerous one.
- **Don't run production builds** (`npm run build*`) unless asked — they're slow and write installers.
- **The user makes their own git commits.** Don't commit or push unless explicitly asked.
- **Log user-facing changes in `CHANGELOG.md` as you make them.** Any fix or change a user
  would notice gets a bullet under `## Unreleased` (the source of truth for release notes —
  see Releasing). Write it in the user's words, not commit-speak. Skip it for internal-only
  work (refactors, build/tooling, docs, tests) that ships no visible change.
- **No analytics, telemetry or crash reporting IN THE APP.** The product is positioned on privacy and
  the privacy policy says so in as many words. Diagnostics are local-only and user-initiated
  (clipboard or a file the user picks). This is the promise that differentiates the product — treat
  any proposal to add a network call to the app as a decision with a very high bar, not a tweak.
  *The marketing site is scoped separately:* it carries **cookieless page-view analytics**
  (Cloudflare Web Analytics), which `privacy.html` describes accurately. That is deliberate and
  current — do not "restore" a no-analytics claim about the site. What stays banned there is
  cookies, advertising/conversion pixels and cross-site tracking of any kind.
- **This repo is public.** Nothing private goes in it: secrets stay in gitignored `*.env` files, and
  launch/ad copy and download stats stay in the gitignored `marketing/` and `download-stats.json`.
- **There is no licensing.** The 1.x trial/licence gate (Polar) was removed when the app went open
  source; `electron/license-cleanup.js` only deletes the records 1.x left on disk. Don't reintroduce a
  gate, a key check or a purchase flow.

## Gotcha that looks like a broken install

`ELECTRON_RUN_AS_NODE=1` is set in the agent tool environment. With it set, `electron.exe` behaves as
plain Node — `--version` prints the *bundled* Node version and `require('electron')` fails. Nothing
is wrong. Strip it when spawning: `env -u ELECTRON_RUN_AS_NODE …`

## Releasing

Full process in **`RELEASING.md`** — read it before driving a release. `release:win` on the PC and
`release:mac` on the Mac both upload into the **same draft** GitHub Release (electron-builder's
`releaseType` defaults to `draft`), which is then published by hand.

The rules that matter most, because getting them wrong is expensive:

- **Publishing *is* shipping the update** — there's no separate push step, and it reaches every
  installed app. **Never publish a release on the user's behalf.** Leave it a draft and say it's ready.
- **Both machines must be on the same commit.** The version is `2.{git rev-list --count HEAD}.0`, so a
  mismatch produces two half-complete drafts instead of one. `creating GitHub release` in the *second*
  machine's log is the tell that this happened.
- **`npm run release:check` before publishing.** Read-only gate: asserts all six artifacts, that
  `latest-mac.yml` points at the `.zip` (omitting it breaks macOS auto-update *silently*), and that the
  checksum table covers everything uploaded. **Verify with this, not the build log** — electron-builder
  doesn't log `latest.yml` uploads, which has already caused one false alarm.
- **`CHANGELOG.md` is the source of truth for release notes**, for every version past and present.
  Never write notes in the GitHub UI. `## Unreleased` feeds the release being built;
  `npm run release-notes -- --notes=1.421.0` corrects an already-published one;
  `npm run changelog:promote` closes a version out afterwards.
- **Secrets live in the gitignored `electron-builder.env`** (`GH_TOKEN`, and `APPLE_*` on the Mac).
  Never print, echo or commit them. `electron-builder.env.example` is the committed template.

Both machines need **Node 22+** and their own `electron-builder.env` — it deliberately doesn't travel
with the repo.

## Seeing your changes

Use the **`run-vocal-slice`** skill — it launches and screenshots both the app and the marketing
site over the DevTools Protocol. Verify UI work by looking at a render, not by reasoning about the
CSS: that discipline has caught defects repeatedly here, and reading the cascade has not.

## Layout notes

- `static/js/app.js` is the whole renderer. `switchTab` / `switchSettingsPanel` are on `window`.
- `brand/build-icon.js` is the single source for the icon, the app `.ico`/`.icns`, the site favicons
  and the social card. Edit the generator, never the generated SVGs.
- `build-scripts/notices.js` regenerates `THIRD-PARTY-NOTICES.md` and **fails the build** on an
  unclassified or relicensed dependency — that's deliberate.
- The marketing site is a **separate repo**, `../vocal-slice-web`, plain static files for GitHub
  Pages. Its **only** permitted external request on page load is the cookieless analytics beacon —
  no third-party fonts, no embeds, no CDN scripts, no advertising pixels. `scratchpad/utmcheck.mjs`
  enforces this with an allowlist of one host.
