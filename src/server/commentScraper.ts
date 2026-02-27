import { execFile } from 'child_process';
import { promisify } from 'util';
import type { HeatmapPoint } from '../types/index.js';
import { YTDLP_PATH, YTDLP_COMMON_ARGS } from './binPaths.js';

const execFileAsync = promisify(execFile);

interface TimestampMention {
  timeS: number;
  count: number;
  text: string;
}

/**
 * Scrape YouTube comments for timestamp mentions like "2:34 best part!"
 * 
 * Uses yt-dlp to fetch comments, then parses timestamps from comment text.
 * More mentions at a specific time = higher intensity.
 * 
 * Returns heatmap-compatible data where intensity = density of timestamp mentions.
 */
export async function scrapeCommentTimestamps(
  videoUrl: string,
  videoDurationS: number,
  windowSizeS: number = 5,
  maxComments: number = 200,
): Promise<{ heatmap: HeatmapPoint[]; timestamps: TimestampMention[] }> {
  console.log(`[comments] Scraping comments for timestamps (max ${maxComments})...`);

  try {
    // Fetch comments using yt-dlp
    const { stdout } = await execFileAsync(YTDLP_PATH, [
      ...YTDLP_COMMON_ARGS,
      '--write-comments',
      '--no-download',
      '--dump-json',
      '--extractor-args', `youtube:max_comments=${maxComments},all,100`,
      '--no-warnings',
      videoUrl,
    ], {
      maxBuffer: 1024 * 1024 * 100,
      timeout: 60000,
    });

    const info = JSON.parse(stdout);
    const comments: any[] = info.comments || [];

    console.log(`[comments] Fetched ${comments.length} comments`);

    if (!comments.length) {
      return { heatmap: [], timestamps: [] };
    }

    // Extract timestamps from comment text
    const timestampRegex = /\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g;
    const mentionMap = new Map<number, { count: number; texts: string[] }>();

    for (const comment of comments) {
      const text = comment.text || '';
      let match;

      // Reset regex state
      timestampRegex.lastIndex = 0;

      while ((match = timestampRegex.exec(text)) !== null) {
        let timeS: number;

        if (match[3]) {
          // HH:MM:SS
          timeS = parseInt(match[1]) * 3600 + parseInt(match[2]) * 60 + parseInt(match[3]);
        } else {
          // MM:SS
          timeS = parseInt(match[1]) * 60 + parseInt(match[2]);
        }

        // Only count timestamps within video duration (with small tolerance)
        if (timeS >= 0 && timeS <= videoDurationS + 5) {
          // Round to nearest window
          const windowStart = Math.floor(timeS / windowSizeS) * windowSizeS;
          const existing = mentionMap.get(windowStart);

          if (existing) {
            existing.count++;
            if (existing.texts.length < 3) {
              existing.texts.push(truncate(text, 80));
            }
          } else {
            mentionMap.set(windowStart, {
              count: 1,
              texts: [truncate(text, 80)],
            });
          }
        }
      }
    }

    if (mentionMap.size === 0) {
      console.log('[comments] No timestamps found in comments');
      return { heatmap: [], timestamps: [] };
    }

    // Build sorted timestamp mentions
    const timestamps: TimestampMention[] = Array.from(mentionMap.entries())
      .map(([timeS, data]) => ({
        timeS,
        count: data.count,
        text: data.texts[0],
      }))
      .sort((a, b) => b.count - a.count);

    console.log(`[comments] Found ${timestamps.length} unique timestamp mentions`);
    timestamps.slice(0, 5).forEach(t => {
      console.log(`   ${formatTime(t.timeS)} — mentioned ${t.count}x`);
    });

    // Convert to heatmap format
    const numWindows = Math.ceil(videoDurationS / windowSizeS);
    const counts: number[] = new Array(numWindows).fill(0);

    for (const [timeS, data] of mentionMap) {
      const idx = Math.min(Math.floor(timeS / windowSizeS), numWindows - 1);
      if (idx >= 0) counts[idx] += data.count;
    }

    // Normalize to 0-1
    const maxCount = Math.max(...counts);
    if (maxCount === 0) {
      return { heatmap: [], timestamps };
    }

    const heatmap: HeatmapPoint[] = counts.map((count, i) => ({
      startMs: i * windowSizeS * 1000,
      endMs: Math.min((i + 1) * windowSizeS * 1000, videoDurationS * 1000),
      intensity: count / maxCount,
    }));

    console.log(`[comments] ✅ Generated heatmap from ${timestamps.length} timestamp mentions`);
    return { heatmap, timestamps };
  } catch (err: any) {
    console.error(`[comments] Scraping failed: ${err.message}`);
    return { heatmap: [], timestamps: [] };
  }
}

// ─── Helpers ────────────────────────────────────────

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + '...';
}
