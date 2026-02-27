import React from 'react';
import type { CutProgress } from '../../types/index';

interface Props {
  progress: CutProgress;
  onDownload: (filename: string) => void;
  onReset: () => void;
  onBackToClips: () => void;
}

export const ProgressPanel: React.FC<Props> = ({ progress, onDownload, onReset, onBackToClips }) => {
  const pct =
    progress.totalClips > 0
      ? Math.round(
          ((progress.currentClip - 1) / progress.totalClips) * 100 +
          (progress.status === 'processing' ? (0.5 / progress.totalClips) * 100 : 0)
        )
      : 0;

  return (
    <div className="animate-fade-in rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-6">
      {/* Status header */}
      <div className="flex items-center gap-3 mb-4">
        {progress.status === 'downloading' && <Spinner />}
        {progress.status === 'processing' && <Spinner />}
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
            {progress.status === 'downloading' && `Downloading clip ${progress.currentClip}/${progress.totalClips}...`}
            {progress.status === 'analyzing' && `Analyzing clip ${progress.currentClip}/${progress.totalClips} for reframe`}
            {progress.status === 'processing' && `Converting clip ${progress.currentClip}/${progress.totalClips} to 9:16`}
            {progress.status === 'captioning' && `Adding captions to clip ${progress.currentClip}/${progress.totalClips}`}
            {progress.status === 'done' && 'All clips ready!'}
            {progress.status === 'error' && 'Something went wrong'}
          </h3>
          <p className="text-xs text-[var(--text-secondary)]">{progress.message}</p>
        </div>
      </div>

      {/* Progress bar */}
      {(progress.status === 'downloading' || progress.status === 'processing' || progress.status === 'analyzing' || progress.status === 'captioning') && (
        <div className="w-full h-2 bg-[var(--bg-primary)] rounded-full overflow-hidden mb-2">
          <div
            className="h-full rounded-full transition-all duration-700 ease-out"
            style={{
              width: `${Math.max(pct, 5)}%`,
              background: 'linear-gradient(90deg, #f97316, #ea580c)',
            }}
          />
        </div>
      )}

      {/* Error details */}
      {progress.status === 'error' && progress.error && (
        <div className="mt-3 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
          <code className="text-xs text-red-400 break-all">{progress.error}</code>
        </div>
      )}

      {/* Download links */}
      {progress.status === 'done' && progress.files && (
        <div className="mt-4 space-y-2">
          {progress.files.map((file, i) => (
            <button
              key={file}
              onClick={() => onDownload(file)}
              className="w-full flex items-center gap-3 p-3 rounded-lg bg-[var(--bg-primary)] border border-[var(--border)] hover:border-[var(--accent)] transition-colors group"
            >
              <div className="w-8 h-8 rounded-lg bg-[var(--accent-dim)] flex items-center justify-center flex-shrink-0">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-[var(--accent)]">
                  <path d="M8 2V10M8 10L5 7M8 10L11 7M3 13H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div className="flex-1 text-left min-w-0">
                <p className="text-sm font-medium truncate group-hover:text-[var(--accent)] transition-colors">
                  {file}
                </p>
                <p className="text-[10px] text-[var(--text-secondary)]">
                  Clip {i + 1} · 1080×1920 · H.264
                </p>
              </div>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" className="text-[var(--text-secondary)] group-hover:text-[var(--accent)] transition-colors">
                <path d="M4 8H12M12 8L8 4M12 8L8 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          ))}
        </div>
      )}

      {/* Action buttons */}
      {(progress.status === 'done' || progress.status === 'error') && (
        <div className="mt-4 flex gap-2">
          <button
            onClick={onBackToClips}
            className="flex-1 py-2.5 rounded-lg border border-[var(--accent)] text-sm font-medium text-[var(--accent)] hover:bg-[var(--accent-dim)] transition-colors"
          >
            ← Back to clips
          </button>
          <button
            onClick={onReset}
            className="flex-1 py-2.5 rounded-lg border border-[var(--border)] text-sm font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[#3a3a3e] transition-colors"
          >
            New video
          </button>
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
    <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
  </div>
);
