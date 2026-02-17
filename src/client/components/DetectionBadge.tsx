import React from 'react';
import type { DetectionResult } from '../../types/index';

interface Props {
  detection: DetectionResult;
}

const METHOD_INFO: Record<string, { icon: string; label: string; color: string; description: string }> = {
  heatmap: {
    icon: '📊',
    label: 'Most Replayed',
    color: '#22c55e',
    description: 'YouTube viewer engagement heatmap',
  },
  audio: {
    icon: '🔊',
    label: 'Audio Energy',
    color: '#3b82f6',
    description: 'Volume spikes, bass drops, crowd noise',
  },
  scene: {
    icon: '🎬',
    label: 'Scene Detection',
    color: '#a855f7',
    description: 'Rapid visual cuts and transitions',
  },
  comments: {
    icon: '💬',
    label: 'Comment Timestamps',
    color: '#f59e0b',
    description: 'Timestamps mentioned by viewers',
  },
  combined: {
    icon: '🧠',
    label: 'Combined Score',
    color: '#f97316',
    description: 'Blended signal from all methods',
  },
};

export const DetectionBadge: React.FC<Props> = ({ detection }) => {
  const methodsToShow = detection.methodsUsed.filter(m => m !== 'combined');

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <div
          className="w-2 h-2 rounded-full"
          style={{
            backgroundColor: detection.hasYouTubeHeatmap ? '#22c55e' : '#f59e0b',
          }}
        />
        <span className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)]">
          Detection Method
        </span>
      </div>

      {/* Status message */}
      {detection.hasYouTubeHeatmap ? (
        <p className="text-sm text-green-400 mb-3">
          YouTube "Most Replayed" data available — highest accuracy.
        </p>
      ) : (
        <p className="text-sm text-amber-400 mb-3">
          No YouTube heatmap available. Using AI-powered fallback analysis.
        </p>
      )}

      {/* Method badges */}
      <div className="flex flex-wrap gap-2 mb-3">
        {methodsToShow.map(method => {
          const info = METHOD_INFO[method];
          if (!info) return null;
          return (
            <div
              key={method}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border"
              style={{
                borderColor: `${info.color}30`,
                backgroundColor: `${info.color}10`,
              }}
            >
              <span className="text-xs">{info.icon}</span>
              <span
                className="text-xs font-display font-bold"
                style={{ color: info.color }}
              >
                {info.label}
              </span>
            </div>
          );
        })}

        {detection.methodsUsed.includes('combined') && (
          <div
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border"
            style={{
              borderColor: `${METHOD_INFO.combined.color}30`,
              backgroundColor: `${METHOD_INFO.combined.color}10`,
            }}
          >
            <span className="text-xs">🧠</span>
            <span
              className="text-xs font-display font-bold"
              style={{ color: METHOD_INFO.combined.color }}
            >
              Combined
            </span>
          </div>
        )}
      </div>

      {/* Signal descriptions */}
      <div className="space-y-1">
        {methodsToShow.map(method => {
          const info = METHOD_INFO[method];
          if (!info) return null;
          return (
            <p key={method} className="text-[11px] text-[var(--text-secondary)]">
              <span style={{ color: info.color }}>{info.icon}</span>{' '}
              {info.description}
            </p>
          );
        })}
      </div>

      {/* Top comment timestamps */}
      {detection.commentTimestamps && detection.commentTimestamps.length > 0 && (
        <div className="mt-3 pt-3 border-t border-[var(--border)]">
          <p className="text-[10px] font-display uppercase tracking-widest text-[var(--text-secondary)] mb-2">
            Top Comment Timestamps
          </p>
          <div className="space-y-1.5">
            {detection.commentTimestamps.slice(0, 5).map((ct, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className="font-display text-amber-400 flex-shrink-0 w-10">
                  {formatTime(ct.timeS)}
                </span>
                <span className="text-[var(--text-secondary)] font-display text-amber-400/70 flex-shrink-0">
                  ×{ct.count}
                </span>
                <span className="text-[var(--text-secondary)] truncate">
                  {ct.text}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}
