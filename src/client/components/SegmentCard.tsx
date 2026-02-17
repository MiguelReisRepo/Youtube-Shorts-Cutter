import React, { useState, useCallback } from 'react';
import type { PeakSegment, ViralityBreakdown } from '../../types/index';

interface Props {
  segment: PeakSegment;
  index: number;
  isSelected: boolean;
  onToggle: (id: string) => void;
  onUpdate: (id: string, startS: number, endS: number) => void;
  onPreview: (seg: PeakSegment) => void;
  viralityScore?: ViralityBreakdown;
  videoDurationS: number;
  isPreviewActive?: boolean;
}

export const SegmentCard: React.FC<Props> = ({
  segment,
  index,
  isSelected,
  onToggle,
  onUpdate,
  onPreview,
  viralityScore,
  videoDurationS,
  isPreviewActive,
}) => {
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editStart, setEditStart] = useState('');
  const [editEnd, setEditEnd] = useState('');

  // Nudge start/end by delta seconds
  const nudge = useCallback((field: 'start' | 'end', deltaS: number) => {
    const newStart = field === 'start'
      ? Math.max(0, segment.startS + deltaS)
      : segment.startS;
    const newEnd = field === 'end'
      ? Math.min(videoDurationS, segment.endS + deltaS)
      : segment.endS;

    if (newEnd > newStart + 3) { // Min 3s clip
      onUpdate(segment.id, newStart, newEnd);
    }
  }, [segment, videoDurationS, onUpdate]);

  // Enter edit mode
  const startEditing = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setEditStart(formatTimeEditable(segment.startS));
    setEditEnd(formatTimeEditable(segment.endS));
    setIsEditing(true);
  }, [segment]);

  // Save manual time edit
  const saveEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const newStart = parseTimeInput(editStart);
    const newEnd = parseTimeInput(editEnd);

    if (newStart !== null && newEnd !== null && newEnd > newStart + 3) {
      onUpdate(segment.id, newStart, Math.min(newEnd, videoDurationS));
    }
    setIsEditing(false);
  }, [editStart, editEnd, segment, videoDurationS, onUpdate]);

  const cancelEdit = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setIsEditing(false);
  }, []);

  return (
    <div
      className={`
        relative flex flex-col gap-2 p-3 rounded-xl border transition-all
        ${isPreviewActive
          ? 'bg-[var(--accent-dim)] border-[var(--accent)] ring-1 ring-[var(--accent)]'
          : isSelected
            ? 'bg-[var(--accent-dim)] border-[var(--accent)]'
            : 'bg-[var(--bg-secondary)] border-[var(--border)] hover:border-[#3a3a3e]'
        }
      `}
    >
      {/* Now playing indicator */}
      {isPreviewActive && (
        <div className="absolute -top-2 left-3 px-2 py-0.5 rounded bg-[var(--accent)] text-black text-[9px] font-display font-bold flex items-center gap-1">
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-black animate-pulse" />
          PREVIEWING
        </div>
      )}

      {/* Top row: preview, checkbox, index, time, virality */}
      <div className="flex items-center gap-2">
        {/* Preview button */}
        <button
          onClick={(e) => { e.stopPropagation(); onPreview(segment); }}
          className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 transition-all ${
            isPreviewActive
              ? 'bg-[var(--accent)] text-black'
              : 'bg-[var(--bg-primary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)]'
          }`}
          title="Preview this clip"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M2.5 1L10 6L2.5 11V1Z" fill="currentColor"/>
          </svg>
        </button>

        {/* Checkbox */}
        <div
          className={`
            w-5 h-5 rounded-md border-2 flex items-center justify-center flex-shrink-0 transition-all cursor-pointer
            ${isSelected
              ? 'bg-[var(--accent)] border-[var(--accent)]'
              : 'border-[#3a3a3e] hover:border-[var(--accent)]'
            }
          `}
          onClick={() => onToggle(segment.id)}
        >
          {isSelected && (
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6L5 9L10 3" stroke="black" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          )}
        </div>

        {/* Index */}
        <div className="w-6 h-6 rounded-lg bg-[var(--bg-primary)] flex items-center justify-center flex-shrink-0">
          <span className="text-[10px] font-display font-bold">{index + 1}</span>
        </div>

        {/* Time + duration */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-display font-bold">
              {formatTime(segment.startS)} → {formatTime(segment.endS)}
            </span>
            <span className="text-[10px] text-[var(--text-secondary)] font-display">
              {Math.round(segment.endS - segment.startS)}s
            </span>
          </div>

          {/* Intensity bar */}
          <div className="flex items-center gap-2">
            <div className="flex-1 h-1.5 bg-[var(--bg-primary)] rounded-full overflow-hidden">
              <div
                className="h-full rounded-full"
                style={{
                  width: `${segment.avgIntensity * 100}%`,
                  background: 'linear-gradient(90deg, #f97316, #ef4444)',
                }}
              />
            </div>
            <span className="text-[10px] text-[var(--text-secondary)] font-display w-8 text-right">
              {Math.round(segment.avgIntensity * 100)}%
            </span>
          </div>
        </div>

        {/* Virality badge */}
        {viralityScore && (
          <div className="flex-shrink-0">
            <button
              onClick={(e) => { e.stopPropagation(); setShowBreakdown(!showBreakdown); }}
              className="flex flex-col items-center gap-0.5 px-2.5 py-1.5 rounded-lg border transition-all hover:brightness-125"
              style={{
                borderColor: `${viralityScore.color}40`,
                backgroundColor: `${viralityScore.color}15`,
              }}
            >
              <span className="text-base font-display font-black leading-none" style={{ color: viralityScore.color }}>
                {viralityScore.overall}
              </span>
              <span className="text-[9px] font-display leading-none" style={{ color: viralityScore.color }}>
                {viralityScore.label}
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Adjust row: nudge buttons + edit */}
      {isSelected && !isEditing && (
        <div className="flex items-center gap-1.5 pl-[60px] animate-fade-in" onClick={e => e.stopPropagation()}>
          <span className="text-[10px] text-[var(--text-secondary)] w-10 font-display">Start</span>
          <NudgeBtn label="−5s" onClick={() => nudge('start', -5)} />
          <NudgeBtn label="−1s" onClick={() => nudge('start', -1)} />
          <NudgeBtn label="+1s" onClick={() => nudge('start', 1)} />
          <NudgeBtn label="+5s" onClick={() => nudge('start', 5)} />

          <div className="w-2" />

          <span className="text-[10px] text-[var(--text-secondary)] w-7 font-display">End</span>
          <NudgeBtn label="−5s" onClick={() => nudge('end', -5)} />
          <NudgeBtn label="−1s" onClick={() => nudge('end', -1)} />
          <NudgeBtn label="+1s" onClick={() => nudge('end', 1)} />
          <NudgeBtn label="+5s" onClick={() => nudge('end', 5)} />

          <div className="ml-auto" />
          <button
            onClick={startEditing}
            className="text-[10px] text-[var(--accent)] hover:underline font-display"
          >
            ✏️ Edit exact
          </button>
        </div>
      )}

      {/* Manual time edit mode */}
      {isEditing && (
        <div className="flex items-center gap-2 pl-[60px] animate-fade-in" onClick={e => e.stopPropagation()}>
          <label className="text-[10px] text-[var(--text-secondary)] font-display">Start</label>
          <input
            type="text"
            value={editStart}
            onChange={e => setEditStart(e.target.value)}
            placeholder="0:00"
            className="w-16 h-7 px-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-xs text-center font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            onClick={e => e.stopPropagation()}
          />
          <label className="text-[10px] text-[var(--text-secondary)] font-display">End</label>
          <input
            type="text"
            value={editEnd}
            onChange={e => setEditEnd(e.target.value)}
            placeholder="0:00"
            className="w-16 h-7 px-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-xs text-center font-mono text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)]"
            onClick={e => e.stopPropagation()}
          />
          <span className="text-[10px] text-[var(--text-secondary)]">
            = {(() => {
              const s = parseTimeInput(editStart);
              const e = parseTimeInput(editEnd);
              return s !== null && e !== null ? `${Math.round(e - s)}s` : '?';
            })()}
          </span>
          <button onClick={saveEdit}
            className="h-7 px-3 rounded bg-[var(--accent)] text-black text-[10px] font-display font-bold hover:brightness-110"
          >Save</button>
          <button onClick={cancelEdit}
            className="h-7 px-2 rounded text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
          >Cancel</button>
        </div>
      )}

      {/* Virality breakdown popover */}
      {showBreakdown && viralityScore && (
        <div
          className="ml-[52px] p-3 rounded-xl border border-[var(--border)] bg-[var(--bg-primary)] animate-fade-in"
          onClick={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-display font-bold">Virality Breakdown</span>
            <span className="text-lg font-display font-black" style={{ color: viralityScore.color }}>
              {viralityScore.overall}
            </span>
          </div>
          <div className="space-y-1.5">
            <ScoreBar label="Peak Intensity" value={viralityScore.peakIntensity} weight="30%" />
            <ScoreBar label="Hook Strength" value={viralityScore.hookStrength} weight="25%" />
            <ScoreBar label="Pacing" value={viralityScore.pacing} weight="15%" />
            <ScoreBar label="Audio Energy" value={viralityScore.audioEnergy} weight="15%" />
            <ScoreBar label="Position" value={viralityScore.positionBonus} weight="10%" />
            <ScoreBar label="Duration Fit" value={viralityScore.durationFit} weight="5%" />
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Sub-components ─────────────────────────────────

const NudgeBtn: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <button
    onClick={onClick}
    className="h-6 px-1.5 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[10px] font-mono text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[#3a3a3e] transition-all active:scale-95"
  >
    {label}
  </button>
);

const ScoreBar: React.FC<{ label: string; value: number; weight: string }> = ({
  label, value, weight,
}) => (
  <div className="flex items-center gap-2">
    <span className="text-[10px] text-[var(--text-secondary)] w-20 flex-shrink-0">{label}</span>
    <div className="flex-1 h-1 bg-[var(--bg-secondary)] rounded-full overflow-hidden">
      <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${value}%` }} />
    </div>
    <span className="text-[10px] font-display text-[var(--text-primary)] w-6 text-right">{value}</span>
    <span className="text-[8px] text-[var(--text-secondary)] w-6">{weight}</span>
  </div>
);

// ─── Helpers ────────────────────────────────────────

function formatTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatTimeEditable(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Parse time input like "1:23", "1:02:30", "85" (seconds)
 */
function parseTimeInput(input: string): number | null {
  const trimmed = input.trim();

  // Pure number = seconds
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed);

  // M:SS or H:MM:SS
  const parts = trimmed.split(':').map(Number);
  if (parts.some(isNaN)) return null;

  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];

  return null;
}
