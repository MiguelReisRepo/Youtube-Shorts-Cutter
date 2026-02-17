import { spawn } from 'child_process';
import type { HeatmapPoint, PeakSegment } from '../types/index.js';
import { FFMPEG_PATH } from './binPaths.js';

/**
 * Smart Clip Boundary Optimizer
 * 
 * Instead of blindly cutting at exact timestamps, this module:
 * 
 * 1. Finds natural START points:
 *    - Silence gaps (sentence boundaries)
 *    - Scene changes (visual cuts)
 *    - Subtitle cue points
 * 
 * 2. Finds natural END points:
 *    - Sentence endings (silence after speech)
 *    - Scene transitions
 *    - Energy drops (moment conclusion)
 * 
 * 3. Hook optimization:
 *    - Scans a window around the planned start
 *    - Picks the strongest opening moment (high energy, speech start, visual cut)
 *    - Ensures the first 2-3 seconds grab attention
 */

interface BoundaryContext {
  silenceRegions: { startS: number; endS: number }[];
  sceneChanges: number[];   // Timestamps of scene cuts
  heatmap: HeatmapPoint[];
}

interface OptimizedSegment {
  original: PeakSegment;
  optimizedStartS: number;
  optimizedEndS: number;
  hookScore: number;        // 0-100 how strong the opening is
  hookShiftS: number;       // How much we shifted the start for a better hook
  boundaryType: string;     // Description of what boundary we snapped to
}

/**
 * Analyze a video and find natural boundaries near each segment.
 */
export async function detectBoundaries(
  videoPath: string,
  videoDurationS: number,
): Promise<BoundaryContext> {
  console.log('[boundaries] Detecting natural clip boundaries...');

  // Run silence detection in a single pass
  const silenceRegions = await detectSilence(videoPath);
  console.log(`[boundaries] Found ${silenceRegions.length} silence regions`);

  // Scene changes come from the scene detection module (already run during analysis)
  // We pass them in separately, so just return silence here
  return {
    silenceRegions,
    sceneChanges: [],  // Populated from existing scene detection data
    heatmap: [],       // Populated from existing heatmap
  };
}

/**
 * Detect silence regions using ffmpeg silencedetect (single pass).
 */
async function detectSilence(
  videoPath: string,
): Promise<{ startS: number; endS: number }[]> {
  return new Promise((resolve) => {
    const proc = spawn(FFMPEG_PATH, [
      '-i', videoPath,
      '-vn',
      '-af', 'silencedetect=noise=-35dB:d=0.3',
      '-f', 'null', '-',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';

    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    proc.on('close', () => {
      const regions: { startS: number; endS: number }[] = [];
      const starts: number[] = [];

      for (const m of stderr.matchAll(/silence_start: ([\d.]+)/g)) {
        starts.push(parseFloat(m[1]));
      }

      let i = 0;
      for (const m of stderr.matchAll(/silence_end: ([\d.]+)/g)) {
        const endS = parseFloat(m[1]);
        if (i < starts.length) {
          regions.push({ startS: starts[i], endS });
        }
        i++;
      }

      resolve(regions);
    });

    proc.on('error', () => resolve([]));
    setTimeout(() => { try { proc.kill(); } catch {} }, 60000);
  });
}

/**
 * Optimize segment boundaries for natural cuts and strong hooks.
 */
export function optimizeSegments(
  segments: PeakSegment[],
  heatmap: HeatmapPoint[],
  context: BoundaryContext,
  videoDurationS: number,
  targetMinS: number = 15,
  targetMaxS: number = 60,
): OptimizedSegment[] {
  const silences = context.silenceRegions;

  return segments.map(seg => {
    // ── Find best START point ──────────────────
    // Search window: up to 5s before the peak start
    const searchWindowS = 5;
    const startSearchMin = Math.max(0, seg.startS - searchWindowS);
    const startSearchMax = seg.startS + 2; // Can also look slightly after

    // Find the nearest silence gap before the start (sentence boundary)
    let bestStart = seg.startS;
    let bestStartScore = 0;
    let boundaryType = 'original';

    // Option 1: Snap to a silence end (start of new sentence)
    for (const s of silences) {
      if (s.endS >= startSearchMin && s.endS <= startSearchMax) {
        // Starting right after silence = beginning of a sentence
        const hookEnergy = getEnergyAt(heatmap, s.endS, s.endS + 3);
        const score = hookEnergy * 100 + 20; // Bonus for sentence boundary
        if (score > bestStartScore) {
          bestStart = s.endS;
          bestStartScore = score;
          boundaryType = 'sentence_start';
        }
      }
    }

    // Option 2: Find high-energy moment nearby (strong hook)
    const hookCandidates = findHookCandidates(heatmap, startSearchMin, startSearchMax);
    for (const hook of hookCandidates) {
      const score = hook.energy * 100 + 10; // Slight bonus
      if (score > bestStartScore) {
        bestStart = hook.timeS;
        bestStartScore = score;
        boundaryType = 'energy_peak';
      }
    }

    // ── Find best END point ────────────────────
    // Expand the segment to find a natural conclusion
    const peakMoment = seg.startS + (seg.endS - seg.startS) * 0.5; // Middle of segment
    const endSearchMin = Math.max(bestStart + targetMinS, seg.endS - 3);
    const endSearchMax = Math.min(bestStart + targetMaxS, videoDurationS);

    let bestEnd = seg.endS;

    // Option 1: End at a silence gap (sentence boundary)
    for (const s of silences) {
      if (s.startS >= endSearchMin && s.startS <= endSearchMax) {
        const dur = s.startS - bestStart;
        if (dur >= targetMinS && dur <= targetMaxS) {
          bestEnd = s.startS;
          break; // Take the first natural ending
        }
      }
    }

    // Option 2: End at energy drop
    if (bestEnd === seg.endS) {
      const dropPoint = findEnergyDrop(heatmap, endSearchMin, endSearchMax);
      if (dropPoint && (dropPoint - bestStart) >= targetMinS) {
        bestEnd = dropPoint;
      }
    }

    // Ensure duration constraints
    let duration = bestEnd - bestStart;
    if (duration < targetMinS) {
      bestEnd = Math.min(bestStart + targetMinS, videoDurationS);
    }
    if (duration > targetMaxS) {
      bestEnd = bestStart + targetMaxS;
    }

    // ── Score the hook ─────────────────────────
    const hookEnergy = getEnergyAt(heatmap, bestStart, bestStart + 3);
    const hookScore = Math.round(hookEnergy * 100);
    const hookShiftS = Math.round((bestStart - seg.startS) * 10) / 10;

    return {
      original: seg,
      optimizedStartS: Math.round(bestStart * 10) / 10,
      optimizedEndS: Math.round(bestEnd * 10) / 10,
      hookScore,
      hookShiftS,
      boundaryType,
    };
  });
}

/**
 * Apply optimized boundaries back to segments.
 */
export function applyOptimizations(
  optimized: OptimizedSegment[],
): PeakSegment[] {
  return optimized.map(o => ({
    ...o.original,
    startS: o.optimizedStartS,
    endS: o.optimizedEndS,
    durationS: Math.round((o.optimizedEndS - o.optimizedStartS) * 10) / 10,
  }));
}

// ─── Helpers ────────────────────────────────────────

function getEnergyAt(heatmap: HeatmapPoint[], startS: number, endS: number): number {
  const points = heatmap.filter(p => {
    const pS = p.startMs / 1000;
    return pS >= startS && pS < endS;
  });
  if (points.length === 0) return 0.5; // Default mid-energy
  return points.reduce((s, p) => s + p.intensity, 0) / points.length;
}

function findHookCandidates(
  heatmap: HeatmapPoint[],
  searchMinS: number,
  searchMaxS: number,
): { timeS: number; energy: number }[] {
  const candidates: { timeS: number; energy: number }[] = [];

  for (const p of heatmap) {
    const pS = p.startMs / 1000;
    if (pS >= searchMinS && pS <= searchMaxS && p.intensity > 0.5) {
      // Score: energy in this point + energy in next 3 seconds
      const nextEnergy = getEnergyAt(heatmap, pS, pS + 3);
      candidates.push({ timeS: pS, energy: (p.intensity + nextEnergy) / 2 });
    }
  }

  // Sort by energy descending
  candidates.sort((a, b) => b.energy - a.energy);
  return candidates.slice(0, 5);
}

function findEnergyDrop(
  heatmap: HeatmapPoint[],
  searchMinS: number,
  searchMaxS: number,
): number | null {
  let prevEnergy = 1;

  for (const p of heatmap) {
    const pS = p.startMs / 1000;
    if (pS < searchMinS) {
      prevEnergy = p.intensity;
      continue;
    }
    if (pS > searchMaxS) break;

    // Significant energy drop = natural ending point
    if (prevEnergy > 0.4 && p.intensity < prevEnergy * 0.5) {
      return pS;
    }
    prevEnergy = p.intensity;
  }

  return null;
}
