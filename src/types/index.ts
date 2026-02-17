// ─── Shared Types ───────────────────────────────────

export interface HeatmapPoint {
  startMs: number;
  endMs: number;
  intensity: number;
}

export interface PeakSegment {
  id: string;
  startS: number;
  endS: number;
  durationS: number;
  avgIntensity: number;
  peakIntensity: number;
}

export interface VideoInfo {
  id: string;
  title: string;
  durationS: number;
  thumbnail: string;
  channel: string;
  viewCount: string;
}

export interface CropMode {
  type: 'center' | 'blur_pad' | 'smart_reframe';
  label: string;
  description: string;
}

// ─── Detection Methods ──────────────────────────────

export type DetectionMethod = 'heatmap' | 'audio' | 'scene' | 'comments' | 'combined';

export interface DetectionResult {
  methodsUsed: DetectionMethod[];
  primary: DetectionMethod;
  hasYouTubeHeatmap: boolean;
  commentTimestamps?: {
    timeS: number;
    count: number;
    text: string;
  }[];
}

// ─── Virality Score ─────────────────────────────────

export interface ViralityBreakdown {
  overall: number;
  peakIntensity: number;
  hookStrength: number;
  pacing: number;
  audioEnergy: number;
  positionBonus: number;
  durationFit: number;
  label: string;
  color: string;
}

// ─── Caption Options ────────────────────────────────

export type CaptionPreset = 'off' | 'classic' | 'tiktok' | 'minimal' | 'bold_pop';

// ─── Clip Settings ──────────────────────────────────

export interface ClipSettings {
  topN: number;
  minDurationS: number;
  maxDurationS: number;
  minGapS: number;
  intensityThreshold: number;
}

export const DEFAULT_CLIP_SETTINGS: ClipSettings = {
  topN: 5,
  minDurationS: 15,
  maxDurationS: 60,
  minGapS: 30,
  intensityThreshold: 0.6,
};

// ─── API Request / Response ─────────────────────────

export interface AnalyzeRequest {
  url: string;
  settings?: Partial<ClipSettings>;
}

export interface AnalyzeResponse {
  video: VideoInfo;
  heatmap: HeatmapPoint[];
  segments: PeakSegment[];
  detection: DetectionResult;
  viralityScores: ViralityBreakdown[];
}

export interface CutRequest {
  url: string;
  segments: PeakSegment[];
  cropMode: 'center' | 'blur_pad' | 'smart_reframe';
  captions: CaptionPreset;
  videoTitle: string;
}

export interface CutProgress {
  status: 'downloading' | 'analyzing' | 'processing' | 'captioning' | 'done' | 'error';
  currentClip: number;
  totalClips: number;
  message: string;
  files?: string[];
  error?: string;
}

export type JobStatus = {
  id: string;
  progress: CutProgress;
};
