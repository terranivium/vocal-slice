// Minimal Chrome DevTools Protocol client.
//
// No dependencies on purpose — Node 22+ has global `fetch` and `WebSocket`, so this needs no
// Playwright and no `npm install` (which must never be run in this repo; see CLAUDE.md).
//
// Speaks to anything that exposes a CDP endpoint, which here means both a headless Chromium (for
// the marketing site) and the Vocal Slice Electron app itself.

/**
 * Poll a CDP endpoint until a usable page target appears.
 * Polling rather than a single request because the browser/app takes a second or two to open its
 * port, and a lone request would just get ECONNREFUSED.
 */
export async function findTarget(port, { match = () => true, timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = [];
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/json/list`);
            last = await res.json();
            const t = last.find(t => t.type === 'page' && t.webSocketDebuggerUrl && match(t));
            if (t) return t;
        } catch {
            // not listening yet — keep polling instead of failing on the first refused connection
        }
        await new Promise(r => setTimeout(r, 250));
    }
    // Include what WAS seen: "no target" plus the actual target list is a far better error than
    // a bare timeout when you're attached to the wrong process.
    throw new Error(`no matching page target on :${port} after ${timeoutMs}ms. Saw: ` +
        JSON.stringify(last.map(t => ({ type: t.type, url: t.url })), null, 2));
}

/** Connect to a target's websocket and return { send, on, close }. */
export async function connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('websocket failed: ' + wsUrl)), { once: true });
    });

    let nextId = 1;
    const pending = new Map();
    const listeners = [];

    ws.addEventListener('message', ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && pending.has(msg.id)) {
            const { resolve, reject } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error
                ? reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error)})`))
                : resolve(msg.result);
        } else if (msg.method) {
            for (const l of listeners) l(msg);
        }
    });

    return {
        send(method, params = {}) {
            const id = nextId++;
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                ws.send(JSON.stringify({ id, method, params }));
                // A protocol call that never answers would otherwise hang the whole run in silence.
                // That exact failure mode is what made this harness so hard to build the first time.
                setTimeout(() => {
                    if (pending.delete(id)) reject(new Error(`timeout: ${method}`));
                }, 30000);
            });
        },
        on(fn) { listeners.push(fn); },
        close() { ws.close(); },
    };
}

/** Spawn env with ELECTRON_RUN_AS_NODE stripped. See the Gotchas in SKILL.md — this is essential. */
export function cleanEnv() {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
}
