
import { GoogleGenAI, Modality } from "@google/genai";

let aiInstance: GoogleGenAI | null = null;

function getAI() {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("GEMINI_API_KEY is missing. Translation and TTS will not work.");
      return null;
    }
    aiInstance = new GoogleGenAI({ apiKey });
  }
  return aiInstance;
}

let audioContext: AudioContext;
let isQuotaExceeded = false;

let currentSource: AudioBufferSourceNode | null = null;

function getAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
  }
  return audioContext;
}

function decodeBase64(base64: string) {
  try {
    const binaryString = atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    console.error("Base64 decode failed", e);
    return new Uint8Array(0);
  }
}

async function decodeAudioData(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}

/**
 * Native Speech Fallback using Web Speech API
 */
const speakNative = (text: string, langCode: string) => {
  if (!('speechSynthesis' in window)) return;
  
  window.speechSynthesis.cancel();
  
  const utterance = new SpeechSynthesisUtterance(text);
  
  const langMap: Record<string, string> = {
    'he': 'he-IL',
    'ar': 'ar-SA',
    'ru': 'ru-RU',
    'en': 'en-US'
  };
  
  const targetLang = langMap[langCode] || 'en-US';
  utterance.lang = targetLang;

  const setVoice = () => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      // Priority 1: Exact match for targetLang (e.g., 'he-IL')
      // Priority 2: Match for langCode (e.g., 'he')
      const voice = voices.find(v => v.lang === targetLang) || 
                    voices.find(v => v.lang.startsWith(langCode));
      
      if (voice) {
        utterance.voice = voice;
      } else if (langCode === 'he' || langCode === 'ar') {
        // If we're in Hebrew/Arabic and NO matching voice is found,
        // it's better to NOT speak than to speak in a "German" accent.
        console.warn(`No native voice found for ${langCode}, skipping native fallback.`);
        return false;
      }
    }
    return true;
  };

  if (!setVoice()) return;

  utterance.rate = 0.85; // Slightly slower for better clarity
  utterance.pitch = 1.0;
  
  console.log(`Speaking (${targetLang}): ${text}`);
  window.speechSynthesis.speak(utterance);
};

/**
 * Generates an AudioBuffer from text using Gemini TTS.
 */
export const generateAudioBuffer = async (text: string, langCode: string = 'en'): Promise<AudioBuffer | null> => {
  if (isQuotaExceeded) return null;

  try {
    const ctx = getAudioContext();
    // Add language hint to the prompt for better TTS quality
    const prompt = langCode === 'he' ? `Speak this Hebrew text clearly: ${text}` : 
                   langCode === 'ar' ? `Speak this Arabic text clearly: ${text}` : text;

    const ai = getAI();
    if (!ai) return null;

    const response = await ai.models.generateContent({
      model: "gemini-3.1-flash-tts-preview",
      contents: [{ parts: [{ text: prompt }] }],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: 'Kore' },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      const audioData = decodeBase64(base64Audio);
      return await decodeAudioData(audioData, ctx, 24000, 1);
    }
  } catch (error: any) {
    if (error?.message?.includes('429') || error?.message?.includes('quota')) {
      isQuotaExceeded = true;
    }
  }
  return null;
};

/**
 * Plays a pre-generated AudioBuffer immediately.
 */
export const playAudioBuffer = async (buffer: AudioBuffer) => {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch (e) {}
    currentSource = null;
  }

  const ctx = getAudioContext();
  if (ctx.state === 'suspended') {
    await ctx.resume();
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start(0);
  currentSource = source;
};

/**
 * Stops any ongoing speech (both Gemini and Native)
 */
export const stopSpeaking = () => {
  if (currentSource) {
    try {
      currentSource.stop();
    } catch (e) {}
    currentSource = null;
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
};

const translationCache: Record<string, string> = {};

// Queue for handling translation requests to prevent quota exhaustion
let translationQueue: { text: string; targetLanguage: string; resolve: (val: string) => void; reject: (err: any) => void }[] = [];
let isProcessingQueue = false;

const cleanTranslatedText = (text: string): string => {
  // Remove common AI prefixes like "Translation:", "Translated text:", etc.
  return text
    .replace(/^(translation|translated text|hebrew|arabic|russian|english):\s*/i, '')
    .replace(/^["']|["']$/g, '') // Remove quotes
    .trim();
};

const isAlreadyInLanguage = (text: string, langCode: string): boolean => {
  if (langCode === 'he') return /[\u0590-\u05FF]/.test(text);
  if (langCode === 'ar') return /[\u0600-\u06FF]/.test(text);
  if (langCode === 'ru') return /[\u0400-\u04FF]/.test(text);
  return false;
};

/**
 * Translates a batch of strings in a single Gemini request.
 * This is much more efficient and helps avoid quota limits.
 */
export const translateBatch = async (texts: string[], targetLanguage: string): Promise<string[]> => {
  if (texts.length === 0) return [];
  if (targetLanguage === 'English') return texts;

  const langCode = targetLanguage === 'Hebrew' ? 'he' : targetLanguage === 'Arabic' ? 'ar' : targetLanguage === 'Russian' ? 'ru' : 'en';
  
  // Filter out texts already in the target language or already cached
  const toTranslate: string[] = [];
  const results: string[] = new Array(texts.length).fill('');
  
  texts.forEach((text, i) => {
    const cacheKey = `${targetLanguage}:${text}`;
    if (translationCache[cacheKey]) {
      results[i] = translationCache[cacheKey];
    } else if (isAlreadyInLanguage(text, langCode)) {
      results[i] = text;
    } else {
      toTranslate.push(text);
    }
  });

  if (toTranslate.length === 0) return results;

  try {
    const ai = getAI();
    if (!ai) return texts;

    // We use a structured prompt to get back a JSON array or clear list
    const prompt = `Translate the following list of strings to ${targetLanguage}. 
Return ONLY a valid JSON array of strings in the exact same order.
If you cannot translate a string, return the original.

List:
${JSON.stringify(toTranslate)}`;

    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: [{ parts: [{ text: prompt }] }],
    });
    
    const responseText = response.text?.trim() || "";
    let translatedArray: string[] = [];
    
    try {
      // Try to parse as JSON first
      const jsonMatch = responseText.match(/\[.*\]/s);
      if (jsonMatch) {
        translatedArray = JSON.parse(jsonMatch[0]);
      } else {
        // Fallback: split by lines if it's not JSON
        translatedArray = responseText.split('\n').map(l => cleanTranslatedText(l));
      }
    } catch (e) {
      console.warn("Batch translation parse failed, falling back to individual translation", e);
      // If batch fails, we don't want to fail everything
      return texts;
    }

    // Map back to original indices
    let translateIdx = 0;
    return texts.map((text, i) => {
      if (results[i]) return results[i];
      const translated = cleanTranslatedText(translatedArray[translateIdx++] || text);
      const cacheKey = `${targetLanguage}:${text}`;
      translationCache[cacheKey] = translated;
      return translated;
    });
  } catch (error: any) {
    console.error("Batch translation failed:", error);
    if (error?.message?.includes('429')) {
      isQuotaExceeded = true;
    }
    return texts;
  }
};

const processQueue = async () => {
  if (isProcessingQueue || translationQueue.length === 0) return;
  isProcessingQueue = true;

  // Wait a bit to collect more requests into the batch
  await new Promise(r => setTimeout(r, 100));

  while (translationQueue.length > 0) {
    const currentBatches: Record<string, typeof translationQueue> = {};
    
    // Group by target language
    const currentQueue = [...translationQueue];
    translationQueue = [];
    
    currentQueue.forEach(req => {
      if (!currentBatches[req.targetLanguage]) currentBatches[req.targetLanguage] = [];
      currentBatches[req.targetLanguage].push(req);
    });

    for (const [lang, reqs] of Object.entries(currentBatches)) {
      const texts = reqs.map(r => r.text);
      const translated = await translateBatch(texts, lang);
      reqs.forEach((req, i) => req.resolve(translated[i]));
      
      // Pause slightly between batches if there are multiple languages
      if (Object.keys(currentBatches).length > 1) {
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  isProcessingQueue = false;
};

/**
 * Translates text to a target language using Gemini.
 * Optimized with a queue and batching.
 */
export const translateText = (text: string, targetLanguage: string): Promise<string> => {
  const langCode = targetLanguage === 'Hebrew' ? 'he' : targetLanguage === 'Arabic' ? 'ar' : targetLanguage === 'Russian' ? 'ru' : 'en';
  
  if (isAlreadyInLanguage(text, langCode) || targetLanguage === 'English') return Promise.resolve(text);

  const cacheKey = `${targetLanguage}:${text}`;
  if (translationCache[cacheKey]) return Promise.resolve(translationCache[cacheKey]);

  return new Promise((resolve, reject) => {
    translationQueue.push({ text, targetLanguage, resolve, reject });
    processQueue();
  });
};

/**
 * Main entry point for speaking text.
 * Prioritizes high-quality Gemini TTS for Hebrew/Arabic, falls back to native.
 */
export const speakText = async (text: string, targetLanguage: string = 'en') => {
  const trimmedText = text.trim();
  if (!trimmedText) return;

  const langName = targetLanguage === 'he' ? 'Hebrew' : targetLanguage === 'ar' ? 'Arabic' : targetLanguage === 'ru' ? 'Russian' : 'English';
  const textToSpeak = await translateText(trimmedText, langName);

  // For Hebrew and Arabic, browser support is often poor or missing.
  // We prioritize Gemini TTS for these languages to avoid "German" accents.
  if ((targetLanguage === 'he' || targetLanguage === 'ar') && !isQuotaExceeded) {
    try {
      const buffer = await generateAudioBuffer(textToSpeak, targetLanguage);
      if (buffer) {
        await playAudioBuffer(buffer);
        return textToSpeak;
      }
    } catch (e) {
      console.warn("Gemini TTS failed, falling back to native");
    }
  }

  // Fallback to native TTS
  setTimeout(() => {
    speakNative(textToSpeak, targetLanguage);
  }, 50);
  
  return textToSpeak;
};
