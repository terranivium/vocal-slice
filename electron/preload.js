const { contextBridge, ipcRenderer } = require('electron');

// Expose safe APIs to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron
  },
  // Native file dialog
  openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
  // Safe file operations - only for user-selected files and app data
  checkFileExists: (filePath) => ipcRenderer.invoke('check-file-exists', filePath),
  getFileName: (filePath) => ipcRenderer.invoke('get-file-name', filePath),
  getSlicesDir: () => ipcRenderer.invoke('get-slices-dir'),
  saveSliceFile: (fileName, arrayBuffer) => ipcRenderer.invoke('save-slice-file', fileName, arrayBuffer),
  readAudioFile: (filePath) => ipcRenderer.invoke('read-audio-file', filePath),
  deleteSliceFile: (filePath) => ipcRenderer.invoke('delete-slice-file', filePath),
  // Getting slices out: batch export to a folder the user picks, and drag-to-desktop/DAW.
  // Both take [{filePath, fileName}] — the stored file plus the name the user's template wants.
  exportSlices: (items) => ipcRenderer.invoke('export-slices', items),
  startSliceDrag: (items) => ipcRenderer.send('start-slice-drag', items),   // send: startDrag returns nothing
  // Taskbar (Windows) / dock (macOS) progress for a transcription run, and the attention nudge
  // when one ends with the window in the background.
  setProgress: (value) => ipcRenderer.invoke('set-progress', value),
  signalFinished: () => ipcRenderer.invoke('signal-finished'),
  // App/version info for the About section
  getAppInfo: () => ipcRenderer.invoke('get-app-info'),
  // User-initiated diagnostics export (Log tab)
  saveDiagnostics: (text, defaultName) => ipcRenderer.invoke('save-diagnostics', text, defaultName),
  // Storage panel: model location / cleanup
  getStorageInfo: () => ipcRenderer.invoke('get-storage-info'),
  openStorageFolder: (key) => ipcRenderer.invoke('open-storage-folder', key),
  clearHttpCache: () => ipcRenderer.invoke('clear-http-cache'),
  // Downloaded Whisper models — listed from disk, deleted by manifest id (see electron/models.js)
  listModels: () => ipcRenderer.invoke('list-models'),
  deleteModel: (id) => ipcRenderer.invoke('delete-model', id),
  // Model download progress, main→renderer. Needed because the fetch happens in main: the
  // renderer's own request for a model file blocks until the download is verified, so
  // transformers.js has no progress of its own to report. Same wrapper shape as onUpdateStatus —
  // the IpcRendererEvent is stripped so the callback only ever sees the payload.
  onModelProgress: (callback) => ipcRenderer.on('model-progress', (_event, p) => callback(p)),
  // About: bundled open-source attribution, shown in-app (the file lives inside app.asar)
  getThirdPartyNotices: () => ipcRenderer.invoke('get-third-party-notices'),
  // Auto-update. onUpdateStatus is a main→renderer push (the first one here); the wrapper strips the
  // IpcRendererEvent so the callback only ever sees the payload, never a handle to ipc internals.
  onUpdateStatus: (callback) => ipcRenderer.on('update-status', (_event, status) => callback(status)),
  restartToUpdate: () => ipcRenderer.invoke('quit-and-install')
});
