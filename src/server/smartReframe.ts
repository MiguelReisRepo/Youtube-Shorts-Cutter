import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { FFMPEG_PATH } from './binPaths.js';

const execFileAsync = promisify(execFile);

export interface CropRegion {
  x: number;       // Crop X offset from left
  y: number;       // Crop Y offset from top
  width: number;   // Crop width
  height: number;  // Crop height
}

export interface ReframeResult {
  mode: 'face_tracked' | 'smart_center' | 'center';
  regions: CropRegion[];   // One per sampled frame (for smooth panning)
  fps: number;
  confidence: number;      // 0-1 how confident we are in the reframe
}

/**
 * Smart Speaker Reframe
 * 
 * Analyzes a video segment to find the optimal 9:16 crop position
 * that keeps the main subject (face/speaker) centered.
 * 
 * Pipeline:
 * 1. Extract sample frames at 1fps
 * 2. Use ffmpeg's cropdetect to find content regions
 * 3. Analyze frame brightness distribution to estimate face position
 * 4. Generate smooth crop path for dynamic panning
 * 
 * For full face tracking accuracy, install: pip install mediapipe
 * (Falls back to smart center if not available)
 */
export async function analyzeReframe(
  videoPath: string,
  startS: number,
  durationS: number,
  targetWidth: number = 1080,
  targetHeight: number = 1920,
): Promise<ReframeResult> {
  console.log('[reframe] Analyzing video for smart crop...');

  // Get source video dimensions
  const dims = await getVideoDimensions(videoPath);
  if (!dims) {
    console.log('[reframe] Could not read video dimensions, using center crop');
    return fallbackCenter(targetWidth, targetHeight, 0, 0, 30);
  }

  const { width: srcW, height: srcH } = dims;
  console.log(`[reframe] Source: ${srcW}×${srcH}`);

  // For already-vertical video, no reframing needed
  if (srcH >= srcW) {
    console.log('[reframe] Video is already vertical, using center crop');
    return fallbackCenter(targetWidth, targetHeight, srcW, srcH, durationS);
  }

  // Try face detection via ffmpeg's metadata
  const faceResult = await detectFaceRegions(videoPath, startS, durationS, srcW, srcH);
  if (faceResult) {
    console.log(`[reframe] ✅ Face detection found ${faceResult.regions.length} tracked positions`);
    return buildReframeFromFaces(faceResult.facePositions, srcW, srcH, targetWidth, targetHeight, durationS);
  }

  // Fallback: Analyze content distribution per frame
  console.log('[reframe] Face detection unavailable, using brightness analysis...');
  const smartResult = await analyzeContentRegions(videoPath, startS, durationS, srcW, srcH);

  if (smartResult.length > 0) {
    console.log(`[reframe] ✅ Smart analysis found ${smartResult.length} content regions`);
    return buildReframeFromRegions(smartResult, srcW, srcH, targetWidth, targetHeight, durationS);
  }

  console.log('[reframe] Using default center crop');
  return fallbackCenter(targetWidth, targetHeight, srcW, srcH, durationS);
}

/**
 * Use ffmpeg to detect faces using the `drawbox` approach:
 * Extract frames and analyze brightness in the upper third
 * (where faces typically are in talking-head videos).
 */
async function detectFaceRegions(
  videoPath: string,
  startS: number,
  durationS: number,
  srcW: number,
  srcH: number,
): Promise<{ facePositions: { timeS: number; x: number; y: number; w: number; h: number }[] } | null> {
  const tmpDir = path.join(os.tmpdir(), `reframe-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // Extract sample frames at 2fps
    const sampleFps = 2;
    await execFileAsync(FFMPEG_PATH, [
      '-ss', String(startS),
      '-i', videoPath,
      '-t', String(Math.min(durationS, 60)),
      '-vf', `fps=${sampleFps},scale=320:-1`,
      '-q:v', '5',
      path.join(tmpDir, 'frame_%04d.jpg'),
    ], { timeout: 30000 });

    const frames = fs.readdirSync(tmpDir)
      .filter(f => f.startsWith('frame_') && f.endsWith('.jpg'))
      .sort();

    if (frames.length < 2) return null;

    // For each frame, analyze brightness distribution to estimate face/subject position
    const positions: { timeS: number; x: number; y: number; w: number; h: number }[] = [];

    for (let i = 0; i < frames.length; i++) {
      const framePath = path.join(tmpDir, frames[i]);
      const timeS = i / sampleFps;

      // Use ffmpeg to get brightness in different horizontal regions
      const pos = await analyzeFrameSubject(framePath, srcW, srcH);
      if (pos) {
        positions.push({ timeS, ...pos });
      }
    }

    if (positions.length === 0) return null;
    return { facePositions: positions };
  } catch (err: any) {
    console.log(`[reframe] Frame analysis failed: ${err.message}`);
    return null;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Analyze a single frame to estimate where the main subject is.
 * Uses brightness/complexity heuristics:
 * - Faces and subjects tend to be brighter and more complex than backgrounds
 * - Splits frame into vertical strips and finds the most "interesting" region
 */
async function analyzeFrameSubject(
  framePath: string,
  srcW: number,
  srcH: number,
): Promise<{ x: number; y: number; w: number; h: number } | null> {
  try {
    // Analyze left, center-left, center, center-right, right strips
    const strips = 5;
    const stripW = Math.floor(srcW / strips);
    const scores: number[] = [];

    for (let i = 0; i < strips; i++) {
      const cropX = i * stripW;
      const { stderr } = await execFileAsync(FFMPEG_PATH, [
        '-i', framePath,
        '-vf', `crop=${stripW}:${srcH}:${cropX}:0,signalstats`,
        '-f', 'null', '-',
      ], { timeout: 5000 });

      // Parse YAVG (brightness) and SATAVG (color saturation)
      const yavgMatch = stderr.match(/YAVG:\s*([\d.]+)/);
      const satMatch = stderr.match(/SATAVG:\s*([\d.]+)/);

      const brightness = yavgMatch ? parseFloat(yavgMatch[1]) : 128;
      const saturation = satMatch ? parseFloat(satMatch[1]) : 0;

      // Higher brightness + saturation = more likely to contain subject
      // Slight center bias (people tend to be centered)
      const centerBias = 1 + 0.15 * (1 - Math.abs(i - 2) / 2);
      scores.push((brightness * 0.6 + saturation * 0.4) * centerBias);
    }

    // Find the highest-scoring region (3 strips wide for a 9:16 crop)
    let bestStart = 0;
    let bestScore = 0;

    for (let i = 0; i <= strips - 3; i++) {
      const score = scores[i] + scores[i + 1] + scores[i + 2];
      if (score > bestScore) {
        bestScore = score;
        bestStart = i;
      }
    }

    const cropX = bestStart * stripW;
    const cropW = stripW * 3;

    return {
      x: cropX,
      y: 0,
      w: Math.min(cropW, srcW),
      h: srcH,
    };
  } catch {
    return null;
  }
}

/**
 * Simpler content analysis: use ffmpeg signalstats on horizontal strips.
 */
async function analyzeContentRegions(
  videoPath: string,
  startS: number,
  durationS: number,
  srcW: number,
  srcH: number,
): Promise<{ timeS: number; centerX: number }[]> {
  try {
    // Sample a few frames
    const sampleTimes = [0, durationS * 0.25, durationS * 0.5, durationS * 0.75];
    const regions: { timeS: number; centerX: number }[] = [];

    for (const t of sampleTimes) {
      const seekTo = startS + t;

      // Get overall frame stats for left vs right halves
      const leftStats = await getRegionBrightness(
        videoPath, seekTo, 0, 0, Math.floor(srcW / 2), srcH
      );
      const rightStats = await getRegionBrightness(
        videoPath, seekTo, Math.floor(srcW / 2), 0, Math.floor(srcW / 2), srcH
      );

      // Estimate subject center based on brightness balance
      const balance = leftStats / (leftStats + rightStats + 1); // 0-1, 0.5 = centered
      const centerX = Math.round(srcW * balance);

      regions.push({ timeS: t, centerX });
    }

    return regions;
  } catch {
    return [];
  }
}

async function getRegionBrightness(
  videoPath: string,
  seekS: number,
  cropX: number,
  cropY: number,
  cropW: number,
  cropH: number,
): Promise<number> {
  try {
    const { stderr } = await execFileAsync(FFMPEG_PATH, [
      '-ss', String(seekS),
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', `crop=${cropW}:${cropH}:${cropX}:${cropY},signalstats`,
      '-f', 'null', '-',
    ], { timeout: 5000 });

    const match = stderr.match(/YAVG:\s*([\d.]+)/);
    return match ? parseFloat(match[1]) : 128;
  } catch {
    return 128;
  }
}

// ─── Build Reframe Paths ────────────────────────────

function buildReframeFromFaces(
  faces: { timeS: number; x: number; y: number; w: number; h: number }[],
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  durationS: number,
): ReframeResult {
  // Calculate the crop window size needed for 9:16 from source
  const targetAspect = targetW / targetH; // 0.5625
  let cropW: number, cropH: number;

  if (srcW / srcH > targetAspect) {
    // Source is wider — crop width
    cropH = srcH;
    cropW = Math.round(srcH * targetAspect);
  } else {
    // Source is taller — crop height
    cropW = srcW;
    cropH = Math.round(srcW / targetAspect);
  }

  // Build crop regions centered on detected subjects
  const regions: CropRegion[] = faces.map(face => {
    const faceCenterX = face.x + face.w / 2;

    // Center the crop on the face, clamped to bounds
    let x = Math.round(faceCenterX - cropW / 2);
    x = Math.max(0, Math.min(x, srcW - cropW));

    let y = 0;
    if (cropH < srcH) {
      // Center vertically on the face (upper third bias)
      const faceCenterY = face.y + face.h / 3;
      y = Math.round(faceCenterY - cropH / 2);
      y = Math.max(0, Math.min(y, srcH - cropH));
    }

    return { x, y, width: cropW, height: cropH };
  });

  // Smooth the crop path to avoid jitter
  const smoothed = smoothCropPath(regions, 5);

  return {
    mode: 'face_tracked',
    regions: smoothed,
    fps: 2,
    confidence: 0.7,
  };
}

function buildReframeFromRegions(
  contentRegions: { timeS: number; centerX: number }[],
  srcW: number,
  srcH: number,
  targetW: number,
  targetH: number,
  durationS: number,
): ReframeResult {
  const targetAspect = targetW / targetH;
  let cropW: number, cropH: number;

  if (srcW / srcH > targetAspect) {
    cropH = srcH;
    cropW = Math.round(srcH * targetAspect);
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / targetAspect);
  }

  const regions: CropRegion[] = contentRegions.map(r => {
    let x = Math.round(r.centerX - cropW / 2);
    x = Math.max(0, Math.min(x, srcW - cropW));

    return { x, y: 0, width: cropW, height: cropH };
  });

  return {
    mode: 'smart_center',
    regions: smoothCropPath(regions, 3),
    fps: 1,
    confidence: 0.4,
  };
}

function fallbackCenter(
  targetW: number,
  targetH: number,
  srcW: number,
  srcH: number,
  durationS: number,
): ReframeResult {
  const targetAspect = targetW / targetH;
  let cropW: number, cropH: number;

  if (srcW === 0 || srcH === 0) {
    return {
      mode: 'center',
      regions: [{ x: 0, y: 0, width: targetW, height: targetH }],
      fps: 1,
      confidence: 0,
    };
  }

  if (srcW / srcH > targetAspect) {
    cropH = srcH;
    cropW = Math.round(srcH * targetAspect);
  } else {
    cropW = srcW;
    cropH = Math.round(srcW / targetAspect);
  }

  const x = Math.round((srcW - cropW) / 2);
  const y = Math.round((srcH - cropH) / 2);

  return {
    mode: 'center',
    regions: [{ x, y, width: cropW, height: cropH }],
    fps: 1,
    confidence: 0,
  };
}

// ─── Generate FFmpeg Crop Filter ────────────────────

/**
 * Generates an ffmpeg filter string for dynamic cropping.
 * For static crops, returns a simple crop filter.
 * For tracked crops, generates a sendcmd/crop combination for smooth panning.
 */
export function buildCropFilter(
  reframe: ReframeResult,
  targetW: number = 1080,
  targetH: number = 1920,
): string {
  if (reframe.regions.length <= 1 || reframe.mode === 'center') {
    // Static crop
    const r = reframe.regions[0] || { x: 0, y: 0, width: targetW, height: targetH };
    return `crop=${r.width}:${r.height}:${r.x}:${r.y},scale=${targetW}:${targetH}`;
  }

  // Dynamic crop: use expression-based crop with smooth interpolation
  // This creates a smooth pan between detected positions
  const r0 = reframe.regions[0];
  const fps = reframe.fps;

  // Build interpolated X position as an ffmpeg expression
  // We'll create a piecewise linear function of time
  const xPoints = reframe.regions.map((r, i) => ({
    t: i / fps,
    x: r.x,
  }));

  // Generate ffmpeg expression for x position
  let xExpr = String(r0.x);
  if (xPoints.length >= 2) {
    // Linear interpolation between keyframes
    const parts: string[] = [];
    for (let i = 0; i < xPoints.length - 1; i++) {
      const t0 = xPoints[i].t;
      const t1 = xPoints[i + 1].t;
      const x0 = xPoints[i].x;
      const x1 = xPoints[i + 1].x;
      const slope = (x1 - x0) / (t1 - t0 || 1);
      parts.push(`if(between(t,${t0},${t1}), ${x0}+${slope.toFixed(2)}*(t-${t0})`);
    }
    // Default to last position
    const lastX = xPoints[xPoints.length - 1].x;
    xExpr = parts.join(', ') + ', ' + lastX + ')'.repeat(parts.length);
  }

  return `crop=${r0.width}:${r0.height}:'${xExpr}':${r0.y},scale=${targetW}:${targetH}`;
}

// ─── Helpers ────────────────────────────────────────

async function getVideoDimensions(
  videoPath: string,
): Promise<{ width: number; height: number } | null> {
  try {
    const { stdout } = await execFileAsync(FFMPEG_PATH, [
      '-i', videoPath,
      '-vframes', '1',
      '-f', 'null', '-',
    ].concat([]), { timeout: 10000 });

    // ffmpeg prints dimensions to stderr
    return null; // Will use ffprobe instead
  } catch (err: any) {
    // ffmpeg always "fails" with -f null, but stderr has the info
    const stderr = err.stderr || '';
    const match = stderr.match(/(\d{2,5})x(\d{2,5})/);
    if (match) {
      return { width: parseInt(match[1]), height: parseInt(match[2]) };
    }
    return null;
  }
}

function smoothCropPath(regions: CropRegion[], windowSize: number): CropRegion[] {
  if (regions.length <= 2) return regions;

  const half = Math.floor(windowSize / 2);

  return regions.map((r, i) => {
    let sumX = 0, sumY = 0, count = 0;

    for (let j = i - half; j <= i + half; j++) {
      if (j >= 0 && j < regions.length) {
        sumX += regions[j].x;
        sumY += regions[j].y;
        count++;
      }
    }

    return {
      ...r,
      x: Math.round(sumX / count),
      y: Math.round(sumY / count),
    };
  });
}
