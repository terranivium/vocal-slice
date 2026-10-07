// REPL driver for the Vocal Slice Electron app.
//
//   node .claude/skills/run-vocal-slice/drive.mjs
//   > launch
//   > panel storage
//   > ss settings-storage
//   > quit
//
// A REPL rather than a batch script because app launch takes several seconds — this way you can
// poke at the UI repeatedly without paying that cost each time.
//
// Runs as PLAIN NODE and talks CDP to the app over a socket. Do not be tempted to rewrite this as
// an Electron main script: Electron on Windows is a GUI-subsystem binary, so console output never
// reaches a pipe and every failure becomes invisible. See SKILL.md → Gotchas.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { findTarget, connect, cleanEnv } from './cdp.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
// The binary's name differs per platform (electron.exe vs Electron.app/Contents/MacOS/Electron).
// electron's installer records the right relative path in path.txt, so read it rather than guess.
const ELECTRON = path.join(REPO, 'node_modules/electron/dist',
    fs.readFileSync(path.join(REPO, 'node_modules/electron/path.txt'), 'utf8').trim());
const OUT = process.env.SHOT_DIR || path.join(os.tmpdir(), 'vocal-slice-shots');
const PORT = Number(process.env.CDP_PORT || 9223);

fs.mkdirSync(OUT, { recursive: true });

let child = null;
let cdp = null;

const COMMANDS = {
    async launch() {
        if (cdp) return console.log('already launched');
        if (!fs.existsSync(ELECTRON)) return console.log('ERROR: electron not found at ' + ELECTRON);

        // cleanEnv() strips ELECTRON_RUN_AS_NODE — with it set the binary runs as plain Node and
        // never opens a window, which looks exactly like a broken install.
        child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`],
            { cwd: REPO, env: cleanEnv(), stdio: 'ignore' });
        child.on('error', e => console.log('SPAWN FAILED:', e.message));
        console.log('launched, pid', child.pid, '— a real window will appear');

        // Skip devtools targets, or you can end up driving the inspector instead of the app.
        const t = await findTarget(PORT, { timeoutMs: 45000, match: t => !t.url.startsWith('devtools://') });
        cdp = await connect(t.webSocketDebuggerUrl);
        await cdp.send('Page.enable');
        await new Promise(r => setTimeout(r, 4000));   // renderer boot + first paint
        console.log('attached:', t.url);
    },

    async ss(name) {
        if (!cdp) return console.log('ERROR: launch first');
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const f = path.join(OUT, (name || `app-${Date.now()}`) + '.png');
        fs.writeFileSync(f, Buffer.from(shot.data, 'base64'));
        console.log('screenshot:', f, '— now LOOK at it. A blank frame is a failure, not a pass.');
    },

    // The app's own tab/panel switchers, exposed on window by static/js/app.js. This is what makes
    // panel-specific screenshots possible without clicking through by hand.
    //
    // `panel` switches to the Settings TAB first: calling switchSettingsPanel on its own updates a
    // pane that isn't on screen, so the screenshot silently shows whatever tab was already open.
    async panel(name) {
        await COMMANDS.eval(
            `(switchTab('settings'), switchSettingsPanel(${JSON.stringify(name)}),
              document.querySelector('.settings-panel.active')?.id ?? 'NO_ACTIVE_PANEL')`);
    },
    async tab(name) { await COMMANDS.eval(`(switchTab(${JSON.stringify(name)}), 'ok')`); },

    async eval(expr) {
        if (!cdp) return console.log('ERROR: launch first');
        const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
            expression: expr, returnByValue: true, awaitPromise: true,
        });
        if (exceptionDetails) return console.log('EXCEPTION:', exceptionDetails.text || exceptionDetails.exception?.description);
        console.log(JSON.stringify(result.value ?? result.description ?? null));
    },

    async text(sel) {
        await COMMANDS.eval(sel
            ? `document.querySelector(${JSON.stringify(sel)})?.innerText ?? '(no match)'`
            : `document.body.innerText.slice(0, 2000)`);
    },

    async click(sel) {
        await COMMANDS.eval(
            `(() => { const el = document.querySelector(${JSON.stringify(sel)});
               if (!el) return 'NOT_FOUND'; el.click(); return 'OK'; })()`);
    },

    // Panels that fetch (Storage lists cached models) render "Loading…" first. Give them a beat
    // before screenshotting or you capture the spinner.
    async wait(ms) { await new Promise(r => setTimeout(r, Number(ms) || 1000)); },

    async quit() {
        if (cdp) { try { cdp.close(); } catch {} cdp = null; }
        if (child) { child.kill(); child = null; }
        console.log('closed');
    },

    help() {
        console.log('commands: launch, ss [name], panel <name>, tab <name>, click <sel>, ' +
                    'eval <js>, text [sel], quit');
        console.log('shots →', OUT);
    },
};

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' });
console.log('Vocal Slice driver — "help" for commands, "launch" to start');
rl.prompt();

// Two things make piped input (`printf 'launch\nss x\nquit\n' | node drive.mjs`) work, and both are
// needed — interactive use hides the problems:
//   1. readline emits every buffered line at once, so commands must be SERIALISED or `ss` fires
//      while `launch` is still awaiting and reports "launch first".
//   2. stdin hits EOF immediately after the last line, so 'close' arrives mid-queue; the handler
//      below drains the queue before quitting, and `closed` stops us prompting a dead interface.
let queue = Promise.resolve();
let closed = false;

async function handle(line) {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    if (cmd) {
        const fn = COMMANDS[cmd];
        if (!fn) console.log('unknown:', cmd, '— try: help');
        else try { await fn(rest.join(' ')); } catch (e) { console.log('ERROR:', e.message); }
    }
    if (cmd === 'quit') { if (!closed) rl.close(); return; }
    if (!closed) rl.prompt();
}

rl.on('line', line => { queue = queue.then(() => handle(line)); });

// With piped input stdin hits EOF the moment the last line is read, so 'close' fires while the
// queue is still working. Draining it first is what makes `printf '…' | node drive.mjs` usable —
// without this the process exits mid-launch and every command appears to do nothing.
rl.on('close', async () => {
    closed = true;
    await queue;
    await COMMANDS.quit();
    process.exit(0);
});
