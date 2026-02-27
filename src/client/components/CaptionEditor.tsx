import React, { useState, useCallback } from 'react';
import type { PeakSegment, SubtitleEntry } from '../../types/index';

interface Props {
  url: string;
  segments: PeakSegment[];
  selectedIds: Set<string>;
  subtitles: Record<string, SubtitleEntry[]>;
  onSubtitlesChange: (subtitles: Record<string, SubtitleEntry[]>) => void;
}

export const CaptionEditor: React.FC<Props> = ({
  url, segments, selectedIds, subtitles, onSubtitlesChange,
}) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSegment, setExpandedSegment] = useState<string | null>(null);

  const selectedSegments = segments.filter(s => selectedIds.has(s.id));

  const fetchSubtitles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/subtitles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, segments: selectedSegments }),
      });
      if (!res.ok) throw new Error('Failed to fetch subtitles');
      const data = await res.json();
      onSubtitlesChange(data.subtitles);
      if (selectedSegments.length > 0) {
        setExpandedSegment(selectedSegments[0].id);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [url, selectedSegments, onSubtitlesChange]);

  const updateEntryText = useCallback((segId: string, entryIndex: number, newText: string) => {
    onSubtitlesChange({
      ...subtitles,
      [segId]: subtitles[segId].map((entry, i) =>
        i === entryIndex ? { ...entry, text: newText } : entry
      ),
    });
  }, [subtitles, onSubtitlesChange]);

  const hasSubtitles = Object.keys(subtitles).length > 0;
  const totalEntries = Object.values(subtitles).reduce((sum, entries) => sum + entries.length, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h4 className="text-[10px] font-display uppercase tracking-widest text-[var(--text-secondary)]">
          Edit Captions
        </h4>
        {hasSubtitles && (
          <span className="text-[10px] text-[var(--text-secondary)]">
            {totalEntries} entries
          </span>
        )}
      </div>

      {!hasSubtitles && (
        <button
          onClick={fetchSubtitles}
          disabled={loading || selectedSegments.length === 0}
          className="w-full py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] transition-all disabled:opacity-40"
        >
          {loading ? 'Loading subtitles...' : 'Load subtitles to edit'}
        </button>
      )}

      {error && (
        <p className="text-[10px] text-red-400">{error}</p>
      )}

      {hasSubtitles && selectedSegments.map((seg, segIdx) => {
        const entries = subtitles[seg.id] || [];
        const isExpanded = expandedSegment === seg.id;
        return (
          <div key={seg.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
            <button
              onClick={() => setExpandedSegment(isExpanded ? null : seg.id)}
              className="w-full flex items-center justify-between px-3 py-2 text-left"
            >
              <span className="text-[11px] font-display">
                Clip {segIdx + 1}
              </span>
              <span className="text-[10px] text-[var(--text-secondary)]">
                {entries.length} lines {isExpanded ? '\u25BE' : '\u25B8'}
              </span>
            </button>
            {isExpanded && (
              <div className="px-3 pb-3 space-y-1.5 max-h-60 overflow-y-auto">
                {entries.length === 0 ? (
                  <p className="text-[10px] text-[var(--text-secondary)] italic">No subtitles found for this segment</p>
                ) : (
                  entries.map((entry, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <span className="text-[9px] text-[var(--text-secondary)] font-mono mt-1.5 w-12 flex-shrink-0">
                        {formatTime(entry.startS)}
                      </span>
                      <input
                        type="text"
                        value={entry.text}
                        onChange={e => updateEntryText(seg.id, i, e.target.value)}
                        className="flex-1 h-7 px-2 rounded bg-[var(--bg-primary)] border border-[var(--border)] text-[11px] text-[var(--text-primary)] focus:outline-none focus:border-[var(--accent)] transition-colors"
                      />
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        );
      })}

      {hasSubtitles && (
        <button
          onClick={fetchSubtitles}
          disabled={loading}
          className="text-[10px] text-[var(--text-secondary)] hover:text-[var(--accent)] font-display transition-colors"
        >
          {loading ? 'Reloading...' : 'Reload subtitles'}
        </button>
      )}
    </div>
  );
};

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
