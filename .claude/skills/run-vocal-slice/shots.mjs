// Full-page screenshots of the vocal-slice-web landing page across themes, widths and platforms.
//
//   node .claude/skills/run-vocal-slice/shots.mjs [pageUrlOrPath]
//
// Output goes to %TEMP%/vocal-slice-shots (override with SHOT_DIR) — deliberately outside the repo,
// so screenshots never end up in git.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findTarget, connect } from './cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const SITE = process.argv[2] || path.join(REPO, '..', 'vocal-slice-web', 'index.html');
const PAGE = SITE.startsWith('http') || SITE.startsWith('file:')
    ? SITE
    : pathToFileURL(path.resolve(SITE)).href;

const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'vocal-slice-shots');
const PORT = Number(process.env.CDP_PORT || 9222);
const PROFILE = path.join(os.tmpdir(), 'vocal-slice-cdp-profile');

const BROWSERS = [
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
];
const BROWSER = process.env.BROWSER || BROWSERS.find(p => fs.existsSync(p));
if (!BROWSER) { console.error('No Chromium browser found. Set BROWSER=<path to exe>.'); process.exit(1); }

const UA_WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';
const UA_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

const VARIANTS = [
    { name: 'desktop-dark-win', w: 1280, scheme: 'dark', ua: UA_WIN },
    { name: 'desktop-light-win', w: 1280, scheme: 'light', ua: UA_WIN },
    { name: 'desktop-dark-mac', w: 1280, scheme: 'dark', ua: UA_MAC },
    { name: 'mobile-dark-win', w: 420, scheme: 'dark', ua: UA_WIN },
    // MUST stay last: setScriptExecutionDisabled persists on the page, so any variant after this
    // one would silently inherit the no-JS state and quietly invalidate its own result.
    { name: 'nojs-dark-win', w: 1280, scheme: 'dark', ua: UA_WIN, nojs: true },
];

fs.mkdirSync(OUT, { recursive: true });
console.log('page:', PAGE);
console.log('out: ', OUT);

const child = spawn(BROWSER, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' });
child.on('error', e => { console.error('SPAWN FAILED:', e.message); process.exit(1); });

const wait = ms => new Promise(r => setTimeout(r, ms));

try {
    const target = await findTarget(PORT);
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');

    for (const v of VARIANTS) {
        // Every override goes in BEFORE navigating. The page's own platform-detection script reads
        // the UA on load, so overriding afterwards would be testing nothing.
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: v.ua });
        await cdp.send('Emulation.setScriptExecutionDisabled', { value: !!v.nojs });
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: v.w, height: 900, deviceScaleFactor: 1, mobile: v.w < 600,
        });
        await cdp.send('Emulation.setEmulatedMedia', {
            media: 'screen',
            features: [{ name: 'prefers-color-scheme', value: v.scheme }],
        });

        const loaded = new Promise(res => cdp.on(m => m.method === 'Page.loadEventFired' && res()));
        await cdp.send('Page.navigate', { url: PAGE });
        await loaded;
        await wait(1200);   // past the load-in animations (wave-in 0.75s; band-in ends at 1.0s)

        // Full page height comes from the layout — a tall window doesn't work, Windows clamps
        // window height to the screen.
        const { cssContentSize } = await cdp.send('Page.getLayoutMetrics');
        const h = Math.ceil(cssContentSize.height);
        const shot = await cdp.send('Page.captureScreenshot', {
            format: 'png',
            captureBeyondViewport: true,
            clip: { x: 0, y: 0, width: v.w, height: h, scale: 1 },
        });

        const file = path.join(OUT, v.name + '.png');
        fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
        console.log(`  ${v.name.padEnd(20)} ${v.w}x${h}  ${(fs.statSync(file).size / 1024).toFixed(0)}kb`);
    }

    cdp.close();
    console.log('DONE — now LOOK at them. Use crop.mjs; a 1280x4900 png is unreadable whole.');
} catch (e) {
    console.error('FAILED:', e.message);
    process.exitCode = 1;
} finally {
    child.kill();
}
