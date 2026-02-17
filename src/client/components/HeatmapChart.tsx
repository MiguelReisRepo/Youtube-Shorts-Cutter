import React from 'react';
import type { HeatmapPoint, PeakSegment } from '../../types/index';

interface Props {
  heatmap: HeatmapPoint[];
  segments: PeakSegment[];
  videoDurationS: number;
  selectedIds: Set<string>;
}

export const HeatmapChart: React.FC<Props> = ({
  heatmap,
  segments,
  videoDurationS,
  selectedIds,
}) => {
  if (!heatmap.length) return null;

  const maxIntensity = Math.max(...heatmap.map(p => p.intensity));
  const barWidth = 100 / heatmap.length;

  return (
    <div className="relative w-full">
      {/* Label */}
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)]">
          Most Replayed Heatmap
        </span>
        <span className="text-xs text-[var(--text-secondary)]">
          {heatmap.length} data points
        </span>
      </div>

      {/* Chart */}
      <div className="relative h-24 bg-[var(--bg-primary)] rounded-lg border border-[var(--border)] overflow-hidden">
        {/* Heatmap bars */}
        <div className="absolute inset-0 flex items-end">
          {heatmap.map((point, i) => {
            const height = (point.intensity / maxIntensity) * 100;
            const hue = Math.round(30 - point.intensity * 30); // orange to red
            const saturation = 80 + point.intensity * 20;
            const lightness = 40 + point.intensity * 15;

            return (
              <div
                key={i}
                className="heat-bar relative"
                style={{
                  width: `${barWidth}%`,
                  height: `${height}%`,
                  backgroundColor: `hsl(${hue}, ${saturation}%, ${lightness}%)`,
                  opacity: 0.7 + point.intensity * 0.3,
                  transition: 'height 0.2s ease',
                }}
                title={`${formatTime(point.startMs / 1000)} — Intensity: ${(point.intensity * 100).toFixed(0)}%`}
              />
            );
          })}
        </div>

        {/* Segment overlays */}
        {segments.map((seg) => {
          const left = (seg.startS / videoDurationS) * 100;
          const width = ((seg.endS - seg.startS) / videoDurationS) * 100;
          const isSelected = selectedIds.has(seg.id);

          return (
            <div
              key={seg.id}
              className="absolute top-0 bottom-0 border-2 rounded-sm"
              style={{
                left: `${left}%`,
                width: `${width}%`,
                borderColor: isSelected ? 'var(--accent)' : 'rgba(255,255,255,0.2)',
                backgroundColor: isSelected
                  ? 'rgba(249, 115, 22, 0.12)'
                  : 'rgba(255,255,255,0.03)',
              }}
            >
              {/* Segment label */}
              <div
                className="absolute -top-0.5 left-0.5 text-[9px] font-display font-bold px-1 rounded-sm"
                style={{
                  backgroundColor: isSelected ? 'var(--accent)' : '#555',
                  color: isSelected ? '#000' : '#fff',
                }}
              >
                {formatTime(seg.startS)}
              </div>
            </div>
          );
        })}

        {/* Time labels */}
        <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 py-0.5">
          <span className="text-[10px] text-[var(--text-secondary)] opacity-50">0:00</span>
          <span className="text-[10px] text-[var(--text-secondary)] opacity-50">
            {formatTime(videoDurationS)}
          </span>
        </div>
      </div>
    </div>
  );
};

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${(m % 60).toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}
