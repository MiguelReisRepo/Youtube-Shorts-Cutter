/**
 * Resolves paths to yt-dlp and ffmpeg binaries.
 * 
 * Priority:
 * 1. Bundled binaries in ./bin/ (downloaded by postinstall)
 * 2. npm packages (ffmpeg-static)
 * 3. System PATH (fallback)
 */
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '../..');
const BIN_DIR = path.join(PROJECT_ROOT, 'bin');

// ─── yt-dlp ─────────────────────────────────────────

function findYtDlp(): string {
  const filename = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

  // 1. Check bundled binary
  const bundled = path.join(BIN_DIR, filename);
  if (fs.existsSync(bundled)) {
    console.log(`[bin] yt-dlp: using bundled → ${bundled}`);
    return bundled;
  }

  // 2. Check system PATH
  try {
    const cmd = process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
    const systemPath = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0];
    if (systemPath && fs.existsSync(systemPath)) {
      console.log(`[bin] yt-dlp: using system → ${systemPath}`);
      return systemPath;
    }
  } catch {}

  // 3. Last resort — hope it's in PATH at runtime
  console.log('[bin] yt-dlp: not found! Run `npm run postinstall` or install manually');
  return 'yt-dlp';
}

// ─── ffmpeg ─────────────────────────────────────────

function findFfmpeg(): string {
  // 1. Check ffmpeg-static npm package
  try {
    // Dynamic import would be cleaner but we need sync here
    const ffmpegStaticPath = path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static', 'ffmpeg');
    if (fs.existsSync(ffmpegStaticPath)) {
      console.log(`[bin] ffmpeg: using ffmpeg-static → ${ffmpegStaticPath}`);
      return ffmpegStaticPath;
    }

    // On some platforms the binary has an extension or different name
    const entries = fs.readdirSync(path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static'));
    const ffmpegBin = entries.find(e => e.startsWith('ffmpeg'));
    if (ffmpegBin) {
      const fullPath = path.join(PROJECT_ROOT, 'node_modules', 'ffmpeg-static', ffmpegBin);
      console.log(`[bin] ffmpeg: using ffmpeg-static → ${fullPath}`);
      return fullPath;
    }
  } catch {}

  // 2. Check system PATH
  try {
    const cmd = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg';
    const systemPath = execSync(cmd, { encoding: 'utf-8' }).trim().split('\n')[0];
    if (systemPath && fs.existsSync(systemPath)) {
      console.log(`[bin] ffmpeg: using system → ${systemPath}`);
      return systemPath;
    }
  } catch {}

  // 3. Last resort
  console.log('[bin] ffmpeg: not found! Install ffmpeg-static or system ffmpeg');
  return 'ffmpeg';
}

// ─── Export resolved paths ──────────────────────────

export const YTDLP_PATH = findYtDlp();
export const FFMPEG_PATH = findFfmpeg();
