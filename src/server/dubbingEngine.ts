/**
 * AI Dubbing Engine
 *
 * Takes translated subtitle entries, generates speech using edge-tts,
 * and mixes the dubbed audio with the original video.
 *
 * Pipeline:
 * 1. Generate TTS audio for each subtitle segment
 * 2. Concatenate TTS segments with proper timing gaps
 * 3. Mix: lower original audio volume, overlay TTS audio
 * 4. Output dubbed video
 *
 * Uses edge-tts (Microsoft Edge's free TTS service):
 * - 40+ languages, neural voices
 * - No API key needed
 * - High quality, natural sounding
 */

import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { FFMPEG_PATH } from './binPaths.js';
import type { TranslationTarget } from './translationEngine.js';

const execFileAsync = promisify(execFile);

interface SubEntry {
  startS: number;
  endS: number;
  text: string;
}

/**
 * Generate a dubbed version of a video clip.
 *
 * @param videoPath - Path to the source video clip
 * @param translatedSubs - Translated subtitle entries with timestamps
 * @param target - Translation target with TTS voice info
 * @param outputPath - Where to write the dubbed video
 * @param originalVolume - Volume level for original audio (0.0 - 1.0)
 */
export async function generateDubbedVideo(
  videoPath: string,
  translatedSubs: SubEntry[],
  target: TranslationTarget,
  outputPath: string,
  originalVolume: number = 0.15,
): Promise<boolean> {
  if (translatedSubs.length === 0) {
    console.log('[dub] No subtitles to dub');
    return false;
  }

  const tmpDir = path.join(os.tmpdir(), `dub-${Date.now()}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    // ── Step 1: Generate TTS audio for each segment ──

    console.log(`[dub] Generating TTS audio (${target.ttsVoice})...`);
    const ttsFiles: { path: string; startS: number; durationS: number }[] = [];

    for (let i = 0; i < translatedSubs.length; i++) {
      const sub = translatedSubs[i];
      const ttsPath = path.join(tmpDir, `tts_${i}.mp3`);

      const success = await generateTTS(sub.text, target.ttsVoice, ttsPath);
      if (success) {
        // Get actual TTS audio duration
        const duration = await getAudioDuration(ttsPath);
        ttsFiles.push({
          path: ttsPath,
          startS: sub.startS,
          durationS: duration || (sub.endS - sub.startS),
        });
      }
    }

    if (ttsFiles.length === 0) {
      console.log('[dub] No TTS audio generated');
      return false;
    }

    console.log(`[dub] Generated ${ttsFiles.length} TTS segments`);

    // ── Step 2: Build the dubbed audio mix ──────────

    // Create a complex ffmpeg filter to:
    // - Lower original audio
    // - Overlay each TTS segment at its timestamp
    // - Mix everything together

    const inputArgs: string[] = ['-y', '-i', videoPath];
    const filterParts: string[] = [];

    // Add each TTS file as input
    for (let i = 0; i < ttsFiles.length; i++) {
      inputArgs.push('-i', ttsFiles[i].path);
    }

    // Lower original audio
    filterParts.push(`[0:a]volume=${originalVolume}[orig]`);

    // Delay and pad each TTS segment
    for (let i = 0; i < ttsFiles.length; i++) {
      const delayMs = Math.round(ttsFiles[i].startS * 1000);
      // Convert TTS to same sample rate + add delay
      filterParts.push(
        `[${i + 1}:a]aresample=44100,adelay=${delayMs}|${delayMs},apad[tts${i}]`
      );
    }

    // Mix all audio streams together
    const mixInputs = ['[orig]', ...ttsFiles.map((_, i) => `[tts${i}]`)].join('');
    filterParts.push(
      `${mixInputs}amix=inputs=${ttsFiles.length + 1}:duration=first:dropout_transition=2[mixed]`
    );

    const filterComplex = filterParts.join(';');

    console.log(`[dub] Mixing audio (${ttsFiles.length} TTS segments + original at ${Math.round(originalVolume * 100)}%)...`);

    await new Promise<void>((resolve, reject) => {
      const proc = spawn(FFMPEG_PATH, [
        ...inputArgs,
        '-filter_complex', filterComplex,
        '-map', '0:v',          // Keep original video
        '-map', '[mixed]',      // Use mixed audio
        '-c:v', 'copy',         // Don't re-encode video
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        outputPath,
      ]);

      let stderr = '';
      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Dubbing mix failed: ${stderr.slice(-300)}`));
      });

      proc.on('error', reject);
    });

    console.log(`[dub] ✅ Dubbed video created`);
    return true;
  } catch (err: any) {
    console.log(`[dub] ❌ Dubbing failed: ${err.message}`);
    return false;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * Generate TTS audio using edge-tts npm package.
 */
async function generateTTS(
  text: string,
  voice: string,
  outputPath: string,
): Promise<boolean> {
  try {
    const { MsEdgeTTS } = await import('msedge-tts');
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, 'audio-24khz-96kbitrate-mono-mp3');
    const readable = tts.toStream(text);

    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      readable.on('data', (chunk: any) => {
        if (chunk.type === 'audio') {
          chunks.push(chunk.data);
        }
      });
      readable.on('end', () => {
        if (chunks.length > 0) {
          fs.writeFileSync(outputPath, Buffer.concat(chunks));
          resolve(true);
        } else {
          resolve(false);
        }
      });
      readable.on('error', () => resolve(false));
    });
  } catch (err: any) {
    // Fallback: try edge-tts CLI if npm package doesn't work
    try {
      await execFileAsync('edge-tts', [
        '--voice', voice,
        '--text', text,
        '--write-media', outputPath,
      ], { timeout: 30000 });
      return fs.existsSync(outputPath);
    } catch {
      console.log(`[dub] TTS failed for: "${text.slice(0, 40)}..." — ${err.message}`);
      return false;
    }
  }
}

/**
 * Get audio duration in seconds using ffmpeg.
 */
async function getAudioDuration(filePath: string): Promise<number | null> {
  try {
    const result = await execFileAsync(FFMPEG_PATH, [
      '-i', filePath,
    ], { timeout: 5000 }).catch(err => err);
    const stderr = result.stderr || '';
    const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
    if (match) {
      return parseInt(match[1]) * 3600 +
             parseInt(match[2]) * 60 +
             parseInt(match[3]) +
             parseInt(match[4]) / 100;
    }
    return null;
  } catch {
    return null;
  }
}
