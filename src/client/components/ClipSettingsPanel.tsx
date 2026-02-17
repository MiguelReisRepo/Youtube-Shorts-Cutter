import React from 'react';
import type { ClipSettings } from '../../types/index';

interface Props {
  settings: ClipSettings;
  onChange: (settings: ClipSettings) => void;
}

export const ClipSettingsPanel: React.FC<Props> = ({ settings, onChange }) => {
  const update = (key: keyof ClipSettings, value: number) => {
    onChange({ ...settings, [key]: value });
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-secondary)] p-4">
      <div className="flex items-center gap-2 mb-4">
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" className="text-[var(--text-secondary)]">
          <path d="M5.5 1H2C1.44772 1 1 1.44772 1 2V5.5M8.5 1H12C12.5523 1 13 1.44772 13 2V5.5M1 8.5V12C1 12.5523 1.44772 13 2 13H5.5M13 8.5V12C12.9999 12.5523 12.5523 13 12 13H8.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"/>
        </svg>
        <span className="text-xs font-display uppercase tracking-widest text-[var(--text-secondary)]">
          Clip Settings
        </span>
      </div>

      <div className="space-y-4">
        {/* Number of clips */}
        <SettingSlider
          label="Number of clips"
          value={settings.topN}
          min={1}
          max={10}
          step={1}
          unit=""
          onChange={v => update('topN', v)}
          formatValue={v => `${v}`}
        />

        {/* Clip duration range */}
        <div className="grid grid-cols-2 gap-3">
          <SettingSlider
            label="Min duration"
            value={settings.minDurationS}
            min={5}
            max={60}
            step={5}
            unit="s"
            onChange={v => {
              update('minDurationS', v);
              if (v > settings.maxDurationS) update('maxDurationS', v);
            }}
            formatValue={v => `${v}s`}
          />
          <SettingSlider
            label="Max duration"
            value={settings.maxDurationS}
            min={15}
            max={180}
            step={5}
            unit="s"
            onChange={v => {
              update('maxDurationS', v);
              if (v < settings.minDurationS) update('minDurationS', v);
            }}
            formatValue={v => `${v}s`}
          />
        </div>

        {/* Gap between clips */}
        <SettingSlider
          label="Min gap between clips"
          value={settings.minGapS}
          min={5}
          max={120}
          step={5}
          unit="s"
          onChange={v => update('minGapS', v)}
          formatValue={v => `${v}s`}
          hint="Prevents clips from being too close together"
        />

        {/* Intensity threshold */}
        <SettingSlider
          label="Intensity threshold"
          value={settings.intensityThreshold}
          min={0.2}
          max={0.9}
          step={0.1}
          unit=""
          onChange={v => update('intensityThreshold', Math.round(v * 10) / 10)}
          formatValue={v => `${Math.round(v * 100)}%`}
          hint="Lower = more clips found, higher = only the strongest peaks"
        />
      </div>
    </div>
  );
};

// ─── Slider Sub-component ───────────────────────────

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  formatValue: (value: number) => string;
  hint?: string;
}

const SettingSlider: React.FC<SliderProps> = ({
  label, value, min, max, step, onChange, formatValue, hint,
}) => {
  const pct = ((value - min) / (max - min)) * 100;

  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <label className="text-xs text-[var(--text-secondary)]">{label}</label>
        <span className="text-xs font-display font-bold text-[var(--accent)]">
          {formatValue(value)}
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={e => onChange(parseFloat(e.target.value))}
          className="w-full h-1.5 appearance-none rounded-full cursor-pointer"
          style={{
            background: `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--bg-primary) ${pct}%, var(--bg-primary) 100%)`,
          }}
        />
      </div>
      {hint && (
        <p className="mt-1 text-[10px] text-[var(--text-secondary)] opacity-60">{hint}</p>
      )}

      <style>{`
        input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--bg-primary);
          cursor: pointer;
          box-shadow: 0 0 0 2px var(--accent);
        }
        input[type="range"]::-moz-range-thumb {
          width: 14px;
          height: 14px;
          border-radius: 50%;
          background: var(--accent);
          border: 2px solid var(--bg-primary);
          cursor: pointer;
          box-shadow: 0 0 0 2px var(--accent);
        }
      `}</style>
    </div>
  );
};
