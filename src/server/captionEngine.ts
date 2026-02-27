import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { YTDLP_PATH, FFMPEG_PATH, YTDLP_COMMON_ARGS } from './binPaths.js';
import type { SubtitleEntry } from '../types/index.js';

const execFileAsync = promisify(execFile);

export type { SubtitleEntry };

export interface CaptionStyle {
  fontName: string;
  fontSize: number;
  primaryColor: string;   // ASS color &HBBGGRR& format
  outlineColor: string;
  bgColor: string;
  bold: boolean;
  outline: number;
  shadow: number;
  position: 'bottom' | 'center' | 'top';
  animation: 'none' | 'word-by-word' | 'pop';
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontName: 'Arial Black',
  fontSize: 58,
  primaryColor: '&H00FFFFFF',   // White
  outlineColor: '&H00000000',   // Black
  bgColor: '&H80000000',        // Semi-transparent black
  bold: true,
  outline: 5,
  shadow: 0,
  position: 'bottom',
  animation: 'word-by-word',
};

// Popular preset styles
export const CAPTION_PRESETS = {
  classic: {
    ...DEFAULT_CAPTION_STYLE,
    fontName: 'Arial Black',
    fontSize: 56,
    animation: 'none' as const,
  },
  tiktok: {
    ...DEFAULT_CAPTION_STYLE,
    fontName: 'Arial Black',
    fontSize: 68,
    primaryColor: '&H00FFFFFF',
    outlineColor: '&H00000000',
    outline: 6,
    position: 'center' as const,
    animation: 'word-by-word' as const,
  },
  minimal: {
    ...DEFAULT_CAPTION_STYLE,
    fontName: 'Arial',
    fontSize: 48,
    bold: false,
    outline: 4,
    shadow: 2,
    animation: 'none' as const,
  },
  bold_pop: {
    ...DEFAULT_CAPTION_STYLE,
    fontName: 'Impact',
    fontSize: 72,
    primaryColor: '&H0000FFFF',  // Yellow
    outlineColor: '&H00000000',
    outline: 6,
    position: 'center' as const,
    animation: 'pop' as const,
  },
};

// ─── Subtitle Cache ─────────────────────────────────
// Download subtitles ONCE per video, then slice per segment

interface CachedSubtitles {
  videoUrl: string;
  entries: SubtitleEntry[];  // Full video subtitles (absolute timestamps)
  language: string;
}

let subtitleCache: CachedSubtitles | null = null;

export function clearSubtitleCache(): void {
  subtitleCache = null;
}

// ─── Step 1: Get Subtitles ──────────────────────────

/**
 * Try to get subtitles for a video segment:
 * 1. Use cached subtitles if available (downloaded once per job)
 * 2. Download YouTube's auto-generated subtitles via yt-dlp
 * 3. Fall back to local Whisper transcription if available
 */
export async function getSubtitles(
  videoUrl: string,
  videoPath: string,
  startS: number,
  endS: number,
): Promise<SubtitleEntry[]> {
  // Check cache first — avoid re-downloading for each clip
  if (subtitleCache && subtitleCache.videoUrl === videoUrl) {
    const sliced = sliceSubtitles(subtitleCache.entries, startS, endS);
    if (sliced.length > 0) {
      console.log(`[captions] Using cached ${subtitleCache.language} subtitles (${sliced.length} entries for this segment)`);
      return sliced;
    }
  }

  // Download full subtitles once (not cached yet)
  if (!subtitleCache || subtitleCache.videoUrl !== videoUrl) {
    console.log('[captions] Downloading YouTube subtitles (once for all clips)...');
    const result = await downloadYouTubeSubtitlesFull(videoUrl);
    if (result) {
      subtitleCache = { videoUrl, entries: result.entries, language: result.language };
      console.log(`[captions] ✅ Cached ${result.entries.length} subtitle entries (${result.language})`);
      const sliced = sliceSubtitles(result.entries, startS, endS);
      if (sliced.length > 0) return sliced;
    }
  }

  // Try local Whisper as fallback
  console.log('[captions] No YouTube subs, trying local Whisper...');
  const whisperSubs = await transcribeWithWhisper(videoPath, startS, endS);
  if (whisperSubs.length > 0) {
    console.log(`[captions] ✅ Got ${whisperSubs.length} entries from Whisper`);
    return whisperSubs;
  }

  console.log('[captions] ⚠️ No subtitle source available');
  return [];
}

/**
 * Fetch subtitles for preview/editing (YouTube subs only, no Whisper).
 * Fast because it doesn't require downloading the video.
 */
export async function getSubtitlesForPreview(
  videoUrl: string,
  startS: number,
  endS: number,
): Promise<SubtitleEntry[]> {
  if (subtitleCache && subtitleCache.videoUrl === videoUrl) {
    const sliced = sliceSubtitles(subtitleCache.entries, startS, endS);
    if (sliced.length > 0) return sliced;
  }

  if (!subtitleCache || subtitleCache.videoUrl !== videoUrl) {
    console.log('[captions] Downloading YouTube subtitles for preview...');
    const result = await downloadYouTubeSubtitlesFull(videoUrl);
    if (result) {
      subtitleCache = { videoUrl, entries: result.entries, language: result.language };
      console.log(`[captions] ✅ Cached ${result.entries.length} subtitle entries (${result.language})`);
      const sliced = sliceSubtitles(result.entries, startS, endS);
      if (sliced.length > 0) return sliced;
    }
  }

  return [];
}

/**
 * Slice cached full-video subtitles to a specific time range.
 * Returns entries with timestamps relative to the segment start.
 */
function sliceSubtitles(
  allEntries: SubtitleEntry[],
  startS: number,
  endS: number,
): SubtitleEntry[] {
  return allEntries
    .filter(e => e.endS > startS && e.startS < endS)
    .map(e => ({
      startS: Math.max(0, e.startS - startS),
      endS: Math.min(endS - startS, e.endS - startS),
      text: e.text,
    }));
}

/**
 * Download full subtitles for the entire video.
 * Tries multiple languages: auto-detect, then common languages.
 */
async function downloadYouTubeSubtitlesFull(
  videoUrl: string,
): Promise<{ entries: SubtitleEntry[]; language: string } | null> {
  const tmpDir = path.join(os.tmpdir(), `yt-subs-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Try languages in order: auto-detect first, then common languages
  const langAttempts = [
    'all',    // Auto-detect: grab whatever's available
  ];

  try {
    // First, try to get any available subtitles
    try {
      await execFileAsync(YTDLP_PATH, [
        ...YTDLP_COMMON_ARGS,
        '--write-auto-sub',
        '--sub-lang', 'pt,pt-BR,en,es,fr,de,it,ja,ko,zh',
        '--sub-format', 'json3',
        '--skip-download',
        '-o', path.join(tmpDir, 'subs'),
        '--no-warnings',
        videoUrl,
      ], { maxBuffer: 1024 * 1024 * 50, timeout: 30000 });
    } catch {
      // If that fails, try without specifying language
      await execFileAsync(YTDLP_PATH, [
        ...YTDLP_COMMON_ARGS,
        '--write-auto-sub',
        '--sub-format', 'json3',
        '--skip-download',
        '-o', path.join(tmpDir, 'subs'),
        '--no-warnings',
        videoUrl,
      ], { maxBuffer: 1024 * 1024 * 50, timeout: 30000 });
    }

    // Find whatever subtitle file was downloaded
    const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json3'));
    if (!files.length) return null;

    // Pick the best file (prefer pt/pt-BR, then en, then whatever)
    const preferred = ['pt-BR', 'pt', 'en'];
    let chosen = files[0];
    for (const lang of preferred) {
      const match = files.find(f => f.includes(`.${lang}.`));
      if (match) { chosen = match; break; }
    }

    // Detect language from filename
    const langMatch = chosen.match(/\.([a-z]{2}(?:-[A-Z]{2})?)\.json3$/);
    const language = langMatch ? langMatch[1] : 'auto';

    const raw = fs.readFileSync(path.join(tmpDir, chosen), 'utf-8');
    const data = JSON.parse(raw);

    // Parse JSON3 subtitle format — keep ABSOLUTE timestamps
    const entries: SubtitleEntry[] = [];

    if (data.events) {
      for (const event of data.events) {
        if (!event.segs) continue;

        const eventStartS = (event.tStartMs || 0) / 1000;
        const eventEndS = eventStartS + (event.dDurationMs || 2000) / 1000;

        const text = event.segs
          .map((s: any) => s.utf8 || '')
          .join('')
          .trim()
          .replace(/\n/g, ' ');

        if (!text || text === '\n') continue;

        entries.push({
          startS: eventStartS,   // Absolute timestamp
          endS: eventEndS,
          text,
        });
      }
    }

    return entries.length > 0 ? { entries, language } : null;
  } catch (err: any) {
    console.log(`[captions] YouTube subtitle download failed: ${err.message}`);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Transcribe audio using @xenova/transformers (Whisper ONNX).
 * 
 * Pure JavaScript — no native binaries, no pip install.
 * Model auto-downloads on first use (~150MB, cached afterward).
 * Supports auto language detection.
 */

// Lazy-loaded pipeline (heavy — only load when actually needed)
let whisperPipeline: any = null;
let whisperLoadFailed = false;

async function getWhisperPipeline() {
  if (whisperLoadFailed) return null;
  if (whisperPipeline) return whisperPipeline;

  try {
    console.log('[captions] Loading Whisper model (first time may download ~150MB)...');
    const { pipeline } = await import('@xenova/transformers');
    whisperPipeline = await pipeline(
      'automatic-speech-recognition',
      'Xenova/whisper-base',
      { quantized: true },  // Use quantized model for speed
    );
    console.log('[captions] ✅ Whisper model loaded');
    return whisperPipeline;
  } catch (err: any) {
    console.log(`[captions] ⚠️ Whisper model failed to load: ${err.message}`);
    whisperLoadFailed = true;
    return null;
  }
}

async function transcribeWithWhisper(
  videoPath: string,
  startS: number,
  endS: number,
): Promise<SubtitleEntry[]> {
  const pipe = await getWhisperPipeline();
  if (!pipe) return [];

  const tmpDir = path.join(os.tmpdir(), `whisper-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const audioPath = path.join(tmpDir, 'segment.wav');
  const duration = endS - startS;

  try {
    // Extract audio as 16kHz mono WAV
    await execFileAsync(FFMPEG_PATH, [
      '-y', '-ss', String(startS),
      '-i', videoPath,
      '-t', String(duration),
      '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1',
      audioPath,
    ], { timeout: 30000 });

    if (!fs.existsSync(audioPath)) {
      console.log('[captions] Audio extraction failed');
      return [];
    }

    console.log(`[captions] Transcribing ${Math.round(duration)}s of audio...`);

    // Read WAV as Float32Array for Whisper
    const audioBuffer = fs.readFileSync(audioPath);
    // WAV header is 44 bytes, then PCM int16 data
    const pcmData = new Int16Array(
      audioBuffer.buffer,
      audioBuffer.byteOffset + 44,
      (audioBuffer.byteLength - 44) / 2,
    );
    const float32 = new Float32Array(pcmData.length);
    for (let i = 0; i < pcmData.length; i++) {
      float32[i] = pcmData[i] / 32768.0;
    }

    // Run Whisper
    const result = await pipe(float32, {
      return_timestamps: true,
      chunk_length_s: 30,
      stride_length_s: 5,
      language: null,       // Auto-detect
      task: 'transcribe',
    });

    const entries: SubtitleEntry[] = [];

    if (result.chunks) {
      for (const chunk of result.chunks) {
        const text = (chunk.text || '').trim();
        if (!text) continue;

        const [chunkStart, chunkEnd] = chunk.timestamp || [0, 0];
        entries.push({
          startS: chunkStart ?? 0,
          endS: chunkEnd ?? (chunkStart ?? 0) + 2,
          text,
        });
      }
    } else if (result.text) {
      // Single block — no timestamps, create one entry per ~5 words
      const words = result.text.trim().split(/\s+/);
      const wordsPerChunk = 5;
      const chunkDur = duration / Math.ceil(words.length / wordsPerChunk);

      for (let i = 0; i < words.length; i += wordsPerChunk) {
        const chunkWords = words.slice(i, i + wordsPerChunk);
        const chunkIndex = Math.floor(i / wordsPerChunk);
        entries.push({
          startS: chunkIndex * chunkDur,
          endS: (chunkIndex + 1) * chunkDur,
          text: chunkWords.join(' '),
        });
      }
    }

    console.log(`[captions] ✅ Whisper transcribed ${entries.length} segments`);
    return entries;
  } catch (err: any) {
    console.log(`[captions] Whisper transcription failed: ${err.message}`);
    return [];
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

// ─── Step 2: Generate ASS Subtitle File ─────────────

/**
 * Generate an Advanced SubStation Alpha (.ass) subtitle file
 * with animated styling optimized for vertical short-form video.
 */
export function generateASSFile(
  entries: SubtitleEntry[],
  style: CaptionStyle = DEFAULT_CAPTION_STYLE,
  outputPath: string,
): void {
  // Calculate vertical position
  const verticalMargin = style.position === 'bottom' ? 180
    : style.position === 'top' ? 800
    : 500; // center

  // ASS header
  const header = `[Script Info]
Title: Auto Captions
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${style.fontName},${style.fontSize},${style.primaryColor},&H000000FF,${style.outlineColor},${style.bgColor},${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outline},${style.shadow},2,40,40,${verticalMargin},1
Style: Highlight,${style.fontName},${Math.round(style.fontSize * 1.15)},&H0000FFFF,&H000000FF,${style.outlineColor},${style.bgColor},${style.bold ? -1 : 0},0,0,0,100,100,0,0,1,${style.outline + 1},${style.shadow},2,40,40,${verticalMargin},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  // Generate dialogue lines with animation effects
  const lines: string[] = [];

  for (const entry of entries) {
    const start = formatASSTime(entry.startS);
    const end = formatASSTime(entry.endS);
    let text = entry.text.toUpperCase(); // Shorts captions are usually uppercase

    // Clean up text
    text = text.replace(/\\/g, '');

    // Word wrap for vertical video (max ~25 chars per line)
    text = wrapText(text, 18);

    if (style.animation === 'pop') {
      // Pop-in effect using \fscx and \fscy
      const escaped = text.replace(/\n/g, '\\N');
      lines.push(
        `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\fad(100,100)\\t(0,100,\\fscx110\\fscy110)\\t(100,200,\\fscx100\\fscy100)}${escaped}`
      );
    } else if (style.animation === 'word-by-word') {
      // Word-by-word highlight — split into timed words
      const words = entry.text.trim().split(/\s+/);
      const totalDur = entry.endS - entry.startS;
      const wordDur = totalDur / words.length;

      // Show full sentence but highlight current word
      for (let w = 0; w < words.length; w++) {
        const wStart = entry.startS + w * wordDur;
        const wEnd = Math.min(entry.startS + (w + 1) * wordDur, entry.endS);

        const highlighted = words.map((word, idx) => {
          const upper = word.toUpperCase();
          if (idx === w) {
            return `{\\rHighlight}${upper}{\\rDefault}`;
          }
          return upper;
        }).join(' ');

        const wrapped = wrapText(highlighted, 18).replace(/\n/g, '\\N');
        lines.push(
          `Dialogue: 0,${formatASSTime(wStart)},${formatASSTime(wEnd)},Default,,0,0,0,,${wrapped}`
        );
      }
    } else {
      // No animation — simple fade
      const escaped = text.replace(/\n/g, '\\N');
      lines.push(
        `Dialogue: 0,${start},${end},Default,,0,0,0,,{\\fad(150,150)}${escaped}`
      );
    }
  }

  fs.writeFileSync(outputPath, header + lines.join('\n') + '\n');
  console.log(`[captions] Generated ASS file: ${entries.length} entries, style=${style.animation}`);
}

// ─── Step 3: Burn Captions into Video ───────────────

/**
 * Burns ASS subtitles into a video using ffmpeg.
 * This modifies the video in-place (re-encodes).
 */
export async function burnCaptions(
  videoPath: string,
  assPath: string,
  outputPath: string,
): Promise<void> {
  console.log('[captions] Burning captions into video...');

  // Use the ass filter to overlay subtitles
  // The fontsdir helps find system fonts
  // ffmpeg ass filter needs forward slashes on Windows + escaped colons
  const assPathEscaped = assPath.replace(/\\/g, '/').replace(/:/g, '\\:');

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, [
      '-y',
      '-i', videoPath,
      '-vf', `ass='${assPathEscaped}'`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ]);

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log('[captions] ✅ Captions burned into video');
        resolve();
      } else {
        reject(new Error(`Caption burn failed: ${stderr.slice(-300)}`));
      }
    });

    proc.on('error', reject);
  });
}

// ─── Helpers ────────────────────────────────────────

function formatASSTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h}:${m.toString().padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function wrapText(text: string, maxChars: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    // Strip ASS tags for length calculation
    const cleanWord = word.replace(/\{[^}]*\}/g, '');
    const cleanLine = currentLine.replace(/\{[^}]*\}/g, '');

    if (cleanLine.length + cleanWord.length + 1 > maxChars && currentLine) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = currentLine ? `${currentLine} ${word}` : word;
    }
  }
  if (currentLine) lines.push(currentLine);

  return lines.join('\n');
}
