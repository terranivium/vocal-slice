# Releasing Vocal Slice

A release is built on **two machines** (Windows for the installer, macOS for the signed universal
build) and lands in one GitHub Release on the public
[vocal-slice](https://github.com/terranivium/vocal-slice) repo — the same repo the source lives in. (It
was `vocal-slice-releases` until 2.x; GitHub redirects that name, which is how 1.x installs, whose
`app-update.yml` still says `vocal-slice-releases`, keep finding updates. **Never create a repo called
`vocal-slice-releases` again** — it would capture that redirect and strand every 1.x install.)

Publishing **is** the update mechanism — there's no separate step and nothing is pushed to users. The
upload includes `latest.yml` / `latest-mac.yml`, and installed apps poll that feed on startup and pull
when the version is higher.

## One-time setup — **on each machine**

Start from the committed template:

```bash
cp electron-builder.env.example electron-builder.env      # macOS / Git Bash
copy electron-builder.env.example electron-builder.env    # Windows cmd
```

`electron-builder.env` lives in the project root and is **gitignored**, so it deliberately does not
travel with the repo. Both machines need their own copy, and they need different contents:

| Variable | Windows | Mac |
| --- | --- | --- |
| `GH_TOKEN` | ✅ | ✅ |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | — | ✅ (notarization) |

```
GH_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxx
```

The **same token works on both machines** — it's tied to the GitHub account, not the machine.

**Which token:** prefer a **fine-grained** personal access token scoped to only the
`vocal-slice` repository, with **Contents: Read and write** (enough to create releases and
upload assets). A classic token with `public_repo` also works but grants write access to *every* public
repo you own — more than releasing needs. Fine-grained tokens **expire**, so if a release suddenly
fails with a 401 months from now, check expiry first.

**Alternative:** any ordinary environment variable works just as well — electron-builder reads
`process.env` — if you'd rather not keep a secret file on disk.

electron-builder loads this file itself: `cli.js` calls
`loadEnv(path.join(process.cwd(), "electron-builder.env"))`, and `pack.js` runs it with the repo root
as the working directory. Never commit it.

**Node 22 or newer** on both machines — the tooling uses global `fetch` and `WebSocket` with no
dependencies.

## ⚠ Both machines must be on the same commit

The version is `{major}.{git rev-list --count HEAD}.0` — major from `package.json`, currently **2** (see
`build-scripts/pack.js` for why it must never go down) — so a Windows box
and a Mac sitting on different commits produce **different version numbers** and therefore **two
separate draft releases**.

**`git pull` alone is not enough.** Releases are cut from a working branch, not the default one, so a
machine sitting on `main` will pull happily and still be on the wrong commit. Check out the branch
explicitly and compare the count — that number *is* the version:

```bash
git fetch origin && git checkout <release-branch> && git pull
git rev-list --count HEAD      # must be IDENTICAL on both machines
```

If the two counts differ, stop and reconcile. Building anyway produces two half-complete drafts, and the
only symptom is a log line on the second machine (see below).

## Steps

1. **Windows** — `npm run release:win`
2. **macOS** — `npm run release:mac` (Developer ID cert in the keychain; `APPLE_ID`,
   `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` exported or in `electron-builder.env`)

   **Order doesn't matter.** Whichever machine runs first creates the draft and writes "What's new";
   the second is a no-op for the notes and adds its rows to the checksum table.

   Both upload into the **same draft release**, because electron-builder finds the existing draft by
   version tag. `releaseType` defaults to `draft`, so nothing is visible to users — or to the
   auto-updater — until you publish.

   > ⚠ **`creating GitHub release` in the second machine's log means it went wrong.** That line only
   > appears when no release exists for the tag. Seeing it on the second machine means the two were on
   > different commits, so a **second draft** now exists and each holds half a release.

   **Verify with `npm run release:check`, not the build log.** electron-builder logs `uploading file=`
   for binaries but **not** for `latest.yml` — its absence from the log once looked like a missing
   update feed when the file was there all along. Ask the API.

   **After the mac build, before publishing:**

   ```bash
   syspolicy_check distribution dist/VocalSlice.dmg              # ready for distribution
   syspolicy_check distribution "dist/mac-universal/Vocal Slice.app"
   xcrun stapler validate dist/VocalSlice.dmg                    # The validate action worked
   codesign -dvvv "dist/mac-universal/Vocal Slice.app" 2>&1 | grep -E 'Authority|Runtime'
   lipo -info "dist/mac-universal/Vocal Slice.app/Contents/MacOS/Vocal Slice"   # x86_64 arm64
   ```

   `syspolicy_check` (macOS 14+) is Apple's own pre-distribution linter and gives far better reasons
   than `spctl` — it names the missing signature or ticket outright. **Don't use
   `spctl --type install` on the DMG**: that context is for installer packages, and an earlier version
   of this file claimed it should print `accepted, source=Notarized Developer ID`. It never did, and
   the discrepancy went unnoticed until the first Mac release actually ran.

   A failure here is not cosmetic: macOS auto-update goes through Squirrel.Mac, which checks the
   signature and requires the update to carry the **same Team ID** as the installed app. Unlike Windows
   there is no unsigned path — it fails silently.

   ### The DMG is notarized separately from the app

   electron-builder notarizes the **`.app` and nothing else** — `notarizeIfProvided(appPath, …)` runs
   while packing, before the disk image exists. Left alone it produces a DMG holding a stapled app but
   carrying no ticket of its own, which Apple's linter rates `Fatal` twice. Since the site links
   directly at the DMG, that is the file most users ever touch.

   Two pieces close that, and both must stay in place:

   | Piece | Role |
   | --- | --- |
   | `dmg.sign: true` in `package.json` | signs the disk image — and runs *before* electron-builder hashes it, so the signature is inside the recorded hash |
   | `build-scripts/notarize-dmg.js` | an `artifactBuildCompleted` hook that submits the DMG to the notary service and staples the ticket |

   The hook is on `artifactBuildCompleted` for a specific reason: uploads are dispatched **per
   artifact as it finishes**, not batched at the end. `afterAllArtifactBuild` runs after the DMG has
   already uploaded, so stapling there would leave a good local file and a bad published one.
   `artifactBuildCompleted` runs immediately before dispatch.

   `dmg.writeUpdateInfo: false` goes with them. Stapling rewrites the file after its sha512 has been
   computed, so rather than publish a hash that no longer matches the bytes, the DMG is left out of
   `latest-mac.yml` entirely. Nothing is lost: `MacUpdater` selects the zip and explicitly excludes the
   dmg (`findFile(files, "zip", ["pkg", "dmg"])`).

   Missing `APPLE_*` credentials make the hook **skip with a warning** rather than fail, so
   `npm run build:mac` still works offline. That is only safe because `release:check` independently
   refuses to publish an unstapled DMG — the hook does the work, the gate enforces it.

   **The release notes write themselves.** Each `release:*` run ends with
   `build-scripts/release-notes.js`, which patches the draft's description over the GitHub API. Two
   blocks, with deliberately different rules:

   | Block | Rule |
   | --- | --- |
   | `<!-- checksums:start -->` … | **Always regenerated**, merging rows by filename — so the Mac run adds its `.dmg`/`.zip` beside the Windows ones instead of overwriting them, and a re-run updates rather than duplicates |
   | `<!-- whatsnew:start -->` … | **Written only when absent.** Once it exists — generated or typed by you — nothing overwrites it. `--refresh` forces a re-pull |

   Anything outside both marker pairs is left alone. It never publishes the draft. `npm run checksums`
   remains for ad-hoc hashing, and `npm run release-notes` re-runs just the patch.

3. **"What's new" comes from `CHANGELOG.md`**, which is authoritative for every release, past and
   present. Add bullets under `## Unreleased` *as you make the change*; release time needs nothing typed.
   **Never write notes in the GitHub UI** — edit the file and push, so the two can't diverge.

   If the section is empty it falls back to commit subjects since the previous release and says so on
   stderr. Treat that as a prompt to write the CHANGELOG, not as finished notes: subjects like
   "filename changes" mean nothing to a user. Fix the file, then `npm run release-notes -- --refresh`.

   | Task | Command |
   | --- | --- |
   | Fix the release in flight | `npm run release-notes -- --refresh` |
   | Fix an already-published release | `npm run release-notes -- --notes=1.421.0` |
   | Close a version out, after publishing | `npm run changelog:promote` |

   `--notes` rewrites only that release's "What's new" — it never touches the checksum table and never
   reads `dist/`. **This separation is not cosmetic:** the table is built from whatever sits in `dist/`,
   so a shared path would republish an old release's checksums as hashes of your *current* build, i.e.
   wrong SHA-256s for binaries already downloaded, against a site promising they're verifiable.

4. **`npm run release:check`** — the gate. Read-only; it never publishes or modifies anything, and exits
   non-zero if publishing would be a mistake. It asserts:

   | File | Purpose |
   | --- | --- |
   | `VocalSlice-Setup.exe` | Windows installer — what the site links to; the only Windows artifact published |
   | `VocalSlice.dmg` | macOS download — what the site links to |
   | `VocalSlice-macOS-update.zip` | **macOS auto-update source** — Squirrel.Mac updates from the zip, not the dmg. Named to read as the updater payload so users grab the `.dmg`, not this (both hold the same `.app`; an unzipped app run in place risks App Translocation and can't self-update). |
   | `latest.yml`, `latest-mac.yml` | the update feeds |

   > **The Windows portable is intentionally not published.** `release:win` builds and uploads the NSIS
   > installer only. Build the portable on demand with **`npm run build:portable`** (it lands in `dist/`,
   > same signing as the installer) and hand it out manually — it does **not** self-update, so it's a
   > frozen copy by design. `release:check` therefore does not expect it on the release.

   …plus that `latest-mac.yml` actually **points at the `.zip`**, that both feeds' `version:` match the
   tag, that "What's new" isn't still the `- …` placeholder, and that the checksum table covers every
   uploaded artifact (a gap there means `release-notes.js` never ran on one of the machines).

   It also asserts, **on macOS only**, that the local `VocalSlice.dmg` and packaged `.app` both carry a
   stapled notarization ticket. That part is necessarily local — verifying the uploaded copy would mean
   downloading 200 MB — so it first compares the local DMG's size against the uploaded asset and
   refuses to vouch for a file that isn't the one on the release. Run `release:check` **on the Mac**;
   from Windows this section reports `not checked` and the DMG goes unverified.

   Omitting `VocalSlice-macOS-update.zip` silently breaks macOS auto-update: downloads keep working,
   updates just never arrive — there is no user-visible symptom to catch it later. That is the main reason
   releases stay draft until both machines have uploaded, and the main reason this check exists.

   `npm run release:check -- --tag=v1.421.0` inspects an older release.

5. **Publish the draft.** Updates begin flowing to installed apps from this moment.

6. **Close the version out** — `npm run changelog:promote`. Renames `## Unreleased` to
   `## 2.{N}.0 — YYYY-MM-DD` and opens a fresh empty one above it. Local file edit only; it doesn't
   commit, so review the diff. Skip this and the next release republishes these notes — the script warns
   when it detects that, but only once a published release exists to compare against.

7. **Update the public changelog page** — `npm run changelog:site`, *after* promote, so the page
   includes the version you just closed out.

   It regenerates **`../vocal-slice-web/changelog.html`** from `CHANGELOG.md`. That is a **separate
   repo**: it needs its own commit and push, and nothing publishes it for you. The page also feeds
   the site's footer link, so a stale one is publicly visible.

   Deliberately a manual step, not part of `release:win` / `release:mac` — both machines writing into
   a sibling checkout mid-build would race, and the Mac may not have the site cloned at all. It skips
   with a note when the sibling isn't there, so running it from a machine without the site is safe.

   The in-app "What's new" needs nothing here: `npm run prebuild` bakes `static/changelog.json` from
   the same file on every build.

## Afterwards

- Confirm the site's download links resolve — they point at
  `/releases/latest/download/VocalSlice-Setup.exe` and `…/VocalSlice.dmg`, which 404 until a published
  release exists.
- Confirm <https://vocalslice.com/changelog.html> lists the new version, i.e. step 7 was run *and* the
  `vocal-slice-web` commit was pushed.
- **Test the updater on both platforms separately.** They use entirely different mechanisms (NSIS
  differential download vs Squirrel.Mac), so a pass on one proves nothing about the other. Install the
  previous version, publish this one, confirm detect → download → the "Update ready" toast → restart.

## Notes

- **Draft and pre-release builds are ignored by the updater.** A release must be fully published for
  updates to flow.
- **The version must actually increase.** Two releases from the same commit produce the same
  `1.<buildNumber>.0` and no update will ever be offered — make a commit between releases.
- `build:win` / `build:mac` build **without** publishing. Use those for local testing; `release:*` is
  the only path that uploads.
