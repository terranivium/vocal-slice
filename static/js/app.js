        // Load Transformers.js from a locally-vendored copy (no remote code).
        // Relative to this module: static/js/app.js (dev) and static/build/app.js
        // (prod) both resolve ../vendor/ to static/vendor/.
        const { pipeline, env, WhisperTextStreamer } = await import('../vendor/transformers.web.js');
        
        // Check if running in Electron
        const isElectron = typeof window !== 'undefined' && window.electronAPI;
        
        // Configure transformers.js. Models are served by our own main process over model://,
        // never fetched from Hugging Face — see electron/models.js for why that indirection exists
        // rather than simply repointing env.remoteHost.

        // ── Why CPU transcription freezes the window, and why this line can't fix it ──────────
        // This reads like a one-line toggle and isn't. Flipping it to true does not work here, and
        // the afternoon spent discovering that is the reason for this comment.
        //
        // With proxy off, ONNX Runtime builds and runs its session on the main thread. On the CPU
        // (WASM) backend that means the renderer is blocked for the whole of BOTH the model load and
        // the inference — no repaint, no progress, no cancel. Measured on an M1 with a 24-second
        // clip: ~97s frozen on Medium, and the same defect at 10-20s on Base and Small. The WebGPU
        // path is unaffected, because it dispatches to the GPU and awaits.
        //
        // proxy = true would move that work to a worker, except ORT builds its proxy worker by
        // FETCHING its own script and making a blob URL of it — and this renderer is a file:// page,
        // where fetch() is blocked. It's the same wall that put the models behind model://.
        //
        // Fixing the freeze properly means serving the renderer from a privileged scheme whose
        // handler can send COOP/COEP — the machinery electron/models.js already has — at the cost of
        // changing the page's origin, which orphans localStorage (~15 keys: settings, theme,
        // session, the transcription cache) and so needs a one-shot migration. Nothing else is in
        // web storage any more: there is no IndexedDB, and models are real files on disk. That's the
        // actual price of removing the freeze; the flag above is not.
        env.backends.onnx.wasm.proxy = false;

        // ── Threads, which are NOT gated the way the freeze is ───────────────────────────────
        // An earlier version of this comment said the runtime forces numThreads = 1 unless
        // crossOriginIsolated. That is what the warning *text* says; it is not what the code tests.
        // The real gate is `typeof SharedArrayBuffer !== "undefined"` plus a postMessage(SAB) probe,
        // and Electron can hand us SharedArrayBuffer without cross-origin isolation — see the
        // enable-features switch in electron/main.js. So the origin change buys the freeze fix, and
        // only that; multi-threading was always available for the price of a flag.
        //
        // Measured on this 12-core machine, 24s clip, CPU backend:
        //     threads   1      4      6      12
        //     Base EN   12.07s 6.86s  6.00s  5.85s
        // Half the cores captures nearly all of it — 12 threads bought 2.5% over 6 while taking the
        // whole machine, which for a desktop app that people run alongside other work is a bad
        // trade. Medium sees the same ratio: 176s single-threaded, 60s at six.
        //
        // Transcripts are byte-identical across every thread count tested, so this is a free speedup
        // rather than a precision trade.
        //
        // Setting it at all is not optional. ORT picks its own default only when the value is absent,
        // and that path reads `if (!self.crossOriginIsolated) numThreads = 1` — so leaving it unset
        // pins CPU work to one thread however much SharedArrayBuffer we hand it. The SAB probe
        // governs whether an explicitly set value is honoured, nothing more.
        //
        // Upstream would choose `Math.min(4, Math.ceil(cores / 2))` — the branch ORT takes when it
        // is cross-origin isolated. On the 12-core machine above that is 4 threads, 6.86s, against
        // 6.00s at six: ~13% left on the table. We take the wider cap deliberately, but upstream's is
        // the more conservative number and the one to fall back to if a high-core machine ever shows
        // contention. Both figures are here so that call can be made without re-deriving them.
        //
        // This is one machine's measurements generalised by arithmetic, which is exactly the kind of
        // reasoning that has been wrong before in this file. The resolved value is reported in the
        // diagnostics report so a machine that disagrees can say so.
        env.backends.onnx.wasm.numThreads =
            Math.max(1, Math.min(8, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
        // Serve the ONNX runtime wasm/loader from the local vendor folder instead of
        // a CDN. Use an ABSOLUTE url resolved against the page — a relative wasmPaths
        // is resolved against onnxruntime's own module location (static/vendor/), which
        // would double the path (static/vendor/vendor/...).
        env.backends.onnx.wasm.wasmPaths = new URL('./vendor/', document.baseURI).href;
        // Models come from model://, which the main process backs with our own release assets and
        // an on-disk cache. allowLocalModels was false because a "local" path under a file:// page
        // means a file:// fetch, which Chromium blocks — model:// is a real origin, so that no
        // longer applies. allowRemoteModels stays OFF so there is no path back to a third-party
        // host: if a file is missing from the manifest the load fails loudly here rather than
        // quietly reaching for huggingface.co.
        env.allowRemoteModels = false;
        env.allowLocalModels = true;
        env.localModelPath = 'model://models/';
        // Main caches the files on disk, so a second copy in the browser's Cache API would double
        // the disk cost of every model and re-introduce storage the Storage panel can't measure
        // properly.
        env.useBrowserCache = false;
        
        // Experimental: Try to improve GPU utilization
        if (env.backends.onnx.webgpu) {
            env.backends.onnx.webgpu.executionMode = 'parallel';
        }
        
        // Log backend info
        console.log('Transformers.js environment:', env);
        
        // Global state
        let whisperPipeline = null;
        let currentFile = null;
        let currentAudioBuffer = null; // Float32Array for Whisper transcription
        let originalAudioBuffer = null; // Full AudioBuffer for waveform display and slicing
        let currentTranscription = null;
        // The first-run demo is a view-only preview reconstructed from a bundled clip + baked
        // transcription. While it's showing, nothing is persisted (see saveSessionState), so it never
        // pollutes a returning user's session or creates real slices.
        let demoMode = false;
        let transcriptionCache = {}; // { [audioFilePath]: {text, chunks, continuousText, charToTokenMap, allTokens, savedAt} }
        // Slice-editor state, isolated from the transcription tab's loaded file. Populated in
        // openEditMode, discarded in closeSliceEditor. The shared waveform/preview/slice functions
        // read via the active*() accessors below, which return editState only while the edit
        // modal is open (waveformContext === 'modal') and the globals otherwise.
        let editState = null; // { file, originalBuffer, audioBuffer, transcription }
        let editSelectionSnapshot = null; // main-tab previewState selection, restored on modal close
        let slices = [];
        // Ticked slices, by index into `slices`. Drives "Export selected" and multi-slice drag-out.
        // Deliberately transient (never persisted) and cleared by deleteSlice — that splices the
        // array, which would shift every later index and leave these pointing at the wrong slices.
        const selectedSlices = new Set();
        let sliceDecodeContext = null;
        let webgpuSupported = false;
        
        // Search state
        let searchResults = [];
        let currentSearchIndex = -1;
        let searchActive = false;
        let lastSelectedText = '';
        let selectionAudioMatches = [];
        let selectionAudioIndex = 0;
        let searchHandlersInitialized = false;
        let waveformContext = 'transcription'; // 'transcription' | 'modal'

        // Data accessors mirroring getWaveformEls: in the edit modal, return the editor's own
        // buffers/transcription/file; otherwise the transcription tab's globals. Keeps the shared
        // waveform/preview/slice functions working for both without touching the tab's state.
        const inModal = () => waveformContext === 'modal' && !!editState;
        function activeOriginalBuffer() { return inModal() ? editState.originalBuffer : originalAudioBuffer; }
        function activeAudioBuffer()    { return inModal() ? editState.audioBuffer    : currentAudioBuffer; }
        function activeTranscription()  { return inModal() ? editState.transcription  : currentTranscription; }
        function activeFile()           { return inModal() ? editState.file           : currentFile; }

        function getWaveformEls() {
            const p = waveformContext === 'modal' ? 'edit-' : '';
            return {
                canvas:      document.getElementById(`${p}waveform-canvas`),
                inner:       document.getElementById(`${p}waveform-inner`),
                textLayer:   document.getElementById(`${p}waveform-text-layer`),
                selection:   document.getElementById(`${p}waveform-selection`),
                startHandle: document.getElementById(`${p}waveform-start-handle`),
                endHandle:   document.getElementById(`${p}waveform-end-handle`),
                playhead:    document.getElementById(`${p}waveform-playhead`),
                container:   document.getElementById(`${p}waveform-canvas`)?.closest('.waveform-container'),
                playBtn:     document.getElementById(`${p}preview-play-btn`),
                pauseBtn:    document.getElementById(`${p}preview-pause-btn`),
                loopBtn:     document.getElementById(`${p}preview-loop-btn`),
                startInput:  document.getElementById(`${p}preview-start-time`),
                endInput:    document.getElementById(`${p}preview-end-time`),
                durationEl:  document.getElementById(`${p}preview-duration`),
                speedSelect: document.getElementById(`${p}playback-speed`),
            };
        }

        // Session Persistence using localStorage + file system
        // Save session state to localStorage
        function saveSessionState() {
            // The demo is ephemeral — persisting it would resurrect it as a "restored session" next
            // launch and overwrite whatever the user actually had.
            if (demoMode) return;
            try {
                // Get the actual text from the textarea
                const transcriptionText = document.getElementById('transcription-text').value;
                
                const sessionState = {
                    transcriptionText: transcriptionText,
                    transcription: currentTranscription, // Keep full object for potential re-slicing
                    audioFilePath: currentFile ? currentFile.path : null,
                    fileName: currentFile ? currentFile.name : null,
                    fileSize: currentFile ? currentFile.size : null,
                    slices: slices.map(slice => ({
                        text: slice.text,
                        name: slice.name,
                        startTime: slice.startTime,
                        endTime: slice.endTime,
                        filePath: slice.filePath, // Save file path instead of blob URL
                        start: slice.start,
                        end: slice.end,
                        sourceAudioPath: slice.sourceAudioPath,
                        chunks: slice.chunks || []
                    })),
                    timestamp: Date.now()
                };
                
                console.log('Saving session state:', {
                    audioFilePath: sessionState.audioFilePath,
                    fileName: sessionState.fileName,
                    hasTranscription: !!sessionState.transcriptionText,
                    slicesCount: sessionState.slices.length
                });
                
                localStorage.setItem('vocalslice-session', JSON.stringify(sessionState));
                addLog('💾 Session saved');
            } catch (error) {
                console.error('Failed to save session state:', error);
            }
        }

        // Load session state from localStorage
        function loadSessionState() {
            try {
                const saved = localStorage.getItem('vocalslice-session');
                if (!saved) return null;
                
                return JSON.parse(saved);
            } catch (error) {
                console.error('Failed to load session state:', error);
                return null;
            }
        }

        // --- Per-file transcription cache (so editing an old slice never re-runs Whisper) ---
        // Invariant: holds a transcription for exactly the distinct sourceAudioPaths of
        // the current slices. Populated on slice create/save, pruned on delete/clear.
        const TRANSCRIPTION_CACHE_KEY = 'vocalslice-transcriptions';

        function loadTranscriptionCache() {
            try {
                transcriptionCache = JSON.parse(localStorage.getItem(TRANSCRIPTION_CACHE_KEY)) || {};
            } catch {
                transcriptionCache = {};
            }
        }

        function getCachedTranscription(path) {
            return path ? transcriptionCache[path] : null;
        }

        function cacheTranscription(path, transcription) {
            if (!path || !transcription) return;
            transcriptionCache[path] = {
                text: transcription.text || '',
                chunks: transcription.chunks || [],
                continuousText: transcription.continuousText,
                charToTokenMap: transcription.charToTokenMap,
                allTokens: transcription.allTokens,
                savedAt: Date.now()
            };
            persistTranscriptionCache();
        }

        function persistTranscriptionCache() {
            // Evict oldest entries until it fits under localStorage quota.
            for (;;) {
                try {
                    localStorage.setItem(TRANSCRIPTION_CACHE_KEY, JSON.stringify(transcriptionCache));
                    return;
                } catch (error) {
                    const paths = Object.keys(transcriptionCache);
                    if (paths.length <= 1) {
                        console.warn('Transcription cache: single entry exceeds quota, skipping persist');
                        return;
                    }
                    const oldest = paths.reduce((a, b) =>
                        (transcriptionCache[a].savedAt || 0) <= (transcriptionCache[b].savedAt || 0) ? a : b);
                    delete transcriptionCache[oldest];
                }
            }
        }

        // Drop cache entries not referenced by any current slice (keeps cache == sliced files)
        function gcTranscriptionCache() {
            const referenced = new Set(slices.map(s => s.sourceAudioPath).filter(Boolean));
            let changed = false;
            for (const path of Object.keys(transcriptionCache)) {
                if (!referenced.has(path)) { delete transcriptionCache[path]; changed = true; }
            }
            if (changed) persistTranscriptionCache();
        }

        // Clear session data
        window.clearSession = async function() {
            // Confirm before clearing
            const confirmMessage = 'Clear all session data?\n\nThis will:\n- Remove all slices\n- Clear transcription\n- Reset audio file\n\nThis cannot be undone.';
            if (!confirm(confirmMessage)) {
                return;
            }
            
            try {
                // Delete slice files from disk if in Electron
                if (window.electronAPI && slices.length > 0) {
                    for (const slice of slices) {
                        if (slice.filePath) {
                            await window.electronAPI.deleteSliceFile(slice.filePath);
                        }
                    }
                }
                
                // Clear localStorage
                localStorage.removeItem('vocalslice-session');
                localStorage.removeItem(TRANSCRIPTION_CACHE_KEY);

                // Reset state
                currentFile = null;
                currentAudioBuffer = null;
                originalAudioBuffer = null;
                currentTranscription = null;
                transcriptionCache = {};
                _sourceBytesCache = null;
                slices = [];
                selectedSlices.clear();

                // Reset UI
                document.getElementById('file-info').innerHTML = '<i class="ph ph-folder-open"></i><span>Select audio file</span>';
                document.getElementById('transcribe-btn').disabled = true;
                document.getElementById('create-slice-btn').disabled = true;
                document.getElementById('transcription-text').value = '';
                document.getElementById('transcription-content').style.display = 'none';
                document.getElementById('transcription-empty').style.display = 'block';
                document.getElementById('slices-list').innerHTML = '';
                document.getElementById('slices-empty').style.display = 'block';
                document.getElementById('slices-toolbar').style.display = 'none';

                addLog('🗑️ Session cleared');
            } catch (error) {
                console.error('Failed to clear session:', error);
            }
        };

        // Restore previous session
        async function restoreSession() {
            loadTranscriptionCache();
            const sessionState = loadSessionState();
            if (!sessionState) {
                console.log('No session to restore');
                return false;
            }
            
            try {
                console.log('Restoring session:', {
                    audioFilePath: sessionState.audioFilePath,
                    fileName: sessionState.fileName,
                    hasTranscription: !!sessionState.transcriptionText,
                    slicesCount: sessionState.slices?.length || 0
                });
                
                addLog('🔄 Restoring previous session...');
                
                // Check if running in Electron
                if (!window.electronAPI) {
                    addLog('⚠️ Session restore only available in Electron app');
                    return false;
                }

                const hasTranscription = !!(sessionState.transcriptionText || sessionState.transcription);

                // Restore transcription text FIRST so it appears instantly (it doesn't need the
                // audio — the audio decode below is what used to make the text wait 1-2s).
                if (hasTranscription) {
                    if (sessionState.transcription) {
                        currentTranscription = sessionState.transcription;
                        // Seed the per-file cache so this file's slices can be edited without re-transcribing
                        cacheTranscription(sessionState.audioFilePath, currentTranscription);
                    }
                    const textToDisplay = sessionState.transcriptionText || sessionState.transcription?.text || '';
                    document.getElementById('transcription-text').value = textToDisplay;
                    document.getElementById('transcription-content').style.display = 'flex';
                    document.getElementById('transcription-empty').style.display = 'none';
                    setupSearchHandlers();
                    addLog('✅ Transcription restored');
                }

                // Restore audio file from path (slow: decode + resample) — behind a loading
                // placeholder on the waveform area so the text isn't blocked.
                if (sessionState.audioFilePath) {
                    const exists = await window.electronAPI.checkFileExists(sessionState.audioFilePath);
                    const wfSection = document.getElementById('transcription-waveform-section');
                    if (exists) {
                        // Create a File-like object from the path
                        currentFile = {
                            name: sessionState.fileName,
                            size: sessionState.fileSize,
                            path: sessionState.audioFilePath
                        };

                        const fileSizeMB = (sessionState.fileSize / (1024 * 1024)).toFixed(1);
                        document.getElementById('file-info').innerHTML = `<i class="ph ph-file-audio"></i><span>${sessionState.fileName} (${fileSizeMB} MB)</span>`;
                        document.getElementById('transcribe-btn').disabled = false;

                        // Show the waveform area with a loading spinner while the audio decodes.
                        if (hasTranscription && wfSection) {
                            wfSection.classList.add('wf-loading');
                            wfSection.style.display = 'block';
                        }

                        // Load the audio file into memory for slicing
                        try {
                            addLog(`🔄 Loading audio file: ${sessionState.fileName}`);
                            const loaded = await loadAudioFile(currentFile);
                            originalAudioBuffer = loaded.audioBuffer;
                            currentAudioBuffer = loaded.audioData;
                            // Align on restore too (idempotent via _rawTimestamp), so a session saved
                            // before this feature — or re-restored — gets the same onset-snapped starts.
                            if (currentTranscription)
                                alignChunksToOnsets(currentTranscription.chunks || currentTranscription.allTokens, currentAudioBuffer, 16000);
                            addLog(`✅ Audio file loaded and ready for slicing`);
                        } catch (error) {
                            addLog(`⚠️ Failed to load audio: ${error.message}`);
                            console.error('Failed to load audio file:', error);
                        }

                        // Reveal the waveform (or hide the section if the audio failed to load).
                        if (wfSection) wfSection.classList.remove('wf-loading');
                        if (originalAudioBuffer && hasTranscription) {
                            if (wfSection) wfSection.style.display = 'block';
                            selectFirstPhrase();
                        } else if (wfSection) {
                            wfSection.style.display = 'none';
                        }
                    } else {
                        addLog(`⚠️ Audio file not found: ${sessionState.audioFilePath}`);
                        document.getElementById('file-info').innerHTML = `<i class="ph ph-file"></i><span>${sessionState.fileName} (file not found)</span>`;
                    }
                }

                // Restore slices
                if (sessionState.slices && sessionState.slices.length > 0) {
                    const slicesList = document.getElementById('slices-list');
                    slicesList.innerHTML = '';
                    slices = [];
                    
                    for (const savedSlice of sessionState.slices) {
                        // Check if slice file still exists
                        if (savedSlice.filePath) {
                            const exists = await window.electronAPI.checkFileExists(savedSlice.filePath);
                            if (exists) {
                                // Create blob URL from file path
                                const arrayBuffer = await window.electronAPI.readAudioFile(savedSlice.filePath);
                                const blob = new Blob([arrayBuffer], { type: 'audio/wav' });
                                const url = URL.createObjectURL(blob);
                                
                                const slice = {
                                    text: savedSlice.text,
                                    name: savedSlice.name || slugify(savedSlice.text),
                                    startTime: savedSlice.startTime,
                                    endTime: savedSlice.endTime,
                                    start: savedSlice.start,
                                    end: savedSlice.end,
                                    url: url,
                                    blob: blob,
                                    filePath: savedSlice.filePath,
                                    sourceAudioPath: savedSlice.sourceAudioPath || null,
                                    chunks: savedSlice.chunks || []
                                };
                                
                                slices.push(slice);
                                
                                const sliceDiv = document.createElement('div');
                                sliceDiv.className = 'slice-item';
                                const sliceName = `${slice.text} (Slice ${slices.length})`;
                                sliceDiv.innerHTML = `
                                    <div class="slice-name">${sliceName.substring(0, 50)}${sliceName.length > 50 ? '...' : ''}</div>
                                    <div class="slice-time">${slice.start.toFixed(2)}s - ${slice.end.toFixed(2)}s (${(slice.end - slice.start).toFixed(2)}s)</div>
                                    <audio controls src="${url}"></audio>
                                `;
                                
                                // Add export icon
                                const exportBtn = document.createElement('a');
                                exportBtn.href = url;
                                exportBtn.download = `slice-${slices.length}.wav`;
                                exportBtn.className = 'slice-export-icon';
                                exportBtn.innerHTML = '<i class="ph ph-download-simple"></i>';
                                exportBtn.title = 'Export slice';
                                sliceDiv.appendChild(exportBtn);
                                
                                // Add edit button
                                const editBtn = document.createElement('button');
                                editBtn.className = 'slice-edit-btn';
                                editBtn.innerHTML = '<i class="ph ph-pencil-simple"></i>';
                                const currentIndex = slices.length - 1;
                                
                                // Editable if the slice knows its source audio (loaded on demand in
                                // openEditMode, no re-transcribe) or audio is already loaded (legacy slices).
                                const canEdit = !!(slice.sourceAudioPath || originalAudioBuffer);
                                if (canEdit) {
                                    editBtn.title = 'Edit slice boundaries';
                                    editBtn.onclick = () => openEditMode(currentIndex);
                                } else {
                                    editBtn.title = 'Load an audio file first';
                                    editBtn.style.opacity = '0.3';
                                    editBtn.style.cursor = 'pointer';
                                    editBtn.onclick = () => alert('Cannot edit this slice.\n\nLoad an audio file first.');
                                }
                                sliceDiv.appendChild(editBtn);
                                
                                // Add delete button
                                const deleteBtn = document.createElement('button');
                                deleteBtn.className = 'slice-delete-btn';
                                deleteBtn.innerHTML = '<i class="ph ph-trash"></i>';
                                deleteBtn.title = 'Delete slice';
                                deleteBtn.onclick = () => deleteSlice(currentIndex);
                                sliceDiv.appendChild(deleteBtn);
                                
                                slicesList.appendChild(sliceDiv);
                            }
                        }
                    }
                    
                    if (slices.length > 0) {
                        document.getElementById('slices-empty').style.display = 'none';
                        addLog(`✅ Restored ${slices.length} slice(s)`);
                        
                        // Refresh the slices list to recalculate edit button states
                        // This ensures edit buttons are properly enabled/disabled based on current file
                        updateSlicesList();
                    }
                }

                // Reconcile the transcription cache to the restored slice set (drops the
                // seeded current-file entry if no restored slice references it).
                gcTranscriptionCache();

                const age = Math.round((Date.now() - sessionState.timestamp) / 1000 / 60);
                addLog(`✅ Session restored (${age} minutes old)`);
                return true;
            } catch (error) {
                console.error('Failed to restore session:', error);
                addLog(`❌ Session restore failed: ${error.message}`);
                return false;
            }
        }
        
        // ── First-run demo ────────────────────────────────────────────────────────────────────────
        // Reconstructs a fully-interactive transcription from a bundled public-domain clip and its
        // pre-baked transcription, WITHOUT running Whisper — so the select-text→waveform payoff is
        // immediate, not gated on a model download. This mirrors restoreSession's audio branch; the
        // difference is the source (bundled files) and that it never persists (demoMode).
        const DEMO_CLIP = 'onboarding/demo.wav';
        const DEMO_JSON = 'onboarding/demo.json';
        const DEMO_LABEL = 'Demo — Celtic Tales (LibriVox, public domain)';

        window.loadDemo = async function loadDemo() {
            try {
                addLog('▶️ Loading demo…');
                const [clipBuf, transcription] = await Promise.all([
                    fetch(DEMO_CLIP).then(r => { if (!r.ok) throw new Error(`demo clip ${r.status}`); return r.arrayBuffer(); }),
                    fetch(DEMO_JSON).then(r => { if (!r.ok) throw new Error(`demo json ${r.status}`); return r.json(); }),
                ]);

                // A File-like the existing decoder accepts (it calls file.arrayBuffer()).
                const demoFile = { name: DEMO_LABEL, size: clipBuf.byteLength, arrayBuffer: async () => clipBuf };
                const loaded = await loadAudioFile(demoFile);

                demoMode = true;
                currentFile = demoFile;
                originalAudioBuffer = loaded.audioBuffer;
                currentAudioBuffer = loaded.audioData;
                currentTranscription = transcription;
                // demo.json ships raw Whisper timestamps; align them to the clip's onsets on load.
                alignChunksToOnsets(currentTranscription.chunks || currentTranscription.allTokens, currentAudioBuffer, 16000);

                document.getElementById('transcription-text').value =
                    transcription.text || transcription.continuousText || '';
                document.getElementById('file-info').innerHTML =
                    `<i class="ph ph-sparkle"></i><span>${DEMO_LABEL}</span>`;
                document.getElementById('transcribe-btn').disabled = true; // demo is already transcribed

                document.getElementById('transcription-empty').style.display = 'none';
                document.getElementById('transcription-content').style.display = 'flex';
                document.getElementById('transcription-waveform-section').style.display = 'block';

                setupSearchHandlers();
                selectFirstPhrase();
                addLog('✅ Demo ready — select any words to see the waveform follow');
                return true;
            } catch (error) {
                console.error('Failed to load demo:', error);
                addLog(`⚠️ Demo unavailable: ${error.message}`);
                demoMode = false;
                return false;
            }
        };

        // Leave the demo and return to the clean empty state, touching no persisted data.
        function exitDemo() {
            demoMode = false;
            currentFile = null;
            currentAudioBuffer = null;
            originalAudioBuffer = null;
            currentTranscription = null;
            document.getElementById('transcription-text').value = '';
            document.getElementById('transcription-content').style.display = 'none';
            document.getElementById('transcription-waveform-section').style.display = 'none';
            document.getElementById('transcription-empty').style.display = 'block';
            document.getElementById('file-info').innerHTML =
                '<i class="ph ph-folder-open"></i><span>Select audio file</span>';
            document.getElementById('transcribe-btn').disabled = true;
        }
        window.exitDemo = exitDemo;

        // Replay entry point (Settings button): load the demo, then run the tour, regardless of the
        // first-run flag.
        window.startDemoWalkthrough = async function() {
            switchTab('transcription');
            const ok = await window.loadDemo();
            if (ok && window.startWalkthrough) {
                // let the waveform paint before we measure elements for the spotlight
                setTimeout(() => window.startWalkthrough(), 350);
            }
        };

        // Check WebGPU support with detailed device information
        async function checkWebGPUSupport() {
            try {
                // Check if WebGPU is available
                if (!navigator.gpu) {
                    addLog('❌ WebGPU not supported in this browser');
                    updateWebGPUStatus('WebGPU not supported', 'error');
                    addLog('Please use Chrome 113+, Edge 113+, Firefox 145+, or Safari 26.0+');
                    return false;
                }
                
                // Request adapter with preference for high-performance GPU
                const adapter = await navigator.gpu.requestAdapter({
                    powerPreference: 'high-performance'
                });
                
                if (!adapter) {
                    addLog('❌ No WebGPU adapter available');
                    updateWebGPUStatus('No GPU adapter found', 'error');
                    addLog('Your GPU may not support WebGPU or drivers need updating');
                    return false;
                }
                
                // Try to get detailed adapter info (newer API, may not be available)
                let gpuName = 'Unknown GPU';
                let gpuArchitecture = '';
                let gpuVendor = '';
                let gpuDetails = [];
                
                try {
                    // Try the newer requestAdapterInfo() method
                    if (typeof adapter.requestAdapterInfo === 'function') {
                        const adapterInfo = await adapter.requestAdapterInfo();
                        
                        if (adapterInfo.device) {
                            gpuName = adapterInfo.device;
                        } else if (adapterInfo.description) {
                            gpuName = adapterInfo.description;
                        } else if (adapterInfo.architecture) {
                            gpuArchitecture = adapterInfo.architecture;
                        }
                        
                        if (adapterInfo.vendor) {
                            gpuVendor = adapterInfo.vendor;
                            gpuDetails.push(`Vendor: ${adapterInfo.vendor}`);
                        }
                    }
                    // Fallback to older .info property
                    else if (adapter.info) {
                        gpuName = adapter.info.device || adapter.info.description || gpuName;
                        if (adapter.info.architecture) {
                            gpuArchitecture = adapter.info.architecture;
                        }
                        if (adapter.info.vendor) {
                            gpuVendor = adapter.info.vendor;
                            gpuDetails.push(`Vendor: ${adapter.info.vendor}`);
                        }
                    }
                } catch (infoError) {
                    // Silently fail if we can't get detailed info
                    addLog('⚠️ Could not retrieve detailed GPU info (browser limitation)');
                }
                
                // Build a user-friendly name for the badge
                let displayName = gpuName;
                
                // If we only have architecture, try to make it more descriptive
                if (gpuName === 'Unknown GPU' && gpuArchitecture) {
                    if (gpuVendor) {
                        // e.g., "NVIDIA GPU (Ampere)" or "AMD GPU (RDNA2)"
                        displayName = `${gpuVendor.toUpperCase()} GPU (${gpuArchitecture})`;
                    } else {
                        displayName = `GPU (${gpuArchitecture})`;
                    }
                } else if (gpuName === 'Unknown GPU' && gpuVendor) {
                    // Just show vendor if we have it
                    displayName = `${gpuVendor.toUpperCase()} GPU`;
                }
                
                // For logging, show architecture separately if we have it
                if (gpuArchitecture) {
                    gpuDetails.push(`Architecture: ${gpuArchitecture}`);
                }
                
                // Detect backend based on platform
                const platform = navigator.platform.toLowerCase();
                const userAgent = navigator.userAgent.toLowerCase();
                const isMac = platform.includes('mac') || userAgent.includes('mac');
                const isWindows = platform.includes('win') || userAgent.includes('win');
                const isLinux = platform.includes('linux') || userAgent.includes('linux');
                
                let backend = '';
                if (isMac) {
                    backend = 'Metal';
                    if (gpuName === 'Unknown GPU') {
                        gpuName = 'Apple GPU';
                    }
                } else if (isWindows) {
                    backend = 'Direct3D 12';
                } else if (isLinux) {
                    backend = 'Vulkan';
                } else {
                    backend = 'Unknown';
                }
                
                gpuDetails.push(`Backend: ${backend}`);
                
                // Request device to test capability
                const device = await adapter.requestDevice({
                    requiredLimits: {
                        maxBufferSize: Math.min(adapter.limits.maxBufferSize, 2147483648), // 2GB max
                        maxStorageBufferBindingSize: Math.min(adapter.limits.maxStorageBufferBindingSize, 1073741824), // 1GB max
                    }
                });
                
                // Get memory info if available
                if (adapter.limits.maxBufferSize) {
                    const maxMemoryGB = (adapter.limits.maxBufferSize / (1024 ** 3)).toFixed(2);
                    gpuDetails.push(`Max Buffer: ${maxMemoryGB}GB`);
                }
                
                // Log detailed info
                addLog(`✅ WebGPU ready: ${displayName}`);
                gpuDetails.forEach(detail => addLog(`   ${detail}`));
                
                // Show feature support if available
                if (adapter.features && adapter.features.size > 0) {
                    const features = Array.from(adapter.features);
                    const featureList = features.slice(0, 3).join(', ') + (features.length > 3 ? '...' : '');
                    addLog(`   Features: ${featureList}`);
                }
                
                // Update badge with user-friendly name (shorten if too long)
                const shortName = displayName.length > 35 ? displayName.substring(0, 32) + '...' : displayName;
                updateWebGPUStatus(shortName, 'success');
                
                // Clean up device
                device.destroy();
                
                webgpuSupported = true;
                applyModelSizes();   // the picker's sizes differ by backend — see below
                return true;

            } catch (error) {
                addLog('❌ WebGPU initialization error: ' + error.message);
                
                // Provide helpful error messages
                if (error.message.includes('out of memory')) {
                    updateWebGPUStatus('GPU out of memory', 'error');
                    addLog('Try closing other GPU-intensive applications');
                } else if (error.message.includes('not supported')) {
                    updateWebGPUStatus('WebGPU not supported', 'error');
                    addLog('Your GPU or browser version may not support WebGPU');
                } else {
                    updateWebGPUStatus('WebGPU error', 'error');
                }
                
                return false;
            }
        }
        
        function updateWebGPUStatus(text, type) {
            const statusLight = document.getElementById('gpu-status-light');
            statusLight.title = text;
            statusLight.className = 'ph-fill ph-circle gpu-dot ' + (type || '');
        }
        
        // The smallest model, offered on every backend, and so what the picker falls back to when a
        // saved choice turns out to be unrunnable here.
        const DEFAULT_MODEL = 'onnx-community/whisper-tiny.en_timestamped';

        // Above this, initWhisper asks before downloading. Set so the models that were here before
        // Medium never prompt (Small is the largest at 928MB on CPU) and Medium always does.
        const CONFIRM_DOWNLOAD_BYTES = 1e9;

        // Only for the browser build, which has no main process and so no manifest to read dtypes
        // from. In Electron these come from the catalogue — see initWhisper.
        const FALLBACK_DTYPE = {
            webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
            wasm: { encoder_model: 'fp32', decoder_model_merged: 'fp32' },
        };

        // Last known model catalogue from the main process, keyed by the bare manifest id (the
        // picker's values carry an `onnx-community/` prefix the manifest doesn't). The transcribe
        // path reads this rather than making its own IPC call.
        let modelCatalog = new Map();

        function catalogEntry(pickerValue) {
            return modelCatalog.get(pickerValue.split('/').pop());
        }

        // Whether a model can run on a backend. Unknown models (browser build, or a catalogue that
        // failed to load) are treated as runnable — the old behaviour, and refusing to run anything
        // at all would be worse than letting the load fail with a real error.
        function modelRunsOn(pickerValue, device) {
            const devices = catalogEntry(pickerValue)?.devices;
            return !devices || devices.includes(device);
        }

        // The picker's sizes are rewritten from real figures rather than the hardcoded guesses that
        // used to be in the markup — those said "~75MB" for a model that costs 118 MB, and "~500MB"
        // for one that costs 563 MB on a GPU and 928 MB without one. The gap between devices is real:
        // the encoder and tokeniser are shared, but the decoder ships in two precisions and a machine
        // fetches exactly one, q4 on WebGPU and fp32 on CPU (see initWhisper's dtype map below).
        //
        // Two different numbers, depending on what the user actually needs to know:
        //   already downloaded → its true size on disk, and no "download" wording, because picking it
        //                        costs nothing
        //   not downloaded     → what fetching it will cost on THIS machine's backend
        //
        // Called at startup and again once WebGPU detection finishes, and after any download or
        // deletion, so a model that has just arrived stops advertising itself as a download.
        //
        // It also decides which models this machine can run at all: a model is offered on exactly
        // the backends its weights map names (see MODELS in build-scripts/mirror-models.js), and the
        // rest are disabled rather than offered — the alternative is a multi-gigabyte download that
        // then fails to load. No model ships single-backend today; Medium takes a q4 decoder on CPU
        // precisely so it doesn't have to.
        async function applyModelSizes() {
            if (!window.electronAPI?.listModels) return;   // browser build — labels stay as authored
            let models;
            try {
                models = await window.electronAPI.listModels();
            } catch { return; }

            const device = webgpuSupported ? 'webgpu' : 'wasm';
            modelCatalog = new Map(models.map(m => [m.id, m]));

            for (const opt of document.querySelectorAll('#model-select option')) {
                const model = modelCatalog.get(opt.value.split('/').pop());
                // The authored text is the source for every rewrite, not the previous rewrite's
                // output — the label has three shapes now (a size, or one of two reasons it's
                // unavailable) and patching one into another in place doesn't round-trip.
                if (opt.dataset.baseLabel === undefined) opt.dataset.baseLabel = opt.textContent;

                let label;
                if (!model) {
                    // In the option list but not in the manifest, which means the weights were never
                    // mirrored for this build. Only reachable if the two got out of step — the fix is
                    // to run `npm run models:mirror` and commit static/models.json — but offering it
                    // anyway would 404 at the first byte, so it's shown as unavailable instead.
                    label = 'unavailable';
                    opt.disabled = true;
                } else if (!model.devices.includes(device)) {
                    // Not a size: there is nothing to download here that would help.
                    label = 'needs GPU';
                    opt.disabled = true;
                } else {
                    // ready[device] means the weights this backend needs are already on disk, so
                    // choosing it costs nothing — show what it occupies. Otherwise show what it will
                    // cost to fetch. A model downloaded for the other backend correctly still reads
                    // as a download, because its decoder would have to come down.
                    label = model.ready?.[device]
                        ? formatBytes(model.bytes)
                        : `${formatBytes(model.download?.[device])} download`;
                    opt.disabled = false;
                }
                // Only the parenthesised part changes; the name and the "- Fastest, English Only"
                // tail are authored copy and stay exactly as written.
                opt.textContent = opt.dataset.baseLabel.replace(/\([^)]*\)/, `(${label})`);
            }

            // A saved choice can become unrunnable between sessions — a GPU-only model picked on a
            // machine whose WebGPU has since stopped working, or a settings file carried to another
            // machine. This runs after WebGPU detection resolves, which is the moment that becomes
            // knowable. Left alone, the next transcription would request a decoder the manifest
            // doesn't list and fail with a bare 404.
            const select = document.getElementById('model-select');
            if (select.selectedOptions[0]?.disabled) {
                const dropped = modelDisplayName(select.value);
                const reason = catalogEntry(select.value) ? 'needs a GPU and this machine has none' : 'is not available in this build';
                // Tiny EN unless something has gone badly wrong with the manifest, in which case
                // take whatever is left rather than landing on another disabled option.
                const options = [...select.querySelectorAll('option')];
                const fallback = options.find(o => o.value === DEFAULT_MODEL && !o.disabled) || options.find(o => !o.disabled);
                if (!fallback) return;   // nothing runnable at all; the picker's own labels say why

                select.value = fallback.value;
                saveProcessingSettings();
                // Optional: this can run before the language combobox has finished wiring itself
                // up, in which case its own init pass will derive the right state anyway.
                window.updateLanguageSelector?.();
                whisperPipeline = null;
                addLog(`⚠️ ${dropped} ${reason} — switched to ${modelDisplayName(fallback.value)}`);
            }
        }

        // Whether this run will be done by the CPU backend — either chosen in Settings, or fallen
        // back to because WebGPU isn't available here. ORT does that work on the main thread (see
        // the proxy note at the top of this file), so the window stops responding for the whole of
        // it. The messages below say so; an app that freezes without warning reads as a crash.
        function runsOnCpu() {
            return !webgpuSupported || document.getElementById('device-select').value === 'wasm';
        }

        const CPU_FREEZE_NOTE = "the window won't respond until it's finished";

        // A yield that actually lets the browser paint before the caller blocks the thread.
        // `setTimeout(0)` is not enough and was measured failing here: it queues behind the current
        // task, so the frame can still be committed *after* the blocking call has begun — on Medium
        // the window kept showing the previous screen for the whole run. Two nested rAFs land after
        // a real commit. The timeout is the fallback for a hidden or minimised window, where rAF
        // never fires and would otherwise hang the transcription outright.
        function paintFrame() {
            return new Promise((resolve) => {
                let settled = false;
                const finish = () => { if (!settled) { settled = true; resolve(); } };
                requestAnimationFrame(() => requestAnimationFrame(finish));
                setTimeout(finish, 200);
            });
        }

        // Initialize Whisper model
        async function initWhisper(modelName, deviceType) {
            if (whisperPipeline) {
                addLog('Model already loaded');
                return whisperPipeline;
            }
            
            try {
                addLog('Loading model: ' + modelName);
                showDownloadProgress(true);
                
                // Use the specified device type (from dropdown or fallback)
                if (deviceType === 'webgpu' && !webgpuSupported) {
                    // Not every model survives the downgrade. A WebGPU-only model would ask for
                    // a CPU decoder that isn't in the manifest and 404 — so say so here instead of
                    // failing three layers down. Nothing shipped is in that position today: Medium
                    // is mirrored with a q4 decoder for CPU as well, which is what keeps it runnable
                    // there at all (fp32 wouldn't fit the WASM heap).
                    if (!modelRunsOn(modelName, 'wasm')) {
                        throw new Error(
                            `${modelDisplayName(modelName)} needs a GPU (WebGPU), which isn't available on this machine. ` +
                            `Choose a smaller model in Settings → Transcription.`);
                    }
                    addLog('⚠️ WebGPU not available, falling back to CPU (WASM)');
                    deviceType = 'wasm';
                }

                addLog(`Using device: ${deviceType.toUpperCase()}`);
                
                // Which precision to load each component at, taken from the manifest so it cannot
                // disagree with what electron/models.js costed and downloaded. FALLBACK_DTYPE covers
                // the browser build, where there is no main process and so no catalogue.
                //
                // An fp32 encoder everywhere, and a decoder that is q4 on WebGPU and — for every
                // model but Medium — fp32 on CPU. That fp32 is a deliberate choice, NOT a
                // requirement: transformers.js itself defaults WASM to q8, and q4 loads and runs on
                // the WASM backend perfectly well. It's measured — on base.en a q4 decoder on CPU is
                // ~47% slower (17.84s vs 12.10s of inference on the same clip), because
                // dequantisation cost dominates there, the reverse of the GPU case.
                //
                // Medium overrides this to q4 on CPU because fp32 cannot load at all: ORT Web's
                // wasm32 heap caps at 4GiB and the 1.70GiB decoder allocation fails outright with
                // the encoder already resident. See MEDIUM_WEIGHTS in build-scripts/mirror-models.js.
                const dtype = catalogEntry(modelName)?.dtypes?.[deviceType]
                    || FALLBACK_DTYPE[deviceType];

                const pipelineConfig = {
                    device: deviceType,
                    dtype,
                    progress_callback: (progress) => {
                        if (progress.status === 'progress') {
                            const percent = Math.round((progress.loaded / progress.total) * 100);
                            // In Electron this only reports transformers.js READING an already-
                            // downloaded local file — main does the real fetching and reports it via
                            // model-progress. Writing here too would flicker raw ONNX filenames over
                            // the aggregate message. In a browser context there is no model://
                            // and no main process, so this callback is the only progress there is.
                            if (!window.electronAPI) {
                                updateDownloadProgress(percent, `Downloading ${progress.file}… ${percent}%`);
                            }
                            addLog(`Downloading ${progress.file}: ${percent}%`);
                        } else if (progress.status === 'done') {
                            addLog(`✓ Downloaded ${progress.file}`);
                        }
                    }
                };

                // Ask before committing to a download measured in gigabytes. The picker's label
                // already says the size, but it's easy to change a setting and not connect it to
                // what happens on the next transcription — and Medium is more than ten times the
                // download of the model most people arrive on.
                const entry = catalogEntry(modelName);
                const pending = entry && !entry.ready?.[deviceType] ? entry.download?.[deviceType] : 0;
                if (pending > CONFIRM_DOWNLOAD_BYTES) {
                    const ok = confirm(
                        `${modelDisplayName(modelName)} needs a ${formatBytes(pending)} download before it can transcribe.\n\n` +
                        `It's kept on this machine afterwards, so this happens once. Download now?`);
                    if (!ok) {
                        showDownloadProgress(false);
                        addLog(`Download of ${modelDisplayName(modelName)} declined`);
                        // Tagged like the audio-file cases below, so the transcribe path can tell
                        // this apart from a real failure: answering "no" to a question isn't an
                        // error and shouldn't come back as an alert saying transcription failed.
                        const cancelled = new Error('Model download cancelled');
                        cancelled.code = 'download-declined';
                        throw cancelled;
                    }
                }

                await beginModelDownload(modelName, deviceType);
                whisperPipeline = await pipeline('automatic-speech-recognition', modelName, pipelineConfig);
                endModelDownload();
                
                showDownloadProgress(false);
                // Report the precisions actually loaded, not a guess from the device. This used to be
                // hardcoded per device and so reported "fp32 (full precision)" during a q4 run —
                // which nearly invalidated the measurements that decided Medium's CPU config.
                const dtypeInfo = `${dtype.encoder_model} encoder + ${dtype.decoder_model_merged} decoder`;
                addLog(`✅ Model loaded (${dtypeInfo} on ${deviceType.toUpperCase()})`);
                addLog(`✅ Word-level timestamps enabled`);

                // A model may have just been downloaded; keep the Storage panel and the picker's
                // size labels honest — the one just loaded should stop reading as a download.
                refreshModelStorage();
                applyModelSizes();

                return whisperPipeline;
            } catch (error) {
                showDownloadProgress(false);
                addLog('❌ Failed to load model: ' + error.message);
                throw error;
            }
        }
        
        // Windows taskbar button / macOS dock icon progress, mirroring the loading card so a long
        // run stays readable with the window minimised. No-op in the browser build.
        const TASKBAR_BUSY = 2;    // Electron: >1 is indeterminate
        const TASKBAR_CLEAR = -1;  // Electron: <0 removes the bar
        let _taskbarLast = null;

        function setTaskbarProgress(value) {
            if (!window.electronAPI || !window.electronAPI.setProgress) return;
            // The model-download callback fires far more often than the shell can usefully
            // redraw, so only send whole-percent changes.
            const v = (value < 0 || value > 1) ? value : Math.round(value * 100) / 100;
            if (v === _taskbarLast) return;
            _taskbarLast = v;
            window.electronAPI.setProgress(v);
        }

        // The download + processing progress now drive the unified loading card
        // (spinner + status text + slim bar) instead of separate header bars.
        function showDownloadProgress(show) {
            document.getElementById('loading-progress').style.display = show ? 'block' : 'none';
        }

        // Model downloads happen in the main process now (electron/models.js), so transformers.js's
        // own progress_callback never sees them — from the renderer's side a model file is one
        // request that blocks until main has fetched and verified it. Without this listener a
        // first-run download of a large model would look like a hang.
        // ── Aggregate download progress ─────────────────────────────────────
        // A model is ~6 files, fetched one at a time. Reporting each file's own percentage meant the
        // bar swept 0→100 six times for a single model, which tells the user nothing about how much
        // is actually left. These three variables turn that into one bar across the whole model.
        //
        // The denominator is the model's expected total for THIS device — the encoder and one of the
        // two decoders, per initWhisper's dtype map — read from the manifest via listModels(). Bytes
        // already on disk count towards the numerator, so a partly-downloaded model starts the bar
        // high rather than at zero, which is the honest picture of what's left to do.
        // The card deliberately does NOT name the model. "Whisper Base EN" is three pieces of jargon
        // in a row — a model family, a size tier, a language code — and this is the screen a
        // first-time user stares at longest. Which model is loading adds nothing at that moment;
        // they chose it themselves, and the picker and Storage panel still name it in full.
        let _dlTotal = 0;       // expected bytes for this model on this device
        let _dlOnDisk = 0;      // bytes already present when this run started
        const _dlLoaded = new Map();   // file → bytes fetched during this run

        async function beginModelDownload(modelId, deviceType) {
            _dlTotal = 0;
            _dlOnDisk = 0;
            _dlLoaded.clear();
            if (!window.electronAPI?.listModels) return;
            try {
                const id = String(modelId).split('/').pop();
                const model = (await window.electronAPI.listModels()).find(m => m.id === id);
                if (!model) return;
                _dlTotal = model.download?.[deviceType === 'webgpu' ? 'webgpu' : 'wasm'] || 0;
                _dlOnDisk = model.bytes || 0;
            } catch { /* no manifest / IPC failed — the per-file percentage still works */ }
        }

        function endModelDownload() {
            _dlLoaded.clear();
            _dlTotal = 0;
        }

        function overallDownloadPercent() {
            if (!_dlTotal) return null;
            let fetched = 0;
            for (const n of _dlLoaded.values()) fetched += n;
            // Clamped because the denominator counts every sidecar in the manifest while
            // transformers.js only requests the ones it needs — the sum can legitimately fall short,
            // and on a re-fetch of an already-counted file it can run over.
            return Math.max(0, Math.min(100, Math.round(((_dlOnDisk + fetched) / _dlTotal) * 100)));
        }

        if (window.electronAPI?.onModelProgress) {
            window.electronAPI.onModelProgress((p) => {
                const name = String(p.file || '').split('/').pop();
                if (p.done) {
                    // Name the source only when it wasn't ours, so the log records a fallback
                    // having happened without narrating the normal case every time.
                    addLog(p.source && p.source !== 'vocalslice'
                        ? `✓ Downloaded ${name} (from ${p.source})`
                        : `✓ Downloaded ${name}`);
                }
                _dlLoaded.set(p.file, p.loaded || 0);

                const overall = overallDownloadPercent();
                showDownloadProgress(true);
                // Filenames stay in the Log tab, where they belong — never on the card.

                if (p.verifying) {
                    updateDownloadProgress(overall ?? p.percent, 'Checking the download…');
                    return;
                }
                // Once the bytes are in, the pipeline still has to build the model — on WebGPU that
                // compiles shaders and takes a second or two with no events to report. Say so, and
                // drop the percentage rather than freezing on a number: the denominator counts every
                // sidecar in the manifest and transformers.js fetches only some, so this last stretch
                // would otherwise sit at "99%" and look stuck. "Downloading" would also be wrong by
                // then — the downloading is finished.
                //
                // On CPU that build is where the window locks up — tens of seconds for a large
                // model — and it's the last message painted before it does, so it carries the
                // warning. This overwrites the one set before initWhisper, which the download
                // messages have long since replaced by now.
                const settling = p.done && overall !== null && overall >= 98;
                const preparing = runsOnCpu()
                    ? `Preparing the model — ${CPU_FREEZE_NOTE}…`
                    : 'Preparing the model…';
                updateDownloadProgress(
                    settling ? 100 : (overall ?? p.percent),
                    settling ? preparing
                        : `Downloading transcription model… ${overall ?? p.percent}%`);
            });
        }

        function updateDownloadProgress(percent, text) {
            document.getElementById('loading-progress-fill').style.width = percent + '%';
            document.getElementById('transcription-loading-text').textContent = text;
            // The download percentage is per model shard and restarts at 0 for each one, so it
            // isn't a percentage of the job — showing it outside would sweep the taskbar bar
            // 0→100 several times before transcription even starts.
            setTaskbarProgress(TASKBAR_BUSY);
        }

        function showProcessingProgress(show) {
            document.getElementById('loading-progress').style.display = show ? 'block' : 'none';
        }

        function updateProcessingProgress(percent, text) {
            document.getElementById('loading-progress-fill').style.width = percent + '%';
            document.getElementById('transcription-loading-text').textContent = text;
            setTaskbarProgress(percent / 100);
        }

        function fmtClock(seconds) {
            const s = Math.max(0, Math.round(seconds || 0));
            return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
        }

        function fmtRemaining(seconds) {
            if (!isFinite(seconds) || seconds <= 0) return 'less than a minute';
            const mins = Math.ceil(seconds / 60);
            if (mins <= 1) return 'less than a minute';
            return `${mins} min`;
        }

        // "Transcribing 12:30 of 40:00 · about 6 min remaining"
        function transcribeStatusText(processed, duration, startedAt) {
            const elapsed = (performance.now() - startedAt) / 1000;
            let line = `Transcribing ${fmtClock(processed)} of ${fmtClock(duration)}`;
            // Only extrapolate once there's a real rate to extrapolate from — an ETA off the first
            // moments is noise, and a wrong ETA is worse than none. Nothing left to estimate once
            // the audio is fully decoded, either.
            if (processed > 30 && elapsed > 5 && processed < duration) {
                const remaining = (duration - processed) * (elapsed / processed);
                line += ` · about ${fmtRemaining(remaining)} remaining`;
            }
            return line;
        }

        let _previewText = '';
        let _previewRaf = null;

        // Mirror the user's transcription font onto the preview — same approach the highlight layer
        // uses (copy the textarea's computed style rather than re-reading the settings selects).
        function applyPreviewFont(el) {
            const ta = document.getElementById('transcription-text');
            if (!ta) return;
            const cs = getComputedStyle(ta);
            el.style.fontFamily = cs.fontFamily;
            el.style.fontSize = cs.fontSize;
            el.style.lineHeight = cs.lineHeight;
            el.style.letterSpacing = cs.letterSpacing;
        }

        // Called once per decoded token (very fast). Coalesce the DOM write to one per frame so the
        // text doesn't thrash layout; the flex-end anchor + mask handle the scroll/fade with no
        // scrollTop jump.
        function updateTranscriptionPreview(text) {
            _previewText = text;
            const el = document.getElementById('transcription-preview');
            if (!el) return;
            if (el.style.display === 'none' || !el.style.display) {
                el.style.display = 'flex';
                applyPreviewFont(el);
            }
            if (_previewRaf) return;
            _previewRaf = requestAnimationFrame(() => {
                _previewRaf = null;
                el.textContent = _previewText.slice(-600);   // tail only; keeps the node small
            });
        }

        function resetTranscriptionPreview() {
            if (_previewRaf) { cancelAnimationFrame(_previewRaf); _previewRaf = null; }
            _previewText = '';
            const el = document.getElementById('transcription-preview');
            if (!el) return;
            el.textContent = '';
            el.style.display = 'none';
        }
        
        // Handle file selection
        window.handleFileSelected = async function() {
            // Use native Electron dialog if available
            if (window.electronAPI && window.electronAPI.openFileDialog) {
                try {
                    const fileInfo = await window.electronAPI.openFileDialog();

                    if (!fileInfo) {
                        // User canceled — leave the demo (and any loaded file) untouched.
                        return;
                    }

                    // A real file was chosen: only now end the demo preview (if it was showing).
                    if (demoMode) exitDemo();

                    // Create file object with path
                    currentFile = {
                        name: fileInfo.name,
                        size: fileInfo.size,
                        path: fileInfo.path
                    };
                    
                    const fileSizeMB = (currentFile.size / (1024 * 1024)).toFixed(1);
                    document.getElementById('file-info').innerHTML = `<i class="ph ph-file-audio"></i><span>${currentFile.name} (${fileSizeMB} MB)</span>`;
                    document.getElementById('transcribe-btn').disabled = false;
                    addLog(`File selected: ${currentFile.name} (${fileSizeMB} MB)`);
                    addLog(`📁 Path: ${currentFile.path}`);
                    
                    // Warn for large files
                    if (currentFile.size > 50 * 1024 * 1024) {
                        addLog('⚠️ Large file detected - processing may take longer');
                    }
                } catch (error) {
                    console.error('Failed to open file dialog:', error);
                    addLog(`❌ Failed to select file: ${error.message}`);
                }
            } else {
                // Fallback to HTML file input (browser mode)
                const input = document.getElementById('audio-file');
                
                // If called from button click, trigger the input
                if (!input.files || input.files.length === 0) {
                    input.click();
                    return;
                }
                
                // If called from input onchange, process the file
                const fileInfoDiv = document.getElementById('file-info');
                const transcribeBtn = document.getElementById('transcribe-btn');

                if (input.files && input.files[0]) {
                    // A real file was chosen: only now end the demo preview (if it was showing).
                    if (demoMode) exitDemo();
                    currentFile = input.files[0];
                    const fileSizeMB = (currentFile.size / (1024 * 1024)).toFixed(1);
                    fileInfoDiv.innerHTML = `<i class="ph ph-file-audio"></i><span>${currentFile.name} (${fileSizeMB} MB)</span>`;
                    transcribeBtn.disabled = false;
                    addLog(`File selected: ${currentFile.name} (${fileSizeMB} MB)`);
                    addLog('⚠️ Browser mode - session restore not available');

                    // Warn for large files
                    if (currentFile.size > 50 * 1024 * 1024) {
                        addLog('⚠️ Large file detected - processing may take longer');
                    }
                }
            }
        };
        
        // ── Whisper timestamp-lag correction ────────────────────────────────────────────────────
        // Whisper's word timestamps run consistently LATE — a near-constant offset, not a drift.
        // Measured on the demo clip against a base.en reference alignment (scratch harness): the median
        // lag is ~200ms and roughly uniform across phrase starts AND interior words, so a uniform lead
        // shift lands tiny's starts on base's to within ~56ms (down from ~219ms raw). Selecting a word
        // then plays that word, not the next one. This is why a per-word acoustic snap couldn't fix it:
        // there's nothing local to detect — the whole track is shifted.
        //
        // Applied to the timestamps (not just labels), so selection, highlight and cuts all benefit.
        // Set ONSET_ALIGN false to hard-disable. The amount is a user setting (Advanced → Timestamp
        // compensation) since the ideal value depends on the model; default 300ms suits the fast ones.
        // Initialised at module scope so it's set before the first-run demo aligns.
        const ONSET_ALIGN = true;
        const LAG_KEY = 'whisper-lag-ms';
        const DEFAULT_LAG_MS = 300;
        let whisperLagMs = (() => {
            const v = parseInt(localStorage.getItem(LAG_KEY), 10);
            return Number.isFinite(v) ? Math.max(0, Math.min(500, v)) : DEFAULT_LAG_MS;
        })();

        // Mutates each chunk's timestamp in place (keeps chunks/allTokens shared refs) and seeds
        // _rawTimestamp so a second pass is idempotent — a re-run always shifts from the RAW value, so
        // changing the setting live re-derives correctly rather than compounding. `audio`/`sampleRate`
        // are unused (the correction is a blind constant) but kept in the signature so call sites don't
        // change. Whisper's END delay is the same as its START delay (measured vs a base-model
        // reference), so both boundaries shift equally and word duration is preserved.
        function alignChunksToOnsets(chunks, audio, sampleRate) {
            if (!ONSET_ALIGN || !chunks || !chunks.length) return chunks;
            const lag = whisperLagMs / 1000;
            for (const c of chunks) {
                if (!c || !Array.isArray(c.timestamp)) continue;
                if (!c._rawTimestamp) c._rawTimestamp = [c.timestamp[0], c.timestamp[1]];
                c.timestamp[0] = Math.max(0, c._rawTimestamp[0] - lag);
                c.timestamp[1] = Math.max(c.timestamp[0], c._rawTimestamp[1] - lag);
            }
            return chunks;
        }

        // Advanced-settings control: change the compensation and re-apply live to the loaded transcript.
        window.setWhisperLag = function(ms) {
            whisperLagMs = Math.max(0, Math.min(500, Math.round(Number(ms) || 0)));
            localStorage.setItem(LAG_KEY, String(whisperLagMs));
            const input = document.getElementById('whisper-lag-input');
            if (input) input.value = whisperLagMs;
            if (currentTranscription) {
                alignChunksToOnsets(currentTranscription.chunks || currentTranscription.allTokens, null, 16000);
                const ta = document.getElementById('transcription-text');
                if (ta && ta.selectionStart !== ta.selectionEnd) {
                    handleTranscriptionSelection();          // recompute the selection band from new timings
                } else if (originalAudioBuffer) {
                    drawWaveform();                          // just redraw labels/ticks (calls populateTextOverlay)
                }
            }
        };

        // Load and process audio file with progress feedback.
        //
        // The two ways this fails are told apart and tagged, because callers otherwise have to guess
        // and they guess wrong: the transcribe path used to report "Transcription failed" for a file
        // that never opened, sending people to check their model and language settings.
        //   audio-unreadable  — couldn't get the bytes at all (moved, renamed, deleted)
        //   audio-undecodable — got bytes, but Chromium's media stack can't decode them
        async function loadAudioFile(file) {
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const label = file.name || (file.path ? file.path.split(/[/\\]/).pop() : 'that file');

            let arrayBuffer;
            try {
                // Check if this is a file path (from session restore) or a File object
                if (file.path && !file.arrayBuffer && window.electronAPI) {
                    // Load from file path
                    arrayBuffer = await window.electronAPI.readAudioFile(file.path);
                } else {
                    // Load from File object
                    arrayBuffer = await file.arrayBuffer();
                }
            } catch (cause) {
                const err = new Error(`Couldn't read “${label}”. The file may have been moved, renamed or deleted.`);
                err.code = 'audio-unreadable';
                err.cause = cause;
                throw err;
            }

            let audioBuffer;
            try {
                audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
            } catch (cause) {
                // Keep this list in step with the picker's filters in electron/main.js — decoding is
                // whatever Chromium supports, so both places describe the same set.
                const err = new Error(`Couldn't open “${label}”. It isn't a format Vocal Slice can read — ` +
                    `try WAV, MP3, FLAC, M4A, AAC or OGG.`);
                err.code = 'audio-undecodable';
                err.cause = cause;
                throw err;
            }

            // Yield to browser
            await new Promise(resolve => setTimeout(resolve, 0));
            
            // Whisper expects mono audio at 16kHz
            const targetSampleRate = 16000;
            let audioData;
            
            if (audioBuffer.sampleRate === targetSampleRate && audioBuffer.numberOfChannels === 1) {
                audioData = audioBuffer.getChannelData(0);
            } else {
                // Need resampling and/or mono conversion
                const offlineContext = new OfflineAudioContext(
                    1, 
                    audioBuffer.duration * targetSampleRate, 
                    targetSampleRate
                );
                const source = offlineContext.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(offlineContext.destination);
                source.start(0);
                
                const resampledBuffer = await offlineContext.startRendering();
                audioData = resampledBuffer.getChannelData(0);
            }

            // Return both; callers decide where to store them (globals vs edit-local state).
            return { audioBuffer, audioData };
        }
        
        // Transcribe audio
        window.handleTranscribe = async function() {
            if (!currentFile) {
                alert('Please select an audio file first');
                return;
            }

            const selectedDevice = document.getElementById('device-select').value;
            if (selectedDevice === 'webgpu' && !webgpuSupported) {
                if (!confirm('WebGPU is not available. Transcription will run on CPU (slower). Continue?')) {
                    return;
                }
            }
            
            const transcribeBtn = document.getElementById('transcribe-btn');
            const loadingDiv = document.getElementById('transcription-loading');
            const emptyDiv = document.getElementById('transcription-empty');
            const contentDiv = document.getElementById('transcription-content');
            
            transcribeBtn.disabled = true;
            loadingDiv.style.display = 'block';
            // Reset the unified loading card for a clean start (no stale stage/percent flash).
            document.getElementById('transcription-loading-text').textContent = 'Preparing…';
            document.getElementById('loading-progress-fill').style.width = '0%';
            document.getElementById('loading-progress').style.display = 'none';
            // Busy until there's a real number — the model may still have to load.
            setTaskbarProgress(TASKBAR_BUSY);
            resetTranscriptionPreview();   // don't show the previous run's tail
            emptyDiv.style.display = 'none';
            contentDiv.style.display = 'none';
            
            try {
                addLog('Starting transcription...');
                
                // Initialize model if needed
                const modelName = document.getElementById('model-select').value;
                const selectedDevice = document.getElementById('device-select').value;
                // Warn BEFORE the blocking call, not during it — building the session on CPU blocks
                // the renderer just as the inference does, so anything set afterwards would never be
                // painted. paintFrame() is what gets this message onto the screen.
                if (runsOnCpu()) {
                    document.getElementById('transcription-loading-text').textContent =
                        `Working on your processor — ${CPU_FREEZE_NOTE}…`;
                    await paintFrame();
                }
                await initWhisper(modelName, selectedDevice);
                
                // Load and process audio
                showProcessingProgress(true);
                updateProcessingProgress(10, 'Reading your audio…');
                const loaded = await loadAudioFile(currentFile);
                originalAudioBuffer = loaded.audioBuffer;
                currentAudioBuffer = loaded.audioData;

                const duration = currentAudioBuffer.length / 16000;
                addLog(`Transcribing ${duration.toFixed(1)}s audio...`);
                
                const selectedLanguage = document.getElementById('language-select').value;
                const startTime = performance.now();
                const numExpectedChunks = Math.ceil(duration / 30);

                updateProcessingProgress(30, runsOnCpu()
                    ? `Transcribing on your processor — ${CPU_FREEZE_NOTE}…`
                    : 'Transcribing…');
                // Same reason as before initWhisper: everything from here to the pipeline call is
                // synchronous, and on CPU the call itself blocks, so without waiting for a paint this
                // message is written and then buried — the user would sit looking at "Reading your
                // audio…" for the whole run.
                if (runsOnCpu()) await paintFrame();
                if (duration > 300) {
                    addLog(`Long file (${fmtClock(duration)}) — expect this to take a while (${numExpectedChunks} chunks)`);
                }

                // Check if model is English-only or multilingual
                const isEnglishOnly = modelName.includes('.en');

                // Build generation config optimized for word-level timestamps
                const generationConfig = {
                    chunk_length_s: 30,  // Standard 30s chunks (matches whisper.cpp default)
                    stride_length_s: 0,  // No overlap for faster processing
                    return_timestamps: 'word',  // Word-level timestamps for precise slicing
                    num_beams: 1,  // Greedy decoding stabilizes word timestamps
                };

                // Progress reporting. Whisper decodes long audio in 30s windows, and the streamer's
                // chunk callbacks are the only real progress signal available — without them the bar
                // sat at 30% for the whole (possibly very long) run.
                let processed = 0;      // absolute seconds of audio decoded
                let partial = '';       // text decoded so far

                // Streamer timestamps are relative to the *current* 30s decode window and restart
                // near 0 at each new window, and the callbacks fire per Whisper segment (several per
                // window). So the absolute position is windowBase + t, where windowBase advances one
                // step each time t wraps back toward 0.
                const chunkStep = generationConfig.chunk_length_s - generationConfig.stride_length_s;
                let windowBase = 0;     // absolute start time of the current decode window
                let lastRelT = 0;       // previous window-relative timestamp, to spot the wrap
                let finishing = false;  // audio fully decoded; pipeline still merging + aligning

                const reportProgress = () => {
                    // The pipeline's tail (chunk merge + word-timestamp alignment) emits no events,
                    // so once the audio is decoded there's no honest number left to show — say what
                    // it's doing instead of freezing on a maxed-out counter and a stale ETA.
                    if (finishing) {
                        updateProcessingProgress(90, 'Lining up the words…');
                        return;
                    }
                    const frac = duration ? Math.min(processed / duration, 1) : 0;
                    updateProcessingProgress(
                        30 + Math.round(frac * 60),   // inference occupies the 30–90% band
                        transcribeStatusText(processed, duration, startTime)
                    );
                };

                // Never go backwards (a chunk's closing timestamp can trail the next chunk's start)
                // and never overshoot — the final window is usually shorter than a full step.
                const setProcessed = (t) => {
                    processed = Math.min(Math.max(processed, t), duration);
                    if (!finishing && duration && processed >= duration - 0.5) {
                        finishing = true;
                        addLog('Decoding complete — aligning word timestamps…');
                    }
                    reportProgress();
                };

                // Absolute audio position from a window-relative streamer timestamp. A drop back
                // toward 0 means a new 30s window began, so advance the base by one step.
                const advance = (t) => {
                    if (t < lastRelT - 0.5) {
                        windowBase += chunkStep;
                        addLog(`Transcribed ${fmtClock(windowBase)} / ${fmtClock(duration)}`);
                    }
                    lastRelT = t;
                    setProcessed(windowBase + t);
                };

                // Rebuilt on the WASM fallback below: the streamer is bound to a specific
                // pipeline's tokenizer, and that path constructs a new pipeline.
                const makeStreamer = () => {
                    const feConfig = whisperPipeline.processor?.feature_extractor?.config;
                    const maxSourcePositions = whisperPipeline.model?.config?.max_source_positions;
                    const timePrecision = (feConfig && maxSourcePositions)
                        ? feConfig.chunk_length / maxSourcePositions
                        : 0.02;

                    return new WhisperTextStreamer(whisperPipeline.tokenizer, {
                        time_precision: timePrecision,
                        on_chunk_start: advance,
                        on_chunk_end: advance,
                        callback_function: (text) => {
                            partial += text;
                            updateTranscriptionPreview(partial);
                        }
                    });
                };
                generationConfig.streamer = makeStreamer();

                // Only set task and language for multilingual models
                if (!isEnglishOnly) {
                    generationConfig.task = 'transcribe';  // Force transcription (not translation)
                    generationConfig.language = selectedLanguage;  // Set language explicitly
                    addLog(`Using multilingual model with language: ${selectedLanguage}`);
                } else {
                    addLog(`Using English-only model`);
                }
                
                let result;
                try {
                    result = await whisperPipeline(currentAudioBuffer, generationConfig);
                } catch (gpuError) {
                    // Check if it's a WebGPU shader error. The CPU retry is only on the table for a
                    // model that can actually run there — retrying a WebGPU-only one on WASM would
                    // trade a GPU error for a confusing 404 on a decoder that was never mirrored.
                    // Every model shipped today passes this, Medium included.
                    if (selectedDevice === 'webgpu' && modelRunsOn(modelName, 'wasm') && (
                        gpuError.message.includes('subgroup') ||
                        gpuError.message.includes('shader') ||
                        gpuError.message.includes('compilation')
                    )) {
                        addLog('⚠️ WebGPU shader error detected, retrying with CPU (WASM)...');
                        addLog(`GPU Error: ${gpuError.message}`);
                        
                        // Reinitialize with WASM
                        whisperPipeline = null;
                        await initWhisper(modelName, 'wasm');
                        document.getElementById('device-select').value = 'wasm';
                        
                        updateProcessingProgress(30,
                            `Restarting on your processor — slower, and ${CPU_FREEZE_NOTE}…`);
                        // Start the run over, against the newly-built pipeline.
                        processed = 0;
                        partial = '';
                        windowBase = 0;
                        lastRelT = 0;
                        finishing = false;
                        resetTranscriptionPreview();
                        generationConfig.streamer = makeStreamer();
                        result = await whisperPipeline(currentAudioBuffer, generationConfig);
                    } else {
                        throw gpuError;
                    }
                }
                
                const inferenceTime = ((performance.now() - startTime) / 1000).toFixed(2);
                const realtimeMultiplier = (duration / parseFloat(inferenceTime)).toFixed(2);
                
                addLog(`✅ Completed in ${inferenceTime}s (${realtimeMultiplier}x realtime)`);
                
                updateProcessingProgress(90, 'Almost done…');
                
                // Store the result
                currentTranscription = result;
                
                // Get transcription text
                let transcriptText = result.text || '';
                
                // Clean up and validate chunks if present
                if (result.chunks && result.chunks.length > 0) {
                    const audioDuration = currentAudioBuffer.length / 16000;
                    
                    // Step 1: Validate and clamp chunks
                    let validChunks = result.chunks.filter(chunk => {
                        // Check if chunk exists and has valid timestamp structure
                        if (!chunk) return false;
                        if (!chunk.timestamp) return false;
                        if (!Array.isArray(chunk.timestamp)) return false;
                        if (chunk.timestamp.length < 2) return false;
                        if (typeof chunk.timestamp[0] !== 'number') return false;
                        if (typeof chunk.timestamp[1] !== 'number') return false;
                        if (chunk.timestamp[0] === null || chunk.timestamp[1] === null) return false;
                        if (chunk.timestamp[0] < 0 || chunk.timestamp[1] < 0) return false;
                        
                        // Clamp timestamps to audio duration (fix for Whisper timestamp overflow)
                        if (chunk.timestamp[0] > audioDuration) {
                            chunk.timestamp[0] = audioDuration;
                        }
                        if (chunk.timestamp[1] > audioDuration) {
                            chunk.timestamp[1] = audioDuration;
                        }
                        
                        // Only reject if start is after end
                        if (chunk.timestamp[0] >= chunk.timestamp[1]) return false;
                        
                        return true;
                    });
                    
                    addLog(`📊 Chunks: ${result.chunks.length} total, ${validChunks.length} valid (timestamps clamped to audio duration)`);
                    
                    if (validChunks.length === 0) {
                        addLog('⚠️ No valid timestamp data found');
                        addLog('💡 Slicing will not be available, but text transcription works');
                    }
                    
                    // Step 2: Deduplicate chunks
                    const seenTimestamps = new Set();
                    const uniqueChunks = [];
                    
                    for (const chunk of validChunks) {
                        const key = `${chunk.timestamp[0].toFixed(3)}-${chunk.timestamp[1].toFixed(3)}`;
                        if (!seenTimestamps.has(key)) {
                            seenTimestamps.add(key);
                            uniqueChunks.push(chunk);
                        }
                    }
                    
                    // Step 3: Remove overlapping chunks
                    const nonOverlapping = [];
                    
                    for (let i = 0; i < uniqueChunks.length; i++) {
                        const current = uniqueChunks[i];
                        let isOverlapped = false;
                        
                        for (let j = 0; j < uniqueChunks.length; j++) {
                            if (i === j) continue;
                            
                            const other = uniqueChunks[j];
                            const currentDuration = current.timestamp[1] - current.timestamp[0];
                            const otherDuration = other.timestamp[1] - other.timestamp[0];
                            
                            if (current.timestamp[0] >= other.timestamp[0] - 0.1 &&
                                current.timestamp[1] <= other.timestamp[1] + 0.1 &&
                                otherDuration > currentDuration) {
                                isOverlapped = true;
                                break;
                            }
                        }
                        
                        if (!isOverlapped) {
                            nonOverlapping.push(current);
                        }
                    }
                    
                    // Update result with cleaned chunks
                    currentTranscription.chunks = nonOverlapping;

                    // Snap word starts to real audio onsets (Whisper runs slightly late). In place,
                    // so allTokens (same array) stays in sync; only timestamps change.
                    alignChunksToOnsets(currentTranscription.chunks, currentAudioBuffer, 16000);

                    // Build continuous text to match the textarea display (trimmed, normalized spacing)
                    let displayText = nonOverlapping
                        .map(chunk => chunk.text.trim())
                        .join(' ')
                        .replace(/\s+/g, ' ')
                        .trim();
                    
                    // Build character-to-token map based on display text
                    currentTranscription.continuousText = displayText.toLowerCase();
                    currentTranscription.charToTokenMap = [];
                    currentTranscription.allTokens = nonOverlapping;
                    
                    // Map each character position in display text back to original token
                    let charPos = 0;
                    for (let tokenIdx = 0; tokenIdx < nonOverlapping.length; tokenIdx++) {
                        const trimmedToken = nonOverlapping[tokenIdx].text.trim().toLowerCase();
                        
                        // Map all characters in this token
                        for (let i = 0; i < trimmedToken.length; i++) {
                            if (charPos < currentTranscription.continuousText.length) {
                                currentTranscription.charToTokenMap[charPos] = tokenIdx;
                                charPos++;
                            }
                        }
                        
                        // Skip the space that was added between tokens
                        if (tokenIdx < nonOverlapping.length - 1 && charPos < currentTranscription.continuousText.length) {
                            if (currentTranscription.continuousText[charPos] === ' ') {
                                currentTranscription.charToTokenMap[charPos] = tokenIdx;
                                charPos++;
                            }
                        }
                    }
                    
                    // Rebuild text from valid chunks and build lookup maps
                    if (nonOverlapping.length > 0) {
                        // DEBUG
                        addLog(`🐛 DEBUG: Display text: "${displayText.substring(0, 50)}"`);
                        addLog(`🐛 DEBUG: Continuous text: "${currentTranscription.continuousText.substring(0, 50)}"`);
                        addLog(`🐛 DEBUG: First 10 charToTokenMap entries: [${currentTranscription.charToTokenMap.slice(0, 10).join(', ')}]`);
                        addLog(`🐛 DEBUG: First token timestamp: ${nonOverlapping[0].timestamp[0].toFixed(3)}s to ${nonOverlapping[0].timestamp[1].toFixed(3)}s`);
                        addLog(`📊 Built lookup map: ${nonOverlapping.length} tokens, ${currentTranscription.continuousText.length} chars`);
                        
                        transcriptText = nonOverlapping
                            .map(chunk => chunk.text.trim())
                            .join(' ')
                            .replace(/\s+/g, ' ')
                            .trim();
                    }
                }
                
                document.getElementById('transcription-text').value = transcriptText;

                // Save session state (persists the current transcription for next session;
                // the per-file cache is populated when a slice references this file)
                saveSessionState();
                
                loadingDiv.style.display = 'none';
                contentDiv.style.display = 'flex'; // Use flex instead of block for proper sizing
                emptyDiv.style.display = 'none';
                showProcessingProgress(false);
                setTaskbarProgress(TASKBAR_CLEAR);
                if (window.electronAPI && window.electronAPI.signalFinished) {
                    window.electronAPI.signalFinished();
                }
                resetTranscriptionPreview();

                // Show the waveform and open with the first phrase selected (demonstrates the
                // text→waveform zoom) now that audio + transcription are ready.
                document.getElementById('transcription-waveform-section').style.display = 'block';
                selectFirstPhrase();
                
                // Set up search handlers
                setupSearchHandlers();
                
                // Update slices list to refresh edit button states
                // (in case user is reloading an audio file that has slices)
                updateSlicesList();
                
            } catch (error) {
                addLog('❌ Error: ' + error.message);
                console.error(error);
                // A file that never opened isn't a transcription failure, and saying so sends people
                // to check their model and language settings for no reason. loadAudioFile tags those
                // two cases, and their own message already explains what to do.
                const fileProblem = error.code === 'audio-undecodable' || error.code === 'audio-unreadable';
                // The user declined the model download at the confirmation prompt. They already know
                // what happened — they're the one who said no — so there is nothing to alert about.
                const declined = error.code === 'download-declined';
                // Before the alert, not after: it blocks the renderer, and a modal sitting unseen
                // behind a background window is exactly the case worth flagging.
                setTaskbarProgress(TASKBAR_CLEAR);
                if (window.electronAPI && window.electronAPI.signalFinished) {
                    window.electronAPI.signalFinished();
                }
                if (!declined) alert(fileProblem ? error.message : 'Transcription failed: ' + error.message);
                emptyDiv.style.display = 'block';
                loadingDiv.style.display = 'none';
                showProcessingProgress(false);
                resetTranscriptionPreview();
            } finally {
                transcribeBtn.disabled = false;
            }
        };
        
        function updateSliceButtonState() {
            // slice-btn and quick-slice-btn removed; waveform handles show/hide via handleTranscriptionSelection
        }
        
        // Search Functions
        function performSearch(fromNavigation = false) {
            const searchBox = document.getElementById('search-box');
            const searchTerm = searchBox.value.trim();
            const textArea = document.getElementById('transcription-text');
            const highlightLayer = document.getElementById('highlight-layer');
            const prevBtn = document.getElementById('prev-btn');
            const nextBtn = document.getElementById('next-btn');
            const resultsLabel = document.getElementById('search-results-label');
            
            // Clear previous results
            searchResults = [];
            currentSearchIndex = -1;
            selectionAudioMatches = [];
            selectionAudioIndex = 0;
            
            // Disable navigation buttons by default
            nextBtn.disabled = true;
            prevBtn.disabled = true;
            
            if (searchTerm === '') {
                // Clear search
                searchActive = false;
                resultsLabel.textContent = '';
                textArea.setSelectionRange(0, 0);
                highlightLayer.innerHTML = ''; // Clear highlights
                return;
            }
            
            // Mark search as active
            searchActive = true;
            
            const text = textArea.value;
            const lowerText = text.toLowerCase();
            const lowerSearchTerm = searchTerm.toLowerCase();
            
            // Find all occurrences
            let position = 0;
            let matchCount = 0;
            
            while ((position = lowerText.indexOf(lowerSearchTerm, position)) !== -1) {
                searchResults.push({
                    start: position,
                    end: position + searchTerm.length
                });
                position += searchTerm.length;
                matchCount++;
            }
            
            // Update results label and button state
            if (matchCount > 0) {
                resultsLabel.textContent = `1/${matchCount}`;

                // Enable navigation buttons if multiple matches
                nextBtn.disabled = matchCount <= 1;
                prevBtn.disabled = matchCount <= 1;

                // Navigate to the first match
                currentSearchIndex = 0;
                highlightCurrentSearchResult(fromNavigation);
            } else {
                resultsLabel.textContent = 'No results';
                textArea.setSelectionRange(0, 0);
                highlightLayer.innerHTML = ''; // Clear highlights
            }
        }
        
        window.navigateSearch = function(forward) {
            if (searchResults.length === 0 && selectionAudioMatches.length === 0) return;

            if (searchActive && searchResults.length > 0) {
                // Navigate text search results and update waveform
                currentSearchIndex = (currentSearchIndex + (forward ? 1 : -1) + searchResults.length) % searchResults.length;
                highlightCurrentSearchResult(true);
                // handleTranscriptionSelection is called inside highlightCurrentSearchResult
            } else if (selectionAudioMatches.length > 0) {
                // Navigate audio matches from manual text selection
                selectionAudioIndex = (selectionAudioIndex + (forward ? 1 : -1) + selectionAudioMatches.length) % selectionAudioMatches.length;
                const match = selectionAudioMatches[selectionAudioIndex];
                document.getElementById('search-results-label').textContent =
                    `${selectionAudioIndex + 1}/${selectionAudioMatches.length}`;
                enterSelectionMode(match.startTime / 1000, match.endTime / 1000);
                if (match.charStart !== undefined) applySelectionHighlight(match.charStart, match.charEnd);
            }
        };
        
        function highlightCurrentSearchResult(moveFocus = false) {
            if (!searchActive || searchResults.length === 0 || currentSearchIndex < 0 || currentSearchIndex >= searchResults.length) {
                return;
            }
            
            const textArea = document.getElementById('transcription-text');
            const highlightLayer = document.getElementById('highlight-layer');
            const resultsLabel = document.getElementById('search-results-label');
            const match = searchResults[currentSearchIndex];
            
            // Sync highlight layer styles with textarea
            const computedStyle = window.getComputedStyle(textArea);
            highlightLayer.style.fontFamily = computedStyle.fontFamily;
            highlightLayer.style.fontSize = computedStyle.fontSize;
            highlightLayer.style.lineHeight = computedStyle.lineHeight;
            highlightLayer.style.letterSpacing = computedStyle.letterSpacing;
            highlightLayer.style.wordSpacing = computedStyle.wordSpacing;
            
            // Set the selection to highlight the match
            textArea.setSelectionRange(match.start, match.end);
            
            // Only move focus if explicitly requested (e.g., from navigation buttons)
            if (moveFocus) {
                textArea.focus();
            }
            
            // Update highlight layer to show visual highlight
            const text = textArea.value;
            let highlightedHTML = '';
            
            // Build HTML with highlighted match
            highlightedHTML += escapeHTML(text.substring(0, match.start));
            highlightedHTML += '<mark>' + escapeHTML(text.substring(match.start, match.end)) + '</mark>';
            highlightedHTML += escapeHTML(text.substring(match.end));
            
            highlightLayer.innerHTML = highlightedHTML;
            
            // Scroll to make the selection visible (accurate for soft-wrapped text)
            scrollHighlightIntoView(highlightLayer.querySelector('mark'));
            
            // Update results label (timing shown in waveform controls)
            resultsLabel.textContent = `${currentSearchIndex + 1}/${searchResults.length}`;

            // Update waveform to the audio region for this search result
            handleTranscriptionSelection();
        }
        
        // Helper function to escape HTML
        function escapeHTML(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }
        
        function getMatchesForSelection(selectedText) {
            if (!currentTranscription || !currentTranscription.chunks || !currentTranscription.continuousText || !currentTranscription.charToTokenMap) {
                return [];
            }
            
            // Normalize search text (same as in findFirstMatchingChunk)
            const searchLower = selectedText.trim().toLowerCase().replace(/\n/g, '');
            
            const matches = [];
            let startPos = 0;
            
            // Find all occurrences in continuous text
            while (true) {
                const matchPos = currentTranscription.continuousText.indexOf(searchLower, startPos);
                if (matchPos === -1) break;
                
                const matchEndPos = matchPos + searchLower.length - 1;
                
                // Ensure positions are valid
                if (matchPos < currentTranscription.charToTokenMap.length && matchEndPos < currentTranscription.charToTokenMap.length) {
                    const startTokenIndex = currentTranscription.charToTokenMap[matchPos];
                    const endTokenIndex = currentTranscription.charToTokenMap[matchEndPos];
                    
                    if (startTokenIndex < currentTranscription.chunks.length && endTokenIndex < currentTranscription.chunks.length &&
                        startTokenIndex !== undefined && endTokenIndex !== undefined) {
                        
                        const startToken = currentTranscription.chunks[startTokenIndex];
                        const endToken = currentTranscription.chunks[endTokenIndex];
                        
                        // Calculate actual start/end times with smart boundaries (same logic as findFirstMatchingChunk)
                        const maxGap = 0.5;
                        let actualStartTime, actualEndTime;
                        
                        if (startTokenIndex === 0) {
                            actualStartTime = 0.0;
                        } else {
                            const prevTokenEnd = currentTranscription.chunks[startTokenIndex - 1].timestamp[1];
                            const gap = startToken.timestamp[0] - prevTokenEnd;
                            actualStartTime = gap <= maxGap ? prevTokenEnd : prevTokenEnd + (gap / 2);
                        }
                        
                        const audioDuration = originalAudioBuffer ? originalAudioBuffer.duration : Infinity;
                        if (endTokenIndex === currentTranscription.chunks.length - 1) {
                            actualEndTime = Math.min(endToken.timestamp[1] + 0.5, audioDuration);
                        } else {
                            const nextTokenStart = currentTranscription.chunks[endTokenIndex + 1].timestamp[0];
                            const gap = nextTokenStart - endToken.timestamp[1];
                            actualEndTime = gap <= maxGap ? nextTokenStart : endToken.timestamp[1] + (gap / 2);
                        }
                        
                        matches.push({
                            text: selectedText,
                            startTime: actualStartTime * 1000,
                            endTime: actualEndTime * 1000
                        });
                    }
                }
                
                startPos = matchPos + searchLower.length;
            }
            
            return matches;
        }
        
        // Set up keyboard shortcuts and event listeners for search
        function setupSearchHandlers() {
            // Prevent duplicate initialization
            if (searchHandlersInitialized) return;
            searchHandlersInitialized = true;
            
            const searchBox = document.getElementById('search-box');
            const textArea = document.getElementById('transcription-text');
            const highlightLayer = document.getElementById('highlight-layer');
            
            // Sync scroll between textarea and highlight layer
            textArea.addEventListener('scroll', () => {
                highlightLayer.scrollTop = textArea.scrollTop;
                highlightLayer.scrollLeft = textArea.scrollLeft;
            });
            
            // Icon toggles between magnifying glass (empty) and × (has text)
            const iconBtn = document.getElementById('search-icon-btn');
            const iconEl = document.getElementById('search-icon');

            function updateSearchIcon() {
                if (searchBox.value.length > 0) {
                    iconEl.className = 'ph ph-x';
                    iconBtn.title = 'Clear search';
                } else {
                    iconEl.className = 'ph ph-magnifying-glass';
                    iconBtn.title = 'Search';
                }
            }

            iconBtn.addEventListener('click', () => {
                if (searchBox.value.length > 0) {
                    searchBox.value = '';
                    performSearch(false);
                    updateSearchIcon();
                } else {
                    searchBox.focus();
                }
            });

            // Search as user types (don't move focus - keep it in search box)
            searchBox.addEventListener('input', () => {
                updateSearchIcon();
                performSearch(false);
            });
            
            // Enter key in search box moves to first match and takes focus
            searchBox.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    if (searchResults.length > 0) {
                        // Move focus to the textarea and highlight the current match
                        highlightCurrentSearchResult(true);
                    }
                }
            });
            
            // Keyboard shortcuts
            document.addEventListener('keydown', (e) => {
                // Ctrl+F or Cmd+F to focus search box
                if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
                    e.preventDefault(); // Prevent browser's default find
                    const searchBox = document.getElementById('search-box');
                    searchBox.focus();
                    searchBox.select(); // Select any existing text
                    return;
                }
                
                // Escape key clears search
                if (e.key === 'Escape' && searchActive) {
                    const searchBox = document.getElementById('search-box');
                    const highlightLayer = document.getElementById('highlight-layer');
                    searchBox.value = '';
                    highlightLayer.innerHTML = ''; // Clear highlights
                    performSearch(); // This will clear the search
                }
            });
            
            // Monitor manual text selection
            textArea.addEventListener('mouseup', () => {
                const selectedText = textArea.value.substring(textArea.selectionStart, textArea.selectionEnd).trim();
                
                // If user makes a manual selection while search is active, switch to manual mode
                if (searchActive && selectedText) {
                    const searchBox = document.getElementById('search-box');
                    const highlightLayer = document.getElementById('highlight-layer');
                    const searchTerm = searchBox.value.trim();
                    
                    // Check if the selection is different from the current search term
                    if (selectedText.toLowerCase() !== searchTerm.toLowerCase()) {
                        searchActive = false;
                        searchBox.value = ''; // Clear search box
                        highlightLayer.innerHTML = ''; // Clear highlights
                    }
                }
                
                if (!searchActive && selectedText && selectedText !== lastSelectedText) {
                    lastSelectedText = selectedText;
                    updateManualSelection();
                }
            });
            
            textArea.addEventListener('keyup', () => {
                const selectedText = textArea.value.substring(textArea.selectionStart, textArea.selectionEnd).trim();
                
                // If user makes a manual selection while search is active, switch to manual mode
                if (searchActive && selectedText) {
                    const searchBox = document.getElementById('search-box');
                    const highlightLayer = document.getElementById('highlight-layer');
                    const searchTerm = searchBox.value.trim();
                    
                    // Check if the selection is different from the current search term
                    if (selectedText.toLowerCase() !== searchTerm.toLowerCase()) {
                        searchActive = false;
                        searchBox.value = ''; // Clear search box
                        highlightLayer.innerHTML = ''; // Clear highlights
                    }
                }
                
                if (!searchActive && selectedText && selectedText !== lastSelectedText) {
                    lastSelectedText = selectedText;
                    updateManualSelection();
                }
            });
        }
        
        function updateManualSelection() {
            const textArea = document.getElementById('transcription-text');
            const resultsLabel = document.getElementById('search-results-label');
            const prevBtn = document.getElementById('prev-btn');
            const nextBtn = document.getElementById('next-btn');
            const selectedText = textArea.value.substring(textArea.selectionStart, textArea.selectionEnd).trim();
            
            if (!selectedText) return;
            
            // Find all occurrences of the selected text
            const text = textArea.value;
            const lowerText = text.toLowerCase();
            const lowerSelected = selectedText.toLowerCase();
            
            searchResults = []; // Store results for navigation
            let position = 0;
            let matchCount = 0;
            let currentPosition = -1;
            
            const selectionStart = textArea.selectionStart;
            
            while ((position = lowerText.indexOf(lowerSelected, position)) !== -1) {
                searchResults.push({
                    start: position,
                    end: position + selectedText.length
                });
                matchCount++;
                if (position === selectionStart) {
                    currentPosition = matchCount;
                    currentSearchIndex = matchCount - 1;
                }
                position += selectedText.length;
            }
            
            // Enable/disable navigation buttons based on match count
            nextBtn.disabled = matchCount <= 1;
            prevBtn.disabled = matchCount <= 1;
            
            // Concise count (timing is shown in the transport row, not here).
            resultsLabel.textContent = matchCount > 0 ? `${currentPosition || 1}/${matchCount}` : 'No results';
        }
        
        // ============================================
        // SLICE PREVIEW MODAL
        // ============================================
        
        // Global state for preview modal
        let previewState = {
            selectedText: '',
            match: null,
            startTime: 0,
            endTime: 0,
            windowStart: 0,
            windowEnd: 0,
            audioBuffer: null,
            audioSource: null,
            audioContext: null,
            pausedAt: null,      // absolute time in the source buffer, or null
            playPos: null,       // absolute playhead time while playing
            lastFrameAt: null,   // audioContext.currentTime at the last animatePlayhead frame
            isPlaying: false,
            isPaused: false,
            isLooping: false,
            playbackSpeed: 1.0,
            isDragging: false,
            dragHandle: null,
            editingSliceIndex: null
        };

        let _currentSelectionMatch = null;
        


        // Canvas can't read CSS custom properties, so resolve the theme vars once per draw
        // (never per pixel/tick). All theme vars are hex, so hexToRgb can alpha them.
        // The wave itself is a neutral (--overlay1/2); colour belongs to the controls.
        function waveformPalette() {
            const s = getComputedStyle(document.body);
            const rgba = (v, a, f) => {
                const c = hexToRgb(s.getPropertyValue(v).trim()) || hexToRgb(f);
                return `rgba(${c.r},${c.g},${c.b},${a})`;
            };
            return {
                rulerBg:   s.getPropertyValue('--surface1').trim() || '#45475a',
                rulerLine: s.getPropertyValue('--surface2').trim() || '#585b70',
                grid:      rgba('--overlay0', 0.14, '#6c7086'),
                tick:      s.getPropertyValue('--overlay0').trim() || '#6c7086',
                label:     s.getPropertyValue('--subtext0').trim() || '#a6adc8',
                centre:    s.getPropertyValue('--surface2').trim() || '#585b70',
                waveEdge:  rgba('--overlay1', 0.95, '#7f849c'),
                waveMid:   rgba('--overlay1', 0.65, '#7f849c'),
                waveLine:  rgba('--overlay2', 0.9,  '#9399b2'),
                accentA:   rgba('--blue',  0.16, '#89b4fa'),
                accentB:   rgba('--mauve', 0.16, '#cba6f7'),
            };
        }

        // Shared time-ruler renderer used by both the editor/main waveform and the slice
        // preview waveform so they look identical. Draws the tick strip + time labels +
        // gridlines for the range [tStart, tEnd] across the full canvas width.
        function drawTimeRuler(ctx, width, height, rulerHeight, tStart, tEnd, pal = waveformPalette()) {
            const windowDuration = Math.max(1e-6, tEnd - tStart);

            // Ruler background + separator
            ctx.fillStyle = pal.rulerBg;
            ctx.fillRect(0, 0, width, rulerHeight);
            ctx.strokeStyle = pal.rulerLine;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, rulerHeight);
            ctx.lineTo(width, rulerHeight);
            ctx.stroke();

            // Grid interval (target ~8 lines)
            const NICE = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
            const gridInterval = NICE.find(n => n >= windowDuration / 8) ?? NICE[NICE.length - 1];

            ctx.font = '10px "Segoe UI", system-ui, sans-serif';
            ctx.textBaseline = 'middle';

            const firstTick = Math.ceil(tStart / gridInterval) * gridInterval;
            for (let t = firstTick; t <= tEnd + 1e-9; t += gridInterval) {
                const x = Math.round(((t - tStart) / windowDuration) * width);

                // Subtle vertical grid line below ruler
                ctx.strokeStyle = pal.grid;
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x + 0.5, rulerHeight);
                ctx.lineTo(x + 0.5, height);
                ctx.stroke();

                // Tick mark at bottom of the ruler strip
                ctx.strokeStyle = pal.tick;
                ctx.beginPath();
                ctx.moveTo(x + 0.5, rulerHeight - 5);
                ctx.lineTo(x + 0.5, rulerHeight);
                ctx.stroke();

                // Timestamp label
                ctx.fillStyle = pal.label;
                ctx.fillText(formatRulerTime(t, gridInterval), x + 3, rulerHeight / 2);
            }
        }

        // Draw mono waveform
        async function drawWaveform() {
            const { canvas, inner: wfInner, textLayer: wfTextLayer } = getWaveformEls();
            const ctx = canvas.getContext('2d');

            const oab = activeOriginalBuffer();
            if (!oab) return;
            
            // Set canvas resolution (use higher DPI for sharper rendering)
            const scrollContainer = canvas.closest('.waveform-container');
            const dpr = window.devicePixelRatio || 1;
            const viewportWidth = scrollContainer.clientWidth;
            const contentWidth = viewportWidth;
            
            const RULER_HEIGHT = 16;
            const waveformHeight = 96;
            if (wfInner) {
                wfInner.style.width = contentWidth + 'px';
                wfInner.style.minWidth = contentWidth + 'px';
                wfInner.style.maxWidth = contentWidth + 'px';
            }

            if (wfTextLayer) {
                wfTextLayer.style.width = contentWidth + 'px';
            }
            
            canvas.width = contentWidth * dpr;
            canvas.height = waveformHeight * dpr;
            canvas.style.width = contentWidth + 'px';
            canvas.style.height = waveformHeight + 'px';
            ctx.scale(dpr, dpr);
            
            const width = contentWidth;
            const height = waveformHeight;

            if (width === 0 || height === 0) return;
            
            // Get audio data for the current window only
            const sampleRate = oab.sampleRate;
            const wStartSample = Math.floor(previewState.windowStart * sampleRate);
            const wEndSample = Math.ceil(previewState.windowEnd * sampleRate);
            const audioData = oab.getChannelData(0).subarray(wStartSample, wEndSample);
            const samples = audioData.length;

            const samplesPerPixel = Math.max(1, Math.ceil(samples / width));
            
            // Clear canvas
            ctx.clearRect(0, 0, width, height);

            // Theme colours (the selected region is painted by the .waveform-selection overlay,
            // not here — it has to track the handles during a drag without a canvas repaint).
            const pal = waveformPalette();

            // --- Ruler ---
            drawTimeRuler(ctx, width, height, RULER_HEIGHT, previewState.windowStart, previewState.windowEnd, pal);

            // --- Waveform (shifted below ruler) ---
            const halfH = RULER_HEIGHT + (height - RULER_HEIGHT) / 2;
            const amplitude = (height - RULER_HEIGHT) / 2;

            // Center line
            ctx.strokeStyle = pal.centre;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, halfH);
            ctx.lineTo(width, halfH);
            ctx.stroke();

            // Gradient
            const gradient = ctx.createLinearGradient(0, RULER_HEIGHT, 0, height);
            gradient.addColorStop(0, pal.waveEdge);
            gradient.addColorStop(0.5, pal.waveMid);
            gradient.addColorStop(1, pal.waveEdge);

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(0, halfH);

            for (let x = 0; x < width; x++) {
                const s = Math.floor(x * samplesPerPixel);
                const e = Math.floor((x + 1) * samplesPerPixel);
                let max = 0;
                for (let i = s; i < e && i < samples; i++) if (audioData[i] > max) max = audioData[i];
                ctx.lineTo(x, halfH - Math.min(1, max * 1.5) * amplitude);
            }
            for (let x = width - 1; x >= 0; x--) {
                const s = Math.floor(x * samplesPerPixel);
                const e = Math.floor((x + 1) * samplesPerPixel);
                let min = 0;
                for (let i = s; i < e && i < samples; i++) if (audioData[i] < min) min = audioData[i];
                ctx.lineTo(x, halfH + Math.abs(Math.max(-1, min * 1.5)) * amplitude);
            }

            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = pal.waveLine;
            ctx.lineWidth = 1;
            ctx.stroke();

            populateTextOverlay();
        }
        
        // Helper function to convert hex to RGB
        function hexToRgb(hex) {
            if (!hex) return null;
            // Remove # if present
            hex = hex.replace('#', '');
            // Handle 3-digit hex
            if (hex.length === 3) {
                hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
            }
            const result = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? {
                r: parseInt(result[1], 16),
                g: parseInt(result[2], 16),
                b: parseInt(result[3], 16)
            } : null;
        }
        
        function drawSliceWaveform(canvas, audioBuffer) {
            const dpr = window.devicePixelRatio || 1;
            const width = canvas.clientWidth || canvas.offsetWidth || 400;
            const height = canvas.clientHeight || 80;
            canvas._drawnWidth = width; // stash so the text overlay can use the same value

            canvas.width = width * dpr;
            canvas.height = height * dpr;
            const ctx = canvas.getContext('2d');
            ctx.scale(dpr, dpr);

            const audioData = audioBuffer.getChannelData(0);
            const samples = audioData.length;
            const samplesPerPixel = Math.ceil(samples / width);

            const pal = waveformPalette();

            // Time ruler (0 → clip duration), same style/helper as the editor waveform.
            const RULER_HEIGHT = 16;
            drawTimeRuler(ctx, width, height, RULER_HEIGHT, 0, audioBuffer.duration, pal);

            // The whole clip *is* the selection, so it gets the same accent band the editor's
            // .waveform-selection overlay draws — painted here since previews are never dragged.
            const band = ctx.createLinearGradient(0, 0, width, 0);
            band.addColorStop(0, pal.accentA);
            band.addColorStop(1, pal.accentB);
            ctx.fillStyle = band;
            ctx.fillRect(0, RULER_HEIGHT, width, height - RULER_HEIGHT);

            // Waveform shifted below the ruler.
            const halfH = RULER_HEIGHT + (height - RULER_HEIGHT) / 2;
            const amplitude = (height - RULER_HEIGHT) / 2;

            ctx.strokeStyle = pal.centre;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(0, halfH);
            ctx.lineTo(width, halfH);
            ctx.stroke();

            const gradient = ctx.createLinearGradient(0, RULER_HEIGHT, 0, height);
            gradient.addColorStop(0,   pal.waveEdge);
            gradient.addColorStop(0.5, pal.waveMid);
            gradient.addColorStop(1,   pal.waveEdge);

            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.moveTo(0, halfH);

            for (let x = 0; x < width; x++) {
                const s = Math.floor(x * samplesPerPixel);
                const e = Math.floor((x + 1) * samplesPerPixel);
                let max = 0;
                for (let i = s; i < e && i < samples; i++) if (audioData[i] > max) max = audioData[i];
                ctx.lineTo(x, halfH - Math.min(1, max * 1.5) * amplitude);
            }
            for (let x = width - 1; x >= 0; x--) {
                const s = Math.floor(x * samplesPerPixel);
                const e = Math.floor((x + 1) * samplesPerPixel);
                let min = 0;
                for (let i = s; i < e && i < samples; i++) if (audioData[i] < min) min = audioData[i];
                ctx.lineTo(x, halfH + Math.abs(Math.max(-1, min * 1.5)) * amplitude);
            }

            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = pal.waveLine;
            ctx.lineWidth = 1;
            ctx.stroke();
        }

        // Measure rendered width of a token label
        let tokenMeasureCanvas = null;
        function measureTokenWidth(text, bold) {
            if (!tokenMeasureCanvas) {
                tokenMeasureCanvas = document.createElement('canvas');
            }
            const ctx = tokenMeasureCanvas.getContext('2d');
            // Match the weight actually rendered: 600 for in-range (bold), 400 otherwise — measuring
            // everything at 600 over-spaced the regular labels.
            ctx.font = `${bold ? 600 : 400} 13px "Segoe UI", system-ui, sans-serif`;
            return Math.ceil(ctx.measureText(text).width) + 4;
        }
        
        function formatRulerTime(t, interval) {
            if (t >= 60) {
                const m = Math.floor(t / 60);
                const s = t % 60;
                const dec = interval < 1 ? 1 : 0;
                return `${m}:${s.toFixed(dec).padStart(dec > 0 ? 4 : 2, '0')}`;
            }
            const decimals = interval < 0.1 ? 2 : interval < 1 ? 1 : 0;
            return t.toFixed(decimals) + 's';
        }

        // Position transcription tokens on the timeline below the waveform
        function populateTextOverlay() {
            const { textLayer, canvas } = getWaveformEls();
            if (!textLayer || !activeOriginalBuffer()) return;

            textLayer.innerHTML = '';

            const _tr = activeTranscription();
            const chunks = _tr?.chunks || _tr?.allTokens;
            if (!chunks || chunks.length === 0) return;
            const windowDuration = previewState.windowEnd - previewState.windowStart;
            const width = canvas.clientWidth;

            if (!width || !windowDuration) return;

            const RULER_HEIGHT = 16;
            const ROW_HEIGHT = 18;
            const ROW_PADDING = 4;
            const LANE_GAP = 4;
            const MAX_LANES = 4;
            
            const placements = [];
            
            const windowStart = previewState.windowStart;
            const windowEnd = previewState.windowEnd;

            chunks.forEach(chunk => {
                const text = chunk.text?.trim();
                if (!text || !chunk.timestamp) return;

                const startTime = chunk.timestamp[0];
                let endTime = chunk.timestamp[1];
                if (typeof startTime !== 'number' || startTime < 0) return;
                if (typeof endTime !== 'number' || endTime < startTime) endTime = startTime;

                // Skip tokens entirely outside the window
                if (endTime < windowStart || startTime > windowEnd) return;

                const inRange = endTime > previewState.startTime && startTime < previewState.endTime;
                const displayWidth = measureTokenWidth(text, inRange);

                // Label is anchored at the word START (reads left-to-right like subtitles); a start
                // tick (drawn below) marks the exact start so the label's rightward text extent — which
                // is text width, not the word's duration — isn't mistaken for the word's location.
                const anchorX = ((startTime - windowStart) / windowDuration) * width;   // true start px
                const startX = Math.max(0, Math.min(anchorX, width));
                const displayEndX = Math.min(startX + displayWidth, width);

                placements.push({ text, startTime, endTime, startX, displayEndX, inRange, anchorX });
            });
            
            placements.sort((a, b) => a.startX - b.startX || a.displayEndX - b.displayEndX);
            
            // Assign lanes preserving sentence order: stay on the current lane as long as
            // possible, only advancing upward when forced by overlap. This keeps consecutive
            // words together in runs (like wrapped subtitle text) rather than bouncing back
            // to lane 0 whenever space opens up.
            const laneEnds = [0];
            let currentLane = 0;
            let maxLaneUsed = 0;
            for (const placement of placements) {
                if (placement.startX < laneEnds[currentLane] + LANE_GAP) {
                    // Current lane is busy — advance upward through lanes until one is free
                    let nextLane = currentLane + 1;
                    while (nextLane < laneEnds.length && placement.startX < laneEnds[nextLane] + LANE_GAP) {
                        nextLane++;
                    }
                    if (nextLane >= MAX_LANES) {
                        // All lanes at capacity — fall back to the freest one
                        nextLane = laneEnds.reduce((best, end, idx) => end < laneEnds[best] ? idx : best, 0);
                    } else if (nextLane >= laneEnds.length) {
                        laneEnds.push(0);
                    }
                    currentLane = nextLane;
                }

                laneEnds[currentLane] = Math.max(laneEnds[currentLane], placement.displayEndX);
                placement.lane = currentLane;
                maxLaneUsed = Math.max(maxLaneUsed, currentLane);
            }
            
            // Only cull when tokens are genuinely dense (< 15px per token on average).
            // At high zoom levels tokens are well-spaced and the lane algorithm handles
            // them fine without any culling.
            const avgPxPerToken = placements.length > 0 ? width / placements.length : Infinity;
            const dense = avgPxPerToken < 15;
            const IN_RANGE_GAP_PX = dense ? 40 : 1;
            const OUT_RANGE_GAP_PX = dense ? 120 : 1;
            let lastInRangeX = -999;
            let lastOutRangeX = -999;

            for (const placement of placements) {
                if (placement.inRange) {
                    if (placement.startX - lastInRangeX < IN_RANGE_GAP_PX) continue;
                    lastInRangeX = placement.startX;
                } else {
                    if (placement.startX - lastOutRangeX < OUT_RANGE_GAP_PX) continue;
                    lastOutRangeX = placement.startX;
                }

                const token = document.createElement('span');
                token.className = 'waveform-token';
                token.textContent = placement.text;
                token.style.left = `${placement.startX}px`;
                token.style.top = `${RULER_HEIGHT + ROW_PADDING + placement.lane * ROW_HEIGHT}px`;
                token.title = `${placement.startTime.toFixed(2)}s – ${(placement.endTime ?? placement.startTime).toFixed(2)}s`;

                if (placement.inRange) {
                    token.classList.add('in-range');
                }

                textLayer.appendChild(token);

                // Start tick: a thin vertical mark at the word's exact start, connecting the ruler to
                // the label, so the label's rightward text extent isn't read as the word's position.
                const tick = document.createElement('span');
                tick.className = 'waveform-token-tick' + (placement.inRange ? ' in-range' : '');
                tick.style.left = `${placement.startX}px`;
                tick.style.top = `${RULER_HEIGHT}px`;
                tick.style.height = `${ROW_PADDING + placement.lane * ROW_HEIGHT + ROW_HEIGHT}px`;
                textLayer.appendChild(tick);
            }
        }

        // Update handle positions based on time (window-relative coords)
        // Accent band over the selected region (its ::before/::after scrim the rest). Kept cheap —
        // two style writes — so it can run synchronously alongside the handle during a drag.
        function updateSelectionBand() {
            const { canvas, selection } = getWaveformEls();
            if (!selection || !canvas) return;

            const windowDuration = previewState.windowEnd - previewState.windowStart;
            const width = canvas.clientWidth;
            if (windowDuration <= 0 || !width) return;

            const startX = ((previewState.startTime - previewState.windowStart) / windowDuration) * width;
            const endX = ((previewState.endTime - previewState.windowStart) / windowDuration) * width;

            selection.style.left = `${startX}px`;
            selection.style.width = `${Math.max(0, endX - startX)}px`;
        }

        function updateHandlePositions() {
            const { canvas, startHandle, endHandle } = getWaveformEls();

            const windowDuration = previewState.windowEnd - previewState.windowStart;
            const width = canvas.clientWidth;

            if (windowDuration <= 0) return;

            const startX = ((previewState.startTime - previewState.windowStart) / windowDuration) * width;
            const endX = ((previewState.endTime - previewState.windowStart) / windowDuration) * width;

            startHandle.style.left = `${startX}px`;
            endHandle.style.left = `${endX}px`;

            updateSelectionBand();
            populateTextOverlay();
        }
        
        // Document/canvas drag listeners are re-created on every setupDragHandlers call; keep
        // refs so we can remove the previous set (only one waveform is active at a time).
        let _dragListeners = null; // { move, up, canvas, click }

        // Set up drag handlers for markers
        function setupDragHandlers() {
            const { startHandle, endHandle } = getWaveformEls();

            const startDrag = (e, handle) => {
                e.preventDefault();
                previewState.isDragging = true;
                previewState.dragHandle = handle;
                // Playback survives the drag: onDrag moves the source's bounds in place.
            };

            const onDrag = (e) => {
                if (!previewState.isDragging) return;
                const { canvas, startInput, endInput, startHandle, endHandle } = getWaveformEls();
                const rect = canvas.getBoundingClientRect();
                const width = canvas.clientWidth;
                const windowDuration = previewState.windowEnd - previewState.windowStart;

                let time = previewState.windowStart + ((e.clientX - rect.left) / width) * windowDuration;
                time = Math.max(previewState.windowStart, Math.min(previewState.windowEnd, time));

                let handle;
                if (previewState.dragHandle === 'start') {
                    previewState.startTime = Math.min(time, previewState.endTime - 0.1);
                    startInput.value = previewState.startTime.toFixed(2);
                    handle = startHandle;
                } else {
                    previewState.endTime = Math.max(time, previewState.startTime + 0.1);
                    endInput.value = previewState.endTime.toFixed(2);
                    handle = endHandle;
                }

                // Cheap: move only the dragged handle + the selection band now, for smooth tracking.
                const t = previewState.dragHandle === 'start' ? previewState.startTime : previewState.endTime;
                handle.style.left = `${((t - previewState.windowStart) / windowDuration) * width}px`;
                updateSelectionBand();
                applyPlaybackRange();   // a running loop adopts the new bounds without breaking
                updateDurationDisplay();

                // Expensive token layer + text highlight: at most once per animation frame.
                if (!previewState.dragRaf) {
                    previewState.dragRaf = requestAnimationFrame(() => {
                        previewState.dragRaf = null;
                        populateTextOverlay();
                        updateTextHighlightFromTime();
                    });
                }
            };

            const stopDrag = () => {
                if (!previewState.isDragging) return;
                previewState.isDragging = false;
                previewState.dragHandle = null;
                if (previewState.dragRaf) { cancelAnimationFrame(previewState.dragRaf); previewState.dragRaf = null; }
                updateHandlePositions();
                updateTextHighlightFromTime();

                // The drag may have moved a boundary past the playhead, leaving playback outside the
                // selection (audible as audio from before the new start). Re-cut from the new start;
                // playPreview() with a null pausedAt begins at startTime. On release, not per
                // mousemove — the boundary repeatedly overtakes the playhead while dragging.
                if (previewState.isPlaying &&
                    (previewState.playPos < previewState.startTime || previewState.playPos >= previewState.endTime)) {
                    stopPreview();
                    playPreview();
                }
            };

            // Remove old listeners by cloning
            startHandle.replaceWith(startHandle.cloneNode(true));
            endHandle.replaceWith(endHandle.cloneNode(true));

            // Get fresh references after cloning
            const { startHandle: newStart, endHandle: newEnd, canvas } = getWaveformEls();

            newStart.addEventListener('mousedown', (e) => startDrag(e, 'start'));
            newEnd.addEventListener('mousedown', (e) => startDrag(e, 'end'));

            const onCanvasClick = (e) => {
                e.stopPropagation();
                e.preventDefault();
                if (previewState.isDragging) return;
                const rect = canvas.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const width = canvas.clientWidth;
                const windowDuration = previewState.windowEnd - previewState.windowStart;
                let clickTime = previewState.windowStart + (x / width) * windowDuration;
                clickTime = Math.max(previewState.windowStart, Math.min(previewState.windowEnd, clickTime));
                if (clickTime >= previewState.startTime && clickTime <= previewState.endTime) {
                    seekToTime(clickTime);
                }
            };

            // Drop the previous set before binding a new one, so listeners don't accumulate
            // across the many setupDragHandlers calls (which would multiply per-move work).
            if (_dragListeners) {
                document.removeEventListener('mousemove', _dragListeners.move);
                document.removeEventListener('mouseup', _dragListeners.up);
                _dragListeners.canvas?.removeEventListener('click', _dragListeners.click);
            }
            _dragListeners = { move: onDrag, up: stopDrag, canvas, click: onCanvasClick };
            document.addEventListener('mousemove', onDrag);
            document.addEventListener('mouseup', stopDrag);

            // Add click-to-seek on waveform
            canvas.style.cursor = 'pointer';
            canvas.addEventListener('click', onCanvasClick);
        }
        
        // Seek to a specific time within the slice
        function seekToTime(absoluteTime) {
            const wasPlaying = previewState.isPlaying;

            // Stop current playback without clearing pausedAt
            if (previewState.audioSource) {
                try {
                    // Remove onended handler to prevent it from calling stopPreview
                    previewState.audioSource.onended = null;
                    previewState.audioSource.stop();
                } catch (e) {
                    // Already stopped
                }
                previewState.audioSource = null;
            }
            previewState.isPlaying = false;
            releaseAudioContext();

            // Store the seek position (absolute time in the source buffer)
            previewState.pausedAt = absoluteTime;
            previewState.playPos = absoluteTime;
            previewState.isPaused = true;

            // Position the playhead (window-relative, like the handles)
            const { canvas, playhead, playBtn, pauseBtn } = getWaveformEls();
            const width = canvas.clientWidth;
            const windowDuration = previewState.windowEnd - previewState.windowStart;
            const playheadX = ((absoluteTime - previewState.windowStart) / windowDuration) * width;
            playhead.style.left = `${playheadX}px`;
            playhead.classList.add('playing');

            if (wasPlaying) {
                playPreview();
            } else {
                playBtn.style.display = 'inline-flex';
                pauseBtn.style.display = 'none';
            }
        }
        
        // Update duration display
        function updateDurationDisplay() {
            const duration = previewState.endTime - previewState.startTime;
            const { durationEl } = getWaveformEls();
            if (durationEl) durationEl.textContent = `${duration.toFixed(2)}s`;
        }

        // Update preview from manual time inputs
        window.updatePreviewFromInputs = function() {
            const { startInput, endInput } = getWaveformEls();

            let start = parseFloat(startInput.value);
            let end = parseFloat(endInput.value);

            const duration = activeOriginalBuffer().duration;
            start = Math.max(0, Math.min(duration, start));
            end = Math.max(start + 0.1, Math.min(duration, end));

            previewState.startTime = start;
            previewState.endTime = end;
            startInput.value = start.toFixed(2);
            endInput.value = end.toFixed(2);
            updateDurationDisplay();

            // If the new times go outside the current window, recompute and redraw
            if (start < previewState.windowStart || end > previewState.windowEnd) {
                const { windowStart, windowEnd } = computeWindow(start, end);
                previewState.windowStart = windowStart;
                previewState.windowEnd = windowEnd;
                drawWaveform().then(() => updateHandlePositions());
            } else {
                updateHandlePositions();
            }
            updateTextHighlightFromTime();
        };

        // Toggle playback of preview
        window.togglePreviewPlayback = function() {
            if (previewState.isPlaying) {
                pausePreview();
            } else {
                playPreview();
            }
        };
        
        // Non-loop playback has to end at endTime (the source node would otherwise run on to the end
        // of the whole file). stop() is re-callable — the last scheduled time wins — so this can be
        // re-armed whenever the range or the rate changes mid-playback.
        function scheduleStop() {
            const { audioSource: s, audioContext: ctx } = previewState;
            if (!s || !ctx || previewState.isLooping) return;
            const remaining = (previewState.endTime - previewState.playPos) / previewState.playbackSpeed;
            try { s.stop(ctx.currentTime + Math.max(0, remaining)); } catch (e) { /* already stopped */ }
        }

        // Live bound update: a running source adopts the new selection in place, so dragging a
        // handle doesn't interrupt playback (and a loop keeps looping over the new range).
        function applyPlaybackRange() {
            const s = previewState.audioSource;
            if (!s || !previewState.isPlaying) return;
            s.loopStart = previewState.startTime;
            s.loopEnd = previewState.endTime;
            if (!previewState.isLooping) scheduleStop();
        }

        window.playPreview = function() {
            const oab = activeOriginalBuffer();
            if (!oab) return;

            // Starting Engine A stops Engine B — silence any playing slice preview.
            // (Can't use stopAllPlayback(): stopPreview would kill the preview we're starting.)
            document.querySelectorAll('#slices-list audio').forEach(a => a.pause());

            const audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // Resume where we paused/seeked, but only if that's still inside the selection.
            let pos = previewState.pausedAt;
            if (pos == null || pos < previewState.startTime || pos >= previewState.endTime) {
                pos = previewState.startTime;
            }

            // Play the source buffer itself (no copy) so loopStart/loopEnd stay live-assignable.
            const source = audioContext.createBufferSource();
            source.buffer = oab;
            source.loop = previewState.isLooping;
            source.loopStart = previewState.startTime;
            source.loopEnd = previewState.endTime;
            source.playbackRate.value = previewState.playbackSpeed;
            source.connect(audioContext.destination);
            source.start(0, pos);

            previewState.audioSource = source;
            previewState.audioContext = audioContext;
            previewState.playPos = pos;
            previewState.lastFrameAt = audioContext.currentTime;
            previewState.pausedAt = null;
            previewState.isPlaying = true;
            previewState.isPaused = false;

            if (!previewState.isLooping) {
                source.onended = () => stopPreview();
                scheduleStop();
            }

            // Update buttons
            const { playBtn, pauseBtn, playhead } = getWaveformEls();
            playBtn.style.display = 'none';
            pauseBtn.style.display = 'inline-flex';

            // Show and animate playhead
            playhead.classList.add('playing');
            animatePlayhead();
        };
        
        window.pausePreview = function() {
            if (!previewState.isPlaying) return;

            // Resume point is wherever the playhead got to (absolute time in the source).
            previewState.pausedAt = previewState.playPos;

            // Stop the audio
            if (previewState.audioSource) {
                try {
                    // Remove onended handler to prevent it from calling stopPreview
                    previewState.audioSource.onended = null;
                    previewState.audioSource.stop();
                } catch (e) {
                    // Already stopped
                }
                previewState.audioSource = null;
            }

            previewState.isPlaying = false;
            previewState.isPaused = true;
            releaseAudioContext();

            // Update buttons
            const { playBtn: pPlayBtn, pauseBtn: pPauseBtn } = getWaveformEls();
            pPlayBtn.style.display = 'inline-flex';
            pPauseBtn.style.display = 'none';
        };

        // A context is created per play; browsers cap how many can exist, so let each one go.
        // Only safe once isPlaying is false — animatePlayhead reads audioContext.currentTime.
        function releaseAudioContext() {
            const ctx = previewState.audioContext;
            previewState.audioContext = null;
            if (ctx) ctx.close().catch(() => { /* already closed */ });
        }

        window.stopPreview = function() {
            if (previewState.audioSource) {
                try {
                    previewState.audioSource.onended = null;
                    previewState.audioSource.stop();
                } catch (e) {
                    // Already stopped
                }
                previewState.audioSource = null;
            }

            previewState.isPlaying = false;
            previewState.isPaused = false;
            previewState.pausedAt = null;
            previewState.playPos = null;
            previewState.lastFrameAt = null;
            releaseAudioContext();

            // Update buttons
            const { playBtn: sPlayBtn, pauseBtn: sPauseBtn, playhead: sPlayhead } = getWaveformEls();
            sPlayBtn.style.display = 'inline-flex';
            sPauseBtn.style.display = 'none';

            // Hide playhead
            sPlayhead.classList.remove('playing');
        };

        // Silence every playback surface: Engine A (Web Audio preview / edit, via stopPreview)
        // + Engine B (the per-slice native <audio> elements). Single source of truth for
        // "stop everything" — the two engines are otherwise unaware of each other.
        function stopAllPlayback() {
            stopPreview();
            document.querySelectorAll('#slices-list audio').forEach(a => a.pause());
        }

        window.toggleLoop = function() {
            previewState.isLooping = !previewState.isLooping;
            const { loopBtn } = getWaveformEls();
            
            if (previewState.isLooping) {
                loopBtn.classList.add('active');
                loopBtn.title = 'Loop enabled';
            } else {
                loopBtn.classList.remove('active');
                loopBtn.title = 'Loop playback';
            }
            
            // A scheduled stop() can't be cancelled, so we can't just flip source.loop while playing
            // (the pending stop at endTime would still fire). Re-cut from the current position —
            // seamless, since playPreview resumes from pausedAt.
            if (previewState.isPlaying) {
                const pos = previewState.playPos;
                stopPreview();
                previewState.pausedAt = pos;
                playPreview();
            }
        };

        window.updatePlaybackSpeed = function() {
            const { speedSelect } = getWaveformEls();
            previewState.playbackSpeed = parseFloat(speedSelect.value);

            // If currently playing, update the playback rate
            if (previewState.audioSource && previewState.isPlaying) {
                previewState.audioSource.playbackRate.value = previewState.playbackSpeed;
                scheduleStop();   // the end boundary just moved in wall-clock time
            }
        };
        
        function computeWindow(startTime, endTime) {
            const dur = activeOriginalBuffer().duration;
            const selDur = endTime - startTime;
            const pad = Math.min(Math.max(1, selDur * 0.25), 5);
            return {
                windowStart: Math.max(0, startTime - pad),
                windowEnd: Math.min(dur, endTime + pad)
            };
        }

        function enterOverviewMode() {
            _currentSelectionMatch = null;
            selectionAudioMatches = [];
            selectionAudioIndex = 0;
            if (!originalAudioBuffer) return;
            // A new selection restarts playback from its start (and clears any stale pause point,
            // which is an absolute time inside the *previous* selection).
            const wasPlaying = previewState.isPlaying;
            if (previewState.isPlaying || previewState.isPaused) stopPreview();
            previewState.windowStart = 0;
            previewState.windowEnd = originalAudioBuffer.duration;
            previewState.startTime = 0;
            previewState.endTime = originalAudioBuffer.duration;
            // Reset nav buttons and label
            document.getElementById('prev-btn').disabled = true;
            document.getElementById('next-btn').disabled = true;
            document.getElementById('search-results-label').textContent = '';
            previewState.editingSliceIndex = null;
            const { startHandle: ovStart, endHandle: ovEnd, startInput: ovSI, endInput: ovEI, selection: ovSel } = getWaveformEls();
            ovSI.value = (0).toFixed(2);
            ovEI.value = originalAudioBuffer.duration.toFixed(2);
            ovSI.max = originalAudioBuffer.duration;
            ovEI.max = originalAudioBuffer.duration;
            updateDurationDisplay();
            ovStart.style.display = 'block';
            ovEnd.style.display = 'block';
            if (ovSel) ovSel.style.display = 'block';
            document.getElementById('create-slice-btn').disabled = false;
            if (wasPlaying) playPreview();
            drawWaveform().then(() => {
                updateHandlePositions();
                setupDragHandlers();
                updateTextHighlightFromTime();
            });
        }

        // Open with the first few words selected, so the text→waveform zoom (the core workflow)
        // is immediately visible instead of a full-file overview. Falls back to overview if
        // there's no usable text; handleTranscriptionSelection falls back too if no audio match.
        function selectFirstPhrase(wordCount = 3) {
            const ta = document.getElementById('transcription-text');
            if (!ta || !currentTranscription || !originalAudioBuffer) { enterOverviewMode(); return; }
            const m = ta.value.match(new RegExp(`^\\s*\\S+(?:\\s+\\S+){0,${wordCount - 1}}`));
            if (!m || !m[0].trim()) { enterOverviewMode(); return; }
            ta.setSelectionRange(0, m[0].length);
            handleTranscriptionSelection(); // highlight + zoom + handles + enable Create Slice
        }

        function enterSelectionMode(startTime, endTime) {
            // A new selection restarts playback from its start (and clears any stale pause point,
            // which is an absolute time inside the *previous* selection).
            const wasPlaying = previewState.isPlaying;
            if (previewState.isPlaying || previewState.isPaused) stopPreview();

            const { windowStart, windowEnd } = computeWindow(startTime, endTime);
            previewState.startTime = startTime;
            previewState.endTime = endTime;
            previewState.windowStart = windowStart;
            previewState.windowEnd = windowEnd;
            const { startInput: selStart, endInput: selEnd, startHandle: selSH, endHandle: selEH, selection: selBand } = getWaveformEls();
            selStart.value = startTime.toFixed(2);
            selEnd.value = endTime.toFixed(2);
            const _oabDur = activeOriginalBuffer().duration;
            selStart.max = _oabDur;
            selEnd.max = _oabDur;
            updateDurationDisplay();
            selSH.style.display = 'block';
            selEH.style.display = 'block';
            if (selBand) selBand.style.display = 'block';
            if (wasPlaying) playPreview();
            drawWaveform().then(() => {
                updateHandlePositions();
                setupDragHandlers();
                updateTextHighlightFromTime();
            });
        }

        // Scroll the textarea + overlay so `span` (a node inside #highlight-layer) is visible.
        // Only scrolls when the target is above/below the current view, so a manually-selected
        // (already-visible) word is left in place. offsetTop is accurate for soft-wrapped text.
        function scrollHighlightIntoView(span) {
            const ta = document.getElementById('transcription-text');
            const hl = document.getElementById('highlight-layer');
            if (!ta || !hl || !span) return;
            const top = span.offsetTop;
            const bottom = top + span.offsetHeight;
            const viewTop = ta.scrollTop;
            const viewBottom = viewTop + ta.clientHeight;
            let next = viewTop;
            if (top < viewTop) next = top - 8;
            else if (bottom > viewBottom) next = bottom - ta.clientHeight + 8;
            next = Math.max(0, next);
            ta.scrollTop = next;
            hl.scrollTop = ta.scrollTop;
            hl.scrollLeft = ta.scrollLeft;
        }

        function updateTextHighlightFromTime() {
            const tr = activeTranscription();
            if (!tr) return;
            const chunks = tr.chunks || tr.allTokens;
            if (!chunks || chunks.length === 0) return;

            // Slice label for the current [startTime,endTime] range, from the ACTIVE transcription
            // (edit file while the modal is open, tab file otherwise). Used by saveEditedSlice.
            const inRange = chunks.filter(c => c.timestamp &&
                c.timestamp[0] < previewState.endTime &&
                (c.timestamp[1] ?? c.timestamp[0]) > previewState.startTime);
            if (inRange.length) {
                previewState.selectedText = inRange
                    .map(c => (c.text || '').trim()).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
            }

            // Everything below is the transcription tab's textarea highlight overlay only.
            if (waveformContext !== 'transcription') return;

            const ta = document.getElementById('transcription-text');
            if (!ta) return;

            const text = ta.value;
            let charPos = 0;
            let firstChunkStart = -1;
            let lastChunkEnd = -1;

            for (const chunk of chunks) {
                const chunkText = chunk.text?.trim();
                if (!chunkText || !chunk.timestamp) continue;
                const t0 = chunk.timestamp[0];
                const t1 = chunk.timestamp[1];
                const idx = text.indexOf(chunkText, charPos);
                if (idx === -1) continue;
                if (t0 < previewState.endTime && t1 > previewState.startTime) {
                    if (firstChunkStart === -1) firstChunkStart = idx;
                    lastChunkEnd = idx + chunkText.length;
                }
                charPos = idx + 1;
            }

            const highlightLayer = document.getElementById('highlight-layer');
            if (!highlightLayer) return;

            const computedStyle = window.getComputedStyle(ta);
            highlightLayer.style.fontFamily = computedStyle.fontFamily;
            highlightLayer.style.fontSize = computedStyle.fontSize;
            highlightLayer.style.lineHeight = computedStyle.lineHeight;
            highlightLayer.style.letterSpacing = computedStyle.letterSpacing;
            highlightLayer.style.wordSpacing = computedStyle.wordSpacing;

            if (firstChunkStart === -1) {
                highlightLayer.innerHTML = escapeHTML(text);
                return;
            }

            // One span for the whole range: an even accent tint, with the green/red start and end
            // markers drawn as inset box-shadows (see .range-body) rather than per-word fills.
            highlightLayer.innerHTML =
                escapeHTML(text.substring(0, firstChunkStart)) +
                '<span class="range-body">' + escapeHTML(text.substring(firstChunkStart, lastChunkEnd)) + '</span>' +
                escapeHTML(text.substring(lastChunkEnd));

            if (document.activeElement === ta && ta.selectionStart !== ta.selectionEnd) {
                ta.setSelectionRange(ta.selectionEnd, ta.selectionEnd);
            }
            scrollHighlightIntoView(highlightLayer.querySelector('.range-body'));
        }

        function applySelectionHighlight(start, end) {
            const textArea = document.getElementById('transcription-text');
            const highlightLayer = document.getElementById('highlight-layer');
            const text = textArea.value;
            const computedStyle = window.getComputedStyle(textArea);
            highlightLayer.style.fontFamily = computedStyle.fontFamily;
            highlightLayer.style.fontSize = computedStyle.fontSize;
            highlightLayer.style.lineHeight = computedStyle.lineHeight;
            textArea.focus();
            textArea.setSelectionRange(start, end);
            highlightLayer.innerHTML =
                escapeHTML(text.substring(0, start)) +
                '<mark>' + escapeHTML(text.substring(start, end)) + '</mark>' +
                escapeHTML(text.substring(end));
            scrollHighlightIntoView(highlightLayer.querySelector('mark'));
        }

        function handleTranscriptionSelection() {
            if (!currentTranscription || !originalAudioBuffer) return;
            const ta = document.getElementById('transcription-text');
            const userSelStart = ta.selectionStart;
            const sel = ta.value.substring(userSelStart, ta.selectionEnd).trim();
            if (!sel) return; // plain click / caret move: keep the current selection + search

            const matches = getMatchesForSelection(sel);
            if (!matches || matches.length === 0) { enterOverviewMode(); return; }

            // Annotate each audio match with its char position in the textarea text
            const textLower = ta.value.toLowerCase();
            const selLower = sel.toLowerCase();
            let searchPos = 0;
            for (const m of matches) {
                const idx = textLower.indexOf(selLower, searchPos);
                if (idx !== -1) {
                    m.charStart = idx;
                    m.charEnd = idx + sel.length;
                    searchPos = idx + 1;
                }
            }

            // Find the match closest to where the user actually selected
            let bestIndex = 0;
            let bestDist = Infinity;
            for (let i = 0; i < matches.length; i++) {
                if (matches[i].charStart !== undefined) {
                    const dist = Math.abs(matches[i].charStart - userSelStart);
                    if (dist < bestDist) { bestDist = dist; bestIndex = i; }
                }
            }

            selectionAudioMatches = matches;
            selectionAudioIndex = bestIndex;
            previewState.selectedText = sel;

            // When called from search box navigation, leave the label/buttons alone — they're already set
            if (!searchActive) {
                const prevBtn = document.getElementById('prev-btn');
                const nextBtn = document.getElementById('next-btn');
                const label = document.getElementById('search-results-label');
                prevBtn.disabled = matches.length <= 1;
                nextBtn.disabled = matches.length <= 1;
                label.textContent = matches.length > 1 ? `${bestIndex + 1}/${matches.length}` : '';
            }

            if (previewState.editingSliceIndex === null) {
                document.getElementById('create-slice-btn').disabled = false;
            }
            const match = matches[bestIndex];
            enterSelectionMode(match.startTime / 1000, match.endTime / 1000);
        }

        document.addEventListener('mouseup', (e) => {
            if (e.target.id === 'transcription-text') handleTranscriptionSelection();
        });
        document.addEventListener('keyup', (e) => {
            if (e.target.id === 'transcription-text') handleTranscriptionSelection();
        });
        document.addEventListener('mousedown', (e) => {
            if (e.target.closest('.textarea-wrapper') || e.target.closest('#transcription-waveform-section')) return;
            const _hl = document.getElementById('highlight-layer');
            const _ta = document.getElementById('transcription-text');
            if (_hl && _ta && _hl.querySelector('mark')) _hl.innerHTML = escapeHTML(_ta.value);
        });

        document.addEventListener('click', (e) => {
            if (e.target.closest('#create-slice-btn')) createSlice();
            // Slices-tab selection toolbar
            if (e.target.closest('#slices-select-all-btn')) toggleSelectAllSlices();
            if (e.target.closest('#export-slices-btn')) exportSelectedSlices();
            // Inline slice-editor buttons
            if (e.target.closest('#edit-cancel-btn')) closeSliceEditor();
            if (e.target.closest('#edit-update-btn')) saveEditedSlice(false).then(() => closeSliceEditor());
            if (e.target.closest('#edit-save-as-new-btn')) saveEditedSlice(true).then(() => closeSliceEditor());
            // Inline slice-editor transport
            if (e.target.closest('#edit-preview-play-btn')) playPreview();
            if (e.target.closest('#edit-preview-stop-btn')) stopPreview();
            if (e.target.closest('#edit-preview-pause-btn')) pausePreview();
            if (e.target.closest('#edit-preview-loop-btn')) toggleLoop();
        });

        document.addEventListener('change', (e) => {
            if (e.target.id === 'edit-preview-start-time' || e.target.id === 'edit-preview-end-time') updatePreviewFromInputs();
            if (e.target.id === 'edit-playback-speed') updatePlaybackSpeed();
        });
        
        function animatePlayhead() {
            if (!previewState.isPlaying) return;

            const { playhead, canvas } = getWaveformEls();
            const width = canvas.clientWidth;

            // Advance an absolute position rather than inferring progress through a fixed slice —
            // the bounds can move under us mid-playback (handle drag).
            const now = previewState.audioContext.currentTime;
            let pos = previewState.playPos + (now - previewState.lastFrameAt) * previewState.playbackSpeed;
            previewState.lastFrameAt = now;

            const s = previewState.startTime, e = previewState.endTime;
            if (previewState.isLooping && e > s && pos >= e) {
                pos = s + ((pos - e) % (e - s));   // mirrors the source node's own loop wrap
            }
            previewState.playPos = pos;

            const windowDuration = previewState.windowEnd - previewState.windowStart;
            playhead.style.left = `${((pos - previewState.windowStart) / windowDuration) * width}px`;

            // Continue animation
            if (previewState.isPlaying) {
                requestAnimationFrame(animatePlayhead);
            }
        }
        
        
        // ── Slice naming / export filenames ─────────────────────────────────────────
        const DEFAULT_FILENAME_TEMPLATE = '{source}_{index}_{slug}';

        // Readable, filesystem-safe slug of some transcript/name text.
        function slugify(text) {
            const s = (text || '').toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-+|-+$/g, '')
                .slice(0, 40)
                .replace(/-+$/g, '');
            return s || 'slice';
        }

        // Sanitize a single filename component (keeps case; strips illegal chars).
        function sanitizeFilenamePart(s) {
            return (s || '')
                .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-')
                .replace(/^[-_.]+|[-_.]+$/g, '')
                .slice(0, 80);
        }

        function getFilenameTemplate() {
            return localStorage.getItem('vocalslice-filename-template') || DEFAULT_FILENAME_TEMPLATE;
        }

        const _basename = p => (p ? p.split(/[/\\]/).pop() : '');
        const _stripExt = n => n.replace(/\.[^.]+$/, '');

        // Build the export/download filename for a slice from the user's template.
        function buildSliceFilename(slice, index) {
            const source = sanitizeFilenamePart(_stripExt(_basename(slice.sourceAudioPath))) || 'audio';
            const tokens = {
                source,
                index: String(index + 1).padStart(3, '0'),
                slug: slugify(slice.name || slice.text),
                start: ((slice.startTime || 0) / 1000).toFixed(2),
                end: ((slice.endTime || 0) / 1000).toFixed(2),
            };
            let name = getFilenameTemplate().replace(/\{(source|index|slug|start|end)\}/g, (_, k) => tokens[k]);
            // Final pass: strip anything illegal that the template literals introduced.
            name = name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/^[-_.]+|[-_.]+$/g, '').slice(0, 120);
            return (name || 'slice') + '.wav';
        }

        // Pair each slice's stored file with the name the user's template wants. Main copies rather
        // than renames, so this is what both "Export selected" and drag-out hand over. Slices with
        // no saved file (browser, or the save failed) drop out — there's nothing on disk to give.
        function sliceExportItems(indices) {
            return indices
                .filter(i => slices[i] && slices[i].filePath)
                .map(i => ({ filePath: slices[i].filePath, fileName: buildSliceFilename(slices[i], i) }));
        }

        const selectedIndices = () => [...selectedSlices].sort((a, b) => a - b);

        // Regions of a slice card that must NOT start a drag-out. Anything interactive added inside
        // a slice item needs to be covered here, or grabbing it will fling the file at the desktop.
        const DRAG_EXCLUDED = '.transport-controls, .waveform-container, .slice-editor-slot, input, select, button, a';

        // Keeps the toolbar honest after any list rebuild (sort change, rename, restore, delete).
        function updateSelectionBar() {
            const count = selectedSlices.size;
            const countEl = document.getElementById('slices-selected-count');
            const exportBtn = document.getElementById('export-slices-btn');
            const selectAllBtn = document.getElementById('slices-select-all-btn');
            // Once anything is ticked, every card shows its checkbox instead of its #N badge —
            // otherwise you'd have to hover each one to see what's still selected.
            document.getElementById('slices-list')?.classList.toggle('slices-selecting', count > 0);
            if (countEl) countEl.textContent = count ? `${count} selected` : '';
            if (exportBtn) exportBtn.disabled = count === 0;
            if (selectAllBtn) selectAllBtn.textContent = count === slices.length && count > 0 ? 'Clear' : 'Select all';
        }

        function toggleSelectAllSlices() {
            if (selectedSlices.size === slices.length) selectedSlices.clear();
            else slices.forEach((_, i) => selectedSlices.add(i));
            updateSlicesList();
        }

        async function exportSelectedSlices() {
            if (!window.electronAPI || selectedSlices.size === 0) return;
            const items = sliceExportItems(selectedIndices());
            if (items.length === 0) {
                alert('None of the selected slices have a saved file to export.');
                return;
            }
            try {
                const result = await window.electronAPI.exportSlices(items);
                if (!result) return;                       // user cancelled the folder picker
                addLog(`📁 Exported ${result.written} slice(s) to ${result.dir}`);
                showToast(result.skipped
                    ? `Exported ${result.written} slice(s) — ${result.skipped} couldn't be exported`
                    : `Exported ${result.written} slice(s)`, { icon: 'ph ph-folder-open' });
            } catch (error) {
                addLog(`❌ Export failed: ${error.message}`);
                alert(`Export failed.\n\n${error.message}`);
            }
        }

        // Shared audio extraction + save logic used by createSlice and updateSlice
        async function buildSliceEntry(startTime, endTime, text, name) {
            addLog(`🎵 Exporting slice at source quality...`);
            const blob = await exportSourceQualitySlice(startTime, endTime);
            if (!blob || blob.size <= 44) throw new Error('Failed to extract audio slice');
            addLog(`✅ WAV created: ${(blob.size / 1024).toFixed(1)}KB`);
            const url = URL.createObjectURL(blob);

            let filePath = null;
            if (window.electronAPI) {
                try {
                    const fileName = `slice_${Date.now()}_${startTime.toFixed(2)}-${endTime.toFixed(2)}.wav`;
                    filePath = await window.electronAPI.saveSliceFile(fileName, await blob.arrayBuffer());
                    addLog(`💾 Slice saved to: ${fileName}`);
                } catch (error) {
                    addLog('⚠️ Slice not saved to disk (will be lost on restart)');
                }
            }

            const sliceDuration = endTime - startTime;
            const _tr = activeTranscription();
            const chunks = (_tr?.chunks || _tr?.allTokens || [])
                .filter(c => c.timestamp && (c.timestamp[1] ?? c.timestamp[0]) > startTime && c.timestamp[0] < endTime)
                .map(c => ({
                    text: c.text,
                    timestamp: [
                        Math.max(0, c.timestamp[0] - startTime),
                        Math.min(sliceDuration, (c.timestamp[1] ?? c.timestamp[0]) - startTime)
                    ]
                }));

            return { text, name: name || slugify(text), startTime: startTime * 1000, endTime: endTime * 1000,
                     start: startTime, end: endTime, url, blob, filePath,
                     sourceAudioPath: activeFile()?.path || null, chunks };
        }

        // Transient toast notification. `onClick` (optional) makes the whole toast clickable.
        function showToast(message, { onClick, duration = 3500, icon: iconClass = 'ph ph-check-circle' } = {}) {
            const container = document.getElementById('toast-container');
            if (!container) return;
            const toast = document.createElement('div');
            toast.className = 'toast' + (onClick ? ' toast-clickable' : '');
            const icon = document.createElement('i');
            icon.className = iconClass;
            toast.appendChild(icon);
            toast.appendChild(document.createTextNode(' ' + message));
            if (onClick) {
                const caret = document.createElement('i');
                caret.className = 'ph ph-caret-right toast-caret';
                toast.appendChild(caret);
            }
            container.appendChild(toast);
            requestAnimationFrame(() => toast.classList.add('show'));
            let done = false;
            const dismiss = () => {
                if (done) return;
                done = true;
                toast.classList.remove('show');
                setTimeout(() => toast.remove(), 220);
            };
            let timer = setTimeout(dismiss, duration);
            if (onClick) toast.addEventListener('click', () => { onClick(); dismiss(); });
            toast.addEventListener('mouseenter', () => clearTimeout(timer));
            toast.addEventListener('mouseleave', () => { timer = setTimeout(dismiss, 1200); });
            return toast;
        }

        // Auto-update: when a new version has finished downloading, offer a restart. Non-nagging —
        // it installs on next quit anyway (main process), so this toast is just an accelerator. Long
        // duration and clickable; if ignored it fades and the update lands whenever the app closes.
        if (window.electronAPI && window.electronAPI.onUpdateStatus) {
            window.electronAPI.onUpdateStatus((status) => {
                if (status && status.state === 'downloaded') {
                    showToast('Update ready — restart to apply', {
                        icon: 'ph ph-arrow-clockwise',
                        duration: 12000,
                        onClick: () => window.electronAPI.restartToUpdate(),
                    });
                }
            });
        }

        // After an update has actually landed, point at what changed. Deliberately here rather than
        // on the "Update ready" toast above: that one fires while the user is still running the OLD
        // version, so the notes would describe something they haven't got yet.
        //
        // Silent on a first run — a fresh install has no stored version, and someone who has never
        // seen the app doesn't need a "what's new". Only an actual change announces itself.
        const LAST_SEEN_VERSION_KEY = 'lastSeenVersion';
        async function notifyIfUpdated() {
            if (!window.electronAPI?.getAppInfo) return;
            let current;
            try {
                const info = await window.electronAPI.getAppInfo();
                current = info?.displayVersion;
            } catch (e) { return; }
            if (!current) return;

            const seen = localStorage.getItem(LAST_SEEN_VERSION_KEY);
            localStorage.setItem(LAST_SEEN_VERSION_KEY, current);
            if (!seen || seen === current) return;

            showToast(`Updated to ${current} — see what's new`, {
                icon: 'ph ph-sparkle',
                duration: 12000,
                onClick: () => {
                    switchTab('settings');
                    switchSettingsPanel('about');
                    document.getElementById('whats-new-section')?.scrollIntoView({ block: 'nearest' });
                },
            });
        }
        notifyIfUpdated();

        // Nudge the user to re-transcribe after a setting that changes the output (model/language)
        // — only when there's an existing transcription to re-apply it to.
        function promptRetranscribe(reason) {
            if (!currentTranscription || !currentFile) return;
            // Replace any existing re-transcribe prompt so they don't stack.
            document.querySelectorAll('#toast-container .toast-retranscribe').forEach(el => el.remove());
            const t = showToast(`${reason} — re-transcribe to apply`, {
                duration: 6000,
                icon: 'ph ph-arrow-clockwise',
                onClick: () => {
                    switchTab('transcription', document.getElementById('transcription-tab-btn'));
                    handleTranscribe();
                }
            });
            if (t) t.classList.add('toast-retranscribe');
        }

        // Create a new slice from the current waveform handle positions
        window.createSlice = async function() {
            if (!originalAudioBuffer || !currentAudioBuffer) return;
            try {
                stopPreview();
                const { startTime, endTime, selectedText } = previewState;
                addLog(`🎵 Creating slice: "${selectedText}"`);
                const entry = await buildSliceEntry(startTime, endTime, selectedText);
                slices.push(entry);
                addLog(`✅ Added slice #${slices.length}: "${selectedText}"`);
                // This file now has a slice → cache its transcription for later editing
                cacheTranscription(currentFile?.path, currentTranscription);
                updateSlicesList();
                saveSessionState();
                // Flash button green briefly as confirmation
                const btn = document.getElementById('create-slice-btn');
                if (btn) {
                    btn.style.background = 'var(--green)';
                    setTimeout(() => btn.style.background = '', 700);
                }
                // Direct the user to where the slice went (Slices tab).
                showToast('Slice created — view in Slices tab', {
                    onClick: () => switchTab('slices', document.getElementById('slices-tab-btn'))
                });
            } catch (error) {
                console.error('Error creating slice:', error);
                alert('Failed to create slice: ' + error.message);
            }
        };

        // Update an existing slice (save) or save as new from edit mode
        window.saveEditedSlice = async function(saveAsNew = false) {
            if (!activeOriginalBuffer() || !activeAudioBuffer()) return;
            try {
                stopPreview();
                const { startTime, endTime, selectedText, editingSliceIndex } = previewState;
                // Keep a manually-renamed name; let auto-named slices follow the new selection's text.
                const old = (!saveAsNew && editingSliceIndex !== null) ? slices[editingSliceIndex] : null;
                const keepName = (old && old.name && old.name !== slugify(old.text)) ? old.name : undefined;
                const entry = await buildSliceEntry(startTime, endTime, selectedText, keepName);

                if (!saveAsNew && editingSliceIndex !== null) {
                    if (slices[editingSliceIndex].url) URL.revokeObjectURL(slices[editingSliceIndex].url);
                    slices.splice(editingSliceIndex, 1, entry);
                    addLog(`✏️ Updated slice: "${selectedText}"`);
                } else {
                    slices.push(entry);
                    addLog(`➕ Saved as new slice: "${selectedText}"`);
                }

                // The edited slice's source file now has a slice → cache its transcription (edit-local)
                cacheTranscription(activeFile()?.path, activeTranscription());
                // Clear the editing index first so the rebuild below doesn't re-mount the editor
                // (the caller's closeSliceEditor() does the final teardown).
                previewState.editingSliceIndex = null;
                updateSlicesList();
                saveSessionState(); // reads the untouched tab globals → persists the tab's file + slices
            } catch (error) {
                console.error('Error saving slice:', error);
                alert('Failed to save slice: ' + error.message);
            }
        };

        // Open the inline editor for a slice, in place of that slice's preview-waveform area.
        // Works entirely from its own `editState` (audio + transcription), so the transcription
        // tab's loaded file is never touched. Cross-file slices decode their source on demand.
        window.openEditMode = async function(sliceIndex) {
            const slice = slices[sliceIndex];
            if (!slice) return;

            // Close any editor already open (this or another slice) before opening this one.
            if (previewState.editingSliceIndex != null) closeSliceEditor();

            // Entering edit mode silences whatever was playing (a slice preview, or the
            // transcription-tab preview) so only the editor can sound.
            stopAllPlayback();

            const basename = p => (p ? p.split(/[/\\]/).pop() : null);
            const sourcePath = slice.sourceAudioPath;
            const sameAsCurrent = originalAudioBuffer && currentFile?.path && sourcePath &&
                basename(sourcePath) === basename(currentFile.path);
            const legacyCurrent = !sourcePath && originalAudioBuffer; // old slice, edit against loaded file

            if (sameAsCurrent || legacyCurrent) {
                // Reuse the already-loaded tab buffers (no reload); editing reads them via editState.
                editState = {
                    file: currentFile,
                    originalBuffer: originalAudioBuffer,
                    audioBuffer: currentAudioBuffer,
                    transcription: currentTranscription
                };
            } else {
                if (!sourcePath) {
                    alert('Cannot edit this slice — its source audio is unknown.');
                    return;
                }
                try {
                    addLog(`🔄 Loading source audio for editing: ${basename(sourcePath)}`);
                    const { audioBuffer, audioData } = await loadAudioFile({ path: sourcePath }); // decode only, no Whisper, no globals
                    editState = {
                        file: { path: sourcePath, name: basename(sourcePath) },
                        originalBuffer: audioBuffer,
                        audioBuffer: audioData,
                        transcription: getCachedTranscription(sourcePath) || null
                    };
                } catch (error) {
                    console.error('Failed to load source audio for edit:', error);
                    alert(`Cannot edit this slice.\n\nIts source audio "${basename(sourcePath)}" could not be loaded (moved or deleted?).`);
                    return;
                }
            }

            // Snapshot the tab's current selection so we can restore it when the modal closes.
            editSelectionSnapshot = {
                startTime: previewState.startTime, endTime: previewState.endTime,
                windowStart: previewState.windowStart, windowEnd: previewState.windowEnd,
                selectedText: previewState.selectedText, match: previewState.match
            };

            previewState.editingSliceIndex = sliceIndex;
            previewState.selectedText = slice.text;

            mountSliceEditor(sliceIndex);

            // Draw in this same task, before the browser paints the newly-mounted editor, so
            // the waveform is present on first paint (no empty-canvas flash). drawWaveform
            // reads the container width, which forces the layout it needs — no timer required.
            waveformContext = 'modal';
            enterSelectionMode(slice.start, slice.end);
        };

        // Move the single #slice-editor panel into the given slice's item (replacing its
        // preview-waveform area via the .editing class) and show it.
        function mountSliceEditor(sliceIndex) {
            const editor = document.getElementById('slice-editor');
            const item = document.querySelector(`#slices-list .slice-item[data-slice-index="${sliceIndex}"]`);
            if (!editor || !item) return;
            item.classList.add('editing');
            // Editing implies the expanded state: mark the preview expanded (so it shows +
            // draws when the edit ends) and flip the toggle caret to match.
            const previewContainer = item.querySelector(':scope > .waveform-container');
            if (previewContainer) previewContainer.style.display = '';
            const toggle = item.querySelector('.slice-waveform-toggle');
            if (toggle) { toggle.innerHTML = '<i class="ph ph-caret-up"></i>'; toggle.title = 'Hide waveform'; }
            const slot = item.querySelector('.slice-editor-slot') || item;
            slot.appendChild(editor);
            editor.style.display = '';
        }

        function closeSliceEditor() {
            stopAllPlayback(); // leaving edit mode silences everything, not just Engine A
            waveformContext = 'transcription';
            const editedIndex = previewState.editingSliceIndex;
            // Return the editor panel to its hidden holder (never destroyed by list rebuilds).
            const editor = document.getElementById('slice-editor');
            const holder = document.getElementById('slice-editor-holder');
            if (editor && holder) { editor.style.display = 'none'; holder.appendChild(editor); }
            document.querySelectorAll('#slices-list .slice-item.editing').forEach(el => el.classList.remove('editing'));
            previewState.editingSliceIndex = null;
            // Discard the editor's state (tab globals were never touched) and restore the
            // tab's selection that the editor overwrote.
            editState = null;
            if (editSelectionSnapshot) {
                Object.assign(previewState, editSelectionSnapshot);
                editSelectionSnapshot = null;
            }
            // Un-hiding the preview (removed .editing) leaves its canvas needing a redraw;
            // do it synchronously at the now-correct width so there's no ResizeObserver-lagged
            // flash (same fix as the expand path). Only relevant if the preview was expanded.
            if (editedIndex != null) {
                const item = document.querySelector(`#slices-list .slice-item[data-slice-index="${editedIndex}"]`);
                const container = item?.querySelector('.waveform-container');
                const canvas = container?.querySelector('canvas');
                if (canvas?._redraw && container.style.display !== 'none') canvas._redraw();
            }
        }
        
        function findFirstMatchingChunk(searchText, transcription) {
            if (!transcription.chunks || !transcription.continuousText || !transcription.charToTokenMap) {
                addLog('⚠️ No chunks or lookup data in transcription');
                return null;
            }
            
            // Normalize search text: trim, lowercase, remove newlines (JUCE app logic)
            const searchLower = searchText.trim().toLowerCase().replace(/\n/g, '');
            
            addLog(`📊 Total words: ${transcription.chunks.length}`);
            addLog(`🔍 Searching in ${transcription.continuousText.length} chars for: "${searchLower}"`);
            
            // Find the match in the continuous text (simple string search)
            const matchPos = transcription.continuousText.indexOf(searchLower);
            
            if (matchPos === -1) {
                addLog('❌ No match found in continuous text');
                return null;
            }
            
            const matchEndPos = matchPos + searchLower.length - 1;
            
            addLog(`📍 Match found at char position ${matchPos} to ${matchEndPos}`);
            
            // Ensure positions are valid
            if (matchPos >= transcription.charToTokenMap.length || matchEndPos >= transcription.charToTokenMap.length) {
                addLog(`❌ Match position out of bounds: ${matchPos}-${matchEndPos} (map size: ${transcription.charToTokenMap.length})`);
                return null;
            }
            
            // Get token indices for start and end positions using the character-to-token map
            const startTokenIndex = transcription.charToTokenMap[matchPos];
            const endTokenIndex = transcription.charToTokenMap[matchEndPos];
            
            addLog(`📍 charToTokenMap[${matchPos}] = ${startTokenIndex}, charToTokenMap[${matchEndPos}] = ${endTokenIndex}`);
            
            // Validate token indices
            if (startTokenIndex >= transcription.chunks.length || endTokenIndex >= transcription.chunks.length || 
                startTokenIndex === undefined || endTokenIndex === undefined) {
                addLog(`❌ Token indices invalid: ${startTokenIndex}-${endTokenIndex} (chunks: ${transcription.chunks.length})`);
                return null;
            }
            
            // Get the tokens at these indices
            const startToken = transcription.chunks[startTokenIndex];
            const endToken = transcription.chunks[endTokenIndex];
            
            addLog(`🎯 Start token ${startTokenIndex}: "${startToken.text}" @ ${startToken.timestamp[0].toFixed(3)}s`);
            addLog(`🎯 End token ${endTokenIndex}: "${endToken.text}" @ ${endToken.timestamp[1].toFixed(3)}s`);
            
            // Build the matched text from the tokens
            const matchedText = transcription.chunks
                .slice(startTokenIndex, endTokenIndex + 1)
                .map(chunk => chunk.text)
                .join('')
                .trim();
            
            addLog(`✓ Extracted tokens ${startTokenIndex}-${endTokenIndex}: "${matchedText}"`);
            addLog(`⏱️ Time: ${startToken.timestamp[0].toFixed(3)}s → ${endToken.timestamp[1].toFixed(3)}s (${(endToken.timestamp[1] - startToken.timestamp[0]).toFixed(3)}s duration)`);
            
            // Return match with timing from start and end tokens
            // Smart boundary detection: use natural token boundaries for normal speech,
            // for long gaps, use the midpoint to capture audio more reliably
            const maxGap = 0.5; // Threshold for "normal speech" gaps (500ms)
            
            let actualStartTime;
            if (startTokenIndex === 0) {
                // First token - always start from beginning of file
                actualStartTime = 0.0;
                addLog(`🎯 Start: First token, using beginning of file (0.000s)`);
            } else {
                const prevTokenEnd = transcription.chunks[startTokenIndex - 1].timestamp[1];
                const gap = startToken.timestamp[0] - prevTokenEnd;
                
                if (gap <= maxGap) {
                    // Normal speech - use end of previous token
                    actualStartTime = prevTokenEnd;
                    addLog(`🎯 Start: Natural boundary at end of prev token (${prevTokenEnd.toFixed(3)}s, gap: ${(gap * 1000).toFixed(0)}ms)`);
                } else {
                    // Long pause - use midpoint of the gap to capture word beginning
                    actualStartTime = prevTokenEnd + (gap / 2);
                    addLog(`🎯 Start: Long pause (${(gap * 1000).toFixed(0)}ms), using midpoint → ${actualStartTime.toFixed(3)}s`);
                }
            }
            
            const audioDuration = originalAudioBuffer ? originalAudioBuffer.duration : Infinity;

            let actualEndTime;
            if (endTokenIndex === transcription.chunks.length - 1) {
                // Last token - extend 500ms beyond, but never past the actual audio end
                actualEndTime = Math.min(endToken.timestamp[1] + 0.5, audioDuration);
                addLog(`🎯 End: Last token, adding 500ms buffer → ${actualEndTime.toFixed(3)}s`);
            } else {
                const nextTokenStart = transcription.chunks[endTokenIndex + 1].timestamp[0];
                const gap = nextTokenStart - endToken.timestamp[1];
                
                if (gap <= maxGap) {
                    // Normal speech - use start of next token
                    actualEndTime = nextTokenStart;
                    addLog(`🎯 End: Natural boundary at start of next token (${nextTokenStart.toFixed(3)}s, gap: ${(gap * 1000).toFixed(0)}ms)`);
                } else {
                    // Long pause - use midpoint of the gap
                    actualEndTime = endToken.timestamp[1] + (gap / 2);
                    addLog(`🎯 End: Long pause (${(gap * 1000).toFixed(0)}ms), using midpoint → ${actualEndTime.toFixed(3)}s`);
                }
            }
            
            return {
                text: matchedText,
                timestamp: [actualStartTime, actualEndTime]
            };
        }
        
        // ── Source-quality slice export ─────────────────────────────────────────────
        // WAV sources are sliced byte-exact (identical rate/depth/channels); other formats
        // are re-encoded from the decoded buffer to 24-bit WAV at the decoded (context) rate.

        let _sourceBytesCache = null; // { key, bytes } — 1 entry, avoids re-reading the same file

        // Read the raw bytes of a source file (mirrors loadAudioFile's path/File handling).
        async function readSourceBytes(file) {
            if (!file) return null;
            const key = file.path || file.name || null;
            if (_sourceBytesCache && key && _sourceBytesCache.key === key) return _sourceBytesCache.bytes;
            let bytes = null;
            try {
                if (file.path && !file.arrayBuffer && window.electronAPI) {
                    bytes = await window.electronAPI.readAudioFile(file.path);
                } else if (file.arrayBuffer) {
                    bytes = await file.arrayBuffer();
                } else if (file.path && window.electronAPI) {
                    bytes = await window.electronAPI.readAudioFile(file.path);
                }
            } catch (e) {
                addLog(`⚠️ Could not read source for lossless export: ${e.message}`);
                return null;
            }
            if (bytes && key) _sourceBytesCache = { key, bytes };
            return bytes;
        }

        // Parse a RIFF/WAVE container into its chunk table + fmt fields. Returns null if not WAV.
        function parseWavChunks(ab) {
            if (!ab || ab.byteLength < 12) return null;
            const dv = new DataView(ab);
            const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
            if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
            const chunks = [];
            let fmt = null, dataChunk = null;
            let offset = 12;
            while (offset + 8 <= ab.byteLength) {
                const id = tag(offset);
                const size = dv.getUint32(offset + 4, true);
                const bodyOffset = offset + 8;
                if (bodyOffset + size > ab.byteLength && id !== 'data') break; // malformed
                chunks.push({ id, bodyOffset, size });
                if (id === 'fmt ') {
                    fmt = {
                        audioFormat: dv.getUint16(bodyOffset, true),
                        numChannels: dv.getUint16(bodyOffset + 2, true),
                        sampleRate: dv.getUint32(bodyOffset + 4, true),
                        blockAlign: dv.getUint16(bodyOffset + 12, true),
                        bitsPerSample: dv.getUint16(bodyOffset + 14, true),
                    };
                } else if (id === 'data') {
                    dataChunk = { bodyOffset, size: Math.min(size, ab.byteLength - bodyOffset) };
                }
                offset = bodyOffset + size + (size & 1); // chunks are word-aligned
            }
            if (!fmt || !dataChunk || !fmt.blockAlign) return null;
            return { ...fmt, chunks, dataChunk };
        }

        // Rebuild a WAV containing only the [startTime,endTime] range, copying every chunk
        // verbatim except `data` (replaced by the sliced bytes) → byte-identical quality.
        function sliceWavLossless(ab, parsed, startTime, endTime) {
            const { sampleRate, blockAlign, dataChunk, chunks } = parsed;
            let startByte = Math.round(startTime * sampleRate) * blockAlign;
            let endByte = Math.round(endTime * sampleRate) * blockAlign;
            startByte = Math.max(0, Math.min(startByte, dataChunk.size));
            endByte = Math.max(startByte, Math.min(endByte, dataChunk.size));
            const sliceLen = endByte - startByte;
            const sliceBytes = new Uint8Array(ab, dataChunk.bodyOffset + startByte, sliceLen);

            let bodyTotal = 4; // 'WAVE'
            for (const c of chunks) {
                const size = c.id === 'data' ? sliceLen : c.size;
                bodyTotal += 8 + size + (size & 1);
            }
            const out = new Uint8Array(8 + bodyTotal);
            const odv = new DataView(out.buffer);
            const writeTag = (o, s) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
            writeTag(0, 'RIFF'); odv.setUint32(4, bodyTotal, true); writeTag(8, 'WAVE');
            let o = 12;
            for (const c of chunks) {
                writeTag(o, c.id);
                if (c.id === 'data') {
                    odv.setUint32(o + 4, sliceLen, true);
                    out.set(sliceBytes, o + 8);
                    o += 8 + sliceLen + (sliceLen & 1);
                } else {
                    odv.setUint32(o + 4, c.size, true);
                    out.set(new Uint8Array(ab, c.bodyOffset, c.size), o + 8);
                    o += 8 + c.size + (c.size & 1);
                }
            }
            return new Blob([out], { type: 'audio/wav' });
        }

        // Re-encode a time range of a decoded AudioBuffer to interleaved PCM WAV (default 24-bit).
        function audioBufferRangeToWav(buffer, startTime, endTime, bitDepth = 24) {
            const sampleRate = buffer.sampleRate;
            const numChannels = buffer.numberOfChannels;
            const startSample = Math.max(0, Math.floor(startTime * sampleRate));
            const endSample = Math.min(buffer.length, Math.ceil(endTime * sampleRate));
            const frames = Math.max(0, endSample - startSample);
            const bytesPerSample = bitDepth / 8;
            const blockAlign = numChannels * bytesPerSample;
            const byteRate = sampleRate * blockAlign;
            const dataLength = frames * blockAlign;

            const out = new ArrayBuffer(44 + dataLength);
            const view = new DataView(out);
            const writeString = (offset, s) => { for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i)); };
            writeString(0, 'RIFF');
            view.setUint32(4, 36 + dataLength, true);
            writeString(8, 'WAVE');
            writeString(12, 'fmt ');
            view.setUint32(16, 16, true);
            view.setUint16(20, 1, true); // PCM
            view.setUint16(22, numChannels, true);
            view.setUint32(24, sampleRate, true);
            view.setUint32(28, byteRate, true);
            view.setUint16(32, blockAlign, true);
            view.setUint16(34, bitDepth, true);
            writeString(36, 'data');
            view.setUint32(40, dataLength, true);

            const chans = [];
            for (let c = 0; c < numChannels; c++) chans.push(buffer.getChannelData(c));
            const posMax = Math.pow(2, bitDepth - 1) - 1;
            const negMax = Math.pow(2, bitDepth - 1);
            let offset = 44;
            for (let i = startSample; i < endSample; i++) {
                for (let c = 0; c < numChannels; c++) {
                    let s = Math.max(-1, Math.min(1, chans[c][i]));
                    const v = Math.round(s < 0 ? s * negMax : s * posMax);
                    if (bitDepth === 24) {
                        view.setUint8(offset, v & 0xff);
                        view.setUint8(offset + 1, (v >> 8) & 0xff);
                        view.setUint8(offset + 2, (v >> 16) & 0xff);
                    } else if (bitDepth === 16) {
                        view.setInt16(offset, v, true);
                    }
                    offset += bytesPerSample;
                }
            }
            return new Blob([out], { type: 'audio/wav' });
        }

        // Produce a source-quality WAV blob for the [startTime,endTime] range of the active file:
        // byte-exact for uncompressed WAV, otherwise re-encoded from the decoded buffer.
        async function exportSourceQualitySlice(startTime, endTime) {
            const bytes = await readSourceBytes(activeFile());
            const parsed = bytes && parseWavChunks(bytes);
            // Byte-copy is only valid for constant-block-align formats (PCM/float/extensible).
            if (parsed && [1, 3, 0xFFFE].includes(parsed.audioFormat)) {
                return sliceWavLossless(bytes, parsed, startTime, endTime);
            }
            const buf = activeOriginalBuffer();
            if (!buf) throw new Error('No source audio available for export');
            return audioBufferRangeToWav(buf, startTime, endTime, 24);
        }
        
        function populateSliceTextOverlay(textLayer, chunks, duration, canvasWidth) {
            textLayer.innerHTML = '';
            if (!chunks || chunks.length === 0 || !duration || !canvasWidth) return;

            const ROW_HEIGHT = 18;
            const ROW_PADDING = 4;
            const RULER_HEIGHT = 16; // keep word labels below the time ruler
            const LANE_GAP = 4;
            const MAX_LANES = 4;

            const placements = [];
            chunks.forEach(chunk => {
                const text = chunk.text?.trim();
                if (!text || !chunk.timestamp) return;
                const startTime = chunk.timestamp[0];
                let endTime = chunk.timestamp[1];
                if (typeof startTime !== 'number' || startTime < 0) return;
                if (typeof endTime !== 'number' || endTime < startTime) endTime = startTime;
                // Start-anchored (labels here are always bold), matching the main transcription overlay.
                const w = measureTokenWidth(text, true);
                const startX = Math.max(0, Math.min((startTime / duration) * canvasWidth, canvasWidth));
                const displayEndX = Math.min(startX + w, canvasWidth);
                placements.push({ text, startTime, endTime, startX, displayEndX });
            });

            placements.sort((a, b) => a.startX - b.startX || a.displayEndX - b.displayEndX);

            const laneEnds = [0];
            let currentLane = 0;
            let maxLaneUsed = 0;
            for (const p of placements) {
                if (p.startX < laneEnds[currentLane] + LANE_GAP) {
                    let next = currentLane + 1;
                    while (next < laneEnds.length && p.startX < laneEnds[next] + LANE_GAP) next++;
                    if (next >= MAX_LANES) next = laneEnds.reduce((b, e, i) => e < laneEnds[b] ? i : b, 0);
                    else if (next >= laneEnds.length) laneEnds.push(0);
                    currentLane = next;
                }
                laneEnds[currentLane] = Math.max(laneEnds[currentLane], p.displayEndX);
                p.lane = currentLane;
                maxLaneUsed = Math.max(maxLaneUsed, currentLane);
            }

            textLayer.style.width = `${canvasWidth}px`;
            textLayer.style.height = `${RULER_HEIGHT + ROW_PADDING + (maxLaneUsed + 1) * ROW_HEIGHT}px`;
            for (const p of placements) {
                const token = document.createElement('span');
                token.className = 'waveform-token in-range';
                token.textContent = p.text;
                token.style.left = `${p.startX}px`;
                token.style.top = `${RULER_HEIGHT + ROW_PADDING + p.lane * ROW_HEIGHT}px`;
                token.title = `${p.startTime.toFixed(2)}s – ${(p.endTime ?? p.startTime).toFixed(2)}s`;
                textLayer.appendChild(token);

                const tick = document.createElement('span');
                tick.className = 'waveform-token-tick in-range';
                tick.style.left = `${p.startX}px`;
                tick.style.top = `${RULER_HEIGHT}px`;
                tick.style.height = `${ROW_PADDING + p.lane * ROW_HEIGHT + ROW_HEIGHT}px`;
                textLayer.appendChild(tick);
            }
        }

        document.addEventListener('change', (e) => {
            if (e.target.id === 'slices-sort-select') updateSlicesList();
        });

        function updateSlicesList() {
            const listDiv = document.getElementById('slices-list');
            const emptyDiv = document.getElementById('slices-empty');
            const toolbar = document.getElementById('slices-toolbar');

            console.log(`[updateSlicesList] Rendering ${slices.length} slices`);

            if (slices.length === 0) {
                listDiv.innerHTML = '';
                emptyDiv.style.display = 'block';
                toolbar.style.display = 'none';
                selectedSlices.clear();
                updateSelectionBar();
                return;
            }

            emptyDiv.style.display = 'none';
            toolbar.style.display = 'flex';
            document.querySelectorAll('#slices-list audio').forEach(a => a.pause());
            // Park the inline editor in its holder so the rebuild below can't destroy it.
            const _editor = document.getElementById('slice-editor');
            const _holder = document.getElementById('slice-editor-holder');
            if (_editor && _holder && _editor.parentElement !== _holder) _holder.appendChild(_editor);
            listDiv.innerHTML = '';

            // Build sorted index list without mutating slices array
            const slicesSort = document.getElementById('slices-sort-select')?.value ?? 'newest';
            const sortedEntries = slices.map((slice, i) => ({ slice, originalIndex: i }));
            switch (slicesSort) {
                case 'oldest':
                    // already in insertion order
                    break;
                case 'name-az':
                    sortedEntries.sort((a, b) => a.slice.text.localeCompare(b.slice.text));
                    break;
                case 'name-za':
                    sortedEntries.sort((a, b) => b.slice.text.localeCompare(a.slice.text));
                    break;
                case 'duration-asc':
                    sortedEntries.sort((a, b) => (a.slice.endTime - a.slice.startTime) - (b.slice.endTime - b.slice.startTime));
                    break;
                case 'duration-desc':
                    sortedEntries.sort((a, b) => (b.slice.endTime - b.slice.startTime) - (a.slice.endTime - a.slice.startTime));
                    break;
                case 'newest':
                default:
                    sortedEntries.reverse();
                    break;
            }

            sortedEntries.forEach(({ slice, originalIndex: index }) => {
                const item = document.createElement('div');
                item.className = 'slice-item';
                item.classList.toggle('selected', selectedSlices.has(index));
                item.dataset.sliceIndex = index;

                const header = document.createElement('div');
                header.style.cssText = 'display:flex; justify-content:space-between; align-items:flex-start;';

                const headerLeft = document.createElement('div');
                headerLeft.style.cssText = 'flex:1; min-width:0;';

                const nameRow = document.createElement('div');
                nameRow.className = 'slice-name-row';

                // The #N badge and the select checkbox share one fixed-width slot: the badge shows
                // at rest (it's the only cue for what {index} becomes in the export filename), the
                // checkbox takes over on hover or once anything is ticked. Swapping in place rather
                // than sitting side by side is what keeps the name aligned with the lines below it.
                const slot = document.createElement('span');
                slot.className = 'slice-select-slot';

                const check = document.createElement('input');
                check.type = 'checkbox';
                check.className = 'slice-select-checkbox';
                check.checked = selectedSlices.has(index);
                check.title = 'Select for export';
                check.addEventListener('change', () => {
                    if (check.checked) selectedSlices.add(index); else selectedSlices.delete(index);
                    item.classList.toggle('selected', check.checked);
                    updateSelectionBar();
                });
                slot.appendChild(check);

                const idxBadge = document.createElement('span');
                idxBadge.className = 'slice-index-badge';
                idxBadge.textContent = `#${index + 1}`;

                const name = document.createElement('input');
                name.className = 'slice-name-input';
                name.type = 'text';
                name.spellcheck = false;
                name.title = 'Slice name (used for the export filename)';
                name.value = slice.name || slugify(slice.text);
                name.addEventListener('change', () => {
                    slice.name = name.value.trim() || slugify(slice.text);
                    name.value = slice.name;
                    const dl = item.querySelector('.slice-export-icon');
                    if (dl) dl.download = buildSliceFilename(slice, index);
                    saveSessionState();
                });
                name.addEventListener('keydown', e => { if (e.key === 'Enter') name.blur(); });
                // The card is draggable (below); a draggable ancestor otherwise swallows text
                // selection inside child inputs in Chromium.
                name.draggable = false;

                slot.appendChild(idxBadge);
                nameRow.appendChild(slot);
                nameRow.appendChild(name);

                const time = document.createElement('div');
                time.className = 'slice-time';
                time.textContent = `Time: ${(slice.startTime/1000).toFixed(2)}s - ${(slice.endTime/1000).toFixed(2)}s`;
                // The drag hint lives here rather than on the card: a card-wide title fires
                // whenever the pointer rests anywhere while the user is just reading.
                if (window.electronAPI && slice.filePath) time.title = 'Drag to your desktop or DAW';

                headerLeft.appendChild(nameRow);
                headerLeft.appendChild(time);

                if (slice.sourceAudioPath) {
                    const src = document.createElement('div');
                    src.className = 'slice-source';
                    src.title = slice.sourceAudioPath;
                    const srcIcon = document.createElement('i');
                    srcIcon.className = 'ph ph-file-audio';
                    src.appendChild(srcIcon);
                    src.appendChild(document.createTextNode(' ' + _basename(slice.sourceAudioPath)));
                    headerLeft.appendChild(src);
                }

                const toggleBtn = document.createElement('button');
                toggleBtn.className = 'transport-btn slice-waveform-toggle';
                toggleBtn.title = 'Show waveform';
                toggleBtn.style.flexShrink = '0';
                toggleBtn.innerHTML = '<i class="ph ph-caret-down"></i>';

                header.appendChild(headerLeft);
                header.appendChild(toggleBtn);
                item.appendChild(header);
                
                const audio = document.createElement('audio');
                audio.src = slice.url;
                item.appendChild(audio);

                // Waveform
                const waveContainer = document.createElement('div');
                waveContainer.className = 'waveform-container';
                waveContainer.style.marginTop = '8px';
                waveContainer.style.marginBottom = '0';

                const waveInner = document.createElement('div');
                waveInner.className = 'waveform-inner';

                const waveCanvas = document.createElement('canvas');
                waveCanvas.style.display = 'block';
                waveCanvas.style.width = '100%';
                waveCanvas.style.height = '96px'; // ruler (16) + waveform, matching the editor
                waveCanvas.style.cursor = 'pointer';

                const playhead = document.createElement('div');
                playhead.className = 'waveform-playhead';

                const waveTextLayer = document.createElement('div');
                waveTextLayer.className = 'waveform-text-layer';

                waveInner.appendChild(waveCanvas);
                waveInner.appendChild(playhead);
                waveInner.appendChild(waveTextLayer);
                waveContainer.appendChild(waveInner);
                waveContainer.style.display = 'none';
                item.appendChild(waveContainer);

                // Slot the inline editor gets moved into when this slice is being edited.
                const editorSlot = document.createElement('div');
                editorSlot.className = 'slice-editor-slot';
                item.appendChild(editorSlot);

                // Assigned once the blob is decoded; called on expand to draw at the
                // correct (now-visible) width instead of waiting for the ResizeObserver.
                let redraw = null;

                toggleBtn.addEventListener('click', () => {
                    // While this slice is being edited, collapsing cancels the edit.
                    if (previewState.editingSliceIndex === index) {
                        waveContainer.style.display = 'none';
                        toggleBtn.innerHTML = '<i class="ph ph-caret-down"></i>';
                        toggleBtn.title = 'Show waveform';
                        closeSliceEditor(); // sees the container hidden → no wasted redraw
                        return;
                    }
                    const expanding = waveContainer.style.display === 'none';
                    waveContainer.style.display = expanding ? '' : 'none';
                    toggleBtn.innerHTML = expanding ? '<i class="ph ph-caret-up"></i>' : '<i class="ph ph-caret-down"></i>';
                    toggleBtn.title = expanding ? 'Hide waveform' : 'Show waveform';
                    // Draw immediately at the correct size so there's no blurry/reflow flash.
                    if (expanding && redraw) redraw();
                });

                // Decode blob once for waveform + text overlay
                if (!sliceDecodeContext || sliceDecodeContext.state === 'closed') {
                    sliceDecodeContext = new (window.AudioContext || window.webkitAudioContext)();
                }
                fetch(slice.url)
                    .then(r => r.arrayBuffer())
                    .then(buf => sliceDecodeContext.decodeAudioData(buf))
                    .then(buf => {
                        redraw = () => {
                            drawSliceWaveform(waveCanvas, buf);
                            populateSliceTextOverlay(waveTextLayer, slice.chunks, buf.duration, waveCanvas._drawnWidth);
                        };
                        waveCanvas._redraw = redraw; // bridge out of the per-item closure (used by closeSliceEditor)
                        if (waveContainer.style.display !== 'none') redraw(); // draw now only if already visible
                        let resizeTimer;
                        const ro = new ResizeObserver(() => {
                            clearTimeout(resizeTimer);
                            resizeTimer = setTimeout(redraw, 50);
                        });
                        ro.observe(waveCanvas);
                    })
                    .catch(() => {});

                // Seek on canvas click
                waveCanvas.addEventListener('click', e => {
                    const ratio = e.offsetX / waveCanvas.clientWidth;
                    audio.currentTime = ratio * (audio.duration || 0);
                    playhead.style.left = `${e.offsetX}px`;
                    playhead.classList.add('playing');
                });

                // Playhead RAF
                let rafId = null;
                function animateSlicePlayhead() {
                    if (audio.paused) return;
                    const ratio = audio.duration > 0 ? audio.currentTime / audio.duration : 0;
                    playhead.style.left = `${ratio * waveCanvas.clientWidth}px`;
                    rafId = requestAnimationFrame(animateSlicePlayhead);
                }

                // Transport controls — use the default .transport-controls box so it
                // matches the editor's transport (was overridden to a bare/borderless row).
                const playerDiv = document.createElement('div');
                playerDiv.className = 'transport-controls';
                playerDiv.style.marginTop = '8px';

                const playBtn = document.createElement('button');
                playBtn.className = 'transport-btn';
                playBtn.title = 'Play';
                playBtn.innerHTML = '<i class="ph-fill ph-play"></i>';

                const pauseBtn = document.createElement('button');
                pauseBtn.className = 'transport-btn';
                pauseBtn.title = 'Pause';
                pauseBtn.innerHTML = '<i class="ph-fill ph-pause"></i>';
                pauseBtn.style.display = 'none';

                const stopBtn = document.createElement('button');
                stopBtn.className = 'transport-btn';
                stopBtn.title = 'Stop';
                stopBtn.innerHTML = '<i class="ph-fill ph-stop"></i>';

                const loopBtn = document.createElement('button');
                loopBtn.className = 'transport-btn';
                loopBtn.title = 'Loop';
                loopBtn.innerHTML = '<i class="ph ph-repeat"></i>';

                const divider = document.createElement('div');
                divider.className = 'transport-divider';

                const speedSelect = document.createElement('select');
                speedSelect.className = 'transport-select';
                speedSelect.title = 'Playback speed';
                speedSelect.innerHTML = '<option value="0.5">0.5x</option><option value="0.75">0.75x</option><option value="1" selected>1x</option><option value="1.25">1.25x</option><option value="1.5">1.5x</option><option value="2">2x</option>';

                playBtn.onclick = () => {
                    stopPreview(); // starting Engine B stops Engine A (edit-mode / transcription preview)
                    document.querySelectorAll('#slices-list audio').forEach(a => { if (a !== audio) a.pause(); });
                    audio.play();
                };
                pauseBtn.onclick = () => audio.pause();
                stopBtn.onclick = () => {
                    audio.pause();
                    audio.currentTime = 0;
                    playhead.style.left = '0px';
                    playhead.classList.remove('playing');
                };
                loopBtn.onclick = () => {
                    audio.loop = !audio.loop;
                    loopBtn.classList.toggle('active', audio.loop);
                };
                speedSelect.onchange = () => { audio.playbackRate = parseFloat(speedSelect.value); };

                audio.addEventListener('play', () => {
                    playBtn.style.display = 'none';
                    pauseBtn.style.display = '';
                    playhead.classList.add('playing');
                    rafId = requestAnimationFrame(animateSlicePlayhead);
                });
                audio.addEventListener('pause', () => {
                    playBtn.style.display = '';
                    pauseBtn.style.display = 'none';
                    cancelAnimationFrame(rafId);
                });
                audio.addEventListener('ended', () => {
                    if (!audio.loop) {
                        playBtn.style.display = '';
                        pauseBtn.style.display = 'none';
                        playhead.classList.remove('playing');
                        cancelAnimationFrame(rafId);
                    }
                });

                playerDiv.appendChild(playBtn);
                playerDiv.appendChild(pauseBtn);
                playerDiv.appendChild(stopBtn);
                playerDiv.appendChild(loopBtn);
                playerDiv.appendChild(divider);
                playerDiv.appendChild(speedSelect);

                // Duration readout, mirroring the editor transport
                const durDivider = document.createElement('div');
                durDivider.className = 'transport-divider';
                playerDiv.appendChild(durDivider);
                const durationEl = document.createElement('div');
                durationEl.className = 'time-duration';
                durationEl.innerHTML = `Duration: <span>${((slice.endTime - slice.startTime) / 1000).toFixed(2)}s</span>`;
                playerDiv.appendChild(durationEl);

                // Action buttons inline with transport controls
                const actionDivider = document.createElement('div');
                actionDivider.className = 'transport-divider';
                playerDiv.appendChild(actionDivider);

                const exportBtn = document.createElement('a');
                exportBtn.href = slice.url;
                exportBtn.download = buildSliceFilename(slice, index);
                exportBtn.className = 'slice-export-icon';
                exportBtn.innerHTML = '<i class="ph ph-download-simple"></i>';
                exportBtn.title = 'Export slice';
                playerDiv.appendChild(exportBtn);

                const editBtn = document.createElement('button');
                editBtn.className = 'slice-edit-btn';
                editBtn.innerHTML = '<i class="ph ph-pencil-simple"></i>';

                // Editable if the slice knows its source audio (loaded on demand in
                // openEditMode, no re-transcribe) or audio is already loaded (legacy slices).
                const canEdit = !!(slice.sourceAudioPath || originalAudioBuffer);
                if (canEdit) {
                    editBtn.title = 'Edit slice boundaries';
                    editBtn.onclick = () => openEditMode(index);
                } else {
                    editBtn.title = 'Load an audio file first';
                    editBtn.style.opacity = '0.3';
                    editBtn.style.cursor = 'pointer';
                    editBtn.onclick = () => alert('Cannot edit this slice.\n\nLoad an audio file first.');
                }
                playerDiv.appendChild(editBtn);

                const deleteBtn = document.createElement('button');
                deleteBtn.className = 'slice-delete-btn';
                deleteBtn.innerHTML = '<i class="ph ph-trash"></i>';
                deleteBtn.title = 'Delete slice';
                deleteBtn.onclick = () => deleteSlice(index);
                playerDiv.appendChild(deleteBtn);

                item.appendChild(playerDiv);

                // The whole card is the drag handle — no grip furniture in the header. Everything
                // the user actually operates is excluded; note especially .slice-editor-slot, whose
                // boundary handles are mouse-dragged and would otherwise start a file drag instead.
                if (window.electronAPI && slice.filePath) {
                    item.draggable = true;
                    item.addEventListener('dragstart', (e) => {
                        e.preventDefault();                            // cancel the HTML5 drag either way
                        if (e.target.closest(DRAG_EXCLUDED)) return;   // ...and don't hand this one to the OS
                        // Dragging a ticked slice drags the whole selection; otherwise just this one.
                        const items = sliceExportItems(selectedSlices.has(index) ? selectedIndices() : [index]);
                        if (items.length) window.electronAPI.startSliceDrag(items);
                    });
                }

                listDiv.appendChild(item);
                console.log(`[updateSlicesList] Added slice item #${index + 1}: "${slice.text}"`);
            });

            updateSelectionBar();

            // If a slice was being edited during this rebuild, re-mount the editor into it.
            if (previewState.editingSliceIndex != null) mountSliceEditor(previewState.editingSliceIndex);

            console.log(`[updateSlicesList] Finished rendering ${slices.length} slices to DOM`);
        }
        
        // Delete a slice
        function deleteSlice(index) {
            if (index < 0 || index >= slices.length) {
                console.error('Invalid slice index:', index);
                return;
            }
            
            const slice = slices[index];
            
            // Confirm deletion
            if (!confirm(`Delete slice "${slice.text}"?`)) {
                return;
            }
            
            addLog(`🗑️ Deleting slice: "${slice.text}"`);
            
            // Revoke blob URL to free memory
            if (slice.url) {
                URL.revokeObjectURL(slice.url);
            }
            
            // Delete file from disk if it exists
            if (slice.filePath && window.electronAPI) {
                window.electronAPI.deleteSliceFile(slice.filePath).catch(err => {
                    console.error('Failed to delete slice file:', err);
                });
            }
            
            // Remove from array. Every later index shifts, so the ticked set is no longer
            // meaningful — drop it rather than export the wrong slices.
            slices.splice(index, 1);
            selectedSlices.clear();

            // Drop the source file's cached transcription if no slice references it anymore
            gcTranscriptionCache();

            // Update UI
            updateSlicesList();

            // Save session
            saveSessionState();


            addLog(`✅ Slice deleted successfully`);
        }
        
        // Called by applyTheme(): every canvas bakes its theme colours in at draw time, so the
        // slice previews need repainting too — not just the transcription/editor waveform.
        window.redrawWaveform = function() {
            if (activeOriginalBuffer()) drawWaveform().then(() => updateHandlePositions());
            document.querySelectorAll('#slices-list canvas').forEach(c => {
                if (c._redraw && c.clientWidth > 0) c._redraw();
            });
        };

        window.switchTab = function(tabName, clickedElement) {
            // Editing only exists in the Slices tab; leaving it with an edit open would strand
            // waveformContext in 'modal' and break the Transcription tab. Cancel the edit first.
            if (tabName !== 'slices' && previewState.editingSliceIndex != null) {
                closeSliceEditor();
            }
            // Changing tabs silences any playing slice preview (Engine A is already torn
            // down: via closeSliceEditor above, or it drives the Transcription-tab preview
            // which the user is now leaving).
            document.querySelectorAll('#slices-list audio').forEach(a => a.pause());
            // Update tab buttons
            document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
            if (clickedElement) {
                clickedElement.classList.add('active');
            }
            
            // Update tab content
            document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
            document.getElementById(tabName + '-tab').classList.add('active');

            if (tabName === 'slices') {
                // Un-hiding the tab leaves each visible preview canvas needing a redraw at the
                // now-correct width; do it synchronously to avoid the ResizeObserver-lagged flash.
                document.querySelectorAll('#slices-list .slice-item > .waveform-container canvas').forEach(canvas => {
                    if (canvas._redraw && canvas.clientWidth > 0) canvas._redraw();
                });
            }

        };

        // Settings sub-navigation: the sidebar picks one #settings-panel-<name>.
        window.switchSettingsPanel = function(name, clickedElement) {
            document.querySelectorAll('.settings-nav-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.settings-panel').forEach(p => p.classList.remove('active'));

            const panel = document.getElementById(`settings-panel-${name}`);
            if (panel) panel.classList.add('active');

            const btn = clickedElement
                || document.querySelector(`.settings-nav-btn[onclick*="'${name}'"]`);
            if (btn) btn.classList.add('active');

            // Models can be downloaded between visits, so re-read the cache on open.
            if (name === 'storage') refreshModelStorage();
        };

        // ── Model storage ───────────────────────────────────────────────────────────
        // Models are real files now, under userData/models/, downloaded and verified by the main
        // process (electron/models.js). This panel used to reconstruct the same picture by walking
        // the Cache API and parsing Hugging Face URLs out of the keys; a stat() of the directory
        // says the same thing without guessing, and reports a part-downloaded model honestly.
        function formatBytes(n) {
            if (!n) return '0 MB';
            const units = ['B', 'KB', 'MB', 'GB'];
            let i = 0;
            while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
            return `${n.toFixed(i >= 2 ? 1 : 0)} ${units[i]}`;
        }

        // One-time cleanup for installs upgrading from the Hugging Face era. Those builds cached
        // every model file in the Cache API under 'transformers-cache'; nothing reads it now, so it
        // is dead weight — easily several hundred MB, in a location (userData/Service Worker/
        // CacheStorage) no user would ever find to clear by hand. Runs once and records that it has,
        // because a user who somehow refills that cache shouldn't have it wiped repeatedly.
        const LEGACY_CACHE_CLEARED_KEY = 'vs-legacy-model-cache-cleared';

        async function clearLegacyModelCache() {
            if (!window.caches || localStorage.getItem(LEGACY_CACHE_CLEARED_KEY)) return;
            try {
                const existed = await caches.has('transformers-cache');
                if (existed) {
                    await caches.delete('transformers-cache');
                    // The HTTP cache holds copies of the same files, so it goes too — otherwise the
                    // space we just told the user they got back isn't actually free.
                    await window.electronAPI?.clearHttpCache?.();
                    addLog('🗑️ Cleared the old model cache — models now live in the models folder');
                }
                localStorage.setItem(LEGACY_CACHE_CLEARED_KEY, '1');
            } catch (e) {
                // Non-fatal: worst case is some stale cache lingers and we try again next launch.
                console.warn('Legacy model cache cleanup skipped:', e);
            }
        }

        async function listCachedModels() {
            if (!window.electronAPI?.listModels) return [];
            const models = await window.electronAPI.listModels();
            // Only the ones actually taking up space; the rest are offered by the picker but have
            // never been downloaded, and a list of zero-byte rows is noise.
            return models.filter(m => m.bytes > 0).sort((a, b) => b.bytes - a.bytes);
        }

        // Friendly label, reusing the <option> text from the model picker. The manifest keys the
        // model on its bare name ("whisper-tiny.en_timestamped") while the picker's value carries
        // the org prefix, so match on the suffix rather than the whole value.
        //
        // The picker's parenthesised size is dropped here. It answers "what will choosing this cost
        // me", which belongs in the picker; every row in this panel already shows the real size on
        // disk to its right, so keeping it would print the same number twice on one line. Matches
        // any parenthetical, not just the "(~…)" form the labels used to carry — applyModelSizes
        // now writes "(116.7 MB)" and "(563.1 MB download)", neither of which has a tilde.
        function modelDisplayName(id) {
            const opt = [...document.querySelectorAll('#model-select option')]
                .find(o => o.value === id || o.value.endsWith('/' + id));
            if (!opt) return id;
            return opt.textContent.split(' - ')[0].replace(/\s*\([^)]*\)/, '').trim();
        }

        async function refreshModelStorage() {
            const list = document.getElementById('model-storage-list');
            const totalEl = document.getElementById('model-storage-total');
            if (!list) return;

            // Location (from the main process — the renderer can't know its own profile path).
            try {
                const info = await window.electronAPI.getStorageInfo();
                const pathEl = document.getElementById('storage-path');
                // Point at the models folder specifically — it's what this panel is about, and
                // unlike the old Cache API location it's somewhere a user can usefully open.
                if (pathEl && (info?.modelsDir || info?.userData)) {
                    pathEl.textContent = info.modelsDir || info.userData;
                }
            } catch (e) { /* non-fatal */ }

            let models = [];
            try {
                models = await listCachedModels();
            } catch (e) {
                list.innerHTML = '<div class="storage-empty">Could not read the model cache.</div>';
                return;
            }

            const total = models.reduce((sum, m) => sum + m.bytes, 0);
            if (totalEl) totalEl.textContent = formatBytes(total);

            if (models.length === 0) {
                list.innerHTML = '<div class="storage-empty">No models downloaded yet.</div>';
                return;
            }

            list.innerHTML = '';
            models.forEach(m => {
                const row = document.createElement('div');
                row.className = 'storage-row';

                const name = document.createElement('span');
                name.className = 'storage-row-name';
                name.textContent = modelDisplayName(m.id);
                name.title = m.id;

                const size = document.createElement('span');
                size.className = 'storage-row-size';
                size.textContent = formatBytes(m.bytes);

                const del = document.createElement('button');
                del.className = 'icon-btn';
                del.title = `Delete ${modelDisplayName(m.id)}`;
                del.innerHTML = '<i class="ph ph-trash"></i>';
                del.addEventListener('click', () => deleteCacheGroup(m));

                row.append(name, size, del);
                list.appendChild(row);
            });
        }

        // Deleting something that's currently loaded is safe: whisperPipeline already holds it in
        // memory, and the next transcription re-downloads whatever it needs.
        async function deleteCacheGroup(group) {
            const name = modelDisplayName(group.id);
            if (!confirm(`Delete ${name}?\n\nIt will re-download next time it's needed.`)) return;

            await window.electronAPI.deleteModel(group.id);
            addLog(`🗑️ Deleted model: ${group.id} (${formatBytes(group.bytes)})`);
            refreshModelStorage();
            applyModelSizes();   // it now costs a download again
        }

        window.openStorageFolder = function() {
            window.electronAPI.openStorageFolder('models');
        };

        // Shown in-app rather than opened in an editor: packaged, THIRD-PARTY-NOTICES.md lives inside
        // app.asar, which the OS shell can't open at all — and .md has no default handler on most
        // Windows machines even when it can. Main reads it; we render the text.
        let noticesModalCleanup = null;

        function hideNoticesModal() {
            const modal = document.getElementById('notices-modal');
            if (modal) modal.style.display = 'none';
            if (noticesModalCleanup) { noticesModalCleanup(); noticesModalCleanup = null; }
        }

        function showNoticesModal(text) {
            const modal = document.getElementById('notices-modal');
            const body = document.getElementById('notices-modal-body');
            const closeBtn = document.getElementById('notices-modal-close');
            if (!modal || !body || !closeBtn) {
                showToast('Third-party notices unavailable', { icon: 'ph ph-warning-circle' });
                return;
            }
            hideNoticesModal();                 // never stack two

            body.textContent = text;            // plain text, not markup — 60kB of licence text
            body.scrollTop = 0;                 // reopening starts at the top again

            const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); hideNoticesModal(); } };
            const onBackdrop = (e) => { if (e.target === modal) hideNoticesModal(); };
            const onClose = () => hideNoticesModal();

            document.addEventListener('keydown', onKey, true);
            modal.addEventListener('click', onBackdrop);
            closeBtn.addEventListener('click', onClose);
            noticesModalCleanup = () => {
                document.removeEventListener('keydown', onKey, true);
                modal.removeEventListener('click', onBackdrop);
                closeBtn.removeEventListener('click', onClose);
            };

            modal.style.display = '';
            body.focus();                       // so Page Down / arrows scroll it straight away
        }

        window.openThirdPartyNotices = async function() {
            const text = await window.electronAPI.getThirdPartyNotices();
            if (!text) {                        // missing file — say so rather than doing nothing
                showToast('Third-party notices unavailable', { icon: 'ph ph-warning-circle' });
                return;
            }
            showNoticesModal(text);
        };

        // Header shortcut → jump to the Settings tab and flag the Model & Processing section.
        window.openLanguageSettings = function() {
            switchTab('settings', document.getElementById('settings-tab-btn'));
            switchSettingsPanel('transcription');
            const sec = document.getElementById('model-processing-settings');
            if (sec) {
                sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
                sec.classList.remove('settings-flash');
                void sec.offsetWidth; // restart the animation if triggered again
                sec.classList.add('settings-flash');
                setTimeout(() => sec.classList.remove('settings-flash'), 1300);
            }
        };

        function addLog(message) {
            const logContent = document.getElementById('log-content');
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            const timestamp = new Date().toLocaleTimeString();
            entry.textContent = `[${timestamp}] ${message}`;
            logContent.appendChild(entry);
            logContent.scrollTop = logContent.scrollHeight;
        }

        window.clearLog = function() {
            const el = document.getElementById('log-content');
            if (el) el.innerHTML = '';
            addLog('Log cleared');
        };

        function copyTextToClipboard(text) {
            if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
            // Fallback for environments without the async clipboard API.
            return new Promise((resolve, reject) => {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed; opacity:0;';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                ok ? resolve() : reject(new Error('copy command failed'));
            });
        }

        // Voluntary, user-initiated diagnostics: app/env info + the visible log. Nothing is sent
        // anywhere by the app — it only reaches the clipboard or a file the user picks.
        async function buildDiagnosticsReport() {
            let info = {};
            try { info = (await window.electronAPI?.getAppInfo?.()) || {}; } catch (e) { /* browser mode */ }
            const v = window.electronAPI?.versions || {};
            const val = id => document.getElementById(id)?.value || '-';
            const header = [
                `Vocal Slice ${info.displayVersion || info.version || ''}`.trim(),
                `Branch: ${info.gitBranch || 'unknown'}   Commit: ${info.gitHash || 'unknown'}`,
                `Platform: ${window.electronAPI?.platform || navigator.platform}   Electron: ${v.electron || '-'}   Chrome: ${v.chrome || '-'}`,
                `WebGPU: ${webgpuSupported ? 'supported' : 'unavailable'}`,
                // Read live rather than recomputed: if ORT ever clamps the value we asked for, this
                // reports what is actually in effect. The thread policy is one machine's numbers
                // generalised (see the numThreads comment at the top of this file), so a CPU report
                // from a machine it suits badly is the only way that would ever surface.
                `CPU threads: ${env.backends.onnx.wasm.numThreads} of ${navigator.hardwareConcurrency || '?'}`,
                `Model: ${val('model-select')}   Device: ${val('device-select')}   Language: ${val('language-select')}`,
                '',
                '--- Log ---'
            ];
            const entries = Array.from(document.querySelectorAll('#log-content .log-entry')).map(el => el.textContent);
            return header.concat(entries).join('\n');
        }

        function diagnosticsFileName() {
            // Local time (toISOString would be UTC, and wouldn't match the log's local timestamps).
            const d = new Date();
            const p = n => String(n).padStart(2, '0');
            const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
                          `-${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
            return `vocalslice-diagnostics-${stamp}.txt`;
        }

        window.copyDiagnostics = async function() {
            try {
                await copyTextToClipboard(await buildDiagnosticsReport());
                showToast('Diagnostics copied to clipboard');
            } catch (e) {
                addLog('⚠️ Could not copy diagnostics: ' + e.message);
            }
        };

        window.saveDiagnostics = async function() {
            try {
                const text = await buildDiagnosticsReport();
                const name = diagnosticsFileName();
                if (window.electronAPI?.saveDiagnostics) {
                    const filePath = await window.electronAPI.saveDiagnostics(text, name);
                    if (filePath) showToast('Diagnostics saved');   // null = user cancelled
                    return;
                }
                // Browser fallback: download as a file.
                const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = name;
                a.click();
                URL.revokeObjectURL(url);
                showToast('Diagnostics saved');
            } catch (e) {
                addLog('⚠️ Could not save diagnostics: ' + e.message);
            }
        };

        // Transcription display customization
        // Make this global so onchange handlers can access it
        window.updateTranscriptionStyle = function() {
            const textarea = document.getElementById('transcription-text');
            const fontFamily = document.getElementById('font-family-select').value;
            const fontSize = document.getElementById('font-size-select').value;
            const lineHeight = document.getElementById('line-height-select').value;
            
            if (!textarea) {
                console.error('Transcription textarea not found');
                return;
            }
            
            console.log('Updating transcription style:', { fontFamily, fontSize, lineHeight });
            
            // Apply styles with !important using setProperty
            textarea.style.setProperty('font-family', fontFamily, 'important');
            textarea.style.setProperty('font-size', fontSize, 'important');
            textarea.style.setProperty('line-height', lineHeight, 'important');

            // Save preferences to localStorage
            localStorage.setItem('transcription-font-family', fontFamily);
            localStorage.setItem('transcription-font-size', fontSize);
            localStorage.setItem('transcription-line-height', lineHeight);

            // The textarea font metrics just changed; rebuild the highlight overlay so
            // its spans line up with the words (the overlay mirrors the textarea font).
            if (currentTranscription) {
                requestAnimationFrame(() => updateTextHighlightFromTime());
            }
        };
        
        window.loadTranscriptionPreferences = function() {
            // Load saved preferences from localStorage
            const savedFontFamily = localStorage.getItem('transcription-font-family');
            const savedFontSize = localStorage.getItem('transcription-font-size');
            const savedLineHeight = localStorage.getItem('transcription-line-height');
            
            if (savedFontFamily) {
                document.getElementById('font-family-select').value = savedFontFamily;
            }
            if (savedFontSize) {
                document.getElementById('font-size-select').value = savedFontSize;
            }
            if (savedLineHeight) {
                document.getElementById('line-height-select').value = savedLineHeight;
            }
            
            // Apply the loaded preferences
            window.updateTranscriptionStyle();

            // Filename-template setting
            const tmplInput = document.getElementById('filename-template-input');
            if (tmplInput) tmplInput.value = getFilenameTemplate();
            refreshFilenameExample();

            // Timestamp-compensation setting (whisperLagMs was already read at module load).
            const lagInput = document.getElementById('whisper-lag-input');
            if (lagInput) lagInput.value = whisperLagMs;
        };

        // Persist the filename template and refresh the example + existing download names.
        window.updateFilenameTemplate = function() {
            const input = document.getElementById('filename-template-input');
            if (!input) return;
            const val = input.value.trim();
            if (val) localStorage.setItem('vocalslice-filename-template', val);
            else localStorage.removeItem('vocalslice-filename-template'); // empty → default
            input.value = getFilenameTemplate();
            refreshFilenameExample();
            updateSlicesList(); // re-derive download filenames on existing slices
        };

        function refreshFilenameExample() {
            const el = document.getElementById('filename-example');
            if (!el) return;
            const sample = { name: 'the-cat-sat', text: 'the cat sat',
                             sourceAudioPath: 'interview.wav', startTime: 11350, endTime: 18220 };
            el.textContent = buildSliceFilename(sample, 2);
        }
        
        
        // Initialize
        (async () => {
            addLog('Vocal Slice starting...');
            await checkWebGPUSupport();
            // Again after detection, so a machine with no WebGPU gets the (larger) CPU figures
            // rather than keeping the WebGPU defaults authored into the markup.
            applyModelSizes();
            clearLegacyModelCache();   // upgrade housekeeping; fire-and-forget
            addLog('Ready to transcribe!');
            
            // Attempt to restore previous session
            const restored = await restoreSession();
            if (restored) {
                addLog('💡 Previous session restored - you can continue where you left off');
            } else if (window.onboardingHasSeen && !window.onboardingHasSeen()) {
                // First run, nothing to restore → show the demo and walk through it. Marked seen when
                // the tour finishes or is skipped (inside onboarding.js), so it never nags again.
                const ok = await window.loadDemo();
                if (ok && window.startWalkthrough) {
                    setTimeout(() => window.startWalkthrough(), 400); // let the waveform paint first
                } else if (window.markOnboardingSeen) {
                    window.markOnboardingSeen(); // demo asset missing — don't retry every launch
                }
            }
            
            // ── Language combobox ───────────────────────────────────────────────────────────
            // Whisper knows 99 languages, which is well past what a native dropdown can present,
            // so #language-select is hidden and this filterable list is the visible control. The
            // select stays the value holder — the transcribe path, diagnostics and settings
            // persistence all read its .value, and committing here fires its 'change' so the
            // existing listener below still saves and offers the re-transcribe.
            const langSelect = document.getElementById('language-select');
            const langInput = document.getElementById('language-search');
            const langList = document.getElementById('language-listbox');

            // Fold case and strip accents, so typing "espanol" still finds "Español".
            const foldText = (s) => s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

            const langOptions = [...langSelect.options].map((opt, i) => ({
                code: opt.value,
                label: opt.textContent,
                id: `language-option-${i}`,
                // The native name is in the label already; data-alt carries the alternate English
                // names people actually type (Farsi, Mandarin, Myanmar).
                haystack: foldText(`${opt.textContent} ${opt.dataset.alt || ''} ${opt.value}`)
            }));

            const labelForLang = (code) =>
                (langOptions.find(o => o.code === code) || langOptions[0]).label;

            let langMatches = langOptions;   // options currently rendered
            let langActive = -1;             // keyboard position within langMatches

            function setActiveLang(i) {
                langActive = i;
                const items = langList.children;
                for (let k = 0; k < items.length; k++) items[k].classList.toggle('active', k === i);
                const el = items[i];
                if (!el) return langInput.removeAttribute('aria-activedescendant');
                langInput.setAttribute('aria-activedescendant', el.id);
                el.scrollIntoView({ block: 'nearest' });
            }

            function renderLangList(query) {
                const q = foldText(query.trim());
                langMatches = q ? langOptions.filter(o => o.haystack.includes(q)) : langOptions;

                if (!langMatches.length) {
                    langList.innerHTML = '<li class="combobox-empty">No language matches</li>';
                    langActive = -1;
                    langInput.removeAttribute('aria-activedescendant');
                    return;
                }

                langList.innerHTML = '';
                for (const o of langMatches) {
                    const li = document.createElement('li');
                    li.className = 'combobox-option';
                    li.id = o.id;
                    li.dataset.code = o.code;
                    li.textContent = o.label;
                    li.setAttribute('role', 'option');
                    if (o.code === langSelect.value) li.setAttribute('aria-selected', 'true');
                    langList.appendChild(li);
                }

                // Opening with no query should land on the current language; once someone is
                // typing, the top match is what Enter should take.
                const committed = langMatches.findIndex(o => o.code === langSelect.value);
                setActiveLang(q ? 0 : Math.max(committed, 0));
            }

            // Unhides only — the caller renders, because rendering has to happen while the list is
            // visible for setActiveLang's scrollIntoView to be able to reach the active row.
            function openLangList() {
                if (langInput.disabled || !langList.hidden) return false;
                langList.hidden = false;
                langInput.setAttribute('aria-expanded', 'true');
                return true;
            }

            function closeLangList() {
                if (langList.hidden) return;
                langList.hidden = true;
                langInput.setAttribute('aria-expanded', 'false');
                langInput.removeAttribute('aria-activedescendant');
                langInput.value = labelForLang(langSelect.value);   // drop an abandoned search
            }

            function commitLang(code) {
                const changed = code !== langSelect.value;
                langSelect.value = code;
                closeLangList();
                // Only when it really changed — otherwise merely opening the list and pressing
                // Enter would offer a re-transcribe for nothing.
                if (changed) langSelect.dispatchEvent(new Event('change'));
            }

            langInput.addEventListener('focus', () => {
                langInput.select();
                if (openLangList()) renderLangList('');
            });

            // Committing or Escaping closes the list but leaves the input focused (the list's
            // mousedown preventDefault below is what keeps focus there), so a second click fires no
            // focus event and the picker looks dead. Reopen from the click itself.
            //
            // preventDefault stops mouseup from collapsing the selection to a caret. Without it the
            // reopening click leaves the cursor mid-label and typing APPENDS — "Greek (Ελληνικά)gre"
            // matches nothing. Focus is therefore moved by hand rather than by the default action.
            langInput.addEventListener('mousedown', (e) => {
                if (!langList.hidden) return;   // already open: leave a half-typed search alone
                e.preventDefault();
                if (document.activeElement === langInput) {
                    // Already focused, so no focus event is coming — do its work here instead.
                    langInput.select();
                    openLangList();
                    renderLangList('');
                } else {
                    langInput.focus();          // fires the focus handler: selects, opens, renders
                }
            });

            langInput.addEventListener('input', () => {
                openLangList();
                renderLangList(langInput.value);
            });

            langInput.addEventListener('blur', closeLangList);

            // mousedown rather than click, with preventDefault, so the input keeps focus: dragging
            // the list's scrollbar would otherwise blur it and close the list mid-scroll.
            langList.addEventListener('mousedown', (e) => {
                e.preventDefault();
                const li = e.target.closest('.combobox-option');
                if (li) commitLang(li.dataset.code);
            });

            langInput.addEventListener('keydown', (e) => {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                    e.preventDefault();
                    if (langList.hidden) { openLangList(); return renderLangList(''); }
                    if (!langMatches.length) return;
                    const next = langActive + (e.key === 'ArrowDown' ? 1 : -1);
                    setActiveLang((next + langMatches.length) % langMatches.length);
                } else if (e.key === 'Enter' && !langList.hidden) {
                    e.preventDefault();
                    if (langMatches[langActive]) commitLang(langMatches[langActive].code);
                } else if (e.key === 'Escape' && !langList.hidden) {
                    closeLangList();
                } else if (e.key === 'Tab' && !langList.hidden && langMatches[langActive]) {
                    commitLang(langMatches[langActive].code);
                }
            });

            // Function to update language selector based on model type
            function updateLanguageSelector() {
                const modelName = document.getElementById('model-select').value;
                const languageHint = document.getElementById('language-hint');
                const isEnglishOnly = modelName.includes('.en');

                if (isEnglishOnly) {
                    languageHint.textContent = '🔒 English-only model - language selection disabled';
                    languageHint.style.color = '#999';
                } else {
                    languageHint.textContent = '🌐 Select the language spoken in your audio';
                    languageHint.style.color = '#666';
                }

                // Show English while an .en model is picked, but leave the select holding the
                // user's real choice so it comes back when they return to a multilingual model.
                // (Overwriting the select instead would let saveProcessingSettings persist the
                // forced 'en' on the next model switch and lose their language for good.) The
                // transcribe path already omits `language` for .en models — it has to, since
                // Whisper's English-only checkpoints reject a language token.
                langInput.disabled = isEnglishOnly;
                if (isEnglishOnly) closeLangList();
                langInput.value = labelForLang(isEnglishOnly ? 'en' : langSelect.value);
            }

            // Published because applyModelSizes() can change the model out from under the user (a
            // GPU-only model on a machine with no GPU) and has to bring the language control with
            // it, and it lives in an outer scope than this one.
            window.updateLanguageSelector = updateLanguageSelector;
            
            // Add listener to reset model when device changes
            document.getElementById('device-select').addEventListener('change', () => {
                saveProcessingSettings();
                if (whisperPipeline) {
                    whisperPipeline = null;
                    addLog('Device changed - model will reload on next transcription');
                }
            });
            
            // Add listener to reset model when model selection changes
            document.getElementById('model-select').addEventListener('change', () => {
                saveProcessingSettings();
                updateLanguageSelector();
                if (whisperPipeline) {
                    whisperPipeline = null;
                    addLog('Model changed - will reload on next transcription');
                }
                promptRetranscribe('Model changed');
            });

            // Add listener to save language selection
            document.getElementById('language-select').addEventListener('change', () => {
                langInput.value = labelForLang(langSelect.value);   // keep the picker mirroring it
                saveProcessingSettings();
                promptRetranscribe('Language changed');
            });
            
            // Initialize UI state. Restore first: updateLanguageSelector derives the picker's
            // label and enabled state from the *restored* model and language, so running it
            // before the restore left an English-only model showing an enabled picker.
            loadProcessingSettings(); // Load saved preferences after UI is initialized
            updateLanguageSelector();
            window.loadTranscriptionPreferences();

            window.toggleLogTab = function(enabled) {
                localStorage.setItem('showLogTab', enabled ? 'true' : 'false');
                const btn = document.getElementById('log-tab-btn');
                if (btn) btn.style.display = enabled ? '' : 'none';
                if (!enabled) {
                    const logContent = document.getElementById('log-tab');
                    if (logContent && logContent.classList.contains('active')) {
                        switchTab('transcription', document.querySelector('.tab'));
                    }
                }
            };
            const _showLog = localStorage.getItem('showLogTab') === 'true';
            document.getElementById('show-log-tab').checked = _showLog;
            window.toggleLogTab(_showLog);
            
            // Fallback keyboard shortcuts for browser mode
            if (!window.electronAPI) {
                // No browser-specific shortcuts needed
            }

            // Redraw waveform when container resizes (e.g. dev tools toggle, window resize)
            const _waveformResizeTarget = document.querySelector('#transcription-waveform-section .waveform-container');
            if (_waveformResizeTarget && typeof ResizeObserver !== 'undefined') {
                let _waveformResizeTimer;
                new ResizeObserver(() => {
                    clearTimeout(_waveformResizeTimer);
                    _waveformResizeTimer = setTimeout(() => {
                        if (!activeOriginalBuffer()) return;
                        drawWaveform().then(() => updateHandlePositions());
                    }, 50);
                }).observe(_waveformResizeTarget);
            }

            // Redraw the edit-mode waveform when its container resizes (e.g. window resize while
            // editing). Guarded so mount/unmount/holder resizes don't trigger spurious draws.
            const _editWaveformTarget = document.querySelector('#slice-editor .waveform-container');
            if (_editWaveformTarget && typeof ResizeObserver !== 'undefined') {
                let _editWaveformResizeTimer;
                new ResizeObserver(() => {
                    clearTimeout(_editWaveformResizeTimer);
                    _editWaveformResizeTimer = setTimeout(() => {
                        if (waveformContext !== 'modal' || previewState.editingSliceIndex == null) return;
                        if (!activeOriginalBuffer()) return;
                        drawWaveform().then(() => updateHandlePositions());
                    }, 50);
                }).observe(_editWaveformTarget);
            }

            // Populate the About section (version / branch / commit / build time).
            if (window.electronAPI?.getAppInfo) {
                window.electronAPI.getAppInfo().then(appInfo => {
                    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v || '—'; };
                    set('about-version', appInfo.displayVersion || appInfo.version);
                    set('about-branch', appInfo.gitBranch);
                    set('about-hash', appInfo.gitHash);
                    // buildTime is stored as ISO-8601 UTC; render it in the viewer's local time.
                    let built = '—';
                    if (appInfo.buildTime) {
                        const d = new Date(appInfo.buildTime);
                        if (!isNaN(d)) built = d.toLocaleString();
                    }
                    set('about-built', built);
                }).catch(() => {});
            }

            // "What's new" in Settings → About. changelog.json is baked from CHANGELOG.md by
            // build-scripts/minify.js, so this reads a local file and never touches the network.
            // The newest release is shown open; the rest are <details>, which handles its own
            // toggling and keyboard/screen-reader behaviour without any JS of ours.
            (async () => {
                const section = document.getElementById('whats-new-section');
                const host = document.getElementById('whats-new');
                if (!section || !host) return;

                let releases;
                try {
                    const res = await fetch('changelog.json');
                    if (!res.ok) throw new Error(String(res.status));
                    releases = await res.json();
                } catch (e) {
                    return;   // no changelog.json (source checkout without a build) — stay hidden
                }
                if (!Array.isArray(releases) || !releases.length) return;

                // Same UTC handling as build-scripts/changelog-data.js: a date-only string parses as
                // midnight UTC, so formatting it in local time would show the previous day west of
                // Greenwich.
                const humanDate = (iso) => {
                    const [y, m, d] = String(iso).split('-').map(Number);
                    if (!y || !m || !d) return '';
                    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined,
                        { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
                };

                // textContent throughout — the notes are ours, but building DOM rather than
                // concatenating HTML keeps a stray < in a bullet from becoming markup.
                // Bullets arrive pre-tokenised from changelog.json (build-scripts/changelog-data.js
                // does the parsing, minify.js bakes it in), so **bold**, `code` and *italic* render
                // as markup instead of literal asterisks — which is what shipped in 1.474.0/1.475.0.
                // Plain strings are still accepted: a dev running against an older baked
                // changelog.json should get readable text, not "[object Object]".
                const appendInline = (node, value) => {
                    if (typeof value === 'string') { node.textContent = value; return; }
                    for (const seg of value || []) {
                        const tag = seg.type === 'code' ? 'code'
                            : seg.type === 'strong' ? 'strong'
                                : seg.type === 'em' ? 'em' : null;
                        // textContent throughout: these notes are our own prose, but they are still
                        // data, and innerHTML here would make the changelog an injection surface.
                        const child = tag ? document.createElement(tag) : document.createTextNode(seg.value);
                        if (tag) child.textContent = seg.value;
                        node.appendChild(child);
                    }
                };

                const renderBlocks = (blocks, into) => {
                    for (const b of blocks || []) {
                        if (b.type === 'list') {
                            const ul = document.createElement('ul');
                            ul.className = 'whats-new-list';
                            for (const item of b.items) {
                                const li = document.createElement('li');
                                appendInline(li, item);
                                ul.appendChild(li);
                            }
                            into.appendChild(ul);
                        } else if (b.text) {
                            const p = document.createElement('p');
                            p.className = 'whats-new-text';
                            appendInline(p, b.text);
                            into.appendChild(p);
                        }
                    }
                };

                const [latest, ...earlier] = releases;

                const head = document.createElement('div');
                head.className = 'whats-new-head';
                head.textContent = `${latest.version} · ${humanDate(latest.date)}`;
                host.appendChild(head);
                renderBlocks(latest.blocks, host);

                for (const rel of earlier) {
                    const details = document.createElement('details');
                    details.className = 'whats-new-past';
                    const summary = document.createElement('summary');
                    summary.textContent = `${rel.version} · ${humanDate(rel.date)}`;
                    details.appendChild(summary);
                    renderBlocks(rel.blocks, details);
                    host.appendChild(details);
                }

                section.style.display = '';
            })();

            const _textareaResizeTarget = document.getElementById('transcription-text');
            if (_textareaResizeTarget && typeof ResizeObserver !== 'undefined') {
                let _textareaResizeTimer;
                new ResizeObserver(() => {
                    clearTimeout(_textareaResizeTimer);
                    _textareaResizeTimer = setTimeout(() => {
                        updateTextHighlightFromTime();
                    }, 50);
                }).observe(_textareaResizeTarget);
            }
        })();
