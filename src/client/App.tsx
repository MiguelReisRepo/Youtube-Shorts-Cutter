import React, { useState, useCallback } from 'react';
import type {
  VideoInfo, HeatmapPoint, PeakSegment, CutProgress,
  DetectionResult, ClipSettings, ViralityBreakdown, CaptionPreset,
} from '../types/index';
import { DEFAULT_CLIP_SETTINGS } from '../types/index';
import { HeatmapChart } from './components/HeatmapChart';
import { SegmentCard } from './components/SegmentCard';
import { ProgressPanel } from './components/ProgressPanel';
import { DetectionBadge } from './components/DetectionBadge';
import { ClipSettingsPanel } from './components/ClipSettingsPanel';
import { PreviewPlayer } from './components/PreviewPlayer';
import { BatchPanel } from './components/BatchPanel';

type AppState = 'idle' | 'analyzing' | 'ready' | 'processing';
type CropType = 'center' | 'blur_pad' | 'letterbox' | 'smart_reframe';
type AppMode = 'single' | 'batch';
type VideoQuality = '1080' | '720' | '480';

const QUALITY_OPTIONS = [
  { value: '1080' as VideoQuality, label: '1080p', desc: 'Full HD · best quality', res: '1080×1920' },
  { value: '720' as VideoQuality, label: '720p', desc: 'HD · faster processing', res: '720×1280' },
  { value: '480' as VideoQuality, label: '480p', desc: 'SD · smallest files', res: '480×854' },
];

const CAPTION_OPTIONS: { value: CaptionPreset; label: string; desc: string }[] = [
  { value: 'off', label: 'Off', desc: 'No captions' },
  { value: 'tiktok', label: 'TikTok', desc: 'Bold centered, word-by-word highlight' },
  { value: 'classic', label: 'Classic', desc: 'Bottom, white on black' },
  { value: 'bold_pop', label: 'Bold Pop', desc: 'Yellow, pop-in animation' },
  { value: 'minimal', label: 'Minimal', desc: 'Clean, subtle' },
];

const App: React.FC = () => {
  const [url, setUrl] = useState('');
  const [appState, setAppState] = useState<AppState>('idle');
  const [error, setError] = useState<string | null>(null);

  const [video, setVideo] = useState<VideoInfo | null>(null);
  const [heatmap, setHeatmap] = useState<HeatmapPoint[]>([]);
  const [segments, setSegments] = useState<PeakSegment[]>([]);
  const [detection, setDetection] = useState<DetectionResult | null>(null);
  const [viralityScores, setViralityScores] = useState<ViralityBreakdown[]>([]);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [cropMode, setCropMode] = useState<CropType>('center');
  const [captionPreset, setCaptionPreset] = useState<CaptionPreset>('off');
  const [clipSettings, setClipSettings] = useState<ClipSettings>(DEFAULT_CLIP_SETTINGS);
  const [showSettings, setShowSettings] = useState(false);

  const [progress, setProgress] = useState<CutProgress | null>(null);
  const [appMode, setAppMode] = useState<AppMode>('single');
  const [exportFormats, setExportFormats] = useState<string[]>(['shorts']);
  const [previewSeg, setPreviewSeg] = useState<PeakSegment | null>(null);
  const [quality, setQuality] = useState<VideoQuality>('1080');
  const [translateTo, setTranslateTo] = useState('');
  const [translateMode, setTranslateMode] = useState('');

  // ─── Analyze Video ──────────────────────────────

  const handleAnalyze = useCallback(async () => {
    if (!url.trim()) return;
    setError(null);
    setAppState('analyzing');
    setVideo(null);
    setHeatmap([]);
    setSegments([]);
    setDetection(null);
    setViralityScores([]);

    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), settings: clipSettings }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Analysis failed');
      }
      const data = await res.json();
      setVideo(data.video);
      setHeatmap(data.heatmap);
      setSegments(data.segments);
      setDetection(data.detection);
      setViralityScores(data.viralityScores || []);
      setSelectedIds(new Set(data.segments.map((s: PeakSegment) => s.id)));
      setAppState('ready');

      if (!data.heatmap?.length && !data.segments?.length) {
        setError('Could not detect any highlights. Try lowering the intensity threshold.');
      }
    } catch (err: any) {
      setError(err.message);
      setAppState('idle');
    }
  }, [url, clipSettings]);

  const handleReAnalyze = useCallback(async () => {
    if (!url.trim() || !heatmap.length) return;
    setError(null);
    setAppState('analyzing');
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), settings: clipSettings }),
      });
      if (!res.ok) throw new Error('Re-analysis failed');
      const data = await res.json();
      setSegments(data.segments);
      setViralityScores(data.viralityScores || []);
      setSelectedIds(new Set(data.segments.map((s: PeakSegment) => s.id)));
      setAppState('ready');
    } catch (err: any) {
      setError(err.message);
      setAppState('ready');
    }
  }, [url, heatmap, clipSettings]);

  const toggleSegment = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Update a segment's start/end times (manual adjustment)
  const updateSegment = useCallback((id: string, startS: number, endS: number) => {
    setSegments(prev => prev.map(seg =>
      seg.id === id
        ? { ...seg, startS, endS, durationS: Math.round((endS - startS) * 10) / 10 }
        : seg
    ));
  }, []);

  // ─── Start Processing ─────────────────────────

  const handleCut = useCallback(async () => {
    const selected = segments.filter(s => selectedIds.has(s.id));
    if (!selected.length) return;
    setAppState('processing');
    setProgress(null);

    try {
      const res = await fetch('/api/cut', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: url.trim(),
          segments: selected,
          cropMode,
          captions: captionPreset,
          videoTitle: video?.title || 'clip',
          quality,
          translateTo,
          translateMode,
        }),
      });
      if (!res.ok) throw new Error('Failed to start processing');
      const { jobId } = await res.json();

      const es = new EventSource(`/api/jobs/${jobId}/progress`);
      es.onmessage = (event) => {
        const prog: CutProgress = JSON.parse(event.data);
        setProgress(prog);
        if (prog.status === 'done' || prog.status === 'error') es.close();
      };
      es.onerror = () => {
        es.close();
        setProgress(prev => prev || {
          status: 'error', currentClip: 0, totalClips: selected.length,
          message: 'Connection lost', error: 'Lost connection to server',
        });
      };
    } catch (err: any) {
      setProgress({
        status: 'error', currentClip: 0, totalClips: selectedIds.size,
        message: 'Failed', error: err.message,
      });
    }
  }, [segments, selectedIds, url, cropMode, captionPreset, video]);

  const handleDownload = useCallback((filename: string) => {
    window.open(`/output/${filename}`, '_blank');
  }, []);

  const handleReset = useCallback(() => {
    setAppState('idle'); setUrl(''); setVideo(null); setHeatmap([]);
    setSegments([]); setDetection(null); setViralityScores([]);
    setSelectedIds(new Set()); setProgress(null); setError(null);
  }, []);

  const selectedCount = selectedIds.size;

  return (
    <div className="min-h-screen bg-[var(--bg-primary)]">
      {/* ── Header ──────────────────────────────── */}
      <header className="border-b border-[var(--border)]">
        <div className="max-w-5xl mx-auto px-6 py-5 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path d="M2 4L9 9L16 4M2 14L9 9L16 14" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <div>
            <h1 className="font-display font-bold text-base leading-tight">Shorts Cutter</h1>
            <p className="text-[11px] text-[var(--text-secondary)] font-display tracking-wide">YouTube → Shorts / Reels</p>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8">
        {/* ── Mode Tabs ──────────────────────────── */}
        <div className="mb-6 flex gap-2">
          <button
            onClick={() => setAppMode('single')}
            className={`px-4 py-2 rounded-lg text-xs font-display font-bold transition-all ${
              appMode === 'single'
                ? 'bg-[var(--accent)] text-black'
                : 'bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[#3a3a3e]'
            }`}
          >
            Single Video
          </button>
          <button
            onClick={() => setAppMode('batch')}
            className={`px-4 py-2 rounded-lg text-xs font-display font-bold transition-all flex items-center gap-1.5 ${
              appMode === 'batch'
                ? 'bg-[var(--accent)] text-black'
                : 'bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[#3a3a3e]'
            }`}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><rect x="1" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2"/><rect x="7" y="1" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2"/><rect x="1" y="7" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2"/><rect x="7" y="7" width="4" height="4" rx="0.5" stroke="currentColor" strokeWidth="1.2"/></svg>
            Batch (up to 20)
          </button>
        </div>

        {/* ── Batch Mode ─────────────────────────── */}
        {appMode === 'batch' && (
          <BatchPanel onBack={() => setAppMode('single')} />
        )}

        {appMode === 'single' && (<>
        {/* ── URL Input ──────────────────────────── */}
        <div className="mb-6 animate-fade-in">
          <label className="block text-xs font-display uppercase tracking-widest text-[var(--text-secondary)] mb-2">YouTube Video URL</label>
          <div className="flex gap-3">
            <input
              type="url" value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAnalyze()}
              placeholder="https://www.youtube.com/watch?v=..."
              disabled={appState === 'analyzing' || appState === 'processing'}
              className="flex-1 h-12 px-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-50 font-body"
            />
            <button
              onClick={handleAnalyze}
              disabled={!url.trim() || appState === 'analyzing' || appState === 'processing'}
              className="h-12 px-6 rounded-xl bg-[var(--accent)] text-black font-display font-bold text-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
            >
              {appState === 'analyzing'
                ? <><div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />Analyzing...</>
                : <><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="7" cy="7" r="5" stroke="currentColor" strokeWidth="2"/><path d="M11 11L14 14" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>Analyze</>
              }
            </button>
          </div>

          <button onClick={() => setShowSettings(!showSettings)} className="mt-2 flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors font-display">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={`transition-transform ${showSettings ? 'rotate-90' : ''}`}>
              <path d="M4 2L8 6L4 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            {showSettings ? 'Hide settings' : 'Clip settings'}
          </button>

          {showSettings && (
            <div className="mt-3 animate-fade-in">
              <ClipSettingsPanel settings={clipSettings} onChange={setClipSettings} />
              {heatmap.length > 0 && appState === 'ready' && (
                <button onClick={handleReAnalyze} className="mt-3 w-full py-2.5 rounded-lg border border-[var(--accent)] text-sm font-display font-bold text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors flex items-center justify-center gap-2">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M1 7C1 3.68629 3.68629 1 7 1C9.21 1 11.12 2.27 12 4.12M13 7C13 10.3137 10.3137 13 7 13C4.79 13 2.88 11.73 2 9.88" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/><path d="M12 1V4.12H8.88" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/><path d="M2 13V9.88H5.12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                  Re-analyze with new settings
                </button>
              )}
            </div>
          )}

          {appState === 'analyzing' && (
            <div className="mt-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <p className="text-sm text-blue-400">⏳ Analyzing video... checking heatmap, scoring segments.</p>
            </div>
          )}
          {error && (
            <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
        </div>

        {/* ── Video Info ─────────────────────────── */}
        {video && (
          <div className="mb-6 animate-fade-in">
            <div className="flex gap-4 p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)]">
              <img src={video.thumbnail} alt={video.title} className="w-40 h-24 object-cover rounded-lg flex-shrink-0" />
              <div className="flex-1 min-w-0">
                <h2 className="font-body font-semibold text-sm leading-snug line-clamp-2 mb-1">{video.title}</h2>
                <p className="text-xs text-[var(--text-secondary)]">{video.channel}</p>
                <div className="mt-2 flex items-center gap-3 text-xs text-[var(--text-secondary)]">
                  <span className="flex items-center gap-1">
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2"/><path d="M6 3V6L8 7.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/></svg>
                    {formatDuration(video.durationS)}
                  </span>
                  <span>{video.viewCount} views</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── Detection Badge ────────────────────── */}
        {detection && <div className="mb-6 animate-fade-in"><DetectionBadge detection={detection} /></div>}

        {/* ── Preview Player ─────────────────────── */}
        {video && segments.length > 0 && appState === 'ready' && (
          <div className="mb-6 animate-fade-in sticky top-4 z-10">
            <PreviewPlayer
              videoId={video.id}
              segments={segments}
              selectedIds={selectedIds}
              videoDurationS={video.durationS}
              externalPreview={previewSeg}
              onPreviewChange={setPreviewSeg}
            />
          </div>
        )}

        {/* ── Heatmap ────────────────────────────── */}
        {heatmap.length > 0 && video && (
          <div className="mb-8 animate-fade-in">
            <HeatmapChart heatmap={heatmap} segments={segments} videoDurationS={video.durationS} selectedIds={selectedIds} />
          </div>
        )}

        {/* ── Segments + Options ─────────────────── */}
        {segments.length > 0 && appState === 'ready' && (
          <div className="animate-fade-in">
            {/* Summary bar */}
            {video && (
              <div className="mb-4 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] flex items-center justify-between flex-wrap gap-2 text-xs text-[var(--text-secondary)]">
                <div className="flex items-center gap-4">
                  <span><strong className="text-[var(--text-primary)]">{segments.length}</strong> clips</span>
                  <span><strong className="text-[var(--text-primary)]">{selectedCount}</strong> selected</span>
                  <span>Coverage: <strong className="text-[var(--text-primary)]">{formatDuration(segments.reduce((s, seg) => s + seg.durationS, 0))}</strong> / {formatDuration(video.durationS)}</span>
                </div>
                {viralityScores.length > 0 && (
                  <span className="font-display text-[10px]">
                    Avg score: <strong style={{ color: avgScoreColor(viralityScores) }}>{Math.round(viralityScores.reduce((s, v) => s + v.overall, 0) / viralityScores.length)}</strong>
                  </span>
                )}
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* Segments list */}
              <div className="lg:col-span-2">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)]">Peak Moments</h3>
                  <button onClick={() => {
                    if (selectedIds.size === segments.length) setSelectedIds(new Set());
                    else setSelectedIds(new Set(segments.map(s => s.id)));
                  }} className="text-xs text-[var(--accent)] hover:underline font-display">
                    {selectedIds.size === segments.length ? 'Deselect all' : 'Select all'}
                  </button>
                </div>

                <div className="space-y-2">
                  {segments.map((seg, i) => {
                    const prevEnd = i > 0 ? segments[i - 1].endS : 0;
                    const gapS = seg.startS - prevEnd;
                    return (
                      <React.Fragment key={seg.id}>
                        {i > 0 && (
                          <div className="flex items-center gap-2 px-4 py-0.5">
                            <div className="flex-1 h-px bg-[var(--border)]" />
                            <span className="text-[10px] font-display text-[var(--text-secondary)]">
                              {gapS >= 60 ? `${Math.floor(gapS / 60)}m ${Math.floor(gapS % 60)}s gap` : `${Math.floor(gapS)}s gap`}
                            </span>
                            <div className="flex-1 h-px bg-[var(--border)]" />
                          </div>
                        )}
                        <SegmentCard
                          segment={seg}
                          index={i}
                          isSelected={selectedIds.has(seg.id)}
                          onToggle={toggleSegment}
                          onUpdate={updateSegment}
                          onPreview={(s) => setPreviewSeg(s)}
                          viralityScore={viralityScores[i]}
                          videoDurationS={video?.durationS || 0}
                          isPreviewActive={previewSeg?.id === seg.id}
                        />
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* Options sidebar */}
              <div className="space-y-4">
                {/* Crop mode */}
                <div>
                  <h3 className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)] mb-3">Crop Mode</h3>
                  <div className="space-y-2">
                    <CropModeButton active={cropMode === 'center'} onClick={() => setCropMode('center')} label="Center Crop" description="Fill 9:16 frame, edges cropped"
                      icon={<svg width="20" height="28" viewBox="0 0 20 28" fill="none" className="opacity-60"><rect x="1" y="1" width="18" height="26" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="3" y="6" width="14" height="16" rx="1" stroke="currentColor" strokeWidth="1" strokeDasharray="2 2"/></svg>}
                    />
                    <CropModeButton active={cropMode === 'blur_pad'} onClick={() => setCropMode('blur_pad')} label="Blur Pad" description="Full frame with blurred background"
                      icon={<svg width="20" height="28" viewBox="0 0 20 28" fill="none" className="opacity-60"><rect x="1" y="1" width="18" height="26" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="2" y="8" width="16" height="12" rx="1" fill="currentColor" opacity="0.15"/><rect x="3" y="9" width="14" height="10" rx="1" stroke="currentColor" strokeWidth="1"/></svg>}
                    />
                    <CropModeButton active={cropMode === 'letterbox'} onClick={() => setCropMode('letterbox')} label="Letterbox" description="Full frame with clean black bars"
                      icon={<svg width="20" height="28" viewBox="0 0 20 28" fill="none" className="opacity-60"><rect x="1" y="1" width="18" height="26" rx="2" stroke="currentColor" strokeWidth="1.5"/><rect x="1" y="8" width="18" height="12" stroke="currentColor" strokeWidth="1"/><rect x="1" y="1" width="18" height="7" fill="currentColor" opacity="0.25"/><rect x="1" y="20" width="18" height="7" fill="currentColor" opacity="0.25"/></svg>}
                    />
                    <CropModeButton active={cropMode === 'smart_reframe'} onClick={() => setCropMode('smart_reframe')} label="Smart Reframe" description="AI tracks subject, dynamic panning"
                      icon={<svg width="20" height="28" viewBox="0 0 20 28" fill="none" className="opacity-60"><rect x="1" y="1" width="18" height="26" rx="2" stroke="currentColor" strokeWidth="1.5"/><circle cx="10" cy="11" r="3" stroke="currentColor" strokeWidth="1.2"/><path d="M5 19C5 16.2386 7.23858 14 10 14C12.7614 14 15 16.2386 15 19" stroke="currentColor" strokeWidth="1.2"/></svg>}
                    />
                  </div>
                </div>

                {/* Captions */}
                <div>
                  <h3 className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)] mb-3">Captions</h3>
                  <div className="space-y-1.5">
                    {CAPTION_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setCaptionPreset(opt.value)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border transition-all text-left ${
                          captionPreset === opt.value
                            ? 'bg-[var(--accent-dim)] border-[var(--accent)]'
                            : 'bg-[var(--bg-secondary)] border-[var(--border)] hover:border-[#3a3a3e]'
                        }`}
                      >
                        <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${captionPreset === opt.value ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[#3a3a3e]'}`} />
                        <div>
                          <p className={`text-xs font-medium ${captionPreset === opt.value ? 'text-[var(--accent)]' : ''}`}>{opt.label}</p>
                          <p className="text-[9px] text-[var(--text-secondary)]">{opt.desc}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Translation */}
                <div>
                  <h3 className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)] mb-3">Translation</h3>
                  <div className="space-y-2">
                    <select
                      value={translateTo}
                      onChange={e => {
                        setTranslateTo(e.target.value);
                        if (e.target.value && !translateMode) setTranslateMode('captions');
                        if (!e.target.value) setTranslateMode('');
                      }}
                      className="w-full h-9 px-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] text-xs text-[var(--text-primary)] font-display"
                    >
                      <option value="">No translation</option>
                      <option value="pt-BR">🇧🇷 Portuguese (BR)</option>
                      <option value="es">🇪🇸 Spanish</option>
                    </select>

                    {translateTo && (
                      <div className="space-y-1.5 animate-fade-in">
                        {[
                          { value: 'captions', label: 'Translated captions', desc: 'Subtitles in target language' },
                          { value: 'dub', label: 'AI dubbing', desc: 'TTS voiceover, original audio lowered' },
                          { value: 'both', label: 'Dub + captions', desc: 'Full localization package' },
                        ].map(opt => (
                          <button
                            key={opt.value}
                            onClick={() => setTranslateMode(opt.value)}
                            className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border transition-all text-left ${
                              translateMode === opt.value
                                ? 'bg-blue-500/10 border-blue-500/50'
                                : 'bg-[var(--bg-secondary)] border-[var(--border)] hover:border-[#3a3a3e]'
                            }`}
                          >
                            <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${translateMode === opt.value ? 'bg-blue-400 border-blue-400' : 'border-[#3a3a3e]'}`} />
                            <div>
                              <p className={`text-xs font-medium ${translateMode === opt.value ? 'text-blue-400' : ''}`}>{opt.label}</p>
                              <p className="text-[9px] text-[var(--text-secondary)]">{opt.desc}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Quality */}
                <div>
                  <h3 className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)] mb-3">Quality</h3>
                  <div className="space-y-1.5">
                    {QUALITY_OPTIONS.map(opt => (
                      <button
                        key={opt.value}
                        onClick={() => setQuality(opt.value)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg border transition-all text-left ${
                          quality === opt.value
                            ? 'bg-[var(--accent-dim)] border-[var(--accent)]'
                            : 'bg-[var(--bg-secondary)] border-[var(--border)] hover:border-[#3a3a3e]'
                        }`}
                      >
                        <div className={`w-3 h-3 rounded-full border-2 flex-shrink-0 ${quality === opt.value ? 'bg-[var(--accent)] border-[var(--accent)]' : 'border-[#3a3a3e]'}`} />
                        <div>
                          <p className={`text-xs font-medium ${quality === opt.value ? 'text-[var(--accent)]' : ''}`}>{opt.label}</p>
                          <p className="text-[9px] text-[var(--text-secondary)]">{opt.desc}</p>
                        </div>
                        <span className="ml-auto text-[10px] font-display text-[var(--text-secondary)]">{opt.res}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Output specs */}
                <div className="p-3 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)]">
                  <h4 className="text-[10px] font-display uppercase tracking-widest text-[var(--text-secondary)] mb-2">Output</h4>
                  <div className="space-y-1 text-xs text-[var(--text-secondary)]">
                    <div className="flex justify-between"><span>Resolution</span><span className="text-[var(--text-primary)] font-display">{QUALITY_OPTIONS.find(q => q.value === quality)?.res}</span></div>
                    <div className="flex justify-between"><span>Codec</span><span className="text-[var(--text-primary)] font-display">H.264 High</span></div>
                    <div className="flex justify-between"><span>Audio</span><span className="text-[var(--text-primary)] font-display">AAC 192k</span></div>
                    <div className="flex justify-between"><span>Captions</span><span className="text-[var(--text-primary)] font-display">{captionPreset === 'off' ? 'None' : captionPreset}</span></div>
                    <div className="flex justify-between"><span>Crop</span><span className="text-[var(--text-primary)] font-display">{cropMode === 'smart_reframe' ? 'AI Reframe' : cropMode === 'blur_pad' ? 'Blur Pad' : cropMode === 'letterbox' ? 'Letterbox' : 'Center'}</span></div>
                    {translateTo && (
                      <div className="flex justify-between"><span>Translation</span><span className="text-[var(--text-primary)] font-display">{translateTo === 'pt-BR' ? '🇧🇷 PT-BR' : '🇪🇸 ES'} ({translateMode})</span></div>
                    )}
                  </div>
                </div>

                {/* Cut button */}
                <button onClick={handleCut} disabled={selectedCount === 0}
                  className="w-full h-12 rounded-xl bg-gradient-to-r from-orange-500 to-red-600 text-white font-display font-bold text-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
                >
                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 2L4 14M12 2L12 14M2 6H14M2 10H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  Cut {selectedCount} clip{selectedCount !== 1 ? 's' : ''}
                  {captionPreset !== 'off' && ' + captions'}
                  {translateTo && ` + ${translateMode === 'dub' ? 'dubbing' : translateMode === 'both' ? 'dub+translate' : 'translate'}`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ── Processing Progress ────────────────── */}
        {appState === 'processing' && progress && (
          <div className="mt-8">
            <ProgressPanel progress={progress} onDownload={handleDownload} onReset={handleReset} />
          </div>
        )}

        </>)}
      </main>

      {/* ── Footer ──────────────────────────────── */}
      <footer className="border-t border-[var(--border)] mt-16">
        <div className="max-w-5xl mx-auto px-6 py-4 text-[11px] text-[var(--text-secondary)]">
          <div className="flex items-center justify-between flex-wrap gap-2 font-display">
            <span>yt-dlp + ffmpeg · local processing · no upload</span>
            <div className="flex items-center gap-3">
              <span>📊 Heatmap</span><span>🔊 Audio</span><span>🎬 Scene</span><span>💬 Comments</span><span>🧠 Virality</span><span>🪝 Hook AI</span><span>📦 Batch</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
};

// ─── Sub-components ───────────────────────────────

interface CropModeButtonProps {
  active: boolean; onClick: () => void;
  label: string; description: string; icon: React.ReactNode;
}

const CropModeButton: React.FC<CropModeButtonProps> = ({ active, onClick, label, description, icon }) => (
  <button onClick={onClick} className={`w-full flex items-center gap-3 p-3 rounded-xl border transition-all text-left ${active ? 'bg-[var(--accent-dim)] border-[var(--accent)]' : 'bg-[var(--bg-secondary)] border-[var(--border)] hover:border-[#3a3a3e]'}`}>
    <div className={active ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}>{icon}</div>
    <div>
      <p className={`text-sm font-medium ${active ? 'text-[var(--accent)]' : ''}`}>{label}</p>
      <p className="text-[10px] text-[var(--text-secondary)]">{description}</p>
    </div>
  </button>
);

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

function avgScoreColor(scores: ViralityBreakdown[]): string {
  const avg = scores.reduce((s, v) => s + v.overall, 0) / scores.length;
  if (avg >= 80) return '#ef4444';
  if (avg >= 60) return '#22c55e';
  if (avg >= 40) return '#f59e0b';
  return '#6b7280';
}

export default App;
