// electron-builder `afterPack` hook — flips Electron Fuses on the packaged binary to harden it.
//
// Fuses are compile-time-ish flags baked into the Electron executable that disable capabilities an
// attacker could otherwise abuse (running your signed binary as a plain Node interpreter, injecting code
// via --inspect / NODE_OPTIONS, loading a swapped-in app directory, reading cookies at rest). They can't
// be toggled back on at runtime.
//
// Order matters: afterPack runs BEFORE electron-builder code-signs, so the signature ends up covering the
// fused binary. On macOS we strip the ad-hoc signature (resetAdHocDarwinSignature) so the sign step
// re-signs cleanly.
//
// Needs `@electron/fuses` (build-time only). It isn't a default dependency — install it with:
//     npm install @electron/fuses --save-dev --ignore-scripts
// (pure JS, no native build; --ignore-scripts avoids the Electron postinstall hazard.) If it's missing we
// throw rather than silently ship an un-hardened build.

const path = require('path');

module.exports = async function afterPack(context) {
    let flipFuses, FuseVersion, FuseV1Options;
    try {
        ({ flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses'));
    } catch {
        throw new Error(
            'afterPack: @electron/fuses is not installed, so the build cannot be hardened.\n' +
            '  Install it (build-time only, pure JS):\n' +
            '    npm install @electron/fuses --save-dev --ignore-scripts');
    }

    const { appOutDir, electronPlatformName, packager } = context;
    const name = packager.appInfo.productFilename;   // "Vocal Slice"

    // Universal macOS builds pack x64 and arm64 into separate `<appOutDir>-<arch>-temp` dirs and then
    // lipo-merge them. @electron/universal requires every non-Mach-O file — including each framework's
    // `_CodeSignature/CodeResources` — to be byte-identical across the two arches before it will merge.
    // Flipping fuses in these per-arch passes re-signs each arch independently (resetAdHocDarwinSignature
    // below), so the CodeResources diverge and the merge aborts with "Expected all non-binary files to
    // have identical SHAs". electron-builder calls afterPack a THIRD time on the combined universal app
    // ("a final opportunity … before signing", macPackager doPack) — that is where we harden it, leaving
    // the per-arch apps identical so the merge succeeds. Single-arch and Windows builds have no such
    // temp dir and fall through to flip normally.
    if (/-(?:x64|arm64)-temp$/.test(appOutDir)) {
        console.log(`  • fuses deferred on ${path.basename(appOutDir)} (per-arch pass; the merged universal app is hardened after lipo)`);
        return;
    }

    // Path to the Electron executable/app bundle for this platform.
    const binary =
        electronPlatformName === 'darwin' ? path.join(appOutDir, `${name}.app`) :
        electronPlatformName === 'win32'  ? path.join(appOutDir, `${name}.exe`) :
                                            path.join(appOutDir, name);

    await flipFuses(binary, {
        version: FuseVersion.V1,
        // macOS: drop the ad-hoc sig so electron-builder's codesign step (which runs after this) re-signs.
        resetAdHocDarwinSignature: electronPlatformName === 'darwin',

        // Can't run the app binary as a bare Node interpreter (ELECTRON_RUN_AS_NODE). Note: this only
        // affects the PACKAGED build — the dev harness uses the unpacked node_modules electron.
        [FuseV1Options.RunAsNode]: false,
        // Block code injection via debugger / env-var flags.
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        // Only run the app from the signed asar; encrypt cookies at rest.
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.EnableCookieEncryption]: true,
        // Tamper detection on the asar. Fully enforces only on a SIGNED binary — active on macOS now,
        // inert (harmless) on unsigned Windows until it's signed. If a platform ever fails to launch with
        // this on, it's the first fuse to drop there.
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,

        // NOT touched — left at its default (true). The app loads its own resources over file://, and
        // disabling GrantFileProtocolExtraPrivileges would break that.
    });

    console.log(`  • fuses flipped on ${electronPlatformName} binary (${name})`);
};
