

let audioContext: AudioContext;
let isQuotaExceeded = false;

let currentSource: AudioBufferSourceNode | null = null;
let activeSpeechSessionId = 0;

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
  if (voices.length > 0) {
    const voice = voices.find(v => v.lang === targetLang) || 
                  voices.find(v => v.lang.startsWith(langCode));
    if (voice) utterance.voice = voice;
  }

  // Adjust speaking rate to be slower and clearer for foreign languages
  if (langCode === 'he') {
    utterance.rate = 0.70; // Slow down Hebrew to exactly 0.70
  } else if (langCode === 'ar' || langCode === 'ru') {
    utterance.rate = 0.78; // Slightly slower for better pronunciation clarity
  } else {
    utterance.rate = 1.0;  // Standard speed for English
  }
  
  utterance.pitch = 1.0;
  
  console.log(`Speaking (${targetLang}): ${text}`);
  window.speechSynthesis.speak(utterance);
};

/**
 * Generates an AudioBuffer from text using Gemini TTS via server proxy.
 */
export const generateAudioBuffer = async (text: string, langCode: string = 'en'): Promise<AudioBuffer | null> => {
  if (isQuotaExceeded) return null;

  const startTime = Date.now();
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
      console.log(`[CLIENT] TTS generated in ${Date.now() - startTime}ms`);
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
 * Generates an AudioBuffer from text using Gemini TTS via server proxy.
 * Optimized specifically for the Fast TTS endpoint which handles translation too.
 */
export const generateFastAudioBuffer = async (text: string, targetLanguage: string, langCode: string): Promise<{ buffer: AudioBuffer | null, translatedText: string }> => {
  if (isQuotaExceeded) return { buffer: null, translatedText: text };

  const startTime = Date.now();
  try {
    const response = await fetch('/api/ai/fast-tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, targetLanguage, langCode })
    });

    if (!response.ok) throw new Error("Fast TTS proxy failed");
    
    const data = await response.json();
    const base64Audio = data.audio;
    const translatedText = data.translatedText || text;
    
    if (base64Audio) {
      console.log(`[CLIENT] Fast TTS generated in ${Date.now() - startTime}ms`);
      const ctx = getAudioContext();
      const audioData = decodeBase64(base64Audio);
      const buffer = await decodeAudioData(audioData, ctx);
      return { buffer, translatedText };
    }
  } catch (error: any) {
    console.error("Fast TTS failed:", error);
  }
  return { buffer: null, translatedText: text };
};

/**
 * Plays a pre-generated AudioBuffer. Returns a promise that resolves when playback completes.
 */
export const playAudioBuffer = (buffer: AudioBuffer, langCode?: string): Promise<void> => {
  return new Promise((resolve) => {
    if (currentSource) {
      try {
        currentSource.stop();
      } catch (e) {}
      currentSource = null;
    }

    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
    
    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Slow down playback rate specifically for Hebrew & other languages to improve comfort & comprehension
    if (langCode === 'he') {
      source.playbackRate.value = 0.70; // 30% slower for natural, clear, relaxed Hebrew speech (0.7 rate)
    } else if (langCode === 'ar' || langCode === 'ru') {
      source.playbackRate.value = 0.78; // 22% slower for comfortable Arabic & Russian speech
    } else {
      source.playbackRate.value = 1.0;  // Normal speed
    }

    source.connect(ctx.destination);
    
    let resolved = false;
    const handleEnd = () => {
      if (!resolved) {
        resolved = true;
        if (currentSource === source) {
          currentSource = null;
        }
        resolve();
      }
    };

    source.onended = handleEnd;
    
    try {
      source.start(0);
      currentSource = source;
    } catch (e) {
      console.error("Failed to start audio source", e);
      resolve();
    }
  });
};

/**
 * Stops any ongoing speech (both Gemini/ElevenLabs and Native)
 */
export const stopSpeaking = () => {
  activeSpeechSessionId++;
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

// Warm up browser speech synthesis voices array immediately
if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  window.speechSynthesis.getVoices();
  if (window.speechSynthesis.onvoiceschanged !== undefined) {
    window.speechSynthesis.onvoiceschanged = () => {
      window.speechSynthesis.getVoices();
    };
  }
}

const translationCache: Record<string, string> = {};

const cleanTranslatedText = (text: string): string => {
  // Remove common AI prefixes like "Translation:", "Translated text:", etc.
  return text
    .replace(/^(translation|translated text|hebrew|arabic|russian|english):\s*/i, '')
    .replace(/^["']|["']$/g, '') // Remove quotes
    .trim();
};

const isAlreadyInLanguage = (text: string, langCode: string): boolean => {
  if (langCode !== 'en') {
    // If we're translating to an eastern/other language and there are Latin words with 3+ letters,
    // we should not assume it's already in the target language. We want to translate those.
    if (/[a-zA-Z]{3,}/.test(text)) {
      return false;
    }
  }

  if (langCode === 'he') return /[\u0590-\u05FF]/.test(text);
  if (langCode === 'ar') return /[\u0600-\u06FF]/.test(text);
  if (langCode === 'ru') return /[\u0400-\u04FF]/.test(text);
  if (langCode === 'en') return !/[\u0590-\u05FF\u0600-\u06FF\u0400-\u04FF]/.test(text);
  return false;
};

const cleanTranslationTextClient = (txt: string): string => {
  return txt
    .replace(/^(translation|translated text|hebrew|arabic|russian|english|עברית|ערבית|רוסית|אנגלית):\s*/i, '')
    .replace(/^["'“”]|["'“”]$/g, '') // Remove quotes including smart quotes
    .replace(/\*\*+/g, "") // Remove bold markdown symbols
    .replace(/__+/g, "")
    .replace(/`+/g, "")
    .replace(/\[[^\]]*\]/g, "") // Remove brackets with text inside (e.g. [Mesh], [Object])
    .replace(/נ"צ מוצר/g, "מק\"ט")
    .replace(/נ"צ/g, "מק\"ט")
    // Replace colons, semicolons, and dashes representing labels/separators with a full stop and space to force a beautiful pause between sections
    .replace(/:/g, ".  ")
    .replace(/;/g, ".  ")
    .replace(/\s*[\/\\]\s*/g, ",  ") // Clean slashes with spacious commas
    .replace(/[#*•\-_]+/g, " ") // Clean weird marks
    // Keep pauses when reading lists or categories
    .replace(/,\s*/g, ",  ") // Expand existing commas with a bit more spacing for breathing room
    .replace(/\s+/g, " ") // Clean multiple spaces
    .trim();
};

/**
 * Translates a batch of strings in a single request via server proxy.
 */
export const translateBatch = async (texts: string[], targetLanguage: string): Promise<string[]> => {
  if (texts.length === 0) return [];

  const langCode = targetLanguage === 'Hebrew' ? 'he' : targetLanguage === 'Arabic' ? 'ar' : targetLanguage === 'Russian' ? 'ru' : 'en';
  
  // Filter out texts already in the target language or already cached
  const toTranslate: string[] = [];
  const results: string[] = new Array(texts.length).fill('');
  const toTranslateIndices: number[] = [];
  
  texts.forEach((text, i) => {
    const cacheKey = `${langCode}:${text}`;
    if (translationCache[cacheKey]) {
      results[i] = translationCache[cacheKey];
    } else if (isAlreadyInLanguage(text, langCode)) {
      results[i] = text;
    } else {
      toTranslate.push(text);
      toTranslateIndices.push(i);
    }
  });

  if (toTranslate.length === 0) return results;

  try {
    const response = await fetch('/api/ai/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: toTranslate, targetLanguage })
    });

    if (!response.ok) throw new Error("Translation proxy failed");
    
    const { translated: translatedArray } = await response.json();
    
    if (!Array.isArray(translatedArray)) throw new Error("Invalid response from translation proxy");

    // Map back to original indices
    translatedArray.forEach((translated, idx) => {
      const originalIdx = toTranslateIndices[idx];
      const originalText = toTranslate[idx];
      const cleaned = cleanTranslatedText(translated || originalText);
      results[originalIdx] = cleaned;
      
      const cacheKey = `${langCode}:${originalText}`;
      translationCache[cacheKey] = cleaned;
    });

    return results;
  } catch (error: any) {
    console.error("Batch translation failed:", error);
    // Return original on failure
    texts.forEach((t, i) => { if (!results[i]) results[i] = t; });
    return results;
  }
};

/**
 * Translates text to a target language using Gemini.
 * Optimized with immediate fetch for single requests and caching.
 */
export const translateText = async (text: string, targetLanguage: string): Promise<string> => {
  const trimmedText = text.trim();
  if (!trimmedText) return "";
  
  const langCode = targetLanguage === 'Hebrew' ? 'he' : targetLanguage === 'Arabic' ? 'ar' : targetLanguage === 'Russian' ? 'ru' : 'en';
  const cacheKey = `${langCode}:${trimmedText}`;
  if (translationCache[cacheKey]) return translationCache[cacheKey];

  if (isAlreadyInLanguage(trimmedText, langCode)) {
    translationCache[cacheKey] = trimmedText;
    return trimmedText;
  }

  const startTime = Date.now();
  try {
    const response = await fetch('/api/ai/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts: [trimmedText], targetLanguage }),
    });

    if (!response.ok) throw new Error("Translation failed");
    const data = await response.json();
    const result = cleanTranslatedText(data.translated?.[0] || trimmedText);
    translationCache[cacheKey] = result;
    console.log(`[CLIENT] Translation took ${Date.now() - startTime}ms`);
    return result;
  } catch (error) {
    console.error("Single translation failed:", error);
    return trimmedText;
  }
};

/**
 * Main entry point for speaking text.
 * Instantly updates the UI by translating context-preserving full blocks,
 * and handles playing the speech using either zero-delay Native Speech for Hebrew,
 * or premium ElevenLabs TTS for other languages.
 */
export const speakText = async (text: string, targetLanguage: string = 'en'): Promise<string> => {
  const trimmedText = text.trim();
  if (!trimmedText) return "";

  const langCode = targetLanguage === 'he' ? 'he' : targetLanguage === 'ar' ? 'ar' : targetLanguage === 'ru' ? 'ru' : 'en';
  const langName = targetLanguage === 'he' ? 'Hebrew' : targetLanguage === 'ar' ? 'Arabic' : targetLanguage === 'ru' ? 'Russian' : 'English';

  // 1. Uniquely track this speech session to handle interruptions cleanly.
  stopSpeaking(); // Halts current speaking, native speech immediately, and increments activeSpeechSessionId
  const sessionId = activeSpeechSessionId;

  // Ensure AudioContext is woke up
  try {
    const ctx = getAudioContext();
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch (e) {}

  // 2. Determine if the text is already translated (e.g., contains Hebrew for Hebrew language, or English for English)
  const isAlreadyTranslated = isAlreadyInLanguage(trimmedText, langCode) || langCode === 'en';

  if (isAlreadyTranslated) {
    // 0ms delay! Play instantly because the text is already translated (often via background pre-translation)
    const cleanedTextForSpeech = cleanTranslationTextClient(trimmedText);
    console.log(`[TTS] Speaking already translated text instantly (${langCode}): "${cleanedTextForSpeech}"`);

    // For all client-side premium languages, play using ElevenLabs (no waiting for translation)
    // Play the full block to preserve elegant speech patterns and avoid choppy silence gaps
    try {
      const buffer = await generateAudioBuffer(cleanedTextForSpeech, langCode);
      if (sessionId === activeSpeechSessionId && buffer) {
        await playAudioBuffer(buffer, langCode);
      }
    } catch (err) {
      console.error("[TTS] ElevenLabs audio failed, falling back to instant native speech as last resort", err);
      if (sessionId === activeSpeechSessionId) {
        speakNative(cleanedTextForSpeech, langCode);
      }
    }
    return trimmedText;
  }

  // 3. Otherwise, translate the entire description block at once.
  // This preserves translation context perfectly and avoids breaking numbers, lists, or colons!
  console.log(`[TTS] Text is not yet translated. Translating entire block to ${langName} in one call...`);
  try {
    const translatedText = await translateText(trimmedText, langName);
    if (sessionId !== activeSpeechSessionId) {
      return ""; // Session was cancelled by subsequent interaction
    }

    const cleanedTextForSpeech = cleanTranslationTextClient(translatedText);
    console.log(`[TTS] Speaking newly translated text (${langCode}): "${cleanedTextForSpeech}"`);

    try {
      const buffer = await generateAudioBuffer(cleanedTextForSpeech, langCode);
      if (sessionId === activeSpeechSessionId && buffer) {
        await playAudioBuffer(buffer, langCode);
      }
    } catch (err) {
      console.error("[TTS] ElevenLabs audio failed after translation, falling back to instant native speech as last resort", err);
      if (sessionId === activeSpeechSessionId) {
        speakNative(cleanedTextForSpeech, langCode);
      }
    }
    return translatedText;
  } catch (err) {
    console.error(`[TTS] Translate & Speak failed:`, err);
    // Fallback to native speech with original text
    const cleanedOriginal = cleanTranslationTextClient(trimmedText);
    speakNative(cleanedOriginal, langCode);
    return trimmedText;
  }
};
