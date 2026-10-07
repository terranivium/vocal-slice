const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const esbuild = require('esbuild');
const { minify } = require('html-minifier-terser');
const vendor = require('./vendor');
const notices = require('./notices');
const changelog = require('./changelog-data');

const staticDir = path.join(__dirname, '../static');
const jsDir = path.join(staticDir, 'js');
const buildDir = path.join(staticDir, 'build');

// Bake git branch/commit into build-info.json so the packaged app's About section can show
// them (no .git at runtime). Git-less builds still succeed (values fall back to 'unknown').
function writeBuildInfo() {
    const git = (cmd) => { try { return execSync(cmd).toString().trim(); } catch { return ''; } };
    const info = {
        gitHash: git('git rev-parse --short HEAD') || 'unknown',
        gitBranch: git('git rev-parse --abbrev-ref HEAD') || 'unknown',
        buildNumber: git('git rev-list --count HEAD') || 'unknown',
        buildTime: new Date().toISOString()
    };
    fs.writeFileSync(path.join(staticDir, 'build-info.json'), JSON.stringify(info, null, 2));
    console.log(`   build-info: ${info.gitBranch}@${info.gitHash} (build ${info.buildNumber})`);
    return info;
}

// The version electron-updater ships this build as: {major}.{buildNumber}.0, the same derivation as
// build-scripts/pack.js. Null without a build number (no git), which leaves "## Unreleased" out.
function buildVersion(info) {
    if (!info.buildNumber || info.buildNumber === 'unknown') return null;
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    const major = String(pkg.version).split('.')[0] || '1';
    return { version: `${major}.${info.buildNumber}.0`, date: info.buildTime.slice(0, 10) };
}

// Bake the release notes in so Settings → About can show "What's new" without asking the network.
// That is the whole point: privacy.html enumerates every request the app makes and states it makes
// no others, so fetching notes at runtime would be a privacy-policy change, not a feature.
// The version being built has no heading of its own yet — promotion runs after publishing — so
// "## Unreleased" is passed through as this build's notes. See changelog-data.js. The public
// changelog page does NOT do this: it's read by people who can't download the build yet.
function writeChangelog(info) {
    const unreleasedAs = buildVersion(info);
    const releases = changelog.releases({ unreleasedAs });
    // Segments, not raw strings: app.js renders DOM nodes and cannot run the markdown tokeniser
    // itself, so the parsing happens once here and ships pre-tokenised. Keeps the in-app "What's new"
    // and the public changelog page rendering **bold** and `code` identically.
    const forApp = releases.map(r => ({ ...r, blocks: changelog.segmentBlocks(r.blocks) }));
    fs.writeFileSync(path.join(staticDir, 'changelog.json'), JSON.stringify(forApp));
    const own = releases[0]?.version === unreleasedAs?.version ? ' (this build, from ## Unreleased)' : '';
    console.log(`   changelog: ${releases.length} release(s), newest ${releases[0]?.version || 'none'}${own}`);
}

// Keep runtime-only imports out of the bundle: remote (CDN) URLs and the locally
// vendored transformers.js (loaded at runtime from static/vendor/).
const externalRuntime = {
    name: 'external-runtime',
    setup(build) {
        build.onResolve({ filter: /^https?:\/\// }, args => ({ path: args.path, external: true }));
        build.onResolve({ filter: /vendor[\/\\]transformers\.web\.js$/ }, args => ({ path: args.path, external: true }));
    }
};

async function run() {
    console.log('🔨 Starting build (esbuild + html-minifier-terser)...');

    // 0. Refresh the vendored transformers.js + onnxruntime wasm; regenerate the attribution
    //    notices for what we just vendored; bake build info.
    vendor();
    notices();
    writeChangelog(writeBuildInfo());

    // 1. Bundle + minify + mangle the renderer JS.
    console.log('📦 Bundling JS...');
    // app.js is a module (top-level await) → esm output.
    await esbuild.build({
        entryPoints: [path.join(jsDir, 'app.js')],
        outfile: path.join(buildDir, 'app.js'),
        bundle: true,
        format: 'esm',
        minify: true,
        drop: ['console'],
        legalComments: 'none',
        plugins: [externalRuntime],
    });
    // theme.js + onboarding.js are classic global scripts → iife output.
    await esbuild.build({
        entryPoints: [path.join(jsDir, 'theme.js'), path.join(jsDir, 'onboarding.js')],
        outdir: buildDir,
        bundle: true,
        format: 'iife',
        minify: true,
        drop: ['console'],
        legalComments: 'none',
    });

    // 2. Minify CSS.
    console.log('📦 Minifying CSS...');
    const css = fs.readFileSync(path.join(staticDir, 'styles.css'), 'utf8');
    const minifiedCss = css
        .replace(/\/\*[\s\S]*?\*\//g, '') // Remove CSS comments
        .replace(/\s+/g, ' ')              // Collapse whitespace
        .replace(/\s*([{}:;,])\s*/g, '$1') // Remove spaces around CSS syntax
        .trim();
    fs.writeFileSync(path.join(staticDir, 'styles.min.css'), minifiedCss);

    // 3. Produce index.min.html: point at the built/minified assets, then minify HTML.
    console.log('📦 Minifying HTML...');
    const html = fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8')
        .replace(/href="\.?\/?styles\.css"/, 'href="styles.min.css"')
        .replace('src="js/theme.js"', 'src="build/theme.js"')
        .replace('src="js/onboarding.js"', 'src="build/onboarding.js"')
        .replace('src="js/app.js"', 'src="build/app.js"');

    const minifiedHtml = await minify(html, {
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        removeScriptTypeAttributes: true,
        removeStyleLinkTypeAttributes: true,
        minifyJS: false, // JS is external + already minified by esbuild
        minifyCSS: true, // inline style attributes only
        useShortDoctype: true,
    });
    fs.writeFileSync(path.join(staticDir, 'index.min.html'), minifiedHtml);

    console.log('✅ Build complete!');
    console.log('   - static/build/{app,theme,onboarding}.js created');
    console.log('   - static/styles.min.css created');
    console.log('   - static/index.min.html created');
    console.log('');
    console.log('💡 Source in static/js/ and static/index.html are unchanged for development.');
}

run().catch(err => {
    console.error('❌ Build failed:', err);
    process.exit(1);
});
