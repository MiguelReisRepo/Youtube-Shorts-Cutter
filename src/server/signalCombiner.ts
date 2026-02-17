import type { HeatmapPoint } from '../types/index.js';

export type DetectionMethod = 'heatmap' | 'audio' | 'scene' | 'comments' | 'combined';

export interface SignalSource {
  method: DetectionMethod;
  label: string;
  weight: number;
  points: HeatmapPoint[];
}

/**
 * Combine multiple detection signals into a single unified heatmap.
 * 
 * Each signal is weighted and normalized, then blended together.
 * The result is a single heatmap where intensity represents the
 * combined "hype score" from all available signals.
 */
export function combineSignals(
  sources: SignalSource[],
  videoDurationS: number,
  windowSizeMs: number = 2000,
): { combined: HeatmapPoint[]; methodsUsed: DetectionMethod[] } {
  const activeSources = sources.filter(s => s.points.length > 0);

  if (activeSources.length === 0) {
    return { combined: [], methodsUsed: [] };
  }

  // If only one source, return it directly
  if (activeSources.length === 1) {
    return {
      combined: activeSources[0].points,
      methodsUsed: [activeSources[0].method],
    };
  }

  console.log(`[combiner] Blending ${activeSources.length} signals:`);
  activeSources.forEach(s => {
    console.log(`   ${s.label}: ${s.points.length} points (weight: ${s.weight})`);
  });

  // Create unified time grid
  const numBuckets = Math.ceil((videoDurationS * 1000) / windowSizeMs);
  const grid: number[] = new Array(numBuckets).fill(0);
  let totalWeight = 0;

  for (const source of activeSources) {
    // Resample this source to our grid
    const resampled = resampleToGrid(source.points, numBuckets, videoDurationS * 1000);

    // Add weighted values to grid
    for (let i = 0; i < numBuckets; i++) {
      grid[i] += resampled[i] * source.weight;
    }
    totalWeight += source.weight;
  }

  // Normalize combined values to 0-1
  const maxVal = Math.max(...grid);
  const minVal = Math.min(...grid);
  const range = maxVal - minVal || 1;

  const combined: HeatmapPoint[] = grid.map((val, i) => ({
    startMs: i * windowSizeMs,
    endMs: Math.min((i + 1) * windowSizeMs, videoDurationS * 1000),
    intensity: (val - minVal) / range,
  }));

  console.log(`[combiner] ✅ Combined heatmap: ${combined.length} points`);

  return {
    combined,
    methodsUsed: activeSources.map(s => s.method),
  };
}

/**
 * Resample a heatmap signal to a uniform grid with `numBuckets` entries.
 * Handles different-sized source data by interpolating.
 */
function resampleToGrid(
  points: HeatmapPoint[],
  numBuckets: number,
  totalDurationMs: number,
): number[] {
  const grid: number[] = new Array(numBuckets).fill(0);
  const bucketSizeMs = totalDurationMs / numBuckets;

  for (const point of points) {
    // Find which grid buckets this point overlaps
    const startBucket = Math.floor(point.startMs / bucketSizeMs);
    const endBucket = Math.min(
      Math.ceil(point.endMs / bucketSizeMs),
      numBuckets
    );

    for (let i = startBucket; i < endBucket; i++) {
      if (i >= 0 && i < numBuckets) {
        // Use max to prevent dilution
        grid[i] = Math.max(grid[i], point.intensity);
      }
    }
  }

  // Normalize this individual signal to 0-1
  const max = Math.max(...grid);
  if (max > 0) {
    for (let i = 0; i < grid.length; i++) {
      grid[i] /= max;
    }
  }

  return grid;
}

/**
 * Apply smoothing to a heatmap to reduce noise.
 * Uses a simple moving average window.
 */
export function smoothHeatmap(
  points: HeatmapPoint[],
  windowSize: number = 3,
): HeatmapPoint[] {
  const halfWindow = Math.floor(windowSize / 2);

  return points.map((point, i) => {
    let sum = 0;
    let count = 0;

    for (let j = i - halfWindow; j <= i + halfWindow; j++) {
      if (j >= 0 && j < points.length) {
        sum += points[j].intensity;
        count++;
      }
    }

    return {
      ...point,
      intensity: sum / count,
    };
  });
}
