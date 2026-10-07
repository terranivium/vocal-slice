// Copies the transformers.js browser build + the onnxruntime-web wasm/loader
// files into static/vendor/ so the app runs them locally instead of from a CDN.
// Run once after `npm install` (npm run vendor); also invoked by prebuild.
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const vendorDir = path.join(__dirname, '../static/vendor');

function pkgDir(pkg) {
    const dir = path.join(__dirname, '../node_modules', pkg);
    if (!fs.existsSync(dir)) {
        throw new Error(`${pkg} not found at ${dir} — run "npm install" first`);
    }
    return dir;
}

function copy(src, destName) {
    const dest = path.join(vendorDir, destName || path.basename(src));
    fs.copyFileSync(src, dest);
    return dest;
}

function vendor() {
    console.log('📦 Vendoring transformers.js + onnxruntime-web into static/vendor/...');

    fs.rmSync(vendorDir, { recursive: true, force: true });
    fs.mkdirSync(vendorDir, { recursive: true });

    // 1. transformers.js browser build, pre-bundled into one self-contained ESM.
    //    The raw dist has a bare `onnxruntime-web/webgpu` import that a raw browser
    //    module can't resolve; bundling inlines it. Wasm is NOT bundled — it's
    //    loaded at runtime from this same folder via env.backends.onnx.wasm.wasmPaths.
    const tfDist = path.join(pkgDir('@huggingface/transformers'), 'dist');
    esbuild.buildSync({
        entryPoints: [path.join(tfDist, 'transformers.web.js')],
        outfile: path.join(vendorDir, 'transformers.web.js'),
        bundle: true,
        format: 'esm',
        minify: true,
        legalComments: 'none',
    });

    // 2. onnxruntime-web wasm binaries + their loader .mjs (all threaded variants,
    //    so WebGPU/JSEP and the wasm fallback all resolve locally).
    const ortDist = path.join(pkgDir('onnxruntime-web'), 'dist');
    const ortFiles = fs.readdirSync(ortDist).filter(f =>
        /^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f)
    );
    if (ortFiles.length === 0) {
        throw new Error(`No ort-wasm-simd-threaded*.{wasm,mjs} found in ${ortDist}`);
    }
    ortFiles.forEach(f => copy(path.join(ortDist, f)));

    // 3. Phosphor icons (regular + fill weights only — the weights the app uses),
    //    replacing the remote unpkg script. Copy each weight's style.css + fonts
    //    together so the CSS's relative url() refs resolve locally. woff2 only:
    //    the @font-face lists woff2 first, so Chromium takes it and never requests
    //    the .woff/.ttf/.svg fallbacks — shipping them just bloats the installer.
    //    style.css is copied verbatim (its dangling fallback src entries are inert),
    //    which keeps the "unmodified" claim in THIRD-PARTY-NOTICES.md accurate.
    const phSrc = path.join(pkgDir('@phosphor-icons/web'), 'src');
    const phWeights = ['regular', 'fill'];
    phWeights.forEach(weight => {
        const srcDir = path.join(phSrc, weight);
        const destDir = path.join(vendorDir, 'phosphor', weight);
        fs.mkdirSync(destDir, { recursive: true });
        fs.readdirSync(srcDir)
            .filter(f => f === 'style.css' || /^Phosphor.*\.woff2$/.test(f))
            .forEach(f => fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f)));
    });

    console.log(`✅ Vendored transformers.web.js + ${ortFiles.length} onnxruntime files`);
    console.log(`   + Phosphor icons (${phWeights.join(', ')})`);
}

module.exports = vendor;

if (require.main === module) {
    vendor();
}
