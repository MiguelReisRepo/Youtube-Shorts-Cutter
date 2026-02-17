import { spawn } from 'child_process';
import path from 'path';
import { FFMPEG_PATH } from './binPaths.js';

export interface ExportFormat {
  id: string;
  label: string;
  width: number;
  height: number;
  platform: string;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: 'shorts',    label: 'Vertical 9:16',    width: 1080, height: 1920, platform: 'Shorts / Reels / TikTok' },
  { id: 'square',    label: 'Square 1:1',        width: 1080, height: 1080, platform: 'Instagram Feed / X' },
  { id: 'landscape', label: 'Landscape 16:9',    width: 1920, height: 1080, platform: 'YouTube / Twitter' },
];

/**
 * Export a source clip in multiple aspect ratios.
 * Takes an already-processed 9:16 clip and reformats it.
 */
export async function exportMultiFormat(
  sourcePath: string,           // Path to the 9:16 processed clip
  outputDir: string,
  baseName: string,
  formats: string[],            // Format IDs: ['shorts', 'square', 'landscape']
  onProgress?: (msg: string) => void,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();

  for (const formatId of formats) {
    const format = EXPORT_FORMATS.find(f => f.id === formatId);
    if (!format) continue;

    if (formatId === 'shorts') {
      // 9:16 is the original — just copy/symlink
      results.set(formatId, sourcePath);
      continue;
    }

    const outputPath = path.join(outputDir, `${baseName}_${formatId}.mp4`);
    onProgress?.(`Exporting ${format.label} for ${format.platform}...`);

    try {
      await convertAspectRatio(sourcePath, outputPath, format);
      results.set(formatId, outputPath);
    } catch (err: any) {
      console.log(`[export] Failed to create ${formatId}: ${err.message}`);
    }
  }

  return results;
}

/**
 * Convert a vertical video to a different aspect ratio.
 * Uses blur-pad technique to fill the frame.
 */
function convertAspectRatio(
  inputPath: string,
  outputPath: string,
  format: ExportFormat,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { width, height } = format;

    // Blur background + sharp foreground centered
    const filterComplex = [
      // Background: scale up, crop to target, blur
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,`,
      `crop=${width}:${height},boxblur=25:5[bg];`,
      // Foreground: scale to fit within target
      `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg];`,
      // Overlay centered
      `[bg][fg]overlay=(W-w)/2:(H-h)/2`,
    ].join('');

    const proc = spawn(FFMPEG_PATH, [
      '-y',
      '-i', inputPath,
      '-filter_complex', filterComplex,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '20',
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outputPath,
    ]);

    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Format conversion failed: ${stderr.slice(-200)}`));
    });

    proc.on('error', reject);
  });
}
