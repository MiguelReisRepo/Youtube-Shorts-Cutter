import React, { useState, useCallback, useRef, useEffect } from 'react';

interface BatchResult {
  url: string;
  status: 'pending' | 'analyzing' | 'cutting' | 'done' | 'error';
  video?: { title: string; thumbnail: string };
  files?: string[];
  error?: string;
}

interface Props {
  onBack: () => void;
}

type CropType = 'center' | 'blur_pad' | 'letterbox' | 'smart_reframe';
type CaptionPreset = 'off' | 'classic' | 'tiktok' | 'minimal' | 'bold_pop';

export const BatchPanel: React.FC<Props> = ({ onBack }) => {
  const [urlsText, setUrlsText] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const [results, setResults] = useState<BatchResult[]>([]);
  const [batchStatus, setBatchStatus] = useState<string>('');
  const [cropMode, setCropMode] = useState<CropType>('center');
  const [captionPreset, setCaptionPreset] = useState<CaptionPreset>('tiktok');
  const [topN, setTopN] = useState(3);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => { esRef.current?.close(); };
  }, []);

  const handleStart = useCallback(async () => {
    const urls = urlsText
      .split('\n')
      .map(u => u.trim())
      .filter(u => u.length > 0 && u.includes('youtube'));

    if (!urls.length) return;
    setIsRunning(true);
    setResults(urls.map(url => ({ url, status: 'pending' })));
    setBatchStatus('Starting...');

    try {
      const res = await fetch('/api/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          urls,
          settings: { topN },
          cropMode,
          captions: captionPreset,
        }),
      });

      if (!res.ok) throw new Error('Failed to start batch');
      const { batchId, totalUrls } = await res.json();
      setBatchStatus(`Processing ${totalUrls} videos...`);

      // Listen for progress
      const es = new EventSource(`/api/batch/${batchId}/progress`);
      esRef.current = es;

      es.onmessage = (event) => {
        const data = JSON.parse(event.data);
        setResults(data.results);

        const done = data.results.filter((r: BatchResult) => r.status === 'done').length;
        const errors = data.results.filter((r: BatchResult) => r.status === 'error').length;
        const total = data.results.length;

        if (data.status === 'done') {
          setBatchStatus(`✅ Complete: ${done} succeeded, ${errors} failed out of ${total}`);
          setIsRunning(false);
          es.close();
        } else {
          const processing = data.results.findIndex((r: BatchResult) =>
            r.status === 'analyzing' || r.status === 'cutting'
          );
          setBatchStatus(`Processing ${processing + 1}/${total}... (${done} done)`);
        }
      };

      es.onerror = () => {
        setBatchStatus('Connection lost');
        setIsRunning(false);
        es.close();
      };
    } catch (err: any) {
      setBatchStatus(`Error: ${err.message}`);
      setIsRunning(false);
    }
  }, [urlsText]);

  const doneCount = results.filter(r => r.status === 'done').length;
  const totalFiles = results.reduce((s, r) => s + (r.files?.length || 0), 0);

  return (
    <div className="animate-fade-in">
      <button onClick={onBack} className="mb-4 flex items-center gap-1.5 text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] transition-colors font-display">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6L8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
        Back to single mode
      </button>

      <h2 className="font-display font-bold text-lg mb-1">Batch Processing</h2>
      <p className="text-sm text-[var(--text-secondary)] mb-4">Paste up to 20 YouTube URLs (one per line). Each will be analyzed and the top 3 clips extracted automatically.</p>

      {!isRunning && results.length === 0 && (
        <>
          <textarea
            value={urlsText}
            onChange={e => setUrlsText(e.target.value)}
            placeholder={`https://www.youtube.com/watch?v=...\nhttps://www.youtube.com/watch?v=...\nhttps://www.youtube.com/watch?v=...`}
            rows={8}
            className="w-full p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] text-sm text-[var(--text-primary)] placeholder:text-[var(--text-secondary)] focus:outline-none focus:border-[var(--accent)] transition-colors font-mono resize-none"
          />

          <div className="mt-3 flex items-center justify-between">
            <span className="text-xs text-[var(--text-secondary)]">
              {urlsText.split('\n').filter(u => u.trim().includes('youtube')).length} valid URLs detected
            </span>
            <button
              onClick={handleStart}
              disabled={!urlsText.trim()}
              className="h-10 px-6 rounded-xl bg-gradient-to-r from-orange-500 to-red-600 text-white font-display font-bold text-sm hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center gap-2"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 2L11 7L3 12V2Z" fill="currentColor"/></svg>
              Start Batch
            </button>
          </div>

          {/* Batch settings */}
          <div className="mt-4 p-4 rounded-xl bg-[var(--bg-secondary)] border border-[var(--border)] space-y-3">
            <h4 className="text-[10px] font-display uppercase tracking-widest text-[var(--text-secondary)]">Batch Settings</h4>

            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-xs">
                <span className="text-[var(--text-secondary)]">Clips per video</span>
                <select
                  value={topN}
                  onChange={e => setTopN(Number(e.target.value))}
                  className="h-7 px-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-xs text-[var(--text-primary)]"
                >
                  {[1, 2, 3, 5, 8, 10].map(n => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs">
                <span className="text-[var(--text-secondary)]">Crop</span>
                <select
                  value={cropMode}
                  onChange={e => setCropMode(e.target.value as CropType)}
                  className="h-7 px-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-xs text-[var(--text-primary)]"
                >
                  <option value="center">Center crop</option>
                  <option value="blur_pad">Blur pad</option>
                  <option value="letterbox">Letterbox</option>
                  <option value="smart_reframe">Smart reframe</option>
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs">
                <span className="text-[var(--text-secondary)]">Captions</span>
                <select
                  value={captionPreset}
                  onChange={e => setCaptionPreset(e.target.value as CaptionPreset)}
                  className="h-7 px-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-xs text-[var(--text-primary)]"
                >
                  <option value="off">Off</option>
                  <option value="tiktok">TikTok (word-by-word)</option>
                  <option value="classic">Classic</option>
                  <option value="bold_pop">Bold Pop</option>
                  <option value="minimal">Minimal</option>
                </select>
              </label>
            </div>
          </div>
        </>
      )}

      {/* Status */}
      {batchStatus && (
        <div className="mb-4 p-3 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)]">
          <p className="text-sm font-display">{batchStatus}</p>
          {isRunning && (
            <div className="mt-2 w-full h-1.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${results.length ? (doneCount / results.length) * 100 : 0}%`,
                  background: 'linear-gradient(90deg, #f97316, #ea580c)',
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-2">
          {results.map((r, i) => (
            <div
              key={i}
              className={`flex items-center gap-3 p-3 rounded-xl border ${
                r.status === 'done' ? 'border-green-500/30 bg-green-500/5' :
                r.status === 'error' ? 'border-red-500/30 bg-red-500/5' :
                r.status === 'analyzing' || r.status === 'cutting' ? 'border-[var(--accent)]/30 bg-[var(--accent)]/5' :
                'border-[var(--border)] bg-[var(--bg-secondary)]'
              }`}
            >
              {/* Status icon */}
              <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0">
                {r.status === 'pending' && <span className="text-xs text-[var(--text-secondary)]">{i + 1}</span>}
                {(r.status === 'analyzing' || r.status === 'cutting') && (
                  <div className="w-4 h-4 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                )}
                {r.status === 'done' && <span className="text-green-400">✅</span>}
                {r.status === 'error' && <span className="text-red-400">❌</span>}
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="text-sm truncate">
                  {r.video?.title || r.url}
                </p>
                <p className="text-[10px] text-[var(--text-secondary)]">
                  {r.status === 'pending' && 'Waiting...'}
                  {r.status === 'analyzing' && 'Analyzing video...'}
                  {r.status === 'cutting' && 'Cutting clips...'}
                  {r.status === 'done' && `${r.files?.length || 0} clips created`}
                  {r.status === 'error' && (r.error || 'Failed')}
                </p>
              </div>

              {/* Download links */}
              {r.status === 'done' && r.files && (
                <div className="flex gap-1">
                  {r.files.map((f, fi) => (
                    <a
                      key={fi}
                      href={`/output/${f}`}
                      target="_blank"
                      className="w-7 h-7 rounded bg-green-500/20 flex items-center justify-center text-[10px] text-green-400 hover:bg-green-500/30 transition-colors font-display"
                      title={f}
                    >
                      {fi + 1}
                    </a>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Summary */}
      {!isRunning && totalFiles > 0 && (
        <div className="mt-4 p-4 rounded-xl bg-green-500/10 border border-green-500/20">
          <p className="text-sm font-display font-bold text-green-400">
            🎬 {totalFiles} clips from {doneCount} videos ready in /output
          </p>
        </div>
      )}
    </div>
  );
};
