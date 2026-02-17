import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { PeakSegment } from '../../types/index';

interface Props {
  videoId: string;
  segments: PeakSegment[];
  selectedIds: Set<string>;
  videoDurationS: number;
  externalPreview?: PeakSegment | null;
  onPreviewChange?: (seg: PeakSegment | null) => void;
}

declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

export const PreviewPlayer: React.FC<Props> = ({
  videoId,
  segments,
  selectedIds,
  videoDurationS,
  externalPreview,
  onPreviewChange,
}) => {
  const playerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [activeSegment, setActiveSegment] = useState<PeakSegment | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const timerRef = useRef<number>();

  // Load YouTube IFrame API
  useEffect(() => {
    if (window.YT?.Player) {
      initPlayer();
      return;
    }

    const existing = document.getElementById('yt-iframe-api');
    if (!existing) {
      const tag = document.createElement('script');
      tag.id = 'yt-iframe-api';
      tag.src = 'https://www.youtube.com/iframe_api';
      document.head.appendChild(tag);
    }

    window.onYouTubeIframeAPIReady = initPlayer;

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [videoId]);

  const initPlayer = useCallback(() => {
    if (playerRef.current) {
      playerRef.current.destroy();
    }

    playerRef.current = new window.YT.Player('yt-preview-player', {
      height: '100%',
      width: '100%',
      videoId,
      playerVars: {
        autoplay: 0,
        controls: 1,
        modestbranding: 1,
        rel: 0,
      },
      events: {
        onReady: () => setIsReady(true),
        onStateChange: (event: any) => {
          const playing = event.data === window.YT.PlayerState.PLAYING;
          setIsPlaying(playing);

          if (playing) {
            timerRef.current = window.setInterval(() => {
              if (playerRef.current?.getCurrentTime) {
                setCurrentTime(playerRef.current.getCurrentTime());
              }
            }, 250);
          } else {
            if (timerRef.current) clearInterval(timerRef.current);
          }
        },
      },
    });
  }, [videoId]);

  // Preview a specific segment
  const previewSegment = useCallback((seg: PeakSegment) => {
    if (!playerRef.current?.seekTo) return;
    setActiveSegment(seg);
    onPreviewChange?.(seg);
    playerRef.current.seekTo(seg.startS, true);
    playerRef.current.playVideo();
  }, [onPreviewChange]);

  // Stop at segment end
  useEffect(() => {
    if (activeSegment && currentTime >= activeSegment.endS) {
      playerRef.current?.pauseVideo();
      setActiveSegment(null);
      onPreviewChange?.(null);
    }
  }, [currentTime, activeSegment, onPreviewChange]);

  // Respond to external preview requests (from segment cards)
  useEffect(() => {
    if (externalPreview && isReady && playerRef.current?.seekTo) {
      setActiveSegment(externalPreview);
      playerRef.current.seekTo(externalPreview.startS, true);
      playerRef.current.playVideo();
    }
  }, [externalPreview, isReady]);

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] overflow-hidden">
      {/* Player header */}
      <div className="px-4 py-2.5 border-b border-[var(--border)] flex items-center gap-2">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-[var(--accent)]">
          <path d="M5 3L11 7L5 11V3Z" fill="currentColor"/>
        </svg>
        <span className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)]">
          Preview Player
        </span>
        {activeSegment && (
          <span className="ml-auto text-[10px] font-display text-[var(--accent)]">
            Playing: {formatTime(activeSegment.startS)} → {formatTime(activeSegment.endS)}
          </span>
        )}
      </div>

      {/* YouTube Player */}
      <div ref={containerRef} className="relative aspect-video bg-black">
        <div id="yt-preview-player" className="absolute inset-0" />

        {/* Loading overlay */}
        {!isReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)]">
            <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Timeline with segments */}
      <div className="px-4 py-3">
        <div className="relative h-8 bg-[var(--bg-primary)] rounded-lg overflow-hidden mb-2">
          {/* Segment markers */}
          {segments.map(seg => {
            const left = (seg.startS / videoDurationS) * 100;
            const width = ((seg.endS - seg.startS) / videoDurationS) * 100;
            const isSelected = selectedIds.has(seg.id);
            const isActive = activeSegment?.id === seg.id;

            return (
              <button
                key={seg.id}
                onClick={() => previewSegment(seg)}
                className="absolute top-0 bottom-0 rounded-sm transition-all hover:brightness-125 cursor-pointer"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.5)}%`,
                  backgroundColor: isActive
                    ? 'var(--accent)'
                    : isSelected
                      ? 'rgba(249, 115, 22, 0.5)'
                      : 'rgba(255, 255, 255, 0.15)',
                  border: isActive ? '1px solid var(--accent)' : 'none',
                }}
                title={`${formatTime(seg.startS)} → ${formatTime(seg.endS)} (click to preview)`}
              />
            );
          })}

          {/* Current time indicator */}
          {isReady && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-white z-10 pointer-events-none"
              style={{
                left: `${(currentTime / videoDurationS) * 100}%`,
                transition: 'left 0.25s linear',
              }}
            />
          )}
        </div>

        {/* Segment preview buttons */}
        <div className="flex flex-wrap gap-1.5">
          {segments.map((seg, i) => {
            const isActive = activeSegment?.id === seg.id;
            const isSelected = selectedIds.has(seg.id);

            return (
              <button
                key={seg.id}
                onClick={() => previewSegment(seg)}
                className={`
                  flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-display
                  transition-all border
                  ${isActive
                    ? 'bg-[var(--accent)] text-black border-[var(--accent)]'
                    : isSelected
                      ? 'bg-[var(--accent-dim)] border-[var(--accent)] text-[var(--accent)]'
                      : 'bg-[var(--bg-primary)] border-[var(--border)] text-[var(--text-secondary)] hover:border-[#3a3a3e]'
                  }
                `}
              >
                <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                  <path d="M1.5 0.5L6.5 4L1.5 7.5V0.5Z" fill="currentColor"/>
                </svg>
                Clip {i + 1}: {formatTime(seg.startS)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${(m % 60).toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}
