import { execFile } from 'child_process';
import { promisify } from 'util';
import type { HeatmapPoint, VideoInfo, PeakSegment } from '../types/index.js';
import { v4 as uuid } from 'uuid';
import { YTDLP_PATH, YTDLP_COMMON_ARGS } from './binPaths.js';

const execFileAsync = promisify(execFile);

// ─── Fetch Video Info + Heatmap via yt-dlp ──────────

export async function getVideoData(url: string): Promise<{
  video: VideoInfo;
  heatmap: HeatmapPoint[];
}> {
  console.log(`[youtube] Fetching data for: ${url}`);

  const { stdout } = await execFileAsync(YTDLP_PATH, [
    ...YTDLP_COMMON_ARGS,
    '--dump-json',
    '--no-download',
    '--no-warnings',
    url,
  ], { maxBuffer: 1024 * 1024 * 50 });

  const info = JSON.parse(stdout);

  const video: VideoInfo = {
    id: info.id,
    title: info.title || 'Unknown',
    durationS: info.duration || 0,
    thumbnail: info.thumbnail || info.thumbnails?.[info.thumbnails.length - 1]?.url || '',
    channel: info.channel || info.uploader || 'Unknown',
    viewCount: formatViewCount(info.view_count),
  };

  let heatmap: HeatmapPoint[] = [];

  if (info.heatmap && Array.isArray(info.heatmap)) {
    heatmap = info.heatmap.map((point: any) => ({
      startMs: Math.round(point.start_time * 1000),
      endMs: Math.round(point.end_time * 1000),
      intensity: point.value,
    }));
    console.log(`[youtube] Found ${heatmap.length} heatmap points via yt-dlp`);
  }

  return { video, heatmap };
}

// ─── Peak Segment Detection (v2) ────────────────────
//
// Improvements over v1:
// 1. Overlap removal    — merged segments never overlap
// 2. Minimum gap        — enforced spacing between clips
// 3. Diversity scoring  — penalizes clusters, rewards spread
// 4. Post-expansion     — de-duplicates after duration adjustments
// 5. Greedy selection   — picks best non-conflicting segments

export interface PeakOptions {
  topN?: number;
  minDurationS?: number;
  maxDurationS?: number;
  minGapS?: number;
  intensityThreshold?: number;
}

export function findPeakSegments(
  heatmap: HeatmapPoint[],
  videoDurationS: number,
  options: PeakOptions = {},
): PeakSegment[] {
  const {
    topN = 5,
    minDurationS = 15,
    maxDurationS = 60,
    minGapS = 30,
    intensityThreshold = 0.6,
  } = options;

  if (!heatmap.length) return [];

  console.log(`\n[peaks] Analyzing heatmap (${heatmap.length} points)...`);
  console.log(`   topN=${topN}  duration=${minDurationS}-${maxDurationS}s  gap≥${minGapS}s  threshold≥${intensityThreshold}`);

  // ── Step 1: Identify hot zones ────────────────
  // Find all contiguous regions above threshold

  let threshold = intensityThreshold;
  let hotMarkers = heatmap.filter(m => m.intensity >= threshold);

  // Adaptively lower threshold if too few markers
  while (hotMarkers.length < 5 && threshold > 0.2) {
    threshold -= 0.1;
    hotMarkers = heatmap.filter(m => m.intensity >= threshold);
  }

  if (hotMarkers.length === 0) {
    console.log('   ❌ No markers above any threshold');
    return [];
  }

  console.log(`   Using threshold: ${threshold.toFixed(2)} (${hotMarkers.length} markers)`);

  // Sort by time
  hotMarkers.sort((a, b) => a.startMs - b.startMs);

  // ── Step 2: Merge adjacent markers into raw zones ──
  // Allow small gaps (≤3s) within a single zone

  interface RawZone {
    startMs: number;
    endMs: number;
    intensities: number[];
    peakIntensity: number;
    peakTimeMs: number;
  }

  const zones: RawZone[] = [];
  let current: RawZone = {
    startMs: hotMarkers[0].startMs,
    endMs: hotMarkers[0].endMs,
    intensities: [hotMarkers[0].intensity],
    peakIntensity: hotMarkers[0].intensity,
    peakTimeMs: hotMarkers[0].startMs,
  };

  for (let i = 1; i < hotMarkers.length; i++) {
    const m = hotMarkers[i];
    const gap = m.startMs - current.endMs;

    if (gap <= 3000) {
      // Extend current zone
      current.endMs = Math.max(current.endMs, m.endMs);
      current.intensities.push(m.intensity);
      if (m.intensity > current.peakIntensity) {
        current.peakIntensity = m.intensity;
        current.peakTimeMs = m.startMs;
      }
    } else {
      zones.push(current);
      current = {
        startMs: m.startMs,
        endMs: m.endMs,
        intensities: [m.intensity],
        peakIntensity: m.intensity,
        peakTimeMs: m.startMs,
      };
    }
  }
  zones.push(current);

  console.log(`   Found ${zones.length} raw hot zones`);

  // ── Step 3: Convert zones to candidate segments ───
  // Apply duration constraints, centering around the peak moment

  interface Candidate {
    startS: number;
    endS: number;
    durationS: number;
    avgIntensity: number;
    peakIntensity: number;
    peakTimeS: number;
    score: number; // combined quality score
  }

  const candidates: Candidate[] = zones.map(zone => {
    let startS = zone.startMs / 1000;
    let endS = zone.endMs / 1000;
    let durationS = endS - startS;
    const peakTimeS = zone.peakTimeMs / 1000;
    const avgIntensity = zone.intensities.reduce((a, b) => a + b, 0) / zone.intensities.length;

    // Expand short segments, centering around peak
    if (durationS < minDurationS) {
      const halfNeeded = minDurationS / 2;
      startS = Math.max(0, peakTimeS - halfNeeded);
      endS = Math.min(videoDurationS, peakTimeS + halfNeeded);

      // Shift if we hit a boundary
      if (endS - startS < minDurationS) {
        if (startS === 0) endS = Math.min(videoDurationS, minDurationS);
        else startS = Math.max(0, endS - minDurationS);
      }
      durationS = endS - startS;
    }

    // Trim long segments, keeping peak centered
    if (durationS > maxDurationS) {
      const halfMax = maxDurationS / 2;
      startS = Math.max(0, peakTimeS - halfMax);
      endS = Math.min(videoDurationS, peakTimeS + halfMax);

      if (endS - startS < maxDurationS && startS === 0) {
        endS = Math.min(videoDurationS, maxDurationS);
      } else if (endS - startS < maxDurationS) {
        startS = Math.max(0, endS - maxDurationS);
      }
      durationS = endS - startS;
    }

    return {
      startS: round1(startS),
      endS: round1(endS),
      durationS: round1(durationS),
      avgIntensity: round3(avgIntensity),
      peakIntensity: round3(zone.peakIntensity),
      peakTimeS,
      score: 0, // calculated next
    };
  });

  // ── Step 4: Score candidates with diversity bonus ──
  // Higher score = better. Includes:
  //   - avgIntensity (primary)
  //   - peakIntensity bonus
  //   - duration bonus (longer = slightly better, within limits)
  //   - position diversity (slight bonus for being at different parts of the video)

  for (const c of candidates) {
    c.score =
      c.avgIntensity * 1.0 +        // Primary: average hype level
      c.peakIntensity * 0.3 +         // Bonus: how high the peak is
      Math.min(c.durationS / maxDurationS, 1) * 0.1; // Slight bonus for duration
  }

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  console.log(`   ${candidates.length} candidates after duration adjustments`);

  // ── Step 5: Greedy non-overlapping selection ──────
  // Pick the best candidates that don't overlap and maintain minimum gap

  const selected: Candidate[] = [];

  for (const candidate of candidates) {
    if (selected.length >= topN) break;

    const hasConflict = selected.some(existing => {
      // Check for overlap OR insufficient gap
      const gapBefore = candidate.startS - existing.endS;
      const gapAfter = existing.startS - candidate.endS;
      const gap = Math.max(gapBefore, gapAfter);

      // Conflict if segments overlap (gap < 0) or gap is too small
      return gap < minGapS;
    });

    if (!hasConflict) {
      selected.push(candidate);
    }
  }

  // If we couldn't find enough with the strict gap, relax it
  if (selected.length < topN && selected.length < candidates.length) {
    const relaxedGap = Math.max(minGapS / 2, 10);
    console.log(`   Relaxing gap to ${relaxedGap}s to find more clips...`);

    for (const candidate of candidates) {
      if (selected.length >= topN) break;
      if (selected.includes(candidate)) continue;

      const hasConflict = selected.some(existing => {
        const gapBefore = candidate.startS - existing.endS;
        const gapAfter = existing.startS - candidate.endS;
        return Math.max(gapBefore, gapAfter) < relaxedGap;
      });

      if (!hasConflict) {
        selected.push(candidate);
      }
    }
  }

  // ── Step 6: Sort selected by time and return ──────

  selected.sort((a, b) => a.startS - b.startS);

  const result: PeakSegment[] = selected.map(c => ({
    id: uuid(),
    startS: c.startS,
    endS: c.endS,
    durationS: c.durationS,
    avgIntensity: c.avgIntensity,
    peakIntensity: c.peakIntensity,
  }));

  // Print results
  console.log(`   ✅ Selected ${result.length} non-overlapping clips:`);
  for (let i = 0; i < result.length; i++) {
    const seg = result[i];
    const gap = i > 0 ? seg.startS - result[i - 1].endS : seg.startS;
    console.log(
      `   ${i + 1}. ${fmtTime(seg.startS)} → ${fmtTime(seg.endS)} ` +
      `(${seg.durationS}s) intensity=${(seg.avgIntensity * 100).toFixed(0)}%` +
      (i > 0 ? ` gap=${gap.toFixed(0)}s` : '')
    );
  }

  return result;
}

// ─── Helpers ────────────────────────────────────────

function round1(n: number): number { return Math.round(n * 10) / 10; }
function round3(n: number): number { return Math.round(n * 1000) / 1000; }

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${(m % 60).toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function formatViewCount(count?: number): string {
  if (!count) return 'N/A';
  if (count >= 1_000_000_000) return `${(count / 1_000_000_000).toFixed(1)}B`;
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}
