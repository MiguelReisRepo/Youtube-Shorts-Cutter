import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { getVideoData, findPeakSegments } from './youtube.js';
import { analyzeAudioEnergy } from './audioAnalysis.js';
import { detectSceneChanges } from './sceneDetection.js';
import { scrapeCommentTimestamps } from './commentScraper.js';
import { combineSignals, smoothHeatmap, type SignalSource } from './signalCombiner.js';
import { processJob, downloadVideo, getOutputDir } from './processor.js';
import { scoreSegments } from './viralityScorer.js';
import { detectBoundaries, optimizeSegments, applyOptimizations } from './clipOptimizer.js';
import { EXPORT_FORMATS } from './multiFormat.js';
import type {
  CutProgress,
  PeakSegment,
  DetectionResult,
  DetectionMethod,
  HeatmapPoint,
} from '../types/index.js';
import { v4 as uuid } from 'uuid';

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
      // ❌ No heatmap — run fallback analysis pipeline
      console.log('[api] ❌ No YouTube heatmap — running fallback analysis...');
      console.log('[api] This requires downloading the video first.\n');

      // Download video to temp directory for analysis
      const tmpDir = path.join(os.tmpdir(), `yt-analysis-${uuid()}`);
      fs.mkdirSync(tmpDir, { recursive: true });

      let videoPath: string;
      try {
        videoPath = await downloadVideo(url, (msg) => {
          console.log(`[download] ${msg}`);
        }, tmpDir);
      } catch (err: any) {
        console.error(`[api] Download failed: ${err.message}`);
        return res.status(500).json({
          error: 'Failed to download video for analysis',
          details: err.message,
        });
      }

      // Run all fallback analyses in parallel
      const [audioResult, sceneResult, commentResult] = await Promise.allSettled([
        analyzeAudioEnergy(videoPath, 2, video.durationS),
        detectSceneChanges(videoPath, video.durationS),
        scrapeCommentTimestamps(url, video.durationS),
      ]);

      const audioHeatmap =
        audioResult.status === 'fulfilled' ? audioResult.value : [];
      const sceneHeatmap =
        sceneResult.status === 'fulfilled' ? sceneResult.value : [];
      const commentData =
        commentResult.status === 'fulfilled'
          ? commentResult.value
          : { heatmap: [], timestamps: [] };

      // Store comment timestamps for the response
      commentTimestamps = commentData.timestamps;

      // Build signal sources with weights
      const signals: SignalSource[] = [];

      if (audioHeatmap.length > 0) {
        signals.push({
          method: 'audio',
          label: 'Audio Energy',
          weight: 1.0, // Strong signal
          points: audioHeatmap,
        });
      }

      if (sceneHeatmap.length > 0) {
        signals.push({
          method: 'scene',
          label: 'Scene Changes',
          weight: 0.6, // Supporting signal
          points: sceneHeatmap,
        });
      }

      if (commentData.heatmap.length > 0) {
        signals.push({
          method: 'comments',
          label: 'Comment Timestamps',
          weight: 1.2, // Very strong signal (human-sourced)
          points: commentData.heatmap,
        });
      }

      // Combine signals
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
        primary = 'audio'; // Fallback label
      }

      // Cleanup temp video
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
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
 * POST /api/cut
 * Start a video cutting job, returns a job ID for progress tracking
 */
app.post('/api/cut', async (req, res) => {
  try {
    const { url, segments, cropMode, videoTitle, captions, quality, translateTo, translateMode } = req.body as {
      url: string;
      segments: PeakSegment[];
      cropMode: 'center' | 'blur_pad' | 'letterbox' | 'smart_reframe';
      videoTitle: string;
      captions?: string;
      quality?: string;
      translateTo?: string;
      translateMode?: string;
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
    }, quality || '1080', translateTo || '', translateMode || '');
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
  console.log(`   ✅ Batch URL processing (up to 20 URLs)\n`);
});
