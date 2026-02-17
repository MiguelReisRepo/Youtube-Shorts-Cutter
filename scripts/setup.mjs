/**
 * Post-install script: downloads the yt-dlp binary into ./bin/
 * so users don't need system-level installs.
 */
import { existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import https from 'https';
import fs from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const BIN_DIR = join(ROOT, 'bin');

// Determine platform
const PLATFORM = process.platform; // darwin, linux, win32
const ARCH = process.arch; // x64, arm64

function getYtDlpUrl() {
  if (PLATFORM === 'darwin') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos';
  } else if (PLATFORM === 'linux') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
  } else if (PLATFORM === 'win32') {
    return 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';
  }
  throw new Error(`Unsupported platform: ${PLATFORM}`);
}

function getYtDlpFilename() {
  return PLATFORM === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

async function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      https.get(url, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          follow(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
        file.on('error', reject);
      }).on('error', reject);
    };
    follow(url);
  });
}

async function main() {
  mkdirSync(BIN_DIR, { recursive: true });

  const ytdlpPath = join(BIN_DIR, getYtDlpFilename());

  // Check if yt-dlp already exists
  if (existsSync(ytdlpPath)) {
    console.log('✅ yt-dlp binary already exists');
  } else {
    const url = getYtDlpUrl();
    console.log(`⬇️  Downloading yt-dlp for ${PLATFORM}/${ARCH}...`);
    console.log(`   ${url}`);

    try {
      await downloadFile(url, ytdlpPath);

      // Make executable on Unix
      if (PLATFORM !== 'win32') {
        chmodSync(ytdlpPath, 0o755);
      }

      console.log(`✅ yt-dlp downloaded to ${ytdlpPath}`);
    } catch (err) {
      console.error(`❌ Failed to download yt-dlp: ${err.message}`);
      console.log('   You can install it manually: pip install yt-dlp');
      console.log('   Or: brew install yt-dlp');
    }
  }

  // Check ffmpeg-static
  try {
    const ffmpegStatic = (await import('ffmpeg-static')).default;
    if (ffmpegStatic && existsSync(ffmpegStatic)) {
      console.log(`✅ ffmpeg available at ${ffmpegStatic}`);
    } else {
      console.log('⚠️  ffmpeg-static path not found, will try system ffmpeg');
    }
  } catch {
    console.log('⚠️  ffmpeg-static not yet available (will work after install completes)');
  }

  console.log('\n🎬 Setup complete!');
  console.log('   Whisper model for captions will auto-download on first use (~150MB).');
  console.log('   Run `npm run dev` to start.\n');
}

main().catch(console.error);
