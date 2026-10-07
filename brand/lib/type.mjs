// Type and palette shared by everything that burns text into an image — the product video
// (build-video.mjs) and the Product Hunt gallery (build-ph-gallery.mjs).
//
// Lifted verbatim from the site's :root tokens (../vocal-slice-web/styles.css) so the video, the
// gallery and the page all set text identically. The site's rule is serif for the wordmark and every
// heading, sans for body — serif being Georgia, which is also the app's own transcription font.
// Generated artwork follows the same split: serif for the brand, sans for narration and headlines.
//
// This lives apart from app-stage.mjs deliberately: that module is the CDP driver, and typography
// isn't its job. It's a separate module rather than a copy in each script because a second copy of
// these constants is a second thing to forget when the site's tokens change.

export const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";
export const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const TEXT = '#cdd6f4';      // --text
export const SUBTEXT = '#a6adc8';   // --subtext0
export const OVERLAY = '#6c7086';   // --overlay0

export const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Greedy wrap to at most two lines, sized off an approximate advance width for this face. */
export function wrapText(text, maxWidth, fontSize) {
    const maxChars = Math.max(12, Math.floor(maxWidth * 0.92 / (fontSize * 0.52)));
    const words = text.split(' ');
    const lines = [''];
    for (const w of words) {
        const line = lines[lines.length - 1];
        if (!line) lines[lines.length - 1] = w;
        else if ((line + ' ' + w).length <= maxChars) lines[lines.length - 1] = line + ' ' + w;
        else lines.push(w);
    }
    return lines.slice(0, 2);
}
