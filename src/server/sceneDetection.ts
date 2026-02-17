import { spawn } from 'child_process';
import type { HeatmapPoint } from '../types/index.js';
import { FFMPEG_PATH } from './binPaths.js';

/**
 * Detect scene changes / visual cuts using ffmpeg's scene detection filter.
 * 
 * Areas with many rapid scene changes (action sequences, highlight montages,
 * fast edits) score higher. Calm, static shots score lower.
 * 
 * Returns heatmap-compatible data where intensity = density of scene changes
 * within each window.
 */
export async function detectSceneChanges(
  videoPath: string,
  videoDurationS: number,
  windowSizeS: number = 2,
  sceneThreshold: number = 0.3,
): Promise<HeatmapPoint[]> {
  console.log('[scene] Detecting scene changes...');

  return new Promise((resolve, reject) => {
    // ffmpeg scene filter outputs a score for each frame where a scene change is detected
    const args = [
      '-i', videoPath,
      '-vf', `select='gt(scene,${sceneThreshold})',showinfo`,
      '-f', 'null',
      '-',
    ];

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', () => {
      // Parse timestamps of scene changes from showinfo output
      // Lines look like: [Parsed_showinfo_1 ...] n:  45 pts: 123456 pts_time:1.234 ...
      const regex = /pts_time:\s*([\d.]+)/g;
      const sceneChangeTimes: number[] = [];

      let match;
      while ((match = regex.exec(stderr)) !== null) {
        sceneChangeTimes.push(parseFloat(match[1]));
      }

      console.log(`[scene] Found ${sceneChangeTimes.length} scene changes`);

      if (sceneChangeTimes.length === 0) {
        resolve([]);
        return;
      }

      // Group scene changes into time windows and count density
      const numWindows = Math.ceil(videoDurationS / windowSizeS);
      const counts: number[] = new Array(numWindows).fill(0);

      for (const t of sceneChangeTimes) {
        const idx = Math.min(Math.floor(t / windowSizeS), numWindows - 1);
        if (idx >= 0) counts[idx]++;
      }

      // Normalize to 0-1
      const maxCount = Math.max(...counts);
      if (maxCount === 0) {
        resolve([]);
        return;
      }

      const points: HeatmapPoint[] = counts.map((count, i) => ({
        startMs: i * windowSizeS * 1000,
        endMs: Math.min((i + 1) * windowSizeS * 1000, videoDurationS * 1000),
        intensity: count / maxCount,
      }));

      console.log(`[scene] ✅ Generated ${points.length} scene activity data points`);
      resolve(points);
    });

    proc.on('error', (err) => {
      console.error(`[scene] Detection failed: ${err.message}`);
      resolve([]); // Don't reject, just return empty
    });
  });
}
