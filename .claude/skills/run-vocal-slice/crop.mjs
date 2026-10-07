// Crop a region out of a screenshot so it's actually readable.
//
//   node .claude/skills/run-vocal-slice/crop.mjs <file.png> <top> <height> [out.png]
//   node .claude/skills/run-vocal-slice/crop.mjs desktop-dark-win.png bottom 1750
//
// A full-page capture is often 1280x4900. Viewed whole it scales down to illegibility, so crop to
// the region you actually need before looking. `bottom` is shorthand for "the last N pixels".
//
// Uses sharp from the repo's node_modules — already a devDependency for brand/build-icon.js, so
// this adds nothing. (Never run `npm install` in this repo; see CLAUDE.md.)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const require = createRequire(import.meta.url);

let sharp;
try {
    sharp = require(path.join(REPO, 'node_modules', 'sharp'));
} catch {
    console.error('sharp not found in node_modules. It is a devDependency of this repo.');
    process.exit(1);
}

const [fileArg, topArg, heightArg, outArg] = process.argv.slice(2);
if (!fileArg || !topArg || !heightArg) {
    console.error('usage: crop.mjs <file.png> <top|bottom> <height> [out.png]');
    process.exit(1);
}

const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), 'vocal-slice-shots');
const input = fs.existsSync(fileArg) ? fileArg : path.join(SHOTS, fileArg);
if (!fs.existsSync(input)) { console.error('no such file:', input); process.exit(1); }

const height = Number(heightArg);
const meta = await sharp(input).metadata();
const top = topArg === 'bottom' ? Math.max(0, meta.height - height) : Number(topArg);
const h = Math.min(height, meta.height - top);

const out = outArg
    ? (path.isAbsolute(outArg) ? outArg : path.join(SHOTS, outArg))
    : path.join(SHOTS, 'crop-' + path.basename(input));

await sharp(input).extract({ left: 0, top, width: meta.width, height: h }).toFile(out);
console.log(`${out}  ${meta.width}x${h}  (from y=${top} of ${meta.height})`);
