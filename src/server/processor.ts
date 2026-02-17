import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import type { PeakSegment, CutProgress, CaptionPreset } from '../types/index.js';
import { YTDLP_PATH, FFMPEG_PATH } from './binPaths.js';
import { getSubtitles, generateASSFile, clearSubtitleCache, CAPTION_PRESETS, DEFAULT_CAPTION_STYLE } from './captionEngine.js';
import { analyzeReframe, buildCropFilter } from './smartReframe.js';
import { translateSubtitles, TRANSLATION_TARGETS, type TranslationTarget } from './translationEngine.js';
import { generateDubbedVideo } from './dubbingEngine.js';

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = path.resolve(process.cwd(), 'output');
const TEMP_DIR = path.resolve(process.cwd(), 'temp');

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.mkdirSync(TEMP_DIR, { recursive: true });

// Buffer in seconds added before/after each segment to avoid cutting mid-frame
const SEGMENT_BUFFER_S = 3;

// ─── Download a Single Segment ──────────────────────
//
// Uses yt-dlp's --download-sections to grab ONLY the
// needed time range. For a 60s clip from a 2hr video,
// this downloads ~65s instead of ~7200s. (~100x faster)

async function downloadSegment(
  url: string,
  segment: PeakSegment,
  index: number,
  onProgress?: (msg: string) => void,
): Promise<{ filePath: string; offsetS: number }> {
  // Add buffer around the segment for clean cuts
  const bufStart = Math.max(0, segment.startS - SEGMENT_BUFFER_S);
  const bufEnd = segment.endS + SEGMENT_BUFFER_S;
  const offsetS = segment.startS - bufStart; // How far into the downloaded file the real start is

  const sectionArg = `*${bufStart}-${bufEnd}`;
  const outputTemplate = path.join(TEMP_DIR, `segment_${index}_%(id)s.%(ext)s`);

  onProgress?.(
    `Downloading segment ${index + 1}: ${formatTime(segment.startS)} → ${formatTime(segment.endS)} ` +
    `(${Math.round(bufEnd - bufStart)}s instead of full video)`
  );

  try {
    // --download-sections doesn't reliably merge separate video+audio streams
    // Use best pre-muxed format for segments (short clips, quality is fine)
    // Then re-encode to target quality in cutClip anyway
    await execFileAsync(YTDLP_PATH, [
      '-f', 'best[height<=1080]/bestvideo[height<=1080]+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--download-sections', sectionArg,
      '--force-keyframes-at-cuts',
      '-o', outputTemplate,
      '--no-warnings',
      url,
    ], { maxBuffer: 1024 * 1024 * 100, timeout: 120000 });
  } catch (err: any) {
    // Fallback: if --download-sections fails (older yt-dlp), try full download
    if (err.message?.includes('unrecognized') || err.message?.includes('download-sections')) {
      onProgress?.('Partial download not supported, downloading full video...');
      return downloadFullFallback(url, onProgress);
    }
    throw err;
  }

  // Find the downloaded segment file (may be .mp4, .mkv, .webm, or include format ID like .f399.mp4)
  const files = fs.readdirSync(TEMP_DIR)
    .filter(f => f.startsWith(`segment_${index}_`) && (f.endsWith('.mp4') || f.endsWith('.mkv') || f.endsWith('.webm')));

  if (!files.length) throw new Error(`Segment ${index + 1} download failed: no file found`);

  const filePath = path.join(TEMP_DIR, files[0]);
  const fileSize = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);

  // Log source resolution for quality verification
  const resolution = await getVideoResolution(filePath);
  onProgress?.(`Downloaded segment ${index + 1}: ${fileSize} MB ${resolution ? `(${resolution})` : ''}`);

  // Verify the downloaded file has audio
  const hasAudio = await checkHasAudio(filePath);
  if (!hasAudio) {
    console.log(`[download] ⚠️ Segment ${index + 1} missing audio, falling back to full download`);
    try { fs.unlinkSync(filePath); } catch {}
    return downloadFullFallback(url, onProgress);
  }

  return { filePath, offsetS };
}

// ─── Full Download Fallback ─────────────────────────
// Used if yt-dlp version doesn't support --download-sections

let fullVideoCache: string | null = null;

async function downloadFullFallback(
  url: string,
  onProgress?: (msg: string) => void,
): Promise<{ filePath: string; offsetS: number }> {
  // Only download once, cache for subsequent segments
  if (fullVideoCache && fs.existsSync(fullVideoCache)) {
    return { filePath: fullVideoCache, offsetS: 0 };
  }

  onProgress?.('Downloading full video (fallback mode)...');

  const outputTemplate = path.join(TEMP_DIR, 'full_%(id)s.%(ext)s');

  await execFileAsync(YTDLP_PATH, [
    '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    '--no-warnings',
    url,
  ], { maxBuffer: 1024 * 1024 * 100 });

  const files = fs.readdirSync(TEMP_DIR)
    .filter(f => f.startsWith('full_') && f.endsWith('.mp4'));

  if (!files.length) throw new Error('Full download failed');

  fullVideoCache = path.join(TEMP_DIR, files[0]);
  return { filePath: fullVideoCache, offsetS: 0 };
}

// ─── Download for Analysis (full video needed) ──────

export async function downloadVideo(
  url: string,
  onProgress?: (msg: string) => void,
  outputDir?: string,
): Promise<string> {
  onProgress?.('Starting download...');

  const targetDir = outputDir || TEMP_DIR;
  fs.mkdirSync(targetDir, { recursive: true });
  const outputTemplate = path.join(targetDir, '%(id)s.%(ext)s');

  await execFileAsync(YTDLP_PATH, [
    '-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]',
    '--merge-output-format', 'mp4',
    '-o', outputTemplate,
    '--no-warnings',
    url,
  ], { maxBuffer: 1024 * 1024 * 100 });

  const files = fs.readdirSync(targetDir).filter(f => f.endsWith('.mp4'));
  if (!files.length) throw new Error('Download failed: no MP4 file found');

  const filePath = path.join(targetDir, files[files.length - 1]);
  const fileSize = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(0);
  const resolution = await getVideoResolution(filePath);
  onProgress?.(`Downloaded: ${files[files.length - 1]} (${fileSize} MB, ${resolution || 'unknown res'})`);
  return filePath;
}

// ─── Cut Clip to 9:16 Vertical ──────────────────────

async function cutClip(
  inputPath: string,
  startInFile: number,
  duration: number,
  outputPath: string,
  cropMode: 'center' | 'blur_pad' | 'letterbox' | 'smart_reframe' = 'center',
  reframeCropFilter?: string,
  quality: string = '1080',
): Promise<void> {
  // Resolution based on quality
  const resolutions: Record<string, { w: number; h: number; crf: number }> = {
    '1080': { w: 1080, h: 1920, crf: 18 },
    '720':  { w: 720,  h: 1280, crf: 20 },
    '480':  { w: 480,  h: 854,  crf: 22 },
  };
  const { w: width, h: height, crf } = resolutions[quality] || resolutions['1080'];

  let ffmpegArgs: string[];

  if (cropMode === 'smart_reframe' && reframeCropFilter) {
    // Smart reframe: use dynamically computed crop filter
    ffmpegArgs = [
      '-y',
      '-ss', String(startInFile),
      '-i', inputPath,
      '-t', String(duration),
      '-vf', reframeCropFilter,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(crf),
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-movflags', '+faststart',
      outputPath,
    ];
  } else if (cropMode === 'blur_pad') {
    const filterComplex = [
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,`,
      `crop=${width}:${height},boxblur=20:5[bg];`,
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];`,
      `[bg][fg]overlay=(W-w)/2:(H-h)/2`,
    ].join('');

    ffmpegArgs = [
      '-y',
      '-ss', String(startInFile),
      '-i', inputPath,
      '-t', String(duration),
      '-filter_complex', filterComplex,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(crf),
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-movflags', '+faststart',
      outputPath,
    ];
  } else if (cropMode === 'letterbox') {
    // Full original frame, black bars to fill 9:16
    ffmpegArgs = [
      '-y',
      '-ss', String(startInFile),
      '-i', inputPath,
      '-t', String(duration),
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(crf),
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-movflags', '+faststart',
      outputPath,
    ];
  } else {
    ffmpegArgs = [
      '-y',
      '-ss', String(startInFile),
      '-i', inputPath,
      '-t', String(duration),
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', String(crf),
      '-profile:v', 'high',
      '-level', '4.1',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-ar', '44100',
      '-movflags', '+faststart',
      outputPath,
    ];
  }

  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_PATH, ffmpegArgs);

    let stderr = '';
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(-500)}`));
    });

    proc.on('error', (err) => {
      reject(new Error(`ffmpeg failed: ${err.message}`));
    });
  });
}

// ─── Process Full Job (Optimized) ───────────────────
//
// New flow:  for each clip → download segment → convert → cleanup
// Instead of: download ALL → cut each → cleanup
//
// This means for 5 × 60s clips from a 2hr video:
//   Old: download ~2hr  (maybe 1GB)  → cut 5 clips
//   New: download 5×65s (~5min, ~50MB) → convert each

export async function processJob(
  url: string,
  videoTitle: string,
  segments: PeakSegment[],
  cropMode: 'center' | 'blur_pad' | 'letterbox' | 'smart_reframe',
  captionPreset: string,
  onProgress: (progress: CutProgress) => void,
  quality: string = '1080',
  translateTo: string = '',        // '' = none, 'pt-BR', 'es'
  translateMode: string = '',      // '' = none, 'captions', 'dub', 'both'
): Promise<void> {
  const totalDurationS = segments.reduce((sum, s) => sum + (s.endS - s.startS), 0);

  console.log(`\n[processor] Starting optimized job:`);
  console.log(`   ${segments.length} clips, ~${Math.round(totalDurationS)}s total (instead of full video)`);

  // Reset caches for new job
  fullVideoCache = null;
  clearSubtitleCache();

  try {
    const outputFiles: string[] = [];
    const tempFiles: string[] = [];

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const clipDuration = seg.endS - seg.startS;

      // ── Step 1: Download just this segment ────
      onProgress({
        status: 'downloading',
        currentClip: i + 1,
        totalClips: segments.length,
        message: `Downloading clip ${i + 1}/${segments.length}: ${formatTime(seg.startS)} → ${formatTime(seg.endS)} (~${Math.round(clipDuration + SEGMENT_BUFFER_S * 2)}s)`,
      });

      const { filePath: segmentPath, offsetS } = await downloadSegment(
        url, seg, i,
        (msg) => {
          onProgress({
            status: 'downloading',
            currentClip: i + 1,
            totalClips: segments.length,
            message: msg,
          });
        },
      );
      tempFiles.push(segmentPath);

      // ── Step 2: Smart reframe analysis (if needed) ──
      let reframeCropFilter: string | undefined;
      if (cropMode === 'smart_reframe') {
        onProgress({
          status: 'analyzing',
          currentClip: i + 1,
          totalClips: segments.length,
          message: `Analyzing clip ${i + 1} for smart reframe...`,
        });

        try {
          const reframeResult = await analyzeReframe(segmentPath, offsetS, clipDuration);
          if (reframeResult.confidence > 0) {
            reframeCropFilter = buildCropFilter(reframeResult);
            console.log(`   Reframe: ${reframeResult.mode} (confidence: ${reframeResult.confidence})`);
          } else {
            console.log(`   Reframe: low confidence (${reframeResult.confidence}), falling back to center crop`);
          }
        } catch (err: any) {
          console.log(`   Reframe analysis failed, using center crop: ${err.message}`);
        }
      }

      // ── Step 3: Convert to 9:16 ───────────────
      onProgress({
        status: 'processing',
        currentClip: i + 1,
        totalClips: segments.length,
        message: `Converting clip ${i + 1}/${segments.length} to 9:16 vertical...`,
      });

      const safeTitle = videoTitle
        .replace(/[^\w\s-]/g, '')
        .trim()
        .slice(0, 50)
        .replace(/\s+/g, '_');

      const filename = `${safeTitle}_clip${i + 1}_${formatTimeFilename(seg.startS)}.mp4`;
      const outputPath = path.join(OUTPUT_DIR, filename);

      // When using partial download: start from offset within the segment file
      // When using full fallback: start from the original timestamp
      const seekTime = offsetS === 0 ? seg.startS : offsetS;

      await cutClip(segmentPath, seekTime, clipDuration, outputPath, cropMode, reframeCropFilter, quality);

      // ── Step 4: Captions + Translation + Dubbing ──
      const needsSubs = (captionPreset && captionPreset !== 'off') || translateMode;

      if (needsSubs) {
        onProgress({
          status: 'captioning',
          currentClip: i + 1,
          totalClips: segments.length,
          message: `Getting subtitles for clip ${i + 1}/${segments.length}...`,
        });

        try {
          let subs = await getSubtitles(url, segmentPath, seg.startS, seg.endS);

          // ── 4a: Translate subtitles if requested ───
          let translatedSubs = subs;
          const target = translateTo ? TRANSLATION_TARGETS.find(t => t.id === translateTo) : null;

          if (target && subs.length > 0 && (translateMode === 'captions' || translateMode === 'dub' || translateMode === 'both')) {
            onProgress({
              status: 'captioning',
              currentClip: i + 1,
              totalClips: segments.length,
              message: `Translating clip ${i + 1} to ${target.label}...`,
            });

            translatedSubs = await translateSubtitles(subs, target);
          }

          // ── 4b: Burn captions ─────────────────────
          if (captionPreset && captionPreset !== 'off' && (translatedSubs.length > 0 || subs.length > 0)) {
            // Use translated subs for captions if translation mode includes captions
            const captionSubs = (translateMode === 'captions' || translateMode === 'both') && translatedSubs.length > 0
              ? translatedSubs
              : subs;

            if (captionSubs.length > 0) {
              onProgress({
                status: 'captioning',
                currentClip: i + 1,
                totalClips: segments.length,
                message: `Burning captions on clip ${i + 1}${target ? ` (${target.label})` : ''}...`,
              });

              const assPath = path.join(TEMP_DIR, `captions_${i}.ass`);
              const style = CAPTION_PRESETS[captionPreset as keyof typeof CAPTION_PRESETS] || DEFAULT_CAPTION_STYLE;
              generateASSFile(captionSubs, style, assPath);

              const captionedPath = outputPath.replace('.mp4', '_captioned.mp4');

              await new Promise<void>((resolve, reject) => {
                const assEscaped = assPath.replace(/'/g, "\\'").replace(/:/g, '\\:');
                const proc = spawn(FFMPEG_PATH, [
                  '-y', '-i', outputPath,
                  '-vf', `ass='${assEscaped}'`,
                  '-c:v', 'libx264', '-preset', 'medium', '-crf', quality === '480' ? '22' : quality === '720' ? '20' : '18',
                  '-c:a', 'copy', '-movflags', '+faststart',
                  captionedPath,
                ]);
                let stderr = '';
                proc.stderr.on('data', (d) => { stderr += d.toString(); });
                proc.on('close', (code) => {
                  if (code === 0) resolve();
                  else reject(new Error(`Caption burn failed: ${stderr.slice(-200)}`));
                });
                proc.on('error', reject);
              });

              fs.unlinkSync(outputPath);
              fs.renameSync(captionedPath, outputPath);
              console.log(`   ✅ Captions added (${captionSubs.length} entries, ${target ? target.label : 'original'})`);
              try { fs.unlinkSync(assPath); } catch {}
            } else {
              console.log(`   ⚠️ No subtitles available for clip ${i + 1}`);
            }
          }

          // ── 4c: AI Dubbing ────────────────────────
          if (target && translatedSubs.length > 0 && (translateMode === 'dub' || translateMode === 'both')) {
            onProgress({
              status: 'captioning',
              currentClip: i + 1,
              totalClips: segments.length,
              message: `AI dubbing clip ${i + 1} in ${target.label}...`,
            });

            const dubbedPath = outputPath.replace('.mp4', '_dubbed.mp4');
            const success = await generateDubbedVideo(outputPath, translatedSubs, target, dubbedPath);

            if (success && fs.existsSync(dubbedPath)) {
              fs.unlinkSync(outputPath);
              fs.renameSync(dubbedPath, outputPath);
              console.log(`   ✅ AI dubbed in ${target.label}`);
            } else {
              console.log(`   ⚠️ Dubbing failed (clip saved without dubbing)`);
            }
          }
        } catch (err: any) {
          console.log(`   ⚠️ Subtitle/translation step failed: ${err.message}`);
        }
      }

      const fileSize = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
      console.log(`   ✅ Clip ${i + 1}: ${filename} (${fileSize} MB)`);
      outputFiles.push(filename);
    }

    // Cleanup temp segment files
    for (const f of tempFiles) {
      try {
        // Don't delete if it's the cached full video being used by other segments
        if (f !== fullVideoCache) fs.unlinkSync(f);
      } catch {}
    }
    // Clean full video cache too
    if (fullVideoCache) {
      try { fs.unlinkSync(fullVideoCache); } catch {}
      fullVideoCache = null;
    }

    onProgress({
      status: 'done',
      currentClip: segments.length,
      totalClips: segments.length,
      message: `Done! Created ${outputFiles.length} clips`,
      files: outputFiles,
    });
  } catch (err: any) {
    console.error(`[processor] Error: ${err.message}`);
    onProgress({
      status: 'error',
      currentClip: 0,
      totalClips: segments.length,
      message: 'Processing failed',
      error: err.message || 'Unknown error',
    });
  }
}

// ─── Helpers ────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTimeFilename(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/**
 * Get video resolution from file metadata.
 */
async function getVideoResolution(filePath: string): Promise<string | null> {
  try {
    const result = await execFileAsync(FFMPEG_PATH, [
      '-i', filePath,
    ], { timeout: 5000 }).catch(err => err); // ffmpeg always errors for -i only
    const stderr = result.stderr || '';
    const match = stderr.match(/(\d{3,5})x(\d{3,5})/);
    if (match) return `${match[1]}×${match[2]}`;
    return null;
  } catch {
    return null;
  }
}

/**
 * Verify a downloaded video file has an audio stream.
 */
async function checkHasAudio(filePath: string): Promise<boolean> {
  try {
    // Try to extract 1 frame of audio — succeeds only if audio exists
    await execFileAsync(FFMPEG_PATH, [
      '-i', filePath,
      '-t', '0.1',
      '-vn',
      '-f', 'wav',
      '-y', '/dev/null',
    ], { timeout: 10000 });
    return true;
  } catch (err: any) {
    const stderr = (err.stderr || '') + (err.message || '');
    // If ffmpeg found an audio stream, it's there even if the command errored
    if (stderr.includes('Audio:') && !stderr.includes('does not contain')) {
      return true;
    }
    return false;
  }
}

export function getOutputDir(): string {
  return OUTPUT_DIR;
}
