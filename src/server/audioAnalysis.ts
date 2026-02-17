import { spawn } from 'child_process';
import type { HeatmapPoint } from '../types/index.js';
import { FFMPEG_PATH } from './binPaths.js';

/**
 * Audio Energy Analysis — Single Pass
 *
 * Old approach: thousands of individual ffmpeg calls (2s chunks) = very slow.
 * New approach: ONE ffmpeg process streams RMS energy data in real-time.
 *
 * Uses the `astats` filter which outputs per-frame audio statistics
 * including RMS level. We aggregate into 2-second windows.
 */
export async function analyzeAudioEnergy(
  videoPath: string,
  windowS: number = 2,
  knownDurationS?: number,
): Promise<HeatmapPoint[]> {
  console.log('[audio] Analyzing audio energy (single-pass)...');

  return new Promise((resolve) => {
    const args = [
      '-i', videoPath,
      '-vn',                          // Skip video
      '-af', `astats=metadata=1:reset=${windowS}`, // Reset stats every windowS seconds
      '-f', 'null',                   // Don't output a file
      '-',
    ];

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    const rmsValues: { timeS: number; rms: number }[] = [];
    let currentTime = 0;

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();

      // Parse time progress and RMS values from stderr
      const text = data.toString();

      // Extract current timestamp from progress lines
      const timeMatch = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
      if (timeMatch) {
        currentTime = parseInt(timeMatch[1]) * 3600 +
                     parseInt(timeMatch[2]) * 60 +
                     parseInt(timeMatch[3]) +
                     parseInt(timeMatch[4]) / 100;
      }

      // Extract RMS level from astats metadata
      // Look for: lavfi.astats.Overall.RMS_level=-XX.XX
      const rmsMatches = text.matchAll(/RMS_level=([-\d.]+)/g);
      for (const m of rmsMatches) {
        const rmsDb = parseFloat(m[1]);
        if (!isNaN(rmsDb) && rmsDb > -100) { // Filter out silence (-inf)
          rmsValues.push({ timeS: currentTime, rms: rmsDb });
        }
      }
    });

    proc.on('close', () => {
      if (rmsValues.length === 0) {
        console.log('[audio] astats produced no data, trying volumedetect fallback...');
        analyzeWithVolumeDetect(videoPath, windowS, knownDurationS).then(resolve);
        return;
      }

      // Convert dB RMS to 0-1 intensity, aggregated into windows
      const points = rmsToHeatmap(rmsValues, windowS);
      console.log(`[audio] ✅ Single-pass analysis: ${points.length} data points`);
      resolve(points);
    });

    proc.on('error', () => {
      console.log('[audio] astats failed, trying fallback...');
      analyzeWithVolumeDetect(videoPath, windowS, knownDurationS).then(resolve);
    });

    // Safety timeout: 2 minutes max
    setTimeout(() => {
      try { proc.kill(); } catch {}
    }, 120000);
  });
}

/**
 * Fallback: Use a single volumedetect pass + silence detection
 * to build an energy profile. Still ONE ffmpeg call.
 */
async function analyzeWithVolumeDetect(
  videoPath: string,
  windowS: number,
  knownDurationS?: number,
): Promise<HeatmapPoint[]> {
  console.log('[audio] Using silencedetect fallback (single-pass)...');

  return new Promise((resolve) => {
    // Use silencedetect to find quiet parts, infer loud parts
    const args = [
      '-i', videoPath,
      '-vn',
      '-af', 'silencedetect=noise=-35dB:d=0.3',
      '-f', 'null',
      '-',
    ];

    const proc = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'pipe', 'pipe'] });

    let stderr = '';
    let duration = knownDurationS || 0;

    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on('close', () => {
      // Try to get duration from ffmpeg output if not known
      if (duration === 0) {
        const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
        if (durMatch) {
          duration = parseInt(durMatch[1]) * 3600 +
                    parseInt(durMatch[2]) * 60 +
                    parseInt(durMatch[3]) +
                    parseInt(durMatch[4]) / 100;
        }
      }

      // Second attempt: last time= progress line
      if (duration === 0) {
        const timeMatches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+)\.(\d+)/g)];
        if (timeMatches.length > 0) {
          const last = timeMatches[timeMatches.length - 1];
          duration = parseInt(last[1]) * 3600 +
                    parseInt(last[2]) * 60 +
                    parseInt(last[3]) +
                    parseInt(last[4]) / 100;
        }
      }

      if (duration === 0) {
        console.log('[audio] Could not determine duration');
        resolve([]);
        return;
      }

      console.log(`[audio] Video duration: ${Math.round(duration)}s`);

      // Parse silence periods
      const silenceStarts: number[] = [];
      const silenceEnds: number[] = [];

      for (const m of stderr.matchAll(/silence_start:\s*([\d.]+)/g)) {
        silenceStarts.push(parseFloat(m[1]));
      }
      for (const m of stderr.matchAll(/silence_end:\s*([\d.]+)/g)) {
        silenceEnds.push(parseFloat(m[1]));
      }

      // Build intensity map: 1.0 = sound, 0.1 = silence
      const numWindows = Math.ceil(duration / windowS);
      const points: HeatmapPoint[] = [];

      for (let i = 0; i < numWindows; i++) {
        const startMs = i * windowS * 1000;
        const endMs = (i + 1) * windowS * 1000;
        const startSec = i * windowS;
        const endSec = (i + 1) * windowS;

        // Check if this window overlaps with any silence period
        let silenceOverlap = 0;
        for (let s = 0; s < silenceStarts.length; s++) {
          const silStart = silenceStarts[s];
          const silEnd = s < silenceEnds.length ? silenceEnds[s] : duration;
          const overlap = Math.max(0,
            Math.min(endSec, silEnd) - Math.max(startSec, silStart)
          );
          silenceOverlap += overlap;
        }

        const silenceRatio = silenceOverlap / windowS;
        // Invert: more silence = lower intensity
        const intensity = Math.max(0.05, 1 - silenceRatio * 0.9);

        points.push({ startMs, endMs, intensity });
      }

      // Normalize to 0-1 range
      const maxI = Math.max(...points.map(p => p.intensity), 0.01);
      const minI = Math.min(...points.map(p => p.intensity));
      const range = maxI - minI || 1;

      for (const p of points) {
        p.intensity = (p.intensity - minI) / range;
      }

      console.log(`[audio] ✅ Silence-based analysis: ${points.length} data points (${silenceStarts.length} silence regions)`);
      resolve(points);
    });

    proc.on('error', () => {
      console.log('[audio] All audio analysis methods failed');
      resolve([]);
    });

    setTimeout(() => { try { proc.kill(); } catch {} }, 120000);
  });
}

/**
 * Convert raw RMS dB values into a normalized heatmap.
 */
function rmsToHeatmap(
  rmsValues: { timeS: number; rms: number }[],
  windowS: number,
): HeatmapPoint[] {
  if (rmsValues.length === 0) return [];

  const maxTime = Math.max(...rmsValues.map(v => v.timeS));
  const numWindows = Math.ceil(maxTime / windowS);
  const points: HeatmapPoint[] = [];

  for (let i = 0; i < numWindows; i++) {
    const wStart = i * windowS;
    const wEnd = (i + 1) * windowS;

    const windowValues = rmsValues.filter(v => v.timeS >= wStart && v.timeS < wEnd);

    let avgRms = -60; // Default: quiet
    if (windowValues.length > 0) {
      avgRms = windowValues.reduce((s, v) => s + v.rms, 0) / windowValues.length;
    }

    // Convert dB to 0-1: -60dB = 0 (silence), -10dB = 1 (loud)
    const normalized = Math.max(0, Math.min(1, (avgRms + 60) / 50));

    points.push({
      startMs: wStart * 1000,
      endMs: wEnd * 1000,
      intensity: normalized,
    });
  }

  // Re-normalize to use full 0-1 range
  const maxI = Math.max(...points.map(p => p.intensity), 0.01);
  const minI = Math.min(...points.map(p => p.intensity));
  const range = maxI - minI || 1;

  for (const p of points) {
    p.intensity = (p.intensity - minI) / range;
  }

  return points;
}
