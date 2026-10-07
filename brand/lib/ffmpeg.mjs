// ffmpeg, resolved rather than assumed.
//
// winget installs into a Links shim directory that an already-running shell won't have on PATH.
// Same reasoning as resolving Electron through path.txt. Shared by build-video.mjs (encode) and
// build-voiceover.mjs (mux), which must agree on the binary or a voiced render could be encoded by
// one ffmpeg and muxed by another.

import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export function findFfmpeg(name = 'ffmpeg') {
    const candidates = [
        name,
        path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WinGet', 'Links', `${name}.exe`),
    ];
    for (const c of candidates) {
        try { execFileSync(c, ['-version'], { stdio: 'ignore' }); return c; } catch { /* next */ }
    }
    throw new Error(`${name} not found. Tried PATH and %LOCALAPPDATA%\\Microsoft\\WinGet\\Links.\n` +
        '  Install with: winget install Gyan.FFmpeg');
}

const FFMPEG = findFfmpeg();

export const ff = (args, cwd) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args],
    { cwd, stdio: ['ignore', 'inherit', 'inherit'] });

let _ffprobe = null;

/** Length of a media file in seconds. Resolved lazily — only the voiceover build needs ffprobe. */
export function durationOf(file) {
    _ffprobe ??= findFfmpeg('ffprobe');
    return parseFloat(execFileSync(_ffprobe,
        ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
}
