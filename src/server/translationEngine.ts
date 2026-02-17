/**
 * Translation Engine
 *
 * Uses Helsinki-NLP/Opus-MT models via @xenova/transformers
 * for fully local, offline text translation.
 *
 * Models auto-download on first use (~50MB each, cached afterward).
 */

interface TranslationResult {
  originalText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
}

export interface TranslationTarget {
  id: string;
  label: string;
  model: string;      // HuggingFace model name
  ttsVoice: string;   // edge-tts voice name for dubbing
  ttsLang: string;    // BCP-47 language tag
}

export const TRANSLATION_TARGETS: TranslationTarget[] = [
  {
    id: 'pt-BR',
    label: 'Portuguese (BR)',
    model: 'Xenova/opus-mt-en-ROMANCE',  // Covers PT via Romance group
    ttsVoice: 'pt-BR-AntonioNeural',
    ttsLang: 'pt-BR',
  },
  {
    id: 'es',
    label: 'Spanish',
    model: 'Xenova/opus-mt-en-es',
    ttsVoice: 'es-MX-JorgeNeural',
    ttsLang: 'es-MX',
  },
];

// Cache loaded pipelines per model
const pipelineCache = new Map<string, any>();
let loadFailed = new Set<string>();

async function getTranslationPipeline(modelName: string) {
  if (loadFailed.has(modelName)) return null;
  if (pipelineCache.has(modelName)) return pipelineCache.get(modelName);

  try {
    console.log(`[translate] Loading model ${modelName} (first time downloads ~50MB)...`);
    const { pipeline } = await import('@xenova/transformers');
    const pipe = await pipeline('translation', modelName, { quantized: true });
    pipelineCache.set(modelName, pipe);
    console.log(`[translate] ✅ Model loaded: ${modelName}`);
    return pipe;
  } catch (err: any) {
    console.log(`[translate] ⚠️ Failed to load ${modelName}: ${err.message}`);
    loadFailed.add(modelName);
    return null;
  }
}

/**
 * Translate an array of subtitle entries to a target language.
 */
export async function translateSubtitles(
  entries: { startS: number; endS: number; text: string }[],
  target: TranslationTarget,
): Promise<{ startS: number; endS: number; text: string }[]> {
  if (entries.length === 0) return [];

  const pipe = await getTranslationPipeline(target.model);
  if (!pipe) {
    console.log('[translate] Translation not available, returning original text');
    return entries;
  }

  console.log(`[translate] Translating ${entries.length} segments to ${target.label}...`);

  const translated: { startS: number; endS: number; text: string }[] = [];

  // Batch translate for efficiency — group into chunks of ~10
  const batchSize = 10;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    const texts = batch.map(e => e.text);

    try {
      const results = await Promise.all(
        texts.map(async (text) => {
          const result = await pipe(text, {
            // For ROMANCE model, specify target language prefix
            ...(target.id === 'pt-BR' ? { tgt_lang: '>>por<<' } : {}),
          });
          return result[0]?.translation_text || text;
        })
      );

      for (let j = 0; j < batch.length; j++) {
        translated.push({
          startS: batch[j].startS,
          endS: batch[j].endS,
          text: results[j],
        });
      }
    } catch (err: any) {
      console.log(`[translate] Batch failed, using originals: ${err.message}`);
      translated.push(...batch);
    }
  }

  console.log(`[translate] ✅ Translated ${translated.length} segments to ${target.label}`);
  return translated;
}

/**
 * Simple single-text translation for titles, descriptions, etc.
 */
export async function translateText(
  text: string,
  target: TranslationTarget,
): Promise<string> {
  const pipe = await getTranslationPipeline(target.model);
  if (!pipe) return text;

  try {
    const result = await pipe(text, {
      ...(target.id === 'pt-BR' ? { tgt_lang: '>>por<<' } : {}),
    });
    return result[0]?.translation_text || text;
  } catch {
    return text;
  }
}
