# 🎬 YouTube Shorts Cutter

A full-stack React + TypeScript web app that automatically finds the **most hyped moments** in any YouTube video and cuts them into **vertical 9:16 clips** for YouTube Shorts and Instagram Reels.

Works on **any video** — even those without YouTube's "Most Replayed" heatmap.

## How It Works

```
┌──────────────────────────────────────────────────────────┐
│                    Analysis Pipeline                      │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  1. Try YouTube "Most Replayed" heatmap                  │
│     ├─ ✅ Available? → Use as primary signal             │
│     └─ ❌ Not available? → Run fallback analysis ↓       │
│                                                          │
│  2. Fallback Analysis (runs in parallel):                │
│     ├─ 🔊 Audio Energy — volume spikes, bass drops       │
│     ├─ 🎬 Scene Detection — rapid visual cuts            │
│     └─ 💬 Comment Timestamps — "best part at 2:34!"      │
│                                                          │
│  3. 🧠 Signal Combiner                                   │
│     └─ Weighted blend of all available signals            │
│                                                          │
│  4. Peak Detection → Clip Cutting → 9:16 Output          │
└──────────────────────────────────────────────────────────┘
```

## Detection Methods

| Method | Signal | Weight | Source |
|--------|--------|--------|--------|
| 📊 **Most Replayed** | YouTube viewer heatmap | Primary | YouTube API (yt-dlp) |
| 🔊 **Audio Energy** | Volume/loudness peaks | 1.0 | ffmpeg ebur128 analysis |
| 🎬 **Scene Detection** | Rapid visual cuts | 0.6 | ffmpeg scene filter |
| 💬 **Comment Timestamps** | Viewer-mentioned times | 1.2 | yt-dlp comment scraping |
| 🧠 **Combined** | Weighted blend of above | — | Signal combiner |

When multiple fallback signals are available, they're combined with weights (comments score highest since they're human-sourced).

## Tech Stack

| Layer | Tech |
|-------|------|
| Frontend | React 18, TypeScript, Vite, Tailwind CSS |
| Backend | Express, TypeScript, Node.js |
| Video | yt-dlp (download + heatmap + comments), ffmpeg (analysis + cut) |
| Communication | REST API + Server-Sent Events (SSE) |

## Prerequisites

- **Node.js** 18+
- **yt-dlp** — `pip install yt-dlp` or `brew install yt-dlp`
- **ffmpeg** — `brew install ffmpeg` / `sudo apt install ffmpeg` / `choco install ffmpeg`

## Quick Start

```bash
cd youtube-shorts-cutter
npm install
npm run dev
```

Opens:
- **Frontend** → http://localhost:5173
- **Backend** → http://localhost:3001

## Project Structure

```
src/
├── types/
│   └── index.ts               # Shared TypeScript types
├── server/
│   ├── index.ts                # Express API + analysis orchestration
│   ├── youtube.ts              # YouTube heatmap extraction via yt-dlp
│   ├── audioAnalysis.ts        # 🔊 Audio energy peak detection
│   ├── sceneDetection.ts       # 🎬 Scene change detection via ffmpeg
│   ├── commentScraper.ts       # 💬 Comment timestamp extraction
│   ├── signalCombiner.ts       # 🧠 Multi-signal blending + smoothing
│   └── processor.ts            # Video download + ffmpeg clip cutting
└── client/
    ├── main.tsx
    ├── App.tsx                  # Main UI
    ├── index.css
    └── components/
        ├── HeatmapChart.tsx     # Heatmap visualization
        ├── SegmentCard.tsx      # Peak segment selector cards
        ├── ProgressPanel.tsx    # Processing progress + downloads
        └── DetectionBadge.tsx   # Shows which methods were used
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/analyze` | Full analysis pipeline → heatmap + segments + detection info |
| `POST` | `/api/cut` | Start cutting job → returns job ID |
| `GET` | `/api/jobs/:id/progress` | SSE progress stream |
| `GET` | `/api/jobs/:id` | Current job status |
| `GET` | `/output/:filename` | Download a cut clip |

## Output Specs

- **Aspect ratio:** 9:16 (vertical)
- **Resolution:** 1080 × 1920 px
- **Codec:** H.264 High Profile
- **Audio:** AAC 192kbps / 44.1kHz
- **Container:** MP4 with faststart
- **Quality:** CRF 18

## Crop Modes

| Mode | Best For |
|------|----------|
| **Center Crop** | Talking-head, centered subjects |
| **Blur Pad** | Widescreen content, landscape footage |
