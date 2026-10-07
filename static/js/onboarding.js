// First-run coach-mark walkthrough. A self-contained overlay engine: it knows nothing about the app's
// internals and only reads the on-screen position of elements by id, so it stays decoupled from app.js
// (which owns the demo data and exposes window.loadDemo).
//
// The demo itself is loaded by app.js; this file drives the guided tour over whatever is on screen.
(function () {
    const SEEN_KEY = 'onboardingSeen';

    // Each step anchors to a live element. `pad` grows the spotlight; `placement` is a hint only — the
    // tooltip flips to stay on screen regardless.
    const DEFAULT_STEPS = [
        {
            sel: '#file-info',
            title: 'Choose a file',
            body: 'Open an audio file to transcribe. This tour is running on a demo clip.',
            placement: 'bottom',
        },
        {
            sel: '#language-settings-btn',
            title: 'Model and language',
            body: 'Pick the Whisper model and language. Smaller models are faster, larger ones more accurate. Multilingual models handle non-English audio.',
            placement: 'bottom',
            pad: 8,
        },
        {
            sel: '#transcription-text',
            title: 'Select the words you want',
            body: 'Highlight any phrase in the transcript. The waveform below jumps to that audio.',
            placement: 'bottom',
        },
        {
            // Anchored by CLASS, which the engine supports ($ is querySelector) — this row has no id.
            // It sits directly above the transcript, so coming here straight after the selection step
            // keeps the spotlight travelling smoothly; anchoring it after the waveform step instead
            // would bounce transcript -> waveform -> back up here -> back down to the handles.
            sel: '.search-controls',
            title: 'Find every match',
            body: 'Selecting a phrase also finds everywhere else it appears — step between them with the arrows to compare takes. You can type here to search the transcript too.',
            placement: 'bottom',
            pad: 8,
        },
        {
            sel: '#transcription-waveform-section',
            title: 'The waveform follows',
            body: 'Your selection is snapped to word boundaries, so cuts land cleanly.',
            placement: 'top',
        },
        {
            sel: '#waveform-end-handle',
            title: 'Fine-tune by dragging',
            body: 'Drag the handles to trim the in and out points, then preview with the transport controls.',
            placement: 'top',
            pad: 10,
        },
        {
            sel: '#create-slice-btn',
            title: 'Export the slice',
            body: 'Create the slice and it lands in the Slices tab, ready to save at source quality.',
            placement: 'top',
        },
        {
            sel: '#gpu-status-light',
            title: 'Runs on your machine',
            body: 'This dot shows GPU-acceleration status. Transcription runs locally, falling back to CPU if needed. Your audio is never uploaded.',
            placement: 'bottom',
            pad: 10,
        },
    ];

    let steps = DEFAULT_STEPS;
    let idx = 0;
    let root = null;          // overlay container
    let lastFocus = null;     // to restore focus on close

    const $ = (sel) => document.querySelector(sel);

    function markSeen() {
        try { localStorage.setItem(SEEN_KEY, 'true'); } catch { /* private mode */ }
    }
    function hasSeen() {
        try { return localStorage.getItem(SEEN_KEY) === 'true'; } catch { return false; }
    }

    function buildOverlay() {
        root = document.createElement('div');
        root.className = 'coach-root';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.innerHTML = `
            <div class="coach-spot" aria-hidden="true"></div>
            <div class="coach-pop" role="document">
                <div class="coach-title"></div>
                <div class="coach-body"></div>
                <div class="coach-foot">
                    <div class="coach-dots"></div>
                    <div class="coach-btns">
                        <button type="button" class="coach-skip">Skip</button>
                        <button type="button" class="coach-back">Back</button>
                        <button type="button" class="coach-next">Next</button>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(root);

        root.querySelector('.coach-skip').addEventListener('click', finish);
        root.querySelector('.coach-back').addEventListener('click', () => go(idx - 1));
        root.querySelector('.coach-next').addEventListener('click', () => {
            if (idx >= steps.length - 1) finish(); else go(idx + 1);
        });
        // Clicking the dimmed area (not the popover) advances — a common, forgiving affordance.
        root.addEventListener('click', (e) => { if (e.target === root) go(idx + 1); });

        window.addEventListener('resize', reposition);
        // Capture phase: catch scrolls inside the transcript/waveform, not just the window.
        window.addEventListener('scroll', reposition, true);
        document.addEventListener('keydown', onKey, true);
    }

    function teardown() {
        window.removeEventListener('resize', reposition);
        window.removeEventListener('scroll', reposition, true);
        document.removeEventListener('keydown', onKey, true);
        if (root) root.remove();
        root = null;
    }

    function onKey(e) {
        if (!root) return;
        if (e.key === 'Escape') { e.preventDefault(); finish(); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); (idx >= steps.length - 1) ? finish() : go(idx + 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(idx - 1); }
        else if (e.key === 'Tab') {
            // Trap focus within the popover's buttons.
            const btns = [...root.querySelectorAll('.coach-btns button')].filter(b => b.style.display !== 'none');
            if (!btns.length) return;
            const first = btns[0], last = btns[btns.length - 1];
            if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
    }

    // Find the next step (from `from`) whose target is actually on screen. Steps can point at elements
    // that aren't visible yet (e.g. no selection made) — skip those rather than spotlight nothing.
    function nextVisible(from, dir) {
        for (let i = from; i >= 0 && i < steps.length; i += dir) {
            const el = $(steps[i].sel);
            if (el && el.offsetParent !== null && el.getClientRects().length) return i;
        }
        return -1;
    }

    function go(n) {
        const dir = n >= idx ? 1 : -1;
        const target = nextVisible(Math.max(0, Math.min(n, steps.length - 1)), dir);
        if (target === -1) { finish(); return; }
        idx = target;
        render();
    }

    function render() {
        const step = steps[idx];
        root.querySelector('.coach-title').textContent = step.title;
        root.querySelector('.coach-body').textContent = step.body;

        const dots = steps.map((_, i) => `<span class="coach-dot${i === idx ? ' on' : ''}"></span>`).join('');
        root.querySelector('.coach-dots').innerHTML = dots;

        const back = root.querySelector('.coach-back');
        const next = root.querySelector('.coach-next');
        back.style.display = idx === 0 ? 'none' : '';
        next.textContent = idx >= steps.length - 1 ? 'Done' : 'Next';

        reposition();
        next.focus();
    }

    function reposition() {
        if (!root) return;
        const el = $(steps[idx].sel);
        if (!el) { finish(); return; }
        const pad = steps[idx].pad ?? 6;
        const r = el.getBoundingClientRect();
        const spot = root.querySelector('.coach-spot');
        spot.style.left = (r.left - pad) + 'px';
        spot.style.top = (r.top - pad) + 'px';
        spot.style.width = (r.width + pad * 2) + 'px';
        spot.style.height = (r.height + pad * 2) + 'px';

        // Place the popover above or below the spotlight, whichever has room; clamp horizontally.
        const pop = root.querySelector('.coach-pop');
        const pr = pop.getBoundingClientRect();
        const gap = 12;
        const wantTop = steps[idx].placement === 'top';
        let top = wantTop ? r.top - pr.height - gap : r.bottom + gap;
        if (top < gap) top = r.bottom + gap;                                   // no room above → below
        if (top + pr.height > window.innerHeight - gap) top = r.top - pr.height - gap; // nor below → above
        top = Math.max(gap, Math.min(top, window.innerHeight - pr.height - gap));

        let left = r.left + r.width / 2 - pr.width / 2;
        left = Math.max(gap, Math.min(left, window.innerWidth - pr.width - gap));
        pop.style.top = top + 'px';
        pop.style.left = left + 'px';
    }

    function finish() {
        markSeen();
        teardown();
        if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch { /* gone */ } }
    }

    // Public: start the tour. `customSteps` optional; defaults to the app's four.
    function start(customSteps) {
        if (root) teardown();                  // never stack two tours
        steps = Array.isArray(customSteps) && customSteps.length ? customSteps : DEFAULT_STEPS;
        idx = 0;
        lastFocus = document.activeElement;
        buildOverlay();
        go(0);
    }

    window.startWalkthrough = start;
    window.onboardingHasSeen = hasSeen;
    window.markOnboardingSeen = markSeen;
})();
