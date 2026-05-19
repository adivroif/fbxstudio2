

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
): Promise<AudioBuffer> {
  // Create a copy because decodeAudioData transfers/detaches the buffer
  const bufferCopy = data.buffer.slice(0);
  
  try {
    // browser's native decodeAudioData is much more robust for various formats
    return await ctx.decodeAudioData(data.buffer);
  } catch (e) {
    console.warn("Native decode failed, attempting raw PCM fallback", e);
    // Fallback to manual PCM decoding if native fails
    const numChannels = 1;
    const sampleRate = 24000;
    const dataInt16 = new Int16Array(bufferCopy);
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

  const voices = window.speechSynthesis.getVoices();
  const setVoice = () => {
    if (voices.length > 0) {
      const voice = voices.find(v => v.lang === targetLang) || 
                    voices.find(v => v.lang.startsWith(langCode));
      
      if (voice) {
        utterance.voice = voice;
        return true;
      }
    }
    return false;
  };

  // If voices aren't loaded yet, wait for them
  if (voices.length === 0) {
    window.speechSynthesis.onvoiceschanged = () => {
      const updatedVoices = window.speechSynthesis.getVoices();
      const voice = updatedVoices.find(v => v.lang === targetLang) || 
                    updatedVoices.find(v => v.lang.startsWith(langCode));
      if (voice) utterance.voice = voice;
      window.speechSynthesis.speak(utterance);
    };
    return;
  }

  setVoice();

  utterance.rate = 0.9; 
  utterance.pitch = 1.0;
  
  console.log(`Speaking (${targetLang}): ${text}`);
  window.speechSynthesis.speak(utterance);
};

/**
 * Generates an AudioBuffer from text using Gemini TTS via server proxy.
 */
export const generateAudioBuffer = async (text: string, langCode: string = 'en'): Promise<AudioBuffer | null> => {
  if (isQuotaExceeded) return null;

  try {
    const response = await fetch('/api/ai/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, langCode })
    });

    if (!response.ok) throw new Error("TTS proxy failed");
    
    const data = await response.json();
    const base64Audio = data.audio;
    
    if (base64Audio) {
      const ctx = getAudioContext();
      const audioData = decodeBase64(base64Audio);
      return await decodeAudioData(audioData, ctx);
    }
  } catch (error: any) {
    console.error("TTS failed:", error);
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
 * Translates a batch of strings in a single request via server proxy.
 */
export const translateBatch = async (texts: string[], targetLanguage: string): Promise<string[]> => {
  if (texts.length === 0) return [];
  if (targetLanguage === 'English') return texts;

  const langCode = targetLanguage === 'Hebrew' ? 'he' : targetLanguage === 'Arabic' ? 'ar' : targetLanguage === 'Russian' ? 'ru' : 'en';
  
  // Filter out texts already in the target language or already cached
  const toTranslate: string[] = [];
  const results: string[] = new Array(texts.length).fill('');
  const toTranslateIndices: number[] = [];
  
  texts.forEach((text, i) => {
    const cacheKey = `${targetLanguage}:${text}`;
    if (translationCache[cacheKey]) {
      results[i] = translationCache[cacheKey];
    } else if (isAlreadyInLanguage(text, langCode)) {
      results[i] = text;
    } else {
      toTranslate.push(text);
      toTranslateIndices.push(i);
    }
  });

  // Group unique texts to be translated to avoid redundant API calls
  const uniqueToTranslate = Array.from(new Set(toTranslate));
  
  if (uniqueToTranslate.length === 0) return results;

  try {
    console.log(`[Translation] Requesting batch of ${uniqueToTranslate.length} unique items (from ${texts.length} total)`);
    const response = await fetch('/api/ai/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: uniqueToTranslate, targetLanguage })
    });

    if (!response.ok) throw new Error("Translation proxy failed");
    
    const { translated: translatedUniqueArray } = await response.json();
    
    if (!Array.isArray(translatedUniqueArray) || translatedUniqueArray.length !== uniqueToTranslate.length) {
      throw new Error("Invalid response length from translation proxy");
    }

    // Create a map for quick lookup of translated unique texts
    const uniqueMap: Record<string, string> = {};
    uniqueToTranslate.forEach((original, idx) => {
      uniqueMap[original] = translatedUniqueArray[idx];
    });

    // Map back to all original indices
    toTranslateIndices.forEach((originalIdx) => {
      const originalText = texts[originalIdx];
      const translated = uniqueMap[originalText] || originalText;
      const cleaned = cleanTranslatedText(translated);
      results[originalIdx] = cleaned;
      
      const cacheKey = `${targetLanguage}:${originalText}`;
      translationCache[cacheKey] = cleaned;
    });

    return results;
  } catch (error: any) {
    console.error("Batch translation failed:", error);
    if (error?.message?.includes('429')) {
      isQuotaExceeded = true;
    }
    // Return original on failure
    texts.forEach((t, i) => { if (!results[i]) results[i] = t; });
    return results;
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
