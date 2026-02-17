import type { HeatmapPoint, PeakSegment } from '../types/index.js';

/**
 * Virality Score Engine
 * 
 * Scores each clip 0-100 based on factors that predict short-form performance:
 * 
 *  1. Peak intensity     (30%) — How "hyped" is the moment?
 *  2. Hook strength      (25%) — Do the first 3 seconds have energy?
 *  3. Pacing / cuts      (15%) — Fast visual cuts = higher retention
 *  4. Audio energy       (15%) — Loud, dynamic audio holds attention
 *  5. Position bonus     (10%) — Early in video = more familiar to viewers
 *  6. Duration fit        (5%) — 30-45s is the sweet spot for Shorts
 */

export interface ViralityBreakdown {
  overall: number;          // 0-100 final score
  peakIntensity: number;    // 0-100
  hookStrength: number;     // 0-100
  pacing: number;           // 0-100
  audioEnergy: number;      // 0-100
  positionBonus: number;    // 0-100
  durationFit: number;      // 0-100
  label: string;            // "🔥 Viral", "✅ Strong", "⚡ Good", "🔄 Fair"
  color: string;            // Hex color for the score
}

export function scoreSegments(
  segments: PeakSegment[],
  heatmap: HeatmapPoint[],
  videoDurationS: number,
): ViralityBreakdown[] {
  if (!segments.length) return [];

  return segments.map(seg => {
    // ── 1. Peak Intensity (30%) ───────────────
    // How intense is this moment relative to the whole video?
    const peakIntensity = Math.round(seg.peakIntensity * 100);

    // ── 2. Hook Strength (25%) ────────────────
    // How strong are the first 3 seconds? The hook determines retention.
    const hookWindowS = 3;
    const hookStart = seg.startS;
    const hookEnd = hookStart + hookWindowS;
    const hookPoints = heatmap.filter(p => {
      const pStartS = p.startMs / 1000;
      const pEndS = p.endMs / 1000;
      return pStartS < hookEnd && pEndS > hookStart;
    });

    let hookStrength: number;
    if (hookPoints.length > 0) {
      const avgHookIntensity = hookPoints.reduce((s, p) => s + p.intensity, 0) / hookPoints.length;
      // Bonus if hook intensity is above the segment average
      const hookBonus = avgHookIntensity > seg.avgIntensity ? 15 : 0;
      hookStrength = Math.min(100, Math.round(avgHookIntensity * 85 + hookBonus));
    } else {
      hookStrength = Math.round(seg.avgIntensity * 50); // Fallback
    }

    // ── 3. Pacing / Scene Density (15%) ───────
    // More intensity variation = more dynamic, more engaging
    const segPoints = heatmap.filter(p => {
      const pStartS = p.startMs / 1000;
      return pStartS >= seg.startS && pStartS <= seg.endS;
    });

    let pacing = 50; // Default
    if (segPoints.length >= 3) {
      // Calculate variance in intensity — higher variance = more dynamic
      const mean = segPoints.reduce((s, p) => s + p.intensity, 0) / segPoints.length;
      const variance = segPoints.reduce((s, p) => s + Math.pow(p.intensity - mean, 2), 0) / segPoints.length;
      const stdDev = Math.sqrt(variance);
      // Normalize: stdDev of 0.2+ is very dynamic
      pacing = Math.min(100, Math.round(stdDev * 400));
    }

    // ── 4. Audio Energy (15%) ─────────────────
    // Average intensity as proxy for audio engagement
    const audioEnergy = Math.round(seg.avgIntensity * 100);

    // ── 5. Position Bonus (10%) ───────────────
    // Clips from the first third of a video tend to perform better
    // (viewers are more familiar with that content)
    const relativePosition = seg.startS / videoDurationS;
    let positionBonus: number;
    if (relativePosition < 0.33) {
      positionBonus = 80 + Math.round((1 - relativePosition / 0.33) * 20);
    } else if (relativePosition < 0.66) {
      positionBonus = 50 + Math.round((1 - (relativePosition - 0.33) / 0.33) * 30);
    } else {
      positionBonus = 30 + Math.round((1 - (relativePosition - 0.66) / 0.34) * 20);
    }

    // ── 6. Duration Fit (5%) ──────────────────
    // Sweet spot: 30-45 seconds. Penalty for too short or too long.
    const dur = seg.durationS;
    let durationFit: number;
    if (dur >= 30 && dur <= 45) {
      durationFit = 100;
    } else if (dur >= 20 && dur < 30) {
      durationFit = 70 + Math.round(((dur - 20) / 10) * 30);
    } else if (dur > 45 && dur <= 60) {
      durationFit = 70 + Math.round(((60 - dur) / 15) * 30);
    } else if (dur >= 15 && dur < 20) {
      durationFit = 50;
    } else {
      durationFit = 30;
    }

    // ── Weighted Score ────────────────────────
    const overall = Math.round(
      peakIntensity * 0.30 +
      hookStrength * 0.25 +
      pacing * 0.15 +
      audioEnergy * 0.15 +
      positionBonus * 0.10 +
      durationFit * 0.05
    );

    // ── Label & Color ─────────────────────────
    let label: string;
    let color: string;
    if (overall >= 80) {
      label = '🔥 Viral';
      color = '#ef4444';
    } else if (overall >= 60) {
      label = '✅ Strong';
      color = '#22c55e';
    } else if (overall >= 40) {
      label = '⚡ Good';
      color = '#f59e0b';
    } else {
      label = '🔄 Fair';
      color = '#6b7280';
    }

    return {
      overall,
      peakIntensity,
      hookStrength,
      pacing,
      audioEnergy,
      positionBonus,
      durationFit,
      label,
      color,
    };
  });
}
