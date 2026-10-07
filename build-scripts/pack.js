// Runs electron-builder with the real build number in the environment, so the packaged artifacts
// are named v{major}.{buildNumber} (matching the title bar / About) instead of package.json's
// static "1.0.0". electron-builder resolves ${env.VS_VERSION} inside build.*.artifactName.
//
// Why a wrapper and not an inline env var: npm's `&&` runs each step in its own process, so a var
// exported in one command wouldn't reach electron-builder, and inline syntax is shell-specific
// (pwsh vs cmd vs bash). Setting it here is cross-shell and needs no extra dependency.
//
// Invoked by the build:* scripts, passing the platform flag through: node pack.js --win
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');

// major from package.json, buildNumber baked into static/build-info.json by prebuild (minify.js).
// buildNumber is empty when there's no build-info (no git / prebuild not run).
function versionParts() {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    let buildNumber = '';
    try {
        buildNumber = JSON.parse(fs.readFileSync(path.join(root, 'static/build-info.json'), 'utf8')).buildNumber;
    } catch { /* no build-info (no git / prebuild not run) */ }
    return {
        pkgVersion: String(pkg.version),
        major: String(pkg.version).split('.')[0] || '1',
        buildNumber: (buildNumber && buildNumber !== 'unknown') ? buildNumber : '',
    };
}

// Same derivation as electron/main.js getAppInfo(): v{major}.{buildNumber}. Falls back to
// package.json version when there's no build-info.
function displayVersion() {
    const { pkgVersion, major, buildNumber } = versionParts();
    return buildNumber ? `${major}.${buildNumber}` : pkgVersion;
}

// The version electron-updater actually compares. package.json's version is static by design and
// supplies only the MAJOR — bumped to 2 when the source moved to the public repo, whose commit count
// restarted near zero; 2.{small}.0 still sorts above every 1.{475+}.0 already installed. Never lower
// it. Without this override every release would carry that static version, look identical to the
// installed build, and no update would ever be offered — on any platform. {major}.{buildNumber}.0 rises with each commit, and because
// getAppInfo() derives displayVersion from build-info.json the About/title still reads v{major}.{build}.
// Returns null with no build number, leaving package.json's version to stand.
function semverVersion() {
    const { major, buildNumber } = versionParts();
    return buildNumber ? `${major}.${buildNumber}.0` : null;
}

const cli = require.resolve('electron-builder/cli.js');
const semver = semverVersion();
const args = [cli, ...process.argv.slice(2)];
if (semver) args.push(`--config.extraMetadata.version=${semver}`);

const result = spawnSync(process.execPath, args, {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, VS_VERSION: displayVersion() },
});
process.exit(result.status ?? 1);
