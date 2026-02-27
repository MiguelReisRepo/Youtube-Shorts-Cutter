import React, { useState, useCallback, useRef, useEffect } from 'react';
import type { ChannelVideo, ChannelDownloadProgress } from '../../types/index';

interface Props {
  onBack: () => void;
}

type PanelState = 'input' | 'listing' | 'ready' | 'downloading' | 'done';
type Quality = 'best' | '1080' | '720' | '480';
type InputMode = 'channel' | 'urls';

export const ChannelDownloadPanel: React.FC<Props> = ({ onBack }) => {
  const [inputMode, setInputMode] = useState<InputMode>('channel');
  const [channelUrl, setChannelUrl] = useState('');
  const [urlList, setUrlList] = useState('');
  const [panelState, setPanelState] = useState<PanelState>('input');
  const [videos, setVideos] = useState<ChannelVideo[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [quality, setQuality] = useState<Quality>('1080');
  const [zip, setZip] = useState(true);
  const [progress, setProgress] = useState<ChannelDownloadProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  const handleFetchVideos = useCallback(async () => {
    if (!channelUrl.trim()) return;
    setError(null);
    setPanelState('listing');
    setVideos([]);

    try {
      const res = await fetch('/api/channel/videos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelUrl: channelUrl.trim() }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to list videos');
      }

      const data = await res.json();
      setVideos(data.videos);
      setSelectedIds(new Set(data.videos.map((v: ChannelVideo) => v.id)));
      setPanelState('ready');
    } catch (err: any) {
      setError(err.message);
      setPanelState('input');
    }
  }, [channelUrl]);

  const handleProbeUrls = useCallback(async () => {
    const lines = urlList.trim().split('\n').map(l => l.trim()).filter(l => l && l.startsWith('http'));
    if (!lines.length) return;
    setError(null);
    setPanelState('listing');
    setVideos([]);

    try {
      const res = await fetch('/api/urls/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: lines }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || 'Failed to probe URLs');
      }

      const data = await res.json();
      setVideos(data.videos);
      setSelectedIds(new Set(data.videos.map((v: ChannelVideo) => v.id)));
      setPanelState('ready');
    } catch (err: any) {
      setError(err.message);
      setPanelState('input');
    }
  }, [urlList]);

  const handleDownload = useCallback(async () => {
    const selected = videos.filter(v => selectedIds.has(v.id));
    if (!selected.length) return;

    setPanelState('downloading');
    setProgress(null);

    try {
      const res = await fetch('/api/channel/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videos: selected, zip, quality }),
      });

      if (!res.ok) throw new Error('Failed to start download');
      const { jobId } = await res.json();

      const es = new EventSource(`/api/channel/${jobId}/progress`);
      esRef.current = es;

      es.onmessage = (event) => {
        const prog: ChannelDownloadProgress = JSON.parse(event.data);
        setProgress(prog);
        if (prog.status === 'done' || prog.status === 'error') {
          es.close();
          setPanelState('done');
        }
      };

      es.onerror = () => {
        es.close();
        setProgress(prev => prev || {
          status: 'error', currentVideo: 0, totalVideos: selected.length,
          message: 'Connection lost', error: 'Lost connection to server',
        });
        setPanelState('done');
      };
    } catch (err: any) {
      setProgress({
        status: 'error', currentVideo: 0, totalVideos: selectedIds.size,
        message: 'Failed', error: err.message,
      });
      setPanelState('done');
    }
  }, [videos, selectedIds, zip, quality]);

  const toggleVideo = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    if (selectedIds.size === videos.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(videos.map(v => v.id)));
    }
  }, [selectedIds, videos]);

  const handleReset = useCallback(() => {
    setPanelState('input');
    setChannelUrl('');
    setUrlList('');
    setVideos([]);
    setSelectedIds(new Set());
    setProgress(null);
    setError(null);
  }, []);

  const totalDurationS = videos.filter(v => selectedIds.has(v.id)).reduce((s, v) => s + v.durationS, 0);

  return (
    <div className="animate-fade-in">
      <button onClick={onBack} className="mb-4 flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors font-display">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        Back to single mode
      </button>

      <h2 className="font-display font-bold text-lg mb-1">Channel / URL Download</h2>
      <p className="text-sm text-[var(--text-secondary)] mb-4">
        Download videos from a YouTube channel or paste direct URLs (YouTube, Vimeo, etc.).
      </p>

      {/* ── Input State ─────────────────────────── */}
      {(panelState === 'input' || panelState === 'listing') && (
        <div className="mb-6">
          {/* Mode toggle */}
          <div className="flex gap-1 mb-3 p-0.5 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] w-fit">
            <button
              onClick={() => setInputMode('channel')}
              className={`px-3 py-1.5 rounded-md text-xs font-display font-bold transition-all ${
                inputMode === 'channel'
                  ? 'bg-[var(--accent)] text-black'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Channel
            </button>
            <button
              onClick={() => setInputMode('urls')}
              className={`px-3 py-1.5 rounded-md text-xs font-display font-bold transition-all ${
                inputMode === 'urls'
                  ? 'bg-[var(--accent)] text-black'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              Paste URLs
            </button>
          </div>

          {inputMode === 'channel' ? (
            <>
              <label className="block text-xs font-display uppercase tracking-widest text-[var(--text-secondary)] mb-2">Channel URL</label>
              <div className="flex gap-3">
                <input
                  type="url"
                  value={channelUrl}
                  onChange={e => setChannelUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleFetchVideos()}
                  placeholder="https://www.youtube.com/@ChannelName"
                  disabled={panelState === 'listing'}
                  className="flex-1 h-12 px-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-50 font-body"
                />
                <button
                  onClick={handleFetchVideos}
                  disabled={!channelUrl.trim() || panelState === 'listing'}
                  className="h-12 px-6 rounded-xl bg-[var(--accent)] text-black font-display font-bold text-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
                >
                  {panelState === 'listing'
                    ? <><div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />Loading...</>
                    : <><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4H14M2 8H14M2 12H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>Fetch Videos</>
                  }
                </button>
              </div>
            </>
          ) : (
            <>
              <label className="block text-xs font-display uppercase tracking-widest text-[var(--text-secondary)] mb-2">
                Video URLs <span className="normal-case tracking-normal text-[var(--text-secondary)]">(one per line — YouTube, Vimeo, etc.)</span>
              </label>
              <textarea
                value={urlList}
                onChange={e => setUrlList(e.target.value)}
                placeholder={"https://vimeo.com/1043542213\nhttps://www.youtube.com/watch?v=dQw4w9WgXcQ\nhttps://vimeo.com/1043542371"}
                disabled={panelState === 'listing'}
                rows={6}
                className="w-full px-4 py-3 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)] transition-colors disabled:opacity-50 font-mono resize-y"
              />
              <div className="flex items-center justify-between mt-2">
                <span className="text-[10px] text-[var(--text-secondary)]">
                  {urlList.trim().split('\n').filter(l => l.trim() && l.trim().startsWith('http')).length} URLs detected
                </span>
                <button
                  onClick={handleProbeUrls}
                  disabled={!urlList.trim() || panelState === 'listing'}
                  className="h-10 px-5 rounded-xl bg-[var(--accent)] text-black font-display font-bold text-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
                >
                  {panelState === 'listing'
                    ? <><div className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />Probing...</>
                    : <><svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4H14M2 8H14M2 12H14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>Load Videos</>
                  }
                </button>
              </div>
            </>
          )}

          {panelState === 'listing' && (
            <div className="mt-3 p-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
              <p className="text-sm text-blue-400">
                {inputMode === 'channel'
                  ? 'Loading channel videos... this may take a moment for large channels.'
                  : 'Probing URLs to get video info... this may take a moment.'}
              </p>
            </div>
          )}

          {error && (
            <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <p className="text-sm text-red-400">{error}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Ready State: Video List ──────────────── */}
      {panelState === 'ready' && videos.length > 0 && (
        <>
          {/* Summary + Controls */}
          <div className="mb-4 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] flex items-center justify-between flex-wrap gap-3">
            <div className="flex items-center gap-4 text-xs text-[var(--text-secondary)]">
              <span><strong className="text-[var(--text-primary)]">{videos.length}</strong> videos found</span>
              <span><strong className="text-[var(--text-primary)]">{selectedIds.size}</strong> selected</span>
              <span>Duration: <strong className="text-[var(--text-primary)]">{formatDuration(totalDurationS)}</strong></span>
            </div>
            <button onClick={toggleAll} className="text-xs text-[var(--accent)] hover:underline font-display">
              {selectedIds.size === videos.length ? 'Deselect all' : 'Select all'}
            </button>
          </div>

          {/* Settings */}
          <div className="mb-4 p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] space-y-3">
            <h4 className="text-[10px] font-display uppercase tracking-widest text-[var(--text-secondary)]">Download Settings</h4>
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-xs">
                <span className="text-[var(--text-secondary)]">Quality</span>
                <select
                  value={quality}
                  onChange={e => setQuality(e.target.value as Quality)}
                  className="h-7 px-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-xs text-[var(--text-primary)]"
                >
                  <option value="best">Best available</option>
                  <option value="1080">1080p</option>
                  <option value="720">720p</option>
                  <option value="480">480p</option>
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs cursor-pointer">
                <input
                  type="checkbox"
                  checked={zip}
                  onChange={e => setZip(e.target.checked)}
                  className="w-3.5 h-3.5 rounded accent-[var(--accent)]"
                />
                <span className="text-[var(--text-secondary)]">Download as ZIP</span>
              </label>
            </div>
          </div>

          {/* Video list */}
          <div className="space-y-1.5 max-h-[500px] overflow-y-auto pr-1">
            {videos.map((v, i) => (
              <div
                key={v.id}
                onClick={() => toggleVideo(v.id)}
                className={`flex items-center gap-3 p-2.5 rounded-xl border cursor-pointer transition-all ${
                  selectedIds.has(v.id)
                    ? 'bg-[var(--accent-dim)] border-[var(--accent)]/30'
                    : 'bg-[var(--bg-secondary)] border-[var(--border)] hover:border-[#3a3a3e]'
                }`}
              >
                <div className={`w-4 h-4 rounded border-2 flex-shrink-0 flex items-center justify-center transition-all ${
                  selectedIds.has(v.id)
                    ? 'bg-[var(--accent)] border-[var(--accent)]'
                    : 'border-[#3a3a3e]'
                }`}>
                  {selectedIds.has(v.id) && (
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                      <path d="M2 5L4 7L8 3" stroke="black" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                  )}
                </div>

                <img
                  src={v.thumbnail}
                  alt=""
                  className="w-16 h-9 object-cover rounded flex-shrink-0"
                  onError={e => { (e.target as HTMLImageElement).style.display = 'none'; }}
                />

                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{v.title}</p>
                  <p className="text-[10px] text-[var(--text-secondary)]">
                    {v.durationS > 0 ? formatDuration(v.durationS) : 'Live/Unknown'}
                  </p>
                </div>

                <span className="text-[10px] text-[var(--text-secondary)] flex-shrink-0 font-display">
                  #{i + 1}
                </span>
              </div>
            ))}
          </div>

          {/* Download button */}
          <button
            onClick={handleDownload}
            disabled={selectedIds.size === 0}
            className="mt-4 w-full h-12 rounded-xl bg-gradient-to-r from-orange-500 to-red-600 text-white font-display font-bold text-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 2V10M8 10L5 7M8 10L11 7M3 13H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            Download {selectedIds.size} video{selectedIds.size !== 1 ? 's' : ''}
            {zip ? ' as ZIP' : ''}
          </button>
        </>
      )}

      {/* ── Downloading State ────────────────────── */}
      {panelState === 'downloading' && progress && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-6">
          <div className="flex items-center gap-3 mb-4">
            {progress.status === 'downloading' && <Spinner />}
            {progress.status === 'zipping' && <Spinner />}
            <div>
              <h3 className="font-display font-bold text-sm">
                {progress.status === 'downloading' && `Downloading ${progress.currentVideo}/${progress.totalVideos}...`}
                {progress.status === 'zipping' && 'Creating ZIP file...'}
              </h3>
              <p className="text-xs text-[var(--text-secondary)]">{progress.message}</p>
            </div>
          </div>

          <div className="w-full h-2 bg-[var(--bg-primary)] rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-700 ease-out"
              style={{
                width: `${Math.max(((progress.currentVideo) / progress.totalVideos) * 100, 3)}%`,
                background: progress.status === 'zipping'
                  ? 'linear-gradient(90deg, #3b82f6, #1d4ed8)'
                  : 'linear-gradient(90deg, #f97316, #ea580c)',
              }}
            />
          </div>

          {progress.files && progress.files.length > 0 && (
            <p className="mt-2 text-[10px] text-[var(--text-secondary)]">
              {progress.files.length} video{progress.files.length !== 1 ? 's' : ''} downloaded so far
            </p>
          )}
        </div>
      )}

      {/* ── Done State ───────────────────────────── */}
      {panelState === 'done' && progress && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-6">
          <div className="flex items-center gap-3 mb-4">
            {progress.status === 'done' && (
              <div className="w-8 h-8 rounded-full bg-green-500/20 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M4 9L7.5 12.5L14 5.5" stroke="#22c55e" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
            )}
            {progress.status === 'error' && (
              <div className="w-8 h-8 rounded-full bg-red-500/20 flex items-center justify-center">
                <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                  <path d="M5 5L13 13M13 5L5 13" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round"/>
                </svg>
              </div>
            )}
            <div>
              <h3 className="font-display font-bold text-sm">
                {progress.status === 'done' ? 'Downloads Complete!' : 'Something went wrong'}
              </h3>
              <p className="text-xs text-[var(--text-secondary)]">{progress.message}</p>
            </div>
          </div>

          {progress.error && (
            <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <code className="text-xs text-red-400 break-all">{progress.error}</code>
            </div>
          )}

          {/* ZIP download */}
          {progress.zipFile && (
            <a
              href={`/output/${progress.zipFile}`}
              target="_blank"
              className="mt-4 w-full flex items-center gap-3 p-4 rounded-lg bg-green-500/10 border border-green-500/30 hover:border-green-500/50 transition-colors"
            >
              <div className="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center flex-shrink-0">
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                  <path d="M10 3V13M10 13L6 9M10 13L14 9M4 17H16" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <p className="text-sm font-display font-bold text-green-400">Download ZIP</p>
                <p className="text-[10px] text-[var(--text-secondary)]">
                  {progress.files?.length || 0} videos · {progress.zipFile}
                </p>
              </div>
            </a>
          )}

          {/* Individual files */}
          {progress.files && progress.files.length > 0 && (
            <div className="mt-4">
              <h4 className="text-[10px] font-display uppercase tracking-widest text-[var(--text-secondary)] mb-2">
                Individual Files ({progress.files.length})
              </h4>
              <div className="space-y-1 max-h-[300px] overflow-y-auto">
                {progress.files.map((file, i) => (
                  <a
                    key={i}
                    href={`/output/${encodeURIComponent(file)}`}
                    target="_blank"
                    className="flex items-center gap-2 p-2 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors group"
                  >
                    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-[var(--text-secondary)] group-hover:text-[var(--accent)] flex-shrink-0">
                      <path d="M7 2V9M7 9L4 6M7 9L10 6M2 12H12" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
                    </svg>
                    <span className="text-xs truncate group-hover:text-[var(--accent)] transition-colors">{file}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="mt-4 flex gap-2">
            <button
              onClick={() => { setPanelState('ready'); setProgress(null); }}
              className="flex-1 py-2.5 rounded-lg border border-[var(--accent)] text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors"
            >
              Back to list
            </button>
            <button
              onClick={handleReset}
              className="flex-1 py-2.5 rounded-lg border border-[var(--border)] text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[#3a3a3e] transition-colors"
            >
              New channel
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

const Spinner: React.FC = () => (
  <div className="w-8 h-8 flex items-center justify-center">
    <div
      className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full"
      style={{ animation: 'spin 0.8s linear infinite' }}
    />
  </div>
);

function formatDuration(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
