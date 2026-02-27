import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import archiver from 'archiver';
import { getVideoData, findPeakSegments } from './youtube.js';
import { analyzeAudioEnergy } from './audioAnalysis.js';
import { detectSceneChanges } from './sceneDetection.js';
import { scrapeCommentTimestamps } from './commentScraper.js';
import { combineSignals, smoothHeatmap, type SignalSource } from './signalCombiner.js';
import { processJob, downloadVideo, getOutputDir } from './processor.js';
import { getSubtitlesForPreview } from './captionEngine.js';
import { scoreSegments } from './viralityScorer.js';
import { detectBoundaries, optimizeSegments, applyOptimizations } from './clipOptimizer.js';
import { EXPORT_FORMATS } from './multiFormat.js';
import { YTDLP_PATH, YTDLP_COMMON_ARGS } from './binPaths.js';
import type {
  CutProgress,
  PeakSegment,
  DetectionResult,
  DetectionMethod,
  HeatmapPoint,
  SubtitleEntry,
  ChannelVideo,
  ChannelDownloadProgress,
} from '../types/index.js';
import { v4 as uuid } from 'uuid';

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Serve cut clips as static files
app.use('/output', express.static(getOutputDir()));

// ─── In-memory job store ────────────────────────────

interface Job {
  id: string;
  progress: CutProgress;
  listeners: Set<express.Response>;
}

const jobs = new Map<string, Job>();

// ─── API Routes ─────────────────────────────────────

/**
 * POST /api/analyze
 * 
 * Full analysis pipeline:
 * 1. Try YouTube "Most Replayed" heatmap (best signal)
 * 2. If no heatmap → download video and run fallback analysis:
 *    a. Audio energy peaks
 *    b. Scene change detection
 *    c. Comment timestamp scraping (parallel with a+b)
 * 3. Combine all available signals into a unified heatmap
 * 4. Find peak segments from the combined signal
 */
app.post('/api/analyze', async (req, res) => {
  try {
    const { url, settings } = req.body as {
      url: string;
      settings?: {
        topN?: number;
        minDurationS?: number;
        maxDurationS?: number;
        minGapS?: number;
        intensityThreshold?: number;
      };
    };

    if (!url || !isValidYouTubeUrl(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    console.log(`\n${'='.repeat(60)}`);
    console.log(`[api] Analyzing: ${url}`);
    console.log(`${'='.repeat(60)}\n`);

    // Step 1: Get video info + try YouTube heatmap
    const { video, heatmap: youtubeHeatmap } = await getVideoData(url);
    const hasYouTubeHeatmap = youtubeHeatmap.length > 0;

    let finalHeatmap: HeatmapPoint[];
    let methodsUsed: DetectionMethod[] = [];
    let primary: DetectionMethod;
    let commentTimestamps: DetectionResult['commentTimestamps'];

    if (hasYouTubeHeatmap) {
      // ✅ YouTube heatmap available — use it as primary
      console.log('[api] ✅ YouTube heatmap available — using as primary signal');
      finalHeatmap = youtubeHeatmap;
      methodsUsed = ['heatmap'];
      primary = 'heatmap';
    } else {
      // ❌ No heatmap — run optimized fallback analysis pipeline
      console.log('[api] ❌ No YouTube heatmap — running fallback analysis...');

      const isLongVideo = video.durationS > 1800; // > 30 min
      const signals: SignalSource[] = [];

      // ── Phase 1: Comments first (fast, no download needed) ──
      console.log('[api] Phase 1: Scraping comments for timestamps (fast)...');
      let commentData = { heatmap: [] as HeatmapPoint[], timestamps: [] as { timeS: number; count: number; text: string }[] };
      try {
        commentData = await scrapeCommentTimestamps(url, video.durationS);
      } catch {}

      commentTimestamps = commentData.timestamps;

      if (commentData.heatmap.length > 0) {
        signals.push({
          method: 'comments',
          label: 'Comment Timestamps',
          weight: 1.2,
          points: commentData.heatmap,
        });
      }

      // If comments give a strong signal (5+ timestamp mentions), use them alone for long videos
      const hasStrongCommentSignal = commentData.timestamps.length >= 5;
      const skipExpensiveAnalysis = isLongVideo && hasStrongCommentSignal;

      if (skipExpensiveAnalysis) {
        console.log(`[api] ✅ Strong comment signal (${commentData.timestamps.length} timestamps) — skipping video download for ${Math.round(video.durationS / 60)}min video`);
      } else {
        // ── Phase 2: Download video + audio/scene analysis ──
        console.log(`[api] Phase 2: Downloading video for audio/scene analysis...`);
        if (isLongVideo) {
          console.log(`[api] ⚠️ Long video (${Math.round(video.durationS / 60)}min) — using optimized analysis`);
        }

        const tmpDir = path.join(os.tmpdir(), `yt-analysis-${uuid()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        let videoPath: string;
        try {
          videoPath = await downloadVideo(url, (msg) => {
            console.log(`[download] ${msg}`);
          }, tmpDir, true); // analysisMode = true (low quality)
        } catch (err: any) {
          console.error(`[api] Download failed: ${err.message}`);
          // If we have comments, use them; otherwise fail
          if (signals.length > 0) {
            console.log('[api] Using comment data only (download failed)');
          } else {
            return res.status(500).json({
              error: 'Failed to download video for analysis',
              details: err.message,
            });
          }
          videoPath = ''; // Will skip audio/scene
        }

        if (videoPath) {
          const [audioResult, sceneResult] = await Promise.allSettled([
            analyzeAudioEnergy(videoPath, 2, video.durationS),
            detectSceneChanges(videoPath, video.durationS),
          ]);

          const audioHeatmap = audioResult.status === 'fulfilled' ? audioResult.value : [];
          const sceneHeatmap = sceneResult.status === 'fulfilled' ? sceneResult.value : [];

          if (audioHeatmap.length > 0) {
            signals.push({
              method: 'audio',
              label: 'Audio Energy',
              weight: 1.0,
              points: audioHeatmap,
            });
          }

          if (sceneHeatmap.length > 0) {
            signals.push({
              method: 'scene',
              label: 'Scene Changes',
              weight: 0.6,
              points: sceneHeatmap,
            });
          }
        }

        // Cleanup temp video
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }

      // Combine all available signals
      if (signals.length > 0) {
        const combined = combineSignals(signals, video.durationS);
        finalHeatmap = smoothHeatmap(combined.combined, 3);
        methodsUsed = combined.methodsUsed;

        if (methodsUsed.length > 1) {
          methodsUsed.push('combined');
          primary = 'combined';
        } else {
          primary = methodsUsed[0];
        }
      } else {
        console.log('[api] ⚠️ No analysis signals available');
        finalHeatmap = [];
        primary = 'audio';
      }
    }

    // Find peak segments from whatever heatmap we have
    let segments = findPeakSegments(finalHeatmap, video.durationS, {
      topN: settings?.topN,
      minDurationS: settings?.minDurationS,
      maxDurationS: settings?.maxDurationS,
      minGapS: settings?.minGapS,
      intensityThreshold: settings?.intensityThreshold,
    });

    // Optimize clip boundaries (hook strength + natural start/end)
    try {
      const boundaryContext = {
        silenceRegions: [],  // Available if video was downloaded for analysis
        sceneChanges: [],
        heatmap: finalHeatmap,
      };
      const optimized = optimizeSegments(
        segments,
        finalHeatmap,
        boundaryContext,
        video.durationS,
        settings?.minDurationS || 15,
        settings?.maxDurationS || 60,
      );

      // Log hook optimizations
      for (let i = 0; i < optimized.length; i++) {
        const o = optimized[i];
        if (Math.abs(o.hookShiftS) > 0.5) {
          console.log(`   Clip ${i + 1}: shifted start ${o.hookShiftS > 0 ? '+' : ''}${o.hookShiftS}s for better hook (${o.boundaryType}, score: ${o.hookScore})`);
        }
      }

      segments = applyOptimizations(optimized);
    } catch (err: any) {
      console.log(`[optimizer] Boundary optimization failed (using original cuts): ${err.message}`);
    }

    // Score virality for each segment
    const viralityScores = scoreSegments(segments, finalHeatmap, video.durationS);

    const detection: DetectionResult = {
      methodsUsed,
      primary,
      hasYouTubeHeatmap,
      commentTimestamps,
    };

    console.log(`\n[api] Analysis complete:`);
    console.log(`   Methods: ${methodsUsed.join(', ')}`);
    console.log(`   Heatmap points: ${finalHeatmap.length}`);
    console.log(`   Peak segments: ${segments.length}\n`);

    res.json({ video, heatmap: finalHeatmap, segments, detection, viralityScores });
  } catch (err: any) {
    console.error('[api] Analyze error:', err.message);
    res.status(500).json({
      error: 'Failed to analyze video',
      details: err.message,
    });
  }
});

/**
 * POST /api/subtitles
 * Fetch subtitle text for segments so the user can preview/edit them.
 */
app.post('/api/subtitles', async (req, res) => {
  try {
    const { url, segments } = req.body as {
      url: string;
      segments: PeakSegment[];
    };

    if (!url || !segments?.length) {
      return res.status(400).json({ error: 'Missing url or segments' });
    }

    console.log(`[api] Fetching subtitles for ${segments.length} segments...`);

    const result: Record<string, SubtitleEntry[]> = {};
    for (const seg of segments) {
      result[seg.id] = await getSubtitlesForPreview(url, seg.startS, seg.endS);
    }

    const totalEntries = Object.values(result).reduce((sum, entries) => sum + entries.length, 0);
    console.log(`[api] ✅ Fetched ${totalEntries} subtitle entries`);

    res.json({ subtitles: result });
  } catch (err: any) {
    console.error('[api] Subtitles fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch subtitles', details: err.message });
  }
});

/**
 * POST /api/cut
 * Start a video cutting job, returns a job ID for progress tracking
 */
app.post('/api/cut', async (req, res) => {
  try {
    const { url, segments, cropMode, videoTitle, captions, quality, translateTo, translateMode, editedSubtitles } = req.body as {
      url: string;
      segments: PeakSegment[];
      cropMode: 'center' | 'blur_pad' | 'letterbox' | 'smart_reframe';
      videoTitle: string;
      captions?: string;
      quality?: string;
      translateTo?: string;
      translateMode?: string;
      editedSubtitles?: Record<string, SubtitleEntry[]>;
    };

    if (!url || !segments?.length) {
      return res.status(400).json({ error: 'Missing url or segments' });
    }

    const jobId = uuid();
    const job: Job = {
      id: jobId,
      progress: {
        status: 'downloading',
        currentClip: 0,
        totalClips: segments.length,
        message: 'Starting...',
      },
      listeners: new Set(),
    };

    jobs.set(jobId, job);
    res.json({ jobId });

    // Start processing in background
    processJob(url, videoTitle || 'clip', segments, cropMode || 'center', captions || 'off', (progress) => {
      job.progress = progress;
      for (const listener of job.listeners) {
        listener.write(`data: ${JSON.stringify(progress)}\n\n`);
        if (progress.status === 'done' || progress.status === 'error') {
          listener.end();
        }
      }
    }, quality || '1080', translateTo || '', translateMode || '', editedSubtitles);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/jobs/:id/progress
 * Server-Sent Events stream for job progress
 */
app.get('/api/jobs/:id/progress', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(job.progress)}\n\n`);

  if (job.progress.status === 'done' || job.progress.status === 'error') {
    res.end();
    return;
  }

  job.listeners.add(res);
  req.on('close', () => { job.listeners.delete(res); });
});

/**
 * GET /api/jobs/:id
 */
app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ id: job.id, progress: job.progress });
});

// ─── Helpers ────────────────────────────────────────

function isValidYouTubeUrl(url: string): boolean {
  return /https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(url);
}

// ─── Export Formats Endpoint ────────────────────────

app.get('/api/formats', (_req, res) => {
  res.json({ formats: EXPORT_FORMATS });
});

// ─── Batch Processing ───────────────────────────────

interface BatchJob {
  id: string;
  urls: string[];
  status: 'pending' | 'processing' | 'done' | 'error';
  results: {
    url: string;
    status: 'pending' | 'analyzing' | 'cutting' | 'done' | 'error';
    video?: any;
    segments?: PeakSegment[];
    files?: string[];
    error?: string;
  }[];
  listeners: Set<any>;
}

const batchJobs = new Map<string, BatchJob>();

/**
 * POST /api/batch
 * Process multiple URLs in sequence.
 */
app.post('/api/batch', async (req, res) => {
  const { urls, settings, cropMode, captions } = req.body as {
    urls: string[];
    settings?: any;
    cropMode?: string;
    captions?: string;
  };

  if (!urls?.length) {
    return res.status(400).json({ error: 'No URLs provided' });
  }

  if (urls.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 URLs per batch' });
  }

  const validUrls = urls.filter(u => isValidYouTubeUrl(u.trim()));
  if (!validUrls.length) {
    return res.status(400).json({ error: 'No valid YouTube URLs found' });
  }

  const batchId = uuid();
  const batch: BatchJob = {
    id: batchId,
    urls: validUrls,
    status: 'processing',
    results: validUrls.map(url => ({ url, status: 'pending' as const })),
    listeners: new Set(),
  };

  batchJobs.set(batchId, batch);
  res.json({ batchId, totalUrls: validUrls.length });

  // Process URLs in sequence
  (async () => {
    for (let i = 0; i < validUrls.length; i++) {
      const url = validUrls[i];
      batch.results[i].status = 'analyzing';
      notifyBatchListeners(batch);

      try {
        // Analyze
        const analyzeRes = await fetch(`http://localhost:${PORT}/api/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url, settings }),
        });

        if (!analyzeRes.ok) throw new Error('Analysis failed');
        const data = await analyzeRes.json();

        batch.results[i].video = data.video;
        batch.results[i].segments = data.segments;
        batch.results[i].status = 'cutting';
        notifyBatchListeners(batch);

        // Cut clips
        const selectedSegments = data.segments.slice(0, settings?.topN || 5);
        if (selectedSegments.length > 0) {
          const cutRes = await fetch(`http://localhost:${PORT}/api/cut`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              url,
              segments: selectedSegments,
              cropMode: cropMode || 'center',
              captions: captions || 'off',
              videoTitle: data.video?.title || 'clip',
            }),
          });

          if (!cutRes.ok) throw new Error('Cutting failed');
          const { jobId } = await cutRes.json();

          // Wait for job to complete
          await waitForJob(jobId);
          const job = jobs.get(jobId);
          batch.results[i].files = job?.progress.files || [];
        }

        batch.results[i].status = 'done';
        console.log(`[batch] ✅ ${i + 1}/${validUrls.length}: ${data.video?.title || url}`);
      } catch (err: any) {
        batch.results[i].status = 'error';
        batch.results[i].error = err.message;
        console.log(`[batch] ❌ ${i + 1}/${validUrls.length}: ${err.message}`);
      }

      notifyBatchListeners(batch);
    }

    batch.status = 'done';
    notifyBatchListeners(batch);
    console.log(`\n[batch] ✅ Batch complete: ${batch.results.filter(r => r.status === 'done').length}/${validUrls.length} succeeded`);
  })();
});

/**
 * GET /api/batch/:id/progress
 * SSE stream for batch progress
 */
app.get('/api/batch/:id/progress', (req, res) => {
  const batch = batchJobs.get(req.params.id);
  if (!batch) return res.status(404).json({ error: 'Batch not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify({ status: batch.status, results: batch.results })}\n\n`);

  if (batch.status === 'done') {
    res.end();
    return;
  }

  batch.listeners.add(res);
  req.on('close', () => batch.listeners.delete(res));
});

function notifyBatchListeners(batch: BatchJob) {
  const data = JSON.stringify({ status: batch.status, results: batch.results });
  for (const listener of batch.listeners) {
    try { listener.write(`data: ${data}\n\n`); } catch {}
  }
}

function waitForJob(jobId: string): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      const job = jobs.get(jobId);
      if (!job || job.progress.status === 'done' || job.progress.status === 'error') {
        resolve();
      } else {
        setTimeout(check, 1000);
      }
    };
    check();
  });
}

// ─── Channel Download ────────────────────────────────

interface ChannelDownloadJob {
  id: string;
  progress: ChannelDownloadProgress;
  listeners: Set<express.Response>;
}

const channelJobs = new Map<string, ChannelDownloadJob>();

function isValidChannelUrl(url: string): boolean {
  return /https?:\/\/(www\.)?youtube\.com\/(@[\w.-]+|channel\/[\w-]+|c\/[\w-]+)/.test(url);
}

/**
 * POST /api/channel/videos
 * List all videos from a YouTube channel using yt-dlp --flat-playlist
 */
app.post('/api/channel/videos', async (req, res) => {
  try {
    const { channelUrl } = req.body as { channelUrl: string };

    if (!channelUrl || !isValidChannelUrl(channelUrl)) {
      return res.status(400).json({ error: 'Invalid YouTube channel URL' });
    }

    // Normalize: ensure /videos suffix
    let listUrl = channelUrl.replace(/\/$/, '');
    if (!listUrl.endsWith('/videos') && !listUrl.endsWith('/streams')) {
      listUrl += '/videos';
    }

    console.log(`\n[channel] Listing videos from: ${listUrl}`);

    const { stdout } = await execFileAsync(YTDLP_PATH, [
      ...YTDLP_COMMON_ARGS,
      '--flat-playlist',
      '-j',
      '--no-warnings',
      listUrl,
    ], { maxBuffer: 1024 * 1024 * 50, timeout: 120000 });

    const videos: ChannelVideo[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        videos.push({
          id: entry.id,
          title: entry.title || 'Untitled',
          thumbnail: entry.thumbnails?.[0]?.url || `https://i.ytimg.com/vi/${entry.id}/hqdefault.jpg`,
          durationS: entry.duration || 0,
          url: `https://www.youtube.com/watch?v=${entry.id}`,
        });
      } catch {}
    }

    console.log(`[channel] Found ${videos.length} videos`);
    res.json({ videos, channelUrl: listUrl });
  } catch (err: any) {
    console.error('[channel] List error:', err.message);
    res.status(500).json({ error: 'Failed to list channel videos', details: err.message });
  }
});

/**
 * POST /api/channel/download
 * Start downloading selected videos from a channel
 */
app.post('/api/channel/download', async (req, res) => {
  try {
    const { videos, zip, quality } = req.body as {
      videos: ChannelVideo[];
      zip?: boolean;
      quality?: string;
    };

    if (!videos?.length) {
      return res.status(400).json({ error: 'No videos selected' });
    }

    const jobId = uuid();
    const job: ChannelDownloadJob = {
      id: jobId,
      progress: {
        status: 'downloading',
        currentVideo: 0,
        totalVideos: videos.length,
        message: 'Starting downloads...',
      },
      listeners: new Set(),
    };

    channelJobs.set(jobId, job);
    res.json({ jobId });

    // Process downloads in background
    (async () => {
      const outputDir = getOutputDir();
      const downloadedFiles: string[] = [];
      const qualityFilter = quality === '720' ? '720' : quality === '480' ? '480' : '1080';

      for (let i = 0; i < videos.length; i++) {
        const video = videos[i];
        job.progress = {
          status: 'downloading',
          currentVideo: i + 1,
          totalVideos: videos.length,
          message: `Downloading ${i + 1}/${videos.length}: ${video.title}`,
          files: downloadedFiles,
        };
        notifyChannelListeners(job);

        try {
          // Sanitize filename
          const safeTitle = video.title
            .replace(/[<>:"/\\|?*]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
          const outputFile = `${safeTitle} [${video.id}].mp4`;
          const outputPath = path.join(outputDir, outputFile);

          // Skip if already exists
          if (fs.existsSync(outputPath)) {
            console.log(`[channel] Skipping (exists): ${safeTitle}`);
            downloadedFiles.push(outputFile);
            continue;
          }

          await execFileAsync(YTDLP_PATH, [
            ...YTDLP_COMMON_ARGS,
            '-f', `bestvideo[height<=${qualityFilter}]+bestaudio/best[height<=${qualityFilter}]`,
            '--merge-output-format', 'mp4',
            '-o', outputPath,
            '--no-warnings',
            '--no-part',
            '--no-continue',
            '--windows-filenames',
            video.url,
          ], { maxBuffer: 1024 * 1024 * 100, timeout: 600000 });

          downloadedFiles.push(outputFile);
          console.log(`[channel] ✅ ${i + 1}/${videos.length}: ${safeTitle}`);
        } catch (err: any) {
          console.error(`[channel] ❌ ${i + 1}/${videos.length}: ${err.message}`);
          // Continue with next video on error
        }
      }

      // Zip if requested
      if (zip && downloadedFiles.length > 0) {
        job.progress = {
          status: 'zipping',
          currentVideo: videos.length,
          totalVideos: videos.length,
          message: `Creating ZIP of ${downloadedFiles.length} videos...`,
          files: downloadedFiles,
        };
        notifyChannelListeners(job);

        try {
          const zipName = `channel_${Date.now()}.zip`;
          const zipPath = path.join(outputDir, zipName);
          const output = fs.createWriteStream(zipPath);
          const archive = archiver('zip', { zlib: { level: 1 } }); // Fast compression

          await new Promise<void>((resolve, reject) => {
            output.on('close', resolve);
            archive.on('error', reject);
            archive.pipe(output);

            for (const file of downloadedFiles) {
              const filePath = path.join(outputDir, file);
              if (fs.existsSync(filePath)) {
                archive.file(filePath, { name: file });
              }
            }

            archive.finalize();
          });

          const zipSizeMB = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
          console.log(`[channel] 📦 ZIP created: ${zipName} (${zipSizeMB} MB)`);

          job.progress = {
            status: 'done',
            currentVideo: videos.length,
            totalVideos: videos.length,
            message: `Done! ${downloadedFiles.length} videos downloaded and zipped`,
            files: downloadedFiles,
            zipFile: zipName,
          };
        } catch (err: any) {
          console.error(`[channel] ZIP error: ${err.message}`);
          job.progress = {
            status: 'done',
            currentVideo: videos.length,
            totalVideos: videos.length,
            message: `Downloaded ${downloadedFiles.length} videos (ZIP failed: ${err.message})`,
            files: downloadedFiles,
          };
        }
      } else {
        job.progress = {
          status: 'done',
          currentVideo: videos.length,
          totalVideos: videos.length,
          message: `Done! ${downloadedFiles.length}/${videos.length} videos downloaded`,
          files: downloadedFiles,
        };
      }

      notifyChannelListeners(job);
      console.log(`[channel] ✅ Download complete: ${downloadedFiles.length}/${videos.length} succeeded`);
    })();
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/channel/:id/progress
 * SSE stream for channel download progress
 */
app.get('/api/channel/:id/progress', (req, res) => {
  const job = channelJobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  res.write(`data: ${JSON.stringify(job.progress)}\n\n`);

  if (job.progress.status === 'done' || job.progress.status === 'error') {
    res.end();
    return;
  }

  job.listeners.add(res);
  req.on('close', () => { job.listeners.delete(res); });
});

function notifyChannelListeners(job: ChannelDownloadJob) {
  const data = JSON.stringify(job.progress);
  for (const listener of job.listeners) {
    try { listener.write(`data: ${data}\n\n`); } catch {}
  }
}

// ─── URL List Download (Vimeo, YouTube, etc.) ────────

/**
 * POST /api/urls/info
 * Probe a list of URLs using yt-dlp to get title/duration/thumbnail
 */
app.post('/api/urls/info', async (req, res) => {
  try {
    const { urls } = req.body as { urls: string[] };

    if (!urls?.length) {
      return res.status(400).json({ error: 'No URLs provided' });
    }

    if (urls.length > 200) {
      return res.status(400).json({ error: 'Maximum 200 URLs per request' });
    }

    console.log(`\n[urls] Probing ${urls.length} URLs...`);

    const videos: ChannelVideo[] = [];
    const errors: string[] = [];

    // Probe in batches of 5 for speed
    for (let i = 0; i < urls.length; i += 5) {
      const batch = urls.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(async (url) => {
          const { stdout } = await execFileAsync(YTDLP_PATH, [
            ...YTDLP_COMMON_ARGS,
            '--no-download',
            '-j',
            '--no-warnings',
            url.trim(),
          ], { maxBuffer: 1024 * 1024 * 10, timeout: 30000 });

          const info = JSON.parse(stdout.trim().split('\n')[0]);
          return {
            id: info.id || url,
            title: info.title || info.fulltitle || 'Untitled',
            thumbnail: info.thumbnail || info.thumbnails?.[0]?.url || '',
            durationS: info.duration || 0,
            url: url.trim(),
          } as ChannelVideo;
        })
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          videos.push(result.value);
        } else {
          const failedUrl = batch[j];
          errors.push(failedUrl);
          // Still add it with basic info so user can try downloading
          videos.push({
            id: `url-${i + j}`,
            title: failedUrl.split('/').pop() || failedUrl,
            thumbnail: '',
            durationS: 0,
            url: failedUrl.trim(),
          });
        }
      }

      console.log(`[urls] Probed ${Math.min(i + 5, urls.length)}/${urls.length}`);
    }

    console.log(`[urls] Done: ${videos.length - errors.length} resolved, ${errors.length} failed probe`);
    res.json({ videos, errors });
  } catch (err: any) {
    console.error('[urls] Probe error:', err.message);
    res.status(500).json({ error: 'Failed to probe URLs', details: err.message });
  }
});

// ─── Start Server ───────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🎬 YouTube Shorts Cutter API running on http://localhost:${PORT}`);
  console.log(`   Output directory: ${getOutputDir()}`);
  console.log(`\n   Features:`);
  console.log(`   ✅ Multi-signal analysis (heatmap, audio, scene, comments)`);
  console.log(`   ✅ Virality scoring & hook optimization`);
  console.log(`   ✅ Smart clip boundaries (natural start/end points)`);
  console.log(`   ✅ Auto-captions (YouTube subs + Whisper JS fallback)`);
  console.log(`   ✅ Smart speaker reframe`);
  console.log(`   ✅ Multi-format export (9:16, 1:1, 16:9)`);
  console.log(`   ✅ Batch URL processing (up to 20 URLs)`);
  console.log(`   ✅ Channel video download + ZIP\n`);
});
