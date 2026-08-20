# Vocal Slice — Releases

Release hosting for **[Vocal Slice](https://vocalslice.com)** — transcribe audio on your own machine,
then cut clips by selecting text.

This repository holds the published builds and their release notes. The application source is private.
For what the app does, pricing, and the privacy policy, see **[vocalslice.com](https://vocalslice.com)**.

## Downloads

The site's download buttons point here, but the direct links work too — they always follow the newest
release:

| Platform | Download |
| --- | --- |
| Windows 10/11 (64-bit) | [VocalSlice-Setup.exe](https://github.com/terranivium/vocal-slice-releases/releases/latest/download/VocalSlice-Setup.exe) |
| macOS 11 and later (universal) | [VocalSlice.dmg](https://github.com/terranivium/vocal-slice-releases/releases/latest/download/VocalSlice.dmg) |

The installer and the macOS app update themselves automatically. (On the release page you'll also see
`VocalSlice-macOS-update.zip` — that's the package the macOS app updates itself from, not a download.)

## Verifying a download

Every release page lists a **SHA-256 checksum** for each file. Compare it against what you downloaded:

```powershell
certutil -hashfile VocalSlice-Setup.exe SHA256    # Windows
```

```bash
shasum -a 256 VocalSlice.dmg                      # macOS
```

The printed value should match the release page exactly.

## Signing

The **macOS** build is signed with an Apple Developer ID and notarized by Apple, so it opens normally.

The **Windows** build is not yet code-signed, so SmartScreen shows *"Windows protected your PC —
unknown publisher"* on first run; choose **More info → Run anyway**. That warning reflects the absence
of a certificate, not anything found in the file — the checksum above is how you verify it. Signing is
on the roadmap.

## Support

Questions or problems: `wesley@vocalslice.com`

---

© 2026 Wesley Scott t/a Vocal Slice. All rights reserved. Vocal Slice is proprietary software — see [LICENSE](LICENSE)
for the terms covering these downloads. The app bundles open-source components, each under its own
licence; the full notices ship with the app (viewable under *Settings → About → Third-party licenses*)
and are reproduced here in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
