// Generates THIRD-PARTY-NOTICES.md from the packages actually present in node_modules, so the
// attributions we're obliged to ship stay accurate as dependencies change.
//
// Reproducing these notices is a licence condition of the bundled components (Apache-2.0 for
// transformers.js, MIT for the rest), so this fails the build rather than emit a stale or
// incomplete file. Two guards do the real work:
//   - a licence that no longer matches what we recorded (a relicense is a legal event, not a bump)
//   - a dependency that isn't classified as shipped or build-only (i.e. someone added one)
//
// Run standalone: npm run notices  (also invoked by prebuild via minify.js)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const nodeModules = path.join(root, 'node_modules');

// Microsoft publish onnxruntime-web without a LICENSE file in the package; its dist headers carry
// "Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT License."
const MICROSOFT_MIT = `MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

// Everything that ends up inside the distributed app. The three vendored entries mirror what
// build-scripts/vendor.js copies into static/vendor/; electron is bundled by electron-builder.
// `expect` is the licence we reviewed — a mismatch fails the build.
const SHIPPED = [
    {
        pkg: 'electron',
        name: 'Electron',
        expect: 'MIT',
        holder: 'Electron contributors; GitHub Inc.',
        home: 'https://github.com/electron/electron',
        note: 'Electron embeds Chromium and Node.js. Chromium is distributed under the BSD-3-Clause\n' +
              'license and bundles many further components; the complete set of Chromium notices ships\n' +
              'alongside the application as `LICENSES.chromium.html` in the installation directory.',
    },
    {
        pkg: '@huggingface/transformers',
        name: '@huggingface/transformers (Transformers.js)',
        expect: 'Apache-2.0',
        holder: 'The HuggingFace Inc. team',
        home: 'https://github.com/huggingface/transformers.js',
        note: 'Vendored into this application as `static/vendor/transformers.web.js` — a bundled build\n' +
              'of the published package, redistributed without modification to its licensed source.',
    },
    {
        pkg: 'onnxruntime-web',
        name: 'ONNX Runtime Web',
        expect: 'MIT',
        holder: 'Microsoft Corporation',
        home: 'https://github.com/microsoft/onnxruntime',
        note: 'Vendored into this application as `static/vendor/ort-wasm-*.mjs` and\n' +
              '`static/vendor/ort-wasm-*.wasm`, and redistributed without modification.',
        fallbackText: MICROSOFT_MIT,   // package ships no LICENSE file
    },
    {
        pkg: '@phosphor-icons/web',
        name: 'Phosphor Icons',
        expect: 'MIT',
        holder: 'Phosphor Icons',
        home: 'https://github.com/phosphor-icons/web',
        note: 'Vendored into this application as `static/vendor/phosphor/` (regular + fill weights),\n' +
              'and redistributed without modification.',
    },
    {
        pkg: 'electron-updater',
        name: 'electron-updater',
        expect: 'MIT',
        holder: 'Vladimir Krivosheev',
        home: 'https://github.com/electron-userland/electron-builder',
        note: 'Bundled into the application (main process) to deliver in-app updates. electron-updater\n' +
              'ships its own production dependencies inside the app; those are attributed in the\n' +
              '"Bundled runtime dependencies" appendix below.',
    },
    {
        // Not an npm package, hence `external`: these are the Whisper model weights, which we now
        // host ourselves and the app downloads on demand (see electron/models.js). Redistributing
        // them is what makes attribution an obligation rather than a courtesy — the app previously
        // fetched them from Hugging Face and distributed nothing.
        //
        // The ONNX conversions under onnx-community/ carry no licence tag of their own; they are
        // derivatives of openai/whisper-*, which are Apache-2.0, and inherit those terms.
        external: true,
        pkg: null,
        name: 'OpenAI Whisper models (ONNX)',
        expect: 'Apache-2.0',
        version: 'onnx-community/*_timestamped @ main',
        holder: 'OpenAI',
        home: 'https://huggingface.co/openai/whisper-tiny.en',
        // Same licence document as transformers.js, so reproduce that text rather than carrying a
        // second 11KB copy of Apache-2.0 in this source file.
        licenseFrom: '@huggingface/transformers',
        note: 'Model weights, converted to ONNX by the Hugging Face `onnx-community` organisation and\n' +
              'redistributed by us as release assets, which the application downloads on demand. The\n' +
              'weights are not modified. The conversions are derivative works of OpenAI\'s Whisper\n' +
              'models and are covered by the Apache-2.0 licence reproduced below.',
    },
];

// Runtime `dependencies` whose ENTIRE production closure electron-builder bundles into app.asar.
// Every package in the closure is distributed, so every one is attributed — walked automatically so
// this stays correct when electron-updater bumps, rather than hand-maintaining a dozen entries.
const SHIPPED_BUNDLED_ROOTS = ['electron-updater'];

// Tooling that only runs at build time and is never distributed, so it needs no notice.
const BUILD_ONLY = ['electron-builder', 'electron-reload', 'esbuild', 'html-minifier-terser', '@electron/fuses'];

const LICENSE_FILENAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'LICENCE.md'];

function pkgJson(pkg) {
    const p = path.join(nodeModules, pkg, 'package.json');
    if (!fs.existsSync(p)) {
        throw new Error(`${pkg} not found in node_modules — run "npm install" first`);
    }
    return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function licenseText(entry) {
    const dir = path.join(nodeModules, entry.pkg);
    const found = LICENSE_FILENAMES
        .map(f => path.join(dir, f))
        .find(f => fs.existsSync(f));
    if (found) return fs.readFileSync(found, 'utf8').replace(/\r\n/g, '\n').trim();
    if (entry.fallbackText) return entry.fallbackText;
    throw new Error(
        `No licence file found for ${entry.pkg}. Locate the upstream text and add it as ` +
        `\`fallbackText\` on its entry in build-scripts/notices.js.`
    );
}

// The production-dependency closure of the given root packages: every package that ships inside
// app.asar as a runtime dependency of those roots. Walked from package.json `dependencies` fields.
function productionClosure(rootPkgs) {
    const seen = new Set();
    const visit = (pkg) => {
        if (seen.has(pkg)) return;
        seen.add(pkg);
        let meta;
        try { meta = pkgJson(pkg); } catch { return; }
        for (const dep of Object.keys(meta.dependencies || {})) visit(dep);
    };
    rootPkgs.forEach(visit);
    return [...seen];
}

// A few permissive licences are templates with only the copyright line varying, so a bundled package
// that ships no LICENSE file (e.g. lazy-val) can still be attributed accurately from its declared
// licence + author. Anything outside this set with no file throws — synthesising unusual licence
// text would be worse than a hard stop.
const LICENSE_TEMPLATES = {
    MIT: (holder) => `MIT License

Copyright (c) ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`,
    ISC: (holder) => `ISC License

Copyright (c) ${holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.`,
};

function bundledLicenseText(pkg, meta) {
    const dir = path.join(nodeModules, pkg);
    const found = LICENSE_FILENAMES.map(f => path.join(dir, f)).find(f => fs.existsSync(f));
    if (found) return fs.readFileSync(found, 'utf8').replace(/\r\n/g, '\n').trim();

    const template = LICENSE_TEMPLATES[meta.license];
    const holder = (meta.author && (meta.author.name || meta.author)) || meta.name;
    if (template) return template(String(holder));

    throw new Error(
        `Bundled dependency ${pkg} (${meta.license}) ships no licence file and has no template.\n` +
        `   Add a LICENSE_TEMPLATES entry for "${meta.license}", or handle ${pkg} explicitly.`
    );
}

function slug(s) {
    return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function notices() {
    console.log('📦 Generating THIRD-PARTY-NOTICES.md...');

    const rootPkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const declared = Object.keys({ ...rootPkg.dependencies, ...rootPkg.devDependencies });
    const shippedNames = SHIPPED.map(e => e.pkg);

    // A new dependency must be consciously classified: shipping it without a notice can breach
    // its licence, so refuse to emit a file that might be silently incomplete.
    // `declared` only ever holds npm names, so external entries (pkg: null) never match here —
    // they are classified by existing in SHIPPED at all, not by appearing in package.json.
    const unclassified = declared.filter(d => !shippedNames.includes(d) && !BUILD_ONLY.includes(d));
    if (unclassified.length > 0) {
        throw new Error(
            `Unclassified dependenc${unclassified.length === 1 ? 'y' : 'ies'}: ${unclassified.join(', ')}\n` +
            `   Does it ship inside the app?\n` +
            `     yes → add an entry to SHIPPED in build-scripts/notices.js (name, licence, copyright)\n` +
            `     no  → add its name to BUILD_ONLY in build-scripts/notices.js`
        );
    }

    const components = SHIPPED.map(entry => {
        // Non-package components (model weights) carry their own version string and borrow their
        // licence text from a package that uses the same licence — there is no node_modules entry
        // to read a version or a LICENSE file from.
        if (entry.external) {
            return { ...entry, text: licenseText({ pkg: entry.licenseFrom }) };
        }
        const meta = pkgJson(entry.pkg);
        // A relicense is a legal event, not a version bump — surface it instead of quietly
        // reproducing terms we never reviewed.
        if (meta.license !== entry.expect) {
            throw new Error(
                `${entry.pkg} is now licensed "${meta.license}" but notices.js records "${entry.expect}".\n` +
                `   Review the new terms before shipping, then update its entry in build-scripts/notices.js.`
            );
        }
        return { ...entry, version: meta.version, text: licenseText(entry) };
    });

    // Transitive production deps bundled via SHIPPED_BUNDLED_ROOTS. Exclude anything already given a
    // primary entry above (electron-updater itself) so it isn't attributed twice.
    const primaryNames = new Set(SHIPPED.map(e => e.pkg));
    const bundled = productionClosure(SHIPPED_BUNDLED_ROOTS)
        .filter(pkg => !primaryNames.has(pkg))
        .sort()
        .map(pkg => {
            const meta = pkgJson(pkg);
            return { pkg, version: meta.version, license: meta.license || 'UNKNOWN', text: bundledLicenseText(pkg, meta) };
        });

    let out = `# Third-Party Notices

Vocal Slice incorporates the third-party open-source components listed below. Each remains subject
to its own license, reproduced in full here.

Nothing in the Vocal Slice license (GPL-3.0, see \`LICENSE\`) limits, supersedes or otherwise modifies the
rights granted to you under these licenses in respect of these components.

Build-time-only tooling (${BUILD_ONLY.join(', ')}) is not
distributed with the application and is therefore not listed.

## Contents

${components.map((c, i) => `${i + 1}. [${c.name}](#${i + 1}-${slug(c.name)}) — ${c.expect}`).join('\n')}

---
`;

    components.forEach((c, i) => {
        out += `
## ${i + 1}. ${c.name}

- **Version:** ${c.version}
- **License:** ${c.expect}
- **Copyright:** ${c.holder}
- **Homepage:** ${c.home}

${c.note}

<details>
<summary>${c.expect} license text</summary>

\`\`\`
${c.text}
\`\`\`

</details>

---
`;
    });

    if (bundled.length) {
        out += `
## Bundled runtime dependencies

electron-updater bundles the following production dependencies inside the application. Each is listed
with the licence declared in its package metadata, reproduced in full.

${bundled.map(b => `- **${b.pkg}** ${b.version} — ${b.license}`).join('\n')}

`;
        bundled.forEach(b => {
            out += `
### ${b.pkg}

- **Version:** ${b.version}
- **License:** ${b.license}

<details>
<summary>${b.license} license text</summary>

\`\`\`
${b.text}
\`\`\`

</details>

---
`;
        });
    }

    out += `
_Generated by \`build-scripts/notices.js\` from the versions resolved in \`node_modules\`. Do not edit
by hand — run \`npm run notices\` (or any build) to regenerate._
`;

    fs.writeFileSync(path.join(root, 'THIRD-PARTY-NOTICES.md'), out, 'utf8');
    components.forEach(c => console.log(`   ${c.name} ${c.version} — ${c.expect}`));
}

module.exports = notices;

if (require.main === module) {
    try {
        notices();
    } catch (err) {
        console.error('❌ Notices generation failed:', err.message);
        process.exit(1);
    }
}
