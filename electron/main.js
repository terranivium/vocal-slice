const { app, BrowserWindow, dialog, ipcMain, nativeImage, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { removeLegacyLicenseState } = require('./license-cleanup');
const models = require('./models');
const { autoUpdater } = require('electron-updater');

// Must run before app.ready — registerSchemesAsPrivileged is ignored after that, and the model://
// scheme would then be invisible to the renderer's fetch(). See electron/models.js.
models.registerScheme();

// Create app data directory for slice storage
const userDataPath = app.getPath('userData');
const slicesDir = path.join(userDataPath, 'slices');
if (!fs.existsSync(slicesDir)) {
    fs.mkdirSync(slicesDir, { recursive: true });
}

// Hot reload in development mode
const isDev = process.argv.includes('--dev') || !app.isPackaged;
if (isDev) {
  try {
    require('electron-reload')(path.join(__dirname, '..'), {
      electron: path.join(__dirname, '../node_modules', '.bin', 'electron'),
      hardResetMethod: 'exit',
      watchRenderer: true,
      ignore: [
        /node_modules/,
        /dist/,
        /static[\/\\]build/,
        /\.git/
      ]
    });
    console.log('Hot reload enabled');
  } catch (err) {
    console.log('electron-reload not found. Run: npm install --save-dev electron-reload');
  }
}

// Enable WebGPU with proper flags.
//
// SharedArrayBuffer is here for CPU transcription, not WebGPU. ONNX Runtime decides whether it can
// use threads by testing `typeof SharedArrayBuffer` and whether one survives postMessage — NOT by
// checking crossOriginIsolated, whatever its warning text says. Chromium normally gates SAB behind
// cross-origin isolation, which a file:// page can never have; this switch un-gates it, and
// measured on a 12-core machine that takes CPU transcription from 12.07s to 6.00s on Base EN and
// from 176s to 60s on Medium, with byte-identical transcripts. static/js/app.js sets the thread
// count and carries the numbers.
//
// The trade is real but narrow: SAB without cross-origin isolation re-opens Spectre-class timing
// side channels. That attack needs hostile JavaScript running in this renderer, and there is none —
// every script is first-party and bundled, webSecurity is on, allowRemoteModels is off, and no
// remote content or untrusted frame is ever loaded. It is also a same-process concern only; it
// opens no route for anything to leave the machine.
app.commandLine.appendSwitch('enable-features', 'Vulkan,UseSkiaRenderer,SharedArrayBuffer');
app.commandLine.appendSwitch('enable-unsafe-webgpu');

let mainWindow;

// App/version info: major from package.json + auto build number (git commit count) →
// displayVersion "v{major}.{buildNumber}" (e.g. v1.247). Baked into build-info.json at build
// time (production, no .git); live-git override in dev.
function getAppInfo() {
  const info = { version: require('../package.json').version, buildNumber: 'unknown', gitHash: 'unknown', gitBranch: 'unknown' };
  try {
    Object.assign(info, JSON.parse(fs.readFileSync(path.join(__dirname, '../static/build-info.json'), 'utf8')));
  } catch (e) { /* no build-info (dev) */ }
  if (isDev) {
    // Running from source: any baked build-info is stale, so don't report a build time.
    info.buildTime = null;
    try {
      const o = { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'ignore'] };
      info.gitHash = execSync('git rev-parse --short HEAD', o).toString().trim();
      info.gitBranch = execSync('git rev-parse --abbrev-ref HEAD', o).toString().trim();
      info.buildNumber = execSync('git rev-list --count HEAD', o).toString().trim();
    } catch (e) { /* git unavailable */ }
  }
  const major = String(info.version).split('.')[0] || '1';
  info.displayVersion = (info.buildNumber && info.buildNumber !== 'unknown')
    ? `v${major}.${info.buildNumber}`
    : `v${info.version}`;
  return info;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 950,
    height: 780,
    minWidth: 780,
    minHeight: 600,
    resizable: true,
    backgroundColor: '#667eea',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      // Same-origin policy ON. Model files come from model://, a privileged scheme served by the
      // main process (electron/models.js), and wasm/vendor assets load same-origin from file://,
      // so this doesn't need to be disabled.
      webSecurity: true,
      enableBlinkFeatures: 'WebGPU'
    },
    icon: process.platform === 'win32'
      ? path.join(__dirname, '../static/AppIcon.ico')
      : nativeImage.createFromPath(path.join(__dirname, '../static/AppIcon.icns')),
    show: false
  });

  // Remove menu completely (even on Alt key press)
  mainWindow.setMenu(null);

  // Here rather than once at startup: on macOS closing the window doesn't quit the app, and
  // reopening from the dock builds a NEW webContents. Set once at whenReady, the download
  // progress would then be addressed to the closed window's — so a first-run model download
  // after a reopen reported nothing at all and looked like a hang (measured: 118MB fetched
  // with the card still reading "Preparing…").
  models.setProgressTarget(mainWindow.webContents);

  // Versioned title in the native title bar; don't let the page <title> override it.
  const appTitle = `Vocal Slice ${getAppInfo().displayVersion}`;
  mainWindow.on('page-title-updated', (e) => e.preventDefault());
  mainWindow.setTitle(appTitle);

  // Load the app (minified in production, original in development)
  const htmlFile = isDev ? 'index.html' : 'index.min.html';
  mainWindow.loadFile(path.join(__dirname, '../static', htmlFile));

  // Show window when ready to prevent flashing
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open DevTools in development mode
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    require('electron').shell.openExternal(url);
    return { action: 'deny' };
  });

  // Both platforms stop the attention signal on activation by themselves; this is belt and
  // braces, and makes the intent explicit.
  mainWindow.on('focus', () => mainWindow.flashFrame(false));

  // A reload mid-transcription would otherwise strand the taskbar bar, since the renderer owns
  // clearing it.
  mainWindow.webContents.on('did-finish-load', () => mainWindow.setProgressBar(-1, { mode: 'none' }));

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers for safe file operations
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    // Only formats Chromium can actually decode. Decoding is a bare decodeAudioData (app.js), so
    // this list has to track the media stack, not our wishes: .wma and .aiff were offered here and
    // both fail with "Unable to decode audio data" — and because loadAudioFile has no catch of its
    // own, the user got an alert claiming *transcription* had failed, for a format we suggested.
    // loadAudioFile in static/js/app.js names this same set when a file won't decode — change both.
    filters: [
      { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  
  const filePath = result.filePaths[0];
  const stats = fs.statSync(filePath);
  
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stats.size
  };
});

ipcMain.handle('check-file-exists', async (event, filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch (error) {
    return false;
  }
});

ipcMain.handle('get-file-name', async (event, filePath) => {
  return path.basename(filePath);
});

ipcMain.handle('get-slices-dir', async () => {
  return slicesDir;
});

ipcMain.handle('get-app-info', () => getAppInfo());

// Auto-update. Requested by the renderer's "restart to apply" toast (update-downloaded).
ipcMain.handle('quit-and-install', () => autoUpdater.quitAndInstall());

// Transcription progress on the Windows taskbar button / macOS dock icon, so a long run stays
// readable with the window minimised. One Electron API covers both platforms. The convention is
// Electron's own: <0 clears, >1 is indeterminate (the model download and the alignment tail have
// no honest number), 0..1 is a real fraction.
ipcMain.handle('set-progress', (event, value) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const v = Number(value);
  if (!Number.isFinite(v) || v < 0) mainWindow.setProgressBar(-1, { mode: 'none' });
  else if (v > 1) mainWindow.setProgressBar(2, { mode: 'indeterminate' });
  else mainWindow.setProgressBar(v, { mode: 'normal' });
});

// A finished run is worth noticing from another app — but only if the user is in another app.
// flashFrame is the taskbar flash on Windows and requestUserAttention (a dock bounce) on macOS.
ipcMain.handle('signal-finished', () => {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isFocused()) return;
  mainWindow.flashFrame(true);
});

// Storage panel: where the app's data (including the downloaded models) actually lives.
ipcMain.handle('get-storage-info', () => ({
  userData: app.getPath('userData'),
  slicesDir,
  modelsDir: models.modelsRoot(),
}));

// Takes a key, not a path — the renderer never gets to name an arbitrary location to open.
ipcMain.handle('open-storage-folder', (event, key) =>
  shell.openPath(key === 'slices' ? slicesDir
    : key === 'models' ? models.modelsRoot()
      : app.getPath('userData')));

// Which models are on disk and how much room they take. Replaces the Cache-API accounting the
// panel used to do by parsing Hugging Face URLs — the files are real now, so this is just a stat().
ipcMain.handle('list-models', () => models.list());

// Only ever deletes a directory that matches a model in the shipped manifest (see models.remove).
ipcMain.handle('delete-model', (event, id) => models.remove(id));

// Attribution for the bundled OSS (Apache-2.0/MIT) we're obliged to ship. Packaged, this path is
// inside app.asar — fine to *read* (Electron's fs is asar-aware) but not something the OS shell can
// open, which is why the renderer displays the text rather than handing the file to shell.openPath.
// Fixed path only — same rule as above.
ipcMain.handle('get-third-party-notices', () => {
  try {
    return fs.readFileSync(path.join(__dirname, '../THIRD-PARTY-NOTICES.md'), 'utf8');
  } catch {
    return null;                 // source checkout that hasn't run prebuild, or a broken package
  }
});

// Chromium's HTTP cache holds copies of the downloaded model files too, so clear it alongside the
// Cache API entries — otherwise the space we tell the user they freed isn't really freed.
ipcMain.handle('clear-http-cache', () => session.defaultSession.clearCache());

// User-initiated diagnostics export (Log tab). Writes only where the user chooses.
ipcMain.handle('save-diagnostics', async (event, text, defaultName) => {
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultName,
    filters: [{ name: 'Text', extensions: ['txt', 'log'] }]
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, text, 'utf8');
  return filePath;
});

ipcMain.handle('save-slice-file', async (event, fileName, arrayBuffer) => {
  try {
    const filePath = path.join(slicesDir, fileName);
    const buffer = Buffer.from(arrayBuffer);
    fs.writeFileSync(filePath, buffer);
    return filePath;
  } catch (error) {
    console.error('Failed to save slice:', error);
    throw error;
  }
});

// --- Getting slices out of the app: "Export selected" and drag-to-desktop/DAW ---
//
// Both take {filePath, fileName} pairs from the renderer, because the on-disk name is internal
// (slice_<ts>_<start>-<end>.wav) and the name the user wants comes from their filename template.
// So both *copy* to a new name rather than handing out the stored file.
//
// Neither trusts the renderer's strings: the source has to already live in slicesDir, and the
// destination name is reduced to a basename — the template is user-editable text and must not be
// able to steer a write somewhere else.
function resolveSliceItems(items) {
  return (Array.isArray(items) ? items : []).flatMap((it) => {
    const src = path.resolve(String((it && it.filePath) || ''));
    const name = path.basename(String((it && it.fileName) || ''));
    if (path.dirname(src) !== slicesDir || !name || !fs.existsSync(src)) return [];
    return [{ src, name }];
  });
}

// Two slices can render to the same name (a template of just {slug}, say). Suffix instead of
// silently overwriting — an export that quietly drops files is worse than an odd name.
function uniqueDestination(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 2; fs.existsSync(candidate); n++) {
    candidate = path.join(dir, `${stem}-${n}${ext}`);
  }
  return candidate;
}

ipcMain.handle('export-slices', async (event, items) => {
  const resolved = resolveSliceItems(items);
  const skipped = (Array.isArray(items) ? items.length : 0) - resolved.length;
  if (resolved.length === 0) return { dir: null, written: 0, skipped };

  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Export slices to…',
    buttonLabel: 'Export here',
    properties: ['openDirectory', 'createDirectory']
  });
  if (canceled || !filePaths || filePaths.length === 0) return null;

  const dir = filePaths[0];
  let written = 0;
  for (const { src, name } of resolved) {
    try {
      fs.copyFileSync(src, uniqueDestination(dir, name));
      written++;
    } catch (error) {
      console.error('Failed to export slice:', name, error);
    }
  }
  return { dir, written, skipped: skipped + (resolved.length - written) };
});

// Drag-out. startDrag needs real files on disk under the names the user should see, so stage
// copies in temp; the folder is wiped at the start of each drag so it can't grow unbounded.
const dragStagingDir = path.join(app.getPath('temp'), 'vocal-slice-drag');

// startDrag throws on an empty icon, so build it once from the same asset the window uses. If it
// ever comes back empty the drag would fail on every attempt, hence the startup warning.
let dragIcon = null;
function getDragIcon() {
  if (dragIcon) return dragIcon;
  const iconPath = path.join(__dirname, process.platform === 'win32' ? '../static/AppIcon.ico' : '../static/AppIcon.icns');
  dragIcon = nativeImage.createFromPath(iconPath).resize({ width: 32, height: 32 });
  if (dragIcon.isEmpty()) console.warn('Drag icon is empty — dragging slices out will fail:', iconPath);
  return dragIcon;
}

// ipcMain.on, not handle: startDrag is fire-and-forget and hands the drag to the OS.
ipcMain.on('start-slice-drag', (event, items) => {
  const resolved = resolveSliceItems(items);
  if (resolved.length === 0) return;

  try {
    fs.rmSync(dragStagingDir, { recursive: true, force: true });
    fs.mkdirSync(dragStagingDir, { recursive: true });
    const files = resolved.map(({ src, name }) => {
      const dest = uniqueDestination(dragStagingDir, name);
      fs.copyFileSync(src, dest);
      return dest;
    });
    event.sender.startDrag({ files, icon: getDragIcon() });
  } catch (error) {
    console.error('Failed to start slice drag:', error);
  }
});

ipcMain.handle('read-audio-file', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error('File not found');
    }
    const buffer = fs.readFileSync(filePath);
    return buffer.buffer;
  } catch (error) {
    console.error('Failed to read audio file:', error);
    throw error;
  }
});

ipcMain.handle('delete-slice-file', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Failed to delete slice:', error);
  }
});

// Auto-update. Lenient by design: download in the background and install on the next quit
// (electron-updater defaults), then just offer a "restart to apply" toast — never nag, never block.
// Inert in dev (no app-update.yml when unpackaged) and silent if the releases feed is unreachable
// (e.g. before the first release exists) — a broken update check must never disturb the app.
function initAutoUpdater() {
  if (!app.isPackaged) return;                 // dev / running from source: nothing to update

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('update-downloaded', (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-status', { state: 'downloaded', version: info && info.version });
    }
  });
  // Swallow errors: no releases yet → 404, offline → network error. Neither is actionable for the user.
  autoUpdater.on('error', (err) => console.log('autoUpdater:', err && err.message));

  autoUpdater.checkForUpdates().catch((err) => console.log('autoUpdater check skipped:', err && err.message));
}

// App lifecycle
app.whenReady().then(() => {
  if (process.platform === 'darwin') {
    app.dock.setIcon(nativeImage.createFromPath(path.join(__dirname, '../static/AppIcon.icns')));
  }
  // protocol.handle, unlike the scheme registration above, has to wait for ready.
  models.register();
  createWindow();
  initAutoUpdater();
  // Free since 2.x: clear the 1.x trial/licence record off this machine (no-op once it's gone).
  removeLegacyLicenseState();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  dialog.showErrorBox('Error', error.message);
});
