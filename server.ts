import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import * as dotenv from 'dotenv';

// Load environment variables as early as possible
dotenv.config();

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pipeline } from "stream/promises";
import { GoogleGenAI, Modality, ThinkingLevel } from "@google/genai";
import { v2 } from '@google-cloud/translate';

const { Translate } = v2;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Gemini
let aiInstance: GoogleGenAI | null = null;
const getAI = () => {
  if (!aiInstance) {
    const apiKey = process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("⚠️ Warning: GEMINI_API_KEY or GEMINI_API_KEY1 is missing from environment. TTS will not work.");
      return null;
    }
    console.log("Initializing Gemini AI with API Key from environment (" + (process.env.GEMINI_API_KEY1 ? "GEMINI_API_KEY1" : "GEMINI_API_KEY") + ")");
    aiInstance = new GoogleGenAI({ 
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        }
      }
    });
  }
  return aiInstance;
};

// Initialize Google Cloud Translate
let translateClient: v2.Translate | null = null;
const getTranslate = () => {
  if (!translateClient) {
    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.warn("⚠️ Warning: GOOGLE_TRANSLATE_API_KEY is missing from environment. Translations will use fallback.");
      return null;
    }
    console.log("Initializing Cloud Translate with API Key (first 5 chars):", apiKey.substring(0, 5) + "...");
    translateClient = new Translate({ key: apiKey });
  }
  return translateClient;
};

// Initialize R2 Client (S3 compatible)
const getR2Client = () => {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
};

// Validate R2 configuration
const validateR2Config = () => {
  const required = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME"];
  const missing = required.filter(key => !process.env[key]);
  if (missing.length > 0) {
    console.warn(`⚠️ Warning: Missing R2 environment variables: ${missing.join(", ")}`);
    console.warn("R2 features (Asset Library) will not work correctly until these are configured in the Settings menu.");
  } else {
    console.log("✅ R2 configuration detected.");
  }
};

// Utility for fetching with a timeout
async function fetchWithTimeout(url: string, options: any = {}, timeout = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => {
    console.warn(`Fetch to ${url} timed out after ${timeout}ms - Aborting`);
    controller.abort();
  }, timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error: any) {
    clearTimeout(id);
    if (error.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeout}ms`);
    }
    throw error;
  }
}

// --- AZURE WEB SERVICE LOCAL PERSISTENT CACHE AND RETRY SETUP ---
const azureCacheDir = path.join(process.cwd(), "local_azure_cache");
const listsCacheDir = path.join(azureCacheDir, "lists");
const filesCacheDir = path.join(azureCacheDir, "files");

function ensureAzureCacheDirs() {
  try {
    if (!fs.existsSync(azureCacheDir)) fs.mkdirSync(azureCacheDir, { recursive: true });
    if (!fs.existsSync(listsCacheDir)) fs.mkdirSync(listsCacheDir, { recursive: true });
    if (!fs.existsSync(filesCacheDir)) fs.mkdirSync(filesCacheDir, { recursive: true });
  } catch (err) {
    console.error("⚠️ Failed to create Azure cache directories:", err);
  }
}

// Call directories setup immediately on startup
ensureAzureCacheDirs();

function getSeededDefaultList(folder: string) {
  if (folder === "tenants") {
    return [
      { "FileName": "Axe.fbx", "name": "Axe.fbx", "size": 12582912, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "axe.fbx", "name": "axe.fbx", "size": 12582912, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "Connector.fbx", "name": "Connector.fbx", "size": 3145728, "lastModified": "2026-06-01T12:00:00.000Z" }
    ];
  } else if (folder === "images") {
    return [
      { "FileName": "wallpaper_customer_maxis.png", "name": "wallpaper_customer_maxis.png", "size": 345000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "wallpaper_customer_maxis_only_logo.png", "name": "wallpaper_customer_maxis_only_logo.png", "size": 124000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "axe_BaseColor.png", "name": "axe_BaseColor.png", "size": 512000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "axe_Normal.png", "name": "axe_Normal.png", "size": 824000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "axe_Roughness.png", "name": "axe_Roughness.png", "size": 412000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "axe_Metalness.png", "name": "axe_Metalness.png", "size": 256000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "axe_AO.png", "name": "axe_AO.png", "size": 312000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "Axe_lower_texture_BaseColor.png", "name": "Axe_lower_texture_BaseColor.png", "size": 512000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "Axe_lower_texture_Normal.png", "name": "Axe_lower_texture_Normal.png", "size": 824000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "Axe_lower_texture_Roughness.png", "name": "Axe_lower_texture_Roughness.png", "size": 412000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "Connector_BaseColor.png", "name": "Connector_BaseColor.png", "size": 512000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "Connector_Normal.png", "name": "Connector_Normal.png", "size": 824000, "lastModified": "2026-06-01T12:00:00.000Z" },
      { "FileName": "Connector_Roughness.png", "name": "Connector_Roughness.png", "size": 412000, "lastModified": "2026-06-01T12:00:00.000Z" }
    ];
  }
  return [];
}

function getLocalCachedListPath(folder: string, clientName: string) {
  return path.join(listsCacheDir, `${folder}_${clientName}.json`);
}

function getLocalCachedFilePath(folder: string, fileName: string) {
  return path.join(filesCacheDir, folder, fileName);
}

// Helper to locate a file in the local cache folder that is highly similar (e.g., handles UDIM .1002, whitespace, casing mismatches)
function fuzzyLocateCachedFile(folder: string, requestedFileName: string): string | null {
  const targetDir = path.join(filesCacheDir, folder);
  if (!fs.existsSync(targetDir)) return null;

  try {
    const files = fs.readdirSync(targetDir);
    if (files.length === 0) return null;

    // Direct match check first
    if (files.includes(requestedFileName)) {
      return requestedFileName;
    }

    // Exact name match check with custom casing
    const reqLower = requestedFileName.toLowerCase().trim();
    const lcMatch = files.find(f => f.toLowerCase().trim() === reqLower);
    if (lcMatch) return lcMatch;

    // Prepare requested properties for comparison
    const reqExt = path.extname(requestedFileName).toLowerCase();
    const reqBase = path.basename(requestedFileName, reqExt).trim();
    const reqNormalized = reqBase.replace(/[^a-z0-9]/gi, "").toLowerCase();

    let bestMatch: string | null = null;
    let bestScore = 0;

    for (const diskFile of files) {
      const diskExt = path.extname(diskFile).toLowerCase();
      const diskBase = path.basename(diskFile, diskExt).trim();
      
      const sameExt = diskExt === reqExt;
      const diskNormalized = diskBase.replace(/[^a-z0-9]/gi, "").toLowerCase();

      let score = 0;

      // 1. Check if diskBase starts with reqBase followed by a dot or underscore and number (e.g., Axe__pblue_axe__BaseColor.1002.png)
      const escapedBase = reqBase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const udimRegex = new RegExp("^" + escapedBase + "[._]?\\d+$", "i");
      if (udimRegex.test(diskBase)) {
        score = 95;
      }
      // 2. Check if diskBase starts with reqBase or vice versa
      else if (diskBase.toLowerCase().startsWith(reqBase.toLowerCase()) || reqBase.toLowerCase().startsWith(diskBase.toLowerCase())) {
        score = 80;
      }
      // 3. Check if normalized forms are identical
      else if (reqNormalized && diskNormalized && reqNormalized === diskNormalized) {
        score = 75;
      }
      // 4. Check if one normalized contains another
      else if (reqNormalized && diskNormalized && (diskNormalized.includes(reqNormalized) || reqNormalized.includes(diskNormalized))) {
        score = 60;
      }

      // Small score modification if they have primary matching extensions
      if (score > 0 && sameExt) {
        score += 5;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = diskFile;
      }
    }

    // Only accept matches with solid confidence
    if (bestScore >= 50 && bestMatch) {
      console.log(`[Fuzzy Match Tool] Mapped requested "${requestedFileName}" to cached disk file "${bestMatch}" (score: ${bestScore})`);
      return bestMatch;
    }
  } catch (err: any) {
    console.error(`[Fuzzy Match Tool] Error searching cache directory:`, err.message);
  }

  return null;
}

// Helper to locate a file in the virtual list (images_tenantA.json or tenants_tenantA.json) before it is downloaded to disk
function fuzzyLocateInFileList(folder: string, requestedFileName: string, clientName: string): string | null {
  const cachePath = getLocalCachedListPath(folder, clientName);
  if (!fs.existsSync(cachePath)) return null;

  try {
    const listData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const items = Array.isArray(listData) ? listData : (listData.files || listData.items || listData.data || []);
    if (!items || items.length === 0) return null;

    const fileNames: string[] = items.map((item: any) => {
      if (typeof item === 'string') return item;
      return item.fileName || item.FileName || item.name || item.Name || "";
    }).filter(Boolean);

    // 1. Direct match check first
    if (fileNames.includes(requestedFileName)) {
      return requestedFileName;
    }

    // 2. Case-insensitive exact trim match
    const reqLower = requestedFileName.toLowerCase().trim();
    const lcMatch = fileNames.find(f => f.toLowerCase().trim() === reqLower);
    if (lcMatch) return lcMatch;

    // 3. Special clean check for UDIM numbers and other variants
    const reqExt = path.extname(requestedFileName).toLowerCase();
    const reqBase = path.basename(requestedFileName, reqExt).trim();
    const reqNormalized = reqBase.replace(/[^a-z0-9]/gi, "").toLowerCase();

    let bestMatch: string | null = null;
    let bScore = 0;

    for (const fileName of fileNames) {
      const diskExt = path.extname(fileName).toLowerCase();
      const diskBase = path.basename(fileName, diskExt).trim();
      const sameExt = diskExt === reqExt;
      const diskNormalized = diskBase.replace(/[^a-z0-9]/gi, "").toLowerCase();

      let score = 0;

      // Class 1: Starts with reqBase followed by a dot/underscore and a number (UDIM mismatch)
      // e.g., Axe__pblue_axe__BaseColor.1002.png from Axe__pblue_axe__BaseColor.png
      const escapedBase = reqBase.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const udimRegex = new RegExp("^" + escapedBase + "[._]?\\d+$", "i");
      if (udimRegex.test(diskBase)) {
        score = 95;
      }
      // Class 2: diskBase contains reqBase
      else if (diskBase.toLowerCase().startsWith(reqBase.toLowerCase()) || reqBase.toLowerCase().startsWith(diskBase.toLowerCase())) {
        score = 80;
      }
      // Class 3: Normalized alphabetic matching
      else if (reqNormalized && diskNormalized && reqNormalized === diskNormalized) {
        score = 75;
      }
      // Class 4: Contains
      else if (reqNormalized && diskNormalized && (diskNormalized.includes(reqNormalized) || reqNormalized.includes(diskNormalized))) {
        score = 60;
      }

      // Tie-breakers
      if (score > 0) {
        const diskBaseLower = diskBase.toLowerCase();
        const reqBaseLower = reqBase.toLowerCase();
        
        // If they have same extension
        if (sameExt) {
          score += 5;
        }

        // If they both mention similar suffixes or neither mentions other map types
        const mapKeywords = ['normal', 'metal', 'rough', 'opacity', 'alpha', 'ao', 'height', 'emissive', 'specular', 'bump', 'basecolor', 'diffuse', 'albedo', 'color'];
        const reqHasKeyword = mapKeywords.some(kw => reqBaseLower.includes(kw));
        const diskHasKeyword = mapKeywords.some(kw => diskBaseLower.includes(kw));
        
        if (reqHasKeyword && diskHasKeyword) {
          // If they match the specific map type keyword
          for (const kw of mapKeywords) {
            if (reqBaseLower.includes(kw) && diskBaseLower.includes(kw)) {
              score += 10;
            }
          }
        } else if (!reqHasKeyword && !diskHasKeyword) {
          // Both are standard maps
          score += 5;
        } else if (!reqHasKeyword && diskHasKeyword) {
          // Requested has no special slot keyword but disk file does. Prefer basecolor/diffuse/albedo if present
          if (diskBaseLower.includes('basecolor') || diskBaseLower.includes('diffuse') || diskBaseLower.includes('albedo')) {
            score += 4;
          } else {
            // Penalize other slots if not matching requested intent
            score -= 10;
          }
        }
      }

      if (score > bScore) {
        bScore = score;
        bestMatch = fileName;
      }
    }

    if (bScore >= 50 && bestMatch) {
      console.log(`[Fuzzy List Matcher] Resolved virtual "${requestedFileName}" to real file "${bestMatch}" (score: ${bScore})`);
      return bestMatch;
    }
  } catch (err: any) {
    console.error(`[Fuzzy List Matcher Error] Failed to search metadata list:`, err.message);
  }

  return null;
}

// --- CIRCUIT BREAKER FOR AZURE WEB SERVICE ---
let isAzureUnreachable = false;
let lastAzureFailureTimestamp = 0;
const AZURE_COOLDOWN_MS = 60000; // 1 minute cooldown

function markAzureAsUnreachable() {
  if (!isAzureUnreachable) {
    console.warn("🚨 [Circuit Breaker] Azure API appears to be down or timing out. Tripping circuit breaker - bypassing live calls for 60 seconds.");
    isAzureUnreachable = true;
  }
  lastAzureFailureTimestamp = Date.now();
}

function checkAzureAvailability(): boolean {
  if (isAzureUnreachable) {
    if (Date.now() - lastAzureFailureTimestamp > AZURE_COOLDOWN_MS) {
      console.log("🔄 [Circuit Breaker] Cooldown expired. Resetting circuit breaker to test Azure API availability.");
      isAzureUnreachable = false;
      return true;
    }
    return false;
  }
  return true;
}

async function robustFetchWithRetry(url: string, options: any = {}, initialTimeout = 5000, maxRetries = 2, bypassCircuitBreaker = false) {
  if (!bypassCircuitBreaker && !checkAzureAvailability()) {
    throw new Error("Azure API is currently unreachable (Circuit Breaker active)");
  }

  let lastErr: any = null;
  let delay = 1000; // start with 1s delay
  let timeout = initialTimeout;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[robustFetch] Attempt ${attempt}/${maxRetries} for URL: ${url} (timeout: ${timeout}ms, bypassCircuitBreaker: ${bypassCircuitBreaker})`);
    try {
      const response = await fetchWithTimeout(url, options, timeout);
      
      // If response is OK (2xx), or is not a server-error type (e.g., 502, 503, 504 are retryable)
      if (response.ok) {
        // Successful live request resets circuit breaker state
        isAzureUnreachable = false;
        return response;
      }
      
      // Don't retry if it's a client error (except timeout/rate limits)
      if (response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429) {
        console.warn(`[robustFetch] Client error ${response.status} on attempt ${attempt}. Skipping retries.`);
        return response;
      }

      console.warn(`[robustFetch] Attempt ${attempt} returned status ${response.status}. Retrying in ${delay}ms...`);
    } catch (err: any) {
      lastErr = err;
      console.warn(`[robustFetch] Attempt ${attempt} failed with error: ${err.message}. Retrying in ${delay}ms...`);
      
      // System socket timeouts or HTTP abort errors trip the circuit breaker
      if (!bypassCircuitBreaker && err.message && (err.message.includes("timed out") || err.message.includes("timeout") || err.code === "ECONNREFUSED" || err.code === "ETIMEDOUT" || err.name === "AbortError")) {
        markAzureAsUnreachable();
      }
    }

    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= 1.5; // smoother exponential backoff
      timeout = Math.min(Math.max(timeout + 5000, initialTimeout), 120000); // increase progressively up to 120s max based on initial timeout
    }
  }

  // If all attempts failed
  if (!bypassCircuitBreaker) {
    markAzureAsUnreachable();
  }
  throw lastErr || new Error(`Failed after ${maxRetries} attempts`);
}

// --- COLD START AUTO-WAKEUPS IN BACKGROUND ---
async function prewarmAzureWebService() {
  const pingUrls = [
    "https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=tenants&clientName=tenantB",
    "https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=images&clientName=tenantB"
  ];
  for (const url of pingUrls) {
    console.log(`[Warmup] Triggering background pre-warmup ping to: ${url}`);
    fetchWithTimeout(url, {}, 15000).catch(() => {}); // fire and forget/silent catcher
  }
}

// Start pings in background on server boot
prewarmAzureWebService().catch(() => {});

// --- CACHE SETUP AND SEEDING FOR MODEL PARTS ---
const cacheFilePath = path.join(process.cwd(), "model_parts_cache.json");

// Define high-quality default parts list for Axe to seed on startup
const defaultAxeParts = [
  {
    id: "axe_head_1",
    modelName: "Axe",
    partName: "Golden Axe Head",
    partKey: "pgolden_axe_head",
    description: "Rich golden alloy blade crafted for ceremonial and heavy-duty use.",
    presentAtSite: true
  },
  {
    id: "axe_handle_2",
    modelName: "Axe",
    partName: "Wooden Handle",
    partKey: "pwooden_handel",
    description: "Durable hand-grafted ash wood grip ensuring optimal feedback and balance.",
    presentAtSite: true
  },
  {
    id: "axe_pommel_3",
    modelName: "Axe",
    partName: "Golden Pommel",
    partKey: "pgold_axe_pommel",
    description: "Heavy golden counter-balance pommel situated at the base of the handle.",
    presentAtSite: true
  },
  {
    id: "axe_rune_spot_4",
    modelName: "Axe",
    partName: "Golden Rune Spot",
    partKey: "pgolden_rune_spot",
    description: "Magical rune focal point embedded on the upper guard of the weapon.",
    presentAtSite: true
  },
  {
    id: "axe_rune_5",
    modelName: "Axe",
    partName: "Silver Axe Rune",
    partKey: "psilver_axe_rune",
    description: "Carved metallic silver runes emitting a low, majestic runic shimmer.",
    presentAtSite: true
  },
  {
    id: "axe_upper_band_6",
    modelName: "Axe",
    partName: "Upper Metallic Band",
    partKey: "pgold_upper_texture",
    description: "Heavy protective gold casing stabilizing the upper neck of the shaft.",
    presentAtSite: true
  },
  {
    id: "axe_lower_grip_7",
    modelName: "Axe",
    partName: "Lower Handle Grip",
    partKey: "lower_texture",
    description: "Leather-wrapped ergonomic segment at the lower grip of the weapon.",
    presentAtSite: true
  }
];

const defaultPipeParts = [
  {
    id: "pipe_middle",
    modelName: "Pipe",
    partName: "Pipe Middle Section",
    partKey: "middle",
    description: "Main tubular conduit of the pipeline structure.",
    presentAtSite: true
  },
  {
    id: "pipe_flanges",
    modelName: "Pipe",
    partName: "Pipe Top & Bottom Flanges",
    partKey: "top___bottom",
    description: "The structural connection rims at both ends of the pipe used for coupling.",
    presentAtSite: true
  }
];

const defaultChestParts = [
  {
    id: "chest_body",
    modelName: "Chest",
    partName: "Chest Body",
    partKey: "pCube11",
    description: "The main storage structure of the container, built for heavy protection.",
    presentAtSite: true
  },
  {
    id: "chest_lid",
    modelName: "Chest",
    partName: "Chest Lid & Cover",
    partKey: "pCube14",
    description: "The hinged protective top segment allowing access into the storage void.",
    presentAtSite: true
  },
  {
    id: "chest_lock",
    modelName: "Chest",
    partName: "Reinforced Locking Hasp",
    partKey: "pCube39",
    description: "Heavy-duty locking latch system to secure internal contents.",
    presentAtSite: true
  }
];

const defaultElsaParts = [
  {
    id: "elsa_pin",
    modelName: "ELSA 2 Caliper Guide Pin 35X144mm",
    partName: "Caliper Guide Pin",
    partKey: "elsa_2_caliper_guide_pin_35_144_mm",
    description: "Precision-engineered guide pin for automotive caliper slide assembly (35x144mm).",
    presentAtSite: true
  },
  {
    id: "elsa_boot",
    modelName: "ELSA 2 Caliper Guide Pin 35X144mm",
    partName: "Protective Dust Boot",
    partKey: "boot",
    description: "Flexible rubber dust seal protecting the sliding pin from contaminants.",
    presentAtSite: true
  },
  {
    id: "elsa_bolt",
    modelName: "ELSA 2 Caliper Guide Pin 35X144mm",
    partName: "Securing Anchor Bolt",
    partKey: "bolt",
    description: "Hex-head high-strength fastener anchoring the guide pin into position.",
    presentAtSite: true
  }
];

function initializePartsCache() {
  try {
    let cacheData: any = {};
    if (fs.existsSync(cacheFilePath)) {
      cacheData = JSON.parse(fs.readFileSync(cacheFilePath, "utf-8"));
    }
    
    // Seed default parts for Axe in both "Axe" and lowercase "axe" versions
    if (!cacheData["Axe"]) {
      cacheData["Axe"] = defaultAxeParts;
    }
    if (!cacheData["axe"]) {
      cacheData["axe"] = defaultAxeParts.map(p => ({ ...p, modelName: "axe" }));
    }

    // Seed default parts for Pipe
    if (!cacheData["Pipe"]) {
      cacheData["Pipe"] = defaultPipeParts;
    }
    if (!cacheData["pipe"]) {
      cacheData["pipe"] = defaultPipeParts.map(p => ({ ...p, modelName: "pipe" }));
    }

    // Seed default parts for Chest
    if (!cacheData["Chest"]) {
      cacheData["Chest"] = defaultChestParts;
    }
    if (!cacheData["chest"]) {
      cacheData["chest"] = defaultChestParts.map(p => ({ ...p, modelName: "chest" }));
    }

    // Seed default parts for ELSA
    if (!cacheData["ELSA 2 Caliper Guide Pin 35X144mm"]) {
      cacheData["ELSA 2 Caliper Guide Pin 35X144mm"] = defaultElsaParts;
    }
    if (!cacheData["elsa 2 caliper guide pin 35x144mm"]) {
      cacheData["elsa 2 caliper guide pin 35x144mm"] = defaultElsaParts.map(p => ({ ...p, modelName: "elsa 2 caliper guide pin 35x144mm" }));
    }
    
    fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData, null, 2), "utf-8");
    console.log("✅ Model parts cache initialized and seeded.");
  } catch (err) {
    console.error("⚠️ Failed to initialize or seed parts cache:", err);
  }
}

function getCachedParts(modelName: string) {
  try {
    if (fs.existsSync(cacheFilePath)) {
      const cacheData = JSON.parse(fs.readFileSync(cacheFilePath, "utf-8"));
      // Match direct modelName or case-insensitive name without extension
      const keys = Object.keys(cacheData);
      const matchedKey = keys.find(k => k.toLowerCase() === modelName.toLowerCase() || k.toLowerCase() === modelName.toLowerCase().replace(/\.[^/.]+$/, ""));
      if (matchedKey) {
        console.log(`[Cache Hit] Loaded parts for '${modelName}' from local model_parts_cache.json (key: '${matchedKey}')`);
        return cacheData[matchedKey];
      }
    }
  } catch (err) {
    console.error("Failed to read parts cache:", err);
  }
  return null;
}

function saveCachedParts(modelName: string, parts: any[]) {
  try {
    let cacheData: any = {};
    if (fs.existsSync(cacheFilePath)) {
      cacheData = JSON.parse(fs.readFileSync(cacheFilePath, "utf-8"));
    }
    const cleanKey = modelName.replace(/\.[^/.]+$/, "");
    cacheData[cleanKey] = parts;
    fs.writeFileSync(cacheFilePath, JSON.stringify(cacheData, null, 2), "utf-8");
    console.log(`[Cache Sync] Saved parts for '${modelName}' to local model_parts_cache.json`);
  } catch (err) {
    console.error("Failed to save parts cache:", err);
  }
}

async function startServer() {
  validateR2Config();
  initializePartsCache();
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ limit: "100mb", extended: true }));

  // Ensure uploads directory exists
  const uploadDir = path.join(process.cwd(), "public", "uploads");
  if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
  }

  // Configure multer for file storage
  const storage = multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
      const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
      cb(null, uniqueSuffix + "-" + file.originalname);
    },
  });

  const upload = multer({ storage });

  // API Route for file uploads
  app.post("/api/upload", (req, res, next) => {
    console.log("Receiving upload request...");
    upload.single("file")(req, res, (err) => {
      if (err) {
        console.error("Multer error:", err);
        return res.status(500).json({ error: "Upload failed during processing", details: err.message });
      }
      next();
    });
  }, (req, res) => {
    if (!req.file) {
      console.warn("No file in request after multer");
      return res.status(400).json({ error: "No file uploaded" });
    }
    // Return the URL to the uploaded file
    const fileUrl = `/uploads/${req.file.filename}`;
    console.log(`Success: File uploaded to ${fileUrl}`);
    res.json({ url: fileUrl });
  });

  // API Route for model parts from Azure Web Service
  app.get(["/api/model-parts", "/api/ModelsParts/productName/:productName"], async (req, res) => {
    const modelName = (req.params.productName || req.query.modelName) as string;
    if (!modelName) return res.status(400).json({ error: "modelName is required" });

    const tryFetchParts = async (name: string, timeout = 5000, maxRetries = 2, bypassCircuitBreaker = false) => {
      // Clean name: remove extension and use strictly for the API call
      const cleanName = name.replace(/\.[^/.]+$/, "");
      const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/ModelsParts/productName/${encodeURIComponent(cleanName)}`;

      try {
        console.log(`Strict Fetching model parts: ${azureApiUrl} (bypassCircuitBreaker: ${bypassCircuitBreaker})`);
        const response = await robustFetchWithRetry(azureApiUrl, {}, timeout, maxRetries, bypassCircuitBreaker);

        if (!response.ok) {
          throw new Error(`Azure API responded with status: ${response.status}`);
        }

        const text = await response.text();
        if (!text || text.trim() === "") return null;
        
        try {
          const data = JSON.parse(text);
          // Standardize response to part objects
          const rawParts = Array.isArray(data) ? data : (data.parts || data.data || data.items || []);
          
          if (rawParts.length === 0) return null;

          const parts = rawParts.map((item: any) => ({
            id: (item.partId || item.PartId || Math.random().toString(36).substr(2, 9)).toString(),
            modelName: name,
            partName: item.displayName || item.display_name || item.partName || item.PartName || item.partKey || item.PartKey || "Unnamed Part",
            partKey: item.partKey || item.PartKey || "",
            description: item.description || item.Description || "",
            presentAtSite: item.presentAtSite ?? item.PresentAtSite ?? true // Default to true if not provided by API
          }));

          // Sync successful response to our local file cache
          saveCachedParts(name, parts);
          return parts;
        } catch (jsonErr) {
          console.error("Invalid JSON for parts:", jsonErr);
          return null;
        }
      } catch (err: any) {
        console.error(`Parts fetch failed from Azure for ${cleanName}:`, err.message);
        return null;
      }
    };

    const cachedParts = getCachedParts(modelName);
    const hasCache = cachedParts && cachedParts.length > 0;

    if (hasCache) {
      console.log(`[Cache First] Serving model parts instantly from cache for: ${modelName}`);

      // Asynchronously refresh in the background with a larger timeout to avoid timeout warnings
      (async () => {
        try {
          await tryFetchParts(modelName, 15000, 1, false);
        } catch (bgErr: any) {
          console.log(`[Cache Background Update Status] Skip refreshing model parts: ${bgErr.message}`);
        }
      })();

      return res.json(cachedParts);
    }

    try {
      // Use strictly the modelName (usually the filename) for the parts lookup with a robust timeout
      let parts = await tryFetchParts(modelName, 15000, 2, !hasCache);

      // FALLBACK: Serve cached or pre-seeded data if primary API did not return parts or is slow
      if (!parts || parts.length === 0) {
        console.log(`Serving cached and seeded backup for model: ${modelName}`);
        parts = getCachedParts(modelName);
      }

      if (parts && parts.length > 0) {
        return res.json(parts);
      }
      
      // If no strict match and no cache found, return empty array
      console.warn(`No DB parts found in both API and Cache for strictly matched model: ${modelName}`);
      res.json([]);
    } catch (err: any) {
      console.error("Azure API Error (Global):", err);
      res.status(500).json({ error: "Internal server error during parts fetch" });
    }
  });

  // API Route for inventory from Azure Web Service
  app.get("/api/inventory", async (req, res) => {
    const productName = req.query.productName as string;
    if (!productName) return res.status(400).json({ error: "productName is required" });

    // Use the original productName endpoint which returns an array and allows distinguishing "not found" from "0 quantity"
    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/Inventory/productName/${encodeURIComponent(productName)}`;

    try {
      console.log(`Fetching inventory from Azure API: ${azureApiUrl}`);
      const response = await robustFetchWithRetry(azureApiUrl, {}, 4500, 2, true);
      
      if (!response.ok) {
        throw new Error(`Azure API responded with status: ${response.status}`);
      }

      const text = await response.text();
      if (!text || text.trim() === "") return res.send("10"); // Default to 10 if empty
      
      let data;
      try {
        data = JSON.parse(text);
      } catch (jsonErr) {
        console.error("Failed to parse inventory JSON:", jsonErr);
        return res.send("10");
      }
      
      // If the array is empty, the product is not in the inventory system, assume it's in stock
      if (Array.isArray(data) && data.length === 0) {
        return res.send("10");
      }

      // If we have data, get the quantity from the first item
      if (Array.isArray(data) && data[0]) {
        const quantity = data[0].quantity ?? data[0].Quantity ?? 0;
        return res.send(quantity.toString());
      }

      res.send("10");
    } catch (err: any) {
      console.error("Azure Inventory API Error:", err.message);
      res.status(500).send("10"); // Default to 10 on error
    }
  });

  // API Route for product details from Azure Web Service
  app.get("/api/product-details", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    const modelName = req.query.modelName as string;
    if (!modelName) return res.status(400).json({ error: "modelName is required" });

    const cleanModelName = modelName.replace(/\.(fbx|obj|gltf|glb)$/i, '').trim();
    const productsCacheDir = path.join(azureCacheDir, "products");
    const cachePath = path.join(productsCacheDir, `product_details_${encodeURIComponent(cleanModelName.toLowerCase())}.json`);

    const hasCache = fs.existsSync(cachePath);

    const tryFetch = async (title: string, timeout = 15000, maxRetries = 2, bypassCircuitBreaker = !hasCache) => {
      try {
        const url = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/Products/productTitle/${encodeURIComponent(title)}`;
        const resp = await robustFetchWithRetry(url, {}, timeout, maxRetries, bypassCircuitBreaker);
        if (!resp.ok) return null;
        
        const text = await resp.text();
        if (!text || text.trim() === "") return null;
        
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            return parsed.length > 0 ? parsed[0] : null;
          }
          return parsed;
        } catch (jsonErr) {
          console.error(`Failed to parse JSON for product ${title}:`, jsonErr);
          return null;
        }
      } catch (err: any) {
        // Suppress repetitive logging when the circuit breaker is already active or tripped
        if (err.message && err.message.includes("Circuit Breaker")) {
          return null;
        }
        console.error(`Fetch failed for product ${title}:`, err.message || err);
        return null;
      }
    };

    if (hasCache) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        console.log(`[Cache First] Serving product details instantly from cache for: ${cleanModelName}`);
        
        // Asynchronously refresh cache in the background
        const variations = [
          cleanModelName,
          modelName,
          cleanModelName.replace(/_/g, ' '),
          cleanModelName.replace(/-/g, ' '),
          cleanModelName.charAt(0).toUpperCase() + cleanModelName.slice(1),
          cleanModelName.toLowerCase(),
          cleanModelName.toUpperCase()
        ];
        const uniqueVariations = Array.from(new Set(variations));
        
        (async () => {
          try {
            let data = await tryFetch(cleanModelName, 8000, 1, true);
            if (!data) {
              for (const variant of uniqueVariations) {
                if (variant === cleanModelName) continue;
                data = await tryFetch(variant, 4000, 1, true);
                if (data) break;
              }
            }
            if (data) {
              if (!fs.existsSync(productsCacheDir)) {
                fs.mkdirSync(productsCacheDir, { recursive: true });
              }
              fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
              console.log(`[Cache Background Update] Refreshed product details cache for: ${cleanModelName}`);
            }
          } catch (bgErr: any) {
            console.log(`[Cache Background Update Status] Skip refreshing product details: ${bgErr.message}`);
          }
        })();

        return res.json(cachedData);
      } catch (parseCacheErr) {
        console.error("Failed to parse cached product details JSON:", parseCacheErr);
      }
    }

    try {
      // Create variations to try
      const variations = [
        cleanModelName,
        modelName,
        cleanModelName.replace(/_/g, ' '),         // My_Model -> My Model
        cleanModelName.replace(/-/g, ' '),         // My-Model -> My Model
        cleanModelName.charAt(0).toUpperCase() + cleanModelName.slice(1), // camel -> Camel
        cleanModelName.toLowerCase(),
        cleanModelName.toUpperCase()
      ];

      // Remove duplicates and try each
      const uniqueVariations = Array.from(new Set(variations));
      
      let data = null;

      // Determine tuning parameters based on cache status
      const firstTimeout = hasCache ? 4000 : 8000;
      const firstRetries = hasCache ? 1 : 2;

      // 1. Try to fetch the primary variation first
      data = await tryFetch(cleanModelName, firstTimeout, firstRetries);

      // 2. If primary failed, try other variations with low timeout to prevent blocking
      if (!data) {
        for (const variant of uniqueVariations) {
          if (variant === cleanModelName) continue;
          data = await tryFetch(variant, 4000, 1);
          if (data) {
            console.log(`Matched product using variation: ${variant}`);
            break;
          }
        }
      }
      
      // If we fetched successfully, save to cache
      if (data) {
        try {
          if (!fs.existsSync(productsCacheDir)) {
            fs.mkdirSync(productsCacheDir, { recursive: true });
          }
          fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
          console.log(`[Cache System] Wrote product details cache for: ${cleanModelName}`);
        } catch (cacheErr: any) {
          console.error("Failed to write product details cache:", cacheErr.message);
        }
      }

      // If Azure lookup failed/timed out, try loading from local disk cache
      if (!data && hasCache) {
        try {
          data = JSON.parse(fs.readFileSync(cachePath, "utf8"));
          console.log(`[Cache System] Serving cached copy of product details for: ${cleanModelName}`);
        } catch (parseCacheErr) {
          console.error("Failed to parse cached product details JSON:", parseCacheErr);
        }
      }

      // If still no details (Azure completely down & first-load for model), construct a dynamic high-fidelity seeded backup
      if (!data) {
        let hash = 0;
        for (let i = 0; i < cleanModelName.length; i++) {
          hash = (hash << 5) - hash + cleanModelName.charCodeAt(i);
          hash = hash & hash;
        }
        const hex = Math.abs(hash).toString(16).padEnd(8, '0');
        const deterministicUUID = `${hex}-4000-8000-${hex.substring(0, 4)}-${hex.substring(4, 8)}`.padEnd(36, '0');

        data = {
          productId: deterministicUUID,
          tenantId: "5f6c7a95-3d07-45c7-bcf6-33da948817d1",
          tenantName: "tenantB",
          sku: `SKU-${cleanModelName.toUpperCase()}`,
          productCategory: "3D Assets",
          productTitle: cleanModelName,
          productDescription: `A high-fidelity 3D model of ${cleanModelName}, fully optimized for layout engineering and custom texture studio configurations.`,
          viewCount: Math.floor(100 + Math.abs(hash) % 500),
          likeCount: Math.floor(20 + Math.abs(hash) % 200),
          dislikeCount: Math.floor(Math.abs(hash) % 10),
          interactiveTime: Math.floor(100 + Math.abs(hash) % 400),
          createdDate: "2026-06-01T12:00:00.000Z"
        };
        console.log(`[Proxy Fallback] Serving generated default product details for: ${cleanModelName}`);
      }

      return res.json(data);
    } catch (err: any) {
      console.error("Azure Product Details API Error:", err);
      res.status(500).json({ error: "Failed to fetch product details", details: err.message });
    }
  });

  // NEW: API Proxy Routes for Product Views, Likes, Dislikes, and Time
  app.put("/api/products/:productId/view", async (req, res) => {
    const { productId } = req.params;
    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/Products/${encodeURIComponent(productId)}/view`;
    try {
      console.log(`PUT request for view proxy: ${azureApiUrl}`);
      const response = await fetchWithTimeout(azureApiUrl, {
        method: "PUT"
      }, 15000);
      if (!response.ok) {
        return res.status(response.status).send(await response.text());
      }
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      console.error(`Error in view proxy for product ${productId}:`, err);
      res.status(500).json({ error: "Failed to increment view", details: err.message });
    }
  });

  app.put("/api/products/:productId/like", async (req, res) => {
    const { productId } = req.params;
    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/Products/${encodeURIComponent(productId)}/like`;
    try {
      console.log(`PUT request for like proxy: ${azureApiUrl}`);
      const response = await fetchWithTimeout(azureApiUrl, {
        method: "PUT"
      }, 15000);
      if (!response.ok) {
        return res.status(response.status).send(await response.text());
      }
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      console.error(`Error in like proxy for product ${productId}:`, err);
      res.status(500).json({ error: "Failed to like product", details: err.message });
    }
  });

  app.put("/api/products/:productId/dislike", async (req, res) => {
    const { productId } = req.params;
    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/Products/${encodeURIComponent(productId)}/dislike`;
    try {
      console.log(`PUT request for dislike proxy: ${azureApiUrl}`);
      const response = await fetchWithTimeout(azureApiUrl, {
        method: "PUT"
      }, 15000);
      if (!response.ok) {
        return res.status(response.status).send(await response.text());
      }
      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      console.error(`Error in dislike proxy for product ${productId}:`, err);
      res.status(500).json({ error: "Failed to dislike product", details: err.message });
    }
  });

  // NEW: API Route for categories by tenant name
  app.get("/api/categories/:tenantName", async (req, res) => {
    const { tenantName } = req.params;
    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/categories/tenantName/${encodeURIComponent(tenantName)}`;

    try {
      console.log(`Fetching categories from Azure API: ${azureApiUrl}`);
      let response;
      try {
        response = await fetchWithTimeout(azureApiUrl, {}, 45000);
      } catch (err) {
        console.warn(`Initial categories fetch threw error, retrying...`, err);
        response = await fetchWithTimeout(azureApiUrl, {}, 60000);
      }
      
      // Also retry if not ok but didn't throw
      if (!response.ok) {
        console.warn(`Initial categories fetch returned not-ok status, retrying...`);
        response = await fetchWithTimeout(azureApiUrl, {}, 60000);
      }

      if (!response.ok) {
        throw new Error(`Azure API responded with status: ${response.status}`);
      }

      const data = await response.json();
      res.json(data);
    } catch (err: any) {
      console.error("Azure Categories API Error:", err);
      res.status(500).json({ error: "Failed to fetch categories from Azure", details: err.message });
    }
  });

  // NEW: Robust Helper for serving files resiliently with caching and fuzzy-matching fallbacks
  async function handleGetFileResiliently(folder: string, fileName: string, clientName: string, res: any) {
    const activeClient = clientName || "tenantB";
    
    // Step 0: Pre-resolve virtual/relative filenames using the metadata list if available
    let targetFileName = fileName;
    const listResolvedName = fuzzyLocateInFileList(folder, fileName, activeClient);
    if (listResolvedName) {
      console.log(`[Cache System] Pre-resolved virtual filename "${fileName}" to real filename "${listResolvedName}" via metadata list`);
      targetFileName = listResolvedName;
    }

    // Step 1: Check for exact match in the disk cache
    let localFilePath = getLocalCachedFilePath(folder, targetFileName);
    let hasCache = fs.existsSync(localFilePath);

    // Step 2: Try fuzzy-matching on disk before calling Azure as a safeguard
    if (!hasCache) {
      const fuzzyDiskName = fuzzyLocateCachedFile(folder, targetFileName);
      if (fuzzyDiskName) {
        console.log(`[Cache System] Fuzzy match found on disk: "${targetFileName}" mapped to "${fuzzyDiskName}"`);
        targetFileName = fuzzyDiskName;
        localFilePath = getLocalCachedFilePath(folder, targetFileName);
        hasCache = true;
      }
    }

    if (hasCache) {
      console.log(`[Cache First] Serving file instantly from local cache: ${localFilePath}`);
      const ext = path.extname(targetFileName).toLowerCase();
      const mimeTypes: Record<string, string> = {
        '.fbx': 'application/octet-stream',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.tga': 'image/tga',
        '.dds': 'image/dds',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp'
      };
      if (mimeTypes[ext]) {
        res.setHeader("Content-Type", mimeTypes[ext]);
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=31536000");
      
      return res.sendFile(path.resolve(localFilePath));
    }

    // Step 3: Call Azure since we had a cache miss (requesting targetFileName)
    const azureFileUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-file?folder=${folder}&fileName=${encodeURIComponent(targetFileName)}&clientName=${activeClient}`;
    try {
      console.log(`[Proxy] Resilient request for ${folder}/${targetFileName} (original: ${fileName}). URL: ${azureFileUrl} (cacheStatus: MISS)`);
      
      const ext = path.extname(targetFileName).toLowerCase();
      const isFbx = ext === '.fbx';
      const fetchTimeout = isFbx ? 90000 : 30000;
      
      const response = await robustFetchWithRetry(azureFileUrl, {}, fetchTimeout, isFbx ? 3 : 2, true);
      
      if (!response.ok) {
        throw new Error(`Azure responded with non-ok status: ${response.status}`);
      }

      // Read array buffer and validate it is not HTML error/redirect content
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      const firstChars = buffer.toString('utf8', 0, 100).trim().toLowerCase();
      const isHtml = firstChars.startsWith('<!doctype') || firstChars.startsWith('<html') || firstChars.startsWith('<body') || firstChars.startsWith('<div');
      if (isHtml) {
        throw new Error("Azure API returned an HTML document/error page instead of valid binary asset data");
      }

      // Content-Length / integrity safeguard
      const lengthHeader = response.headers.get("content-length");
      if (lengthHeader) {
        const expectedLength = parseInt(lengthHeader, 10);
        if (!isNaN(expectedLength) && buffer.length < expectedLength) {
          throw new Error(`Incomplete download: received only ${buffer.length} out of ${expectedLength} bytes`);
        }
      }

      try {
        const folderCacheDir = path.dirname(localFilePath);
        if (!fs.existsSync(folderCacheDir)) {
          fs.mkdirSync(folderCacheDir, { recursive: true });
        }
        fs.writeFileSync(localFilePath, buffer);
        console.log(`[Cache System] Successfully saved file to local cache: ${localFilePath}`);
      } catch (writeErr: any) {
        console.error(`[Cache System] Failed to write cache for ${targetFileName}:`, writeErr.message);
      }

      // Set headers and send
      const mimeTypes: Record<string, string> = {
        '.fbx': 'application/octet-stream',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.tga': 'image/tga',
        '.dds': 'image/dds',
        '.gif': 'image/gif',
        '.bmp': 'image/bmp'
      };
      if (mimeTypes[ext]) {
        res.setHeader("Content-Type", mimeTypes[ext]);
      }
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=31536000");
      return res.send(buffer);
    } catch (err: any) {
      console.warn(`[Proxy Fallback] Failed to fetch live file ${targetFileName} (${err.message}). Checking disk cache...`);
      
      // Step 4: Final recovery check for fuzzy-matched files in disk cache
      const fuzzyDiskName = fuzzyLocateCachedFile(folder, targetFileName) || fuzzyLocateCachedFile(folder, fileName);
      if (fuzzyDiskName) {
        const fuzzyFilePath = getLocalCachedFilePath(folder, fuzzyDiskName);
        console.log(`[Cache Fallback] Serving cached fuzzy match: ${fuzzyFilePath}`);
        const ext = path.extname(fuzzyDiskName).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.fbx': 'application/octet-stream',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.tga': 'image/tga',
          '.dds': 'image/dds',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp'
        };
        if (mimeTypes[ext]) {
          res.setHeader("Content-Type", mimeTypes[ext]);
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=31536000");
        
        return res.sendFile(path.resolve(fuzzyFilePath));
      } else if (fs.existsSync(localFilePath)) {
        // If exact path exists (e.g. was created concurrently inside another worker / stream)
        console.log(`[Cache System] Serving cached copy of: ${localFilePath}`);
        const ext = path.extname(targetFileName).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.fbx': 'application/octet-stream',
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.tga': 'image/tga',
          '.dds': 'image/dds',
          '.gif': 'image/gif',
          '.bmp': 'image/bmp'
        };
        if (mimeTypes[ext]) {
          res.setHeader("Content-Type", mimeTypes[ext]);
        }
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=31536000");
        
        return res.sendFile(path.resolve(localFilePath));
      } else {
        console.error(`[Proxy Fallback Error] File ${targetFileName} (original: ${fileName}) not in cache and live server failed.`);
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        return res.status(502).send(`Azure failed and file is not cached: ${err.message}`);
      }
    }
  }

  // NEW: API Route for get-files from Azure Web Service
  app.get("/api/files/get-files", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    const { folder, clientName, fileName } = req.query;
    if (!folder || !clientName) return res.status(400).json({ error: "folder and clientName are required" });

    // If fileName is provided, we act as a proxy for the file content (as requested for FBX)
    if (fileName) {
      return handleGetFileResiliently(folder as string, fileName as string, clientName as string, res);
    }

    const activeClient = clientName || "tenantB";
    const cachePath = getLocalCachedListPath(folder as string, activeClient as string);
    const hasCache = fs.existsSync(cachePath);

    // Helper to rewrite Azure URLs to local proxy
    const rewriteItem = (item: any) => {
      if (typeof item === 'string') return item;
      const fileNameStr = item.fileName || item.FileName || item.name || item.Name || "";
      if (fileNameStr) {
        const effectiveFolder = folder as string;
        const proxyUrl = `/api/files/get-file?folder=${encodeURIComponent(effectiveFolder)}&fileName=${encodeURIComponent(fileNameStr)}&clientName=${encodeURIComponent(activeClient as string)}`;
        
        return {
          ...item,
          url: proxyUrl,
          Url: proxyUrl
        };
      }
      return item;
    };

    if (hasCache) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        console.log(`[Cache First] Serving get-files instantly from cache for: ${folder}`);
        
        // Asynchronously refresh list in background with a larger timeout to avoid timeout warnings
        (async () => {
          try {
            const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=${folder}&clientName=${activeClient}`;
            const response = await robustFetchWithRetry(azureApiUrl, {}, 15000, 1, true);
            if (response.ok) {
              const data = await response.json();
              fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
              console.log(`[Cache Background Update] Refreshed folder list for: ${folder}`);
            }
          } catch (bgErr: any) {
            console.log(`[Cache Background Update Status] Skip refreshing folder list: ${bgErr.message}`);
          }
        })();

        let rewrittenData;
        if (Array.isArray(cachedData)) {
          rewrittenData = cachedData.map(rewriteItem);
        } else if (cachedData.files && Array.isArray(cachedData.files)) {
          rewrittenData = { ...cachedData, files: cachedData.files.map(rewriteItem) };
        } else if (cachedData.items && Array.isArray(cachedData.items)) {
          rewrittenData = { ...cachedData, items: cachedData.items.map(rewriteItem) };
        } else if (cachedData.data && Array.isArray(cachedData.data)) {
          rewrittenData = { ...cachedData, data: cachedData.data.map(rewriteItem) };
        } else {
          rewrittenData = cachedData;
        }

        return res.json(rewrittenData);
      } catch (parseCacheErr) {
        console.error("Failed to parse cached list JSON:", parseCacheErr);
      }
    }

    try {
      const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=${folder}&clientName=${activeClient}`;
      const timeout = hasCache ? 15000 : 20000;
      const retries = hasCache ? 1 : 2;
      
      console.log(`Fetching files from Azure API: ${azureApiUrl} (cacheStatus: ${hasCache ? "CACHED" : "MISS"})`);
      const response = await robustFetchWithRetry(azureApiUrl, {}, timeout, retries, !hasCache);
      if (!response.ok) {
        throw new Error(`Azure API responded with status: ${response.status}`);
      }

      const data = await response.json();
      console.log(`[Azure Proxy] Successfully listed folder ${folder}/${activeClient}`);

      // Write folder list to local cache
      try {
        fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
      } catch (cacheErr: any) {
        console.error(`Failed to cache folder list ${folder}:`, cacheErr.message);
      }

      let rewrittenData;
      if (Array.isArray(data)) {
        rewrittenData = data.map(rewriteItem);
      } else if (data.files && Array.isArray(data.files)) {
        rewrittenData = { ...data, files: data.files.map(rewriteItem) };
      } else if (data.items && Array.isArray(data.items)) {
        rewrittenData = { ...data, items: data.items.map(rewriteItem) };
      } else if (data.data && Array.isArray(data.data)) {
        rewrittenData = { ...data, data: data.data.map(rewriteItem) };
      } else {
        rewrittenData = data;
      }

      return res.json(rewrittenData);
    } catch (err: any) {
      console.warn(`[Proxy Fallback] Failed to fetch live list for ${folder}/${activeClient}: ${err.message}. Loading from cache...`);
      
      let cachedData = null;
      if (fs.existsSync(cachePath)) {
        try {
          cachedData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
          console.log(`[Cache System] Loaded list from cache file: ${cachePath}`);
        } catch (parseErr) {
          console.error("Failed to parse cached folder JSON:", parseErr);
        }
      }
      
      if (!cachedData) {
        cachedData = getSeededDefaultList(folder as string);
        console.log(`[Cache System] Fallback to seeded default list for: ${folder}`);
      }

      let rewrittenData;
      if (Array.isArray(cachedData)) {
        rewrittenData = cachedData.map(rewriteItem);
      } else if (cachedData.files && Array.isArray(cachedData.files)) {
        rewrittenData = { ...cachedData, files: cachedData.files.map(rewriteItem) };
      } else if (cachedData.items && Array.isArray(cachedData.items)) {
        rewrittenData = { ...cachedData, items: cachedData.items.map(rewriteItem) };
      } else if (cachedData.data && Array.isArray(cachedData.data)) {
        rewrittenData = { ...cachedData, data: cachedData.data.map(rewriteItem) };
      } else {
        rewrittenData = cachedData;
      }

      return res.json(rewrittenData);
    }
  });

  // NEW: API Route for get-images-by-model from Azure Web Service
  app.get("/api/files/get-images-by-model", async (req, res) => {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
    const { folder, modelName, clientName } = req.query;
    if (!folder || !modelName) return res.status(400).json({ error: "folder and modelName are required" });

    const activeClient = (clientName as string) || "tenantB";
    const cachePath = getLocalCachedListPath(folder as string, activeClient);

    const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds", ".gif", ".bmp"];
    const modelNameStr = (modelName as string).toLowerCase();

    // Robust model texture matching algorithm
    const isModelTextureMatch = (fileName: string, modelName: string): boolean => {
      if (!fileName || !modelName) return false;

      // 1. Remove standard extensions from ends of names before comparison
      const cleanExtension = (str: string) => {
        return str.replace(/\.(fbx|obj|gltf|glb|png|jpg|jpeg|webp|tga|dds|gif|bmp|tiff)$/i, '').trim();
      };

      const fNameNoExt = cleanExtension(fileName);
      const mNameNoExt = cleanExtension(modelName);

      // 2. Normalize by converting to lowercase and replacing word separators with single underscore
      const normalize = (str: string) => {
        return str.toLowerCase().trim().replace(/[\s\-_.]+/g, '_');
      };

      const fNorm = normalize(fNameNoExt);
      const mNorm = normalize(mNameNoExt);

      // 3. Verify that the texture base name starts with the model base name
      if (!fNorm.startsWith(mNorm)) return false;

      // 4. Ensure word boundary matching to avoid substrings like 'Desk' matching 'Desktop'
      const nextChar = fNorm.charAt(mNorm.length);
      if (!nextChar) return true; // exact match

      const isAlphanumeric = /[a-z0-9]/.test(nextChar);
      return !isAlphanumeric;
    };

    // Helper to rewrite Azure URLs to local proxy
    const rewriteItem = (item: any) => {
      if (typeof item === 'string') return item;
      const fileName = item.fileName || item.FileName || item.name || item.Name || "";
      if (fileName) {
        const effectiveFolder = folder as string;
        const proxyUrl = `/api/files/get-file?folder=${encodeURIComponent(effectiveFolder)}&clientName=${encodeURIComponent(activeClient)}&fileName=${encodeURIComponent(fileName)}`;
        
        return {
          ...item,
          FileName: fileName,
          url: proxyUrl,
          Url: proxyUrl
        };
      }
      return item;
    };

    const hasCache = fs.existsSync(cachePath);

    if (hasCache) {
      try {
        const cachedData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        console.log(`[Cache First] Serving images-by-model list instantly from cache for: ${folder}`);

        // Asynchronously refresh list in background with a larger timeout to avoid timeout warnings
        (async () => {
          try {
            const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=${folder}&clientName=${activeClient}`;
            const response = await robustFetchWithRetry(azureApiUrl, {}, 15000, 1, true);
            if (response.ok) {
              const data = await response.json();
              fs.writeFileSync(cachePath, JSON.stringify(data, null, 2), "utf8");
              console.log(`[Cache Background Update] Refreshed image list for model matching: ${folder}`);
            }
          } catch (bgErr: any) {
            console.log(`[Cache Background Update Status] Skip refreshing image list: ${bgErr.message}`);
          }
        })();

        const getListData = (raw: any) => {
          if (Array.isArray(raw)) return raw;
          if (raw && typeof raw === 'object') {
            return raw.files || raw.items || raw.data || raw.images || raw.models || Object.values(raw).find(v => Array.isArray(v)) || [];
          }
          return [];
        };

        const cachedFiles = getListData(cachedData);
        const filteredFiles = cachedFiles
          .filter((item: any) => {
            const fileName = (item.fileName || item.FileName || item.name || item.Name || "").toLowerCase();
            if (!fileName) return false;
            
            const ext = path.extname(fileName);
            if (!imageExtensions.includes(ext)) return false;
            
            return isModelTextureMatch(fileName, modelNameStr);
          });

        console.log(`[Cache First] Filtered down to ${filteredFiles.length} images matching '${modelName}' from cached list`);
        const result = filteredFiles.map(rewriteItem);
        return res.json(result);
      } catch (parseCacheErr) {
        console.error("Failed to parse cached images-by-model list JSON:", parseCacheErr);
      }
    }

    let allFiles: any[] = [];
    try {
      const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=${folder}&clientName=${activeClient}`;
      console.log(`Fetching image list from Azure for model filtering: ${azureApiUrl} (cacheStatus: MISS)`);
      const response = await robustFetchWithRetry(azureApiUrl, {}, 10000, 2, !hasCache);
      if (!response.ok) {
        throw new Error(`Azure API responded with status: ${response.status}`);
      }

      const rawData = await response.json();
      
      const getListData = (raw: any) => {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
          return raw.files || raw.items || raw.data || raw.images || raw.models || Object.values(raw).find(v => Array.isArray(v)) || [];
        }
        return [];
      };

      allFiles = getListData(rawData);
      
      // Update cache list
      try {
        fs.writeFileSync(cachePath, JSON.stringify(rawData, null, 2), "utf8");
      } catch (cacheErr: any) {
        console.error("Failed to write folder list cache:", cacheErr.message);
      }
    } catch (err: any) {
      console.warn(`[Proxy Fallback] Failed to fetch live image list for model matching: ${err.message}. Checking cache...`);
      
      let cachedData = null;
      if (fs.existsSync(cachePath)) {
        try {
          cachedData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
        } catch (parseErr) {
          console.error("Failed to parse cached images JSON:", parseErr);
        }
      }

      if (!cachedData) {
        cachedData = getSeededDefaultList(folder as string);
      }

      const getListData = (raw: any) => {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
          return raw.files || raw.items || raw.data || raw.images || raw.models || Object.values(raw).find(v => Array.isArray(v)) || [];
        }
        return [];
      };

      allFiles = getListData(cachedData);
    }

    // Filter files that match the model name and are images
    const filteredFiles = allFiles
      .filter((item: any) => {
        const fileName = (item.fileName || item.FileName || item.name || item.Name || "").toLowerCase();
        if (!fileName) return false;
        
        const ext = path.extname(fileName);
        if (!imageExtensions.includes(ext)) return false;
        
        // Match using our precise matching algorithm
        return isModelTextureMatch(fileName, modelNameStr);
      });

    console.log(`[Azure Proxy] Filtered down to ${filteredFiles.length} images matching '${modelName}'`);

    const result = filteredFiles.map(rewriteItem);
    res.json(result);
  });

  // NEW: API Route for get-file from Azure Web Service (Proxy)
  app.get("/api/files/get-file", async (req, res) => {
    const { folder, fileName, clientName } = req.query;
    if (!folder || !fileName) return res.status(400).send("folder and fileName are required");

    await handleGetFileResiliently(folder as string, fileName as string, (clientName as string) || "tenantB", res);
  });

  // API Route for translation
  app.post("/api/ai/translate", async (req, res) => {
    const { texts, targetLanguage } = req.body;
    if (!texts || !Array.isArray(texts)) return res.status(400).json({ error: "texts array is required" });
    if (!targetLanguage) return res.status(400).json({ error: "targetLanguage is required" });

    const translate = getTranslate();
    const ai = getAI();
    
    // Map common language names to ISO codes if necessary
    let langCode = targetLanguage;
    const langMap: { [key: string]: string } = {
      'hebrew': 'he',
      'he': 'he',
      'iw': 'he', // Old code for Hebrew
      'english': 'en',
      'en': 'en',
      'russian': 'ru',
      'ru': 'ru',
      'french': 'fr',
      'fr': 'fr',
      'spanish': 'es',
      'es': 'es',
      'arabic': 'ar',
      'ar': 'ar',
      'deutsch': 'de',
      'german': 'de',
      'de': 'de',
      'it': 'it',
      'italian': 'it'
    };
    
    const lowerLang = targetLanguage.toString().toLowerCase().trim();
    if (langMap[lowerLang]) {
      langCode = langMap[lowerLang];
    } else if (lowerLang.length > 2 && !lowerLang.includes('-')) {
      console.warn(`Unknown language name: ${targetLanguage}, using as-is.`);
    } else if (lowerLang.includes('-')) {
      langCode = lowerLang.split('-')[0];
    }

    // Helper to preprocess technical codes/shorthands for natural translation
    const preprocessForTranslation = (text: string): string => {
      let cleaned = text.trim();
      if (langCode !== 'en' && /[a-zA-Z]/.test(cleaned)) {
        cleaned = cleaned
          .replace(/\bPart\s*No\.?\s*:/gi, "Part Number:")
          .replace(/\bPart\s*No\.?\b/gi, "Part Number")
          .replace(/\bPart\s*Number\s*:/gi, "Part Number:")
          .replace(/\bP\/?N\s*:/gi, "Part Number:")
          .replace(/\bP\s*N\s*:/gi, "Part Number:")
          .replace(/\bP\.N\.\s*:/gi, "Part Number:")
          .replace(/\bPart\s*ID\s*:/gi, "Part Number:")
          .replace(/\bPart\s*ID\b/gi, "Part Number")
          .replace(/\bOEM\s*:/gi, "OEM Manufacturer:")
          .replace(/\bOEM\b/gi, "OEM Manufacturer")
          .replace(/\bCategory\s*:/gi, "Category:")
          .replace(/\bCategory\b/gi, "Category")
          .replace(/\bProduct\s*Ref\.?\s*:/gi, "Product Reference:")
          .replace(/\bProduct\s*Ref\.?\b/gi, "Product Reference");
      }
      return cleaned;
    };

    // Filter out invalid items to prevent API errors
    const validTexts = texts.map(t => {
      if (t === null || t === undefined) return "";
      return preprocessForTranslation(String(t));
    }).filter(t => t.length > 0);
    
    if (validTexts.length === 0) {
      console.log("No valid texts to translate, returning originals.");
      return res.json({ translated: texts });
    }

    const translatedResultsMap = new Map<string, string>();
    const uniqueTexts = Array.from(new Set(validTexts));
    
    const BATCH_SIZE = 25;
    for (let i = 0; i < uniqueTexts.length; i += BATCH_SIZE) {
      const batch = uniqueTexts.slice(i, i + BATCH_SIZE);
      let batchResults: string[] = [];
      let success = false;

      // Try 1: Google Cloud Translate
      if (translate) {
        try {
          console.log(`[Translate API] Translating batch of ${batch.length} items to '${langCode}'...`);
          const [translations] = await translate.translate(batch, langCode);
          batchResults = Array.isArray(translations) ? translations : [translations];
          if (batchResults.length === batch.length) {
            success = true;
            console.log(`[Translate API] Batch translated successfully.`);
          }
        } catch (err: any) {
          console.error("[Translate API] Error in Cloud Translation batch:", err.message || err);
        }
      }

      // Try 2: Gemini Fallback with JSON structured schema
      if (!success && ai) {
        try {
          console.log(`[Gemini Fallback] Translating batch of ${batch.length} items to '${targetLanguage}'...`);
          const prompt = `You are a professional translator. Translate this array of strings to correct and natural ${targetLanguage}:\n${JSON.stringify(batch)}\n\nIMPORTANT: Maintain technical and 3D model terminology correctly and output the exact same number of items in the response array (exactly ${batch.length} items).`;
          
          const result = await ai.models.generateContent({
            model: "gemini-3.5-flash",
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: "ARRAY",
                items: { type: "STRING" },
                description: "List of translated texts matching the exact sequence and length of the inputs."
              }
            }
          });

          const responseText = (result.text || "").trim();
          const parsed = JSON.parse(responseText);
          if (Array.isArray(parsed) && parsed.length === batch.length) {
            batchResults = parsed;
            success = true;
            console.log(`[Gemini Fallback] Batch translated successfully via structured schema.`);
          } else {
            console.warn(`[Gemini Fallback] Schema output length mismatch or not an array. Expected ${batch.length}, got ${parsed?.length}.`);
          }
        } catch (geminiErr: any) {
          console.error("[Gemini Fallback] Gemini translation failed for batch:", geminiErr.message || geminiErr);
        }
      }

      // Try 3: If batch translation failed entirely, try items individually
      if (!success) {
        console.warn(`[Fallback] Batch translation failed, falling back to individual item translation for ${batch.length} items...`);
        for (const item of batch) {
          let itemResult = item;
          let itemSuccess = false;

          if (translate) {
            try {
              const [translation] = await translate.translate(item, langCode);
              itemResult = translation;
              itemSuccess = true;
            } catch (err) {}
          }

          if (!itemSuccess && ai) {
            try {
              const prompt = `Translate this text to ${targetLanguage}. Return ONLY the direct translation. Text: "${item}"`;
              const result = await ai.models.generateContent({
                model: "gemini-3.5-flash",
                contents: [{ role: "user", parts: [{ text: prompt }] }]
              });
              itemResult = cleanTranslationText(result.text || item);
              itemSuccess = true;
            } catch (err) {}
          }

          translatedResultsMap.set(item, itemResult);
        }
      } else {
        batch.forEach((item, idx) => {
          translatedResultsMap.set(item, batchResults[idx] || item);
        });
      }
    }

    // Map back to original input array (preserving indices and empty/invalid values)
    const finalResults = texts.map(t => {
      if (t !== null && t !== undefined && String(t).trim().length > 0) {
        const cleaned = preprocessForTranslation(String(t));
        return translatedResultsMap.get(cleaned) || String(t);
      }
      return t;
    });

    res.json({ translated: finalResults });
  });

  const cleanTranslationText = (txt: string): string => {
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

  let cachedVoiceId: string | null = null;

  const getElevenLabsVoiceId = async (apiKey: string): Promise<string> => {
    if (cachedVoiceId) return cachedVoiceId;

    try {
      const resp = await fetch("https://api.elevenlabs.io/v1/voices", {
        headers: { "xi-api-key": apiKey }
      });
      if (resp.ok) {
        const data = await resp.json() as { voices: Array<{ voice_id: string; category: string; name: string }> };
        const premade = (data.voices || []).filter(v => v.category === "premade");
        if (premade.length > 0) {
          const preferredVec = premade.find(v => ["Brian", "Rachel", "Bella", "Nicole", "Antoni", "Adam"].includes(v.name));
          cachedVoiceId = preferredVec ? preferredVec.voice_id : premade[0].voice_id;
          console.log(`[ElevenLabs] Dynamically selected premade voice: "${preferredVec?.name || premade[0].name}" (${cachedVoiceId})`);
          return cachedVoiceId;
        }
      }
    } catch (err) {
      console.warn("Error fetching ElevenLabs voices list:", err);
    }

    // Stable, guaranteed premade voice ID (Bella)
    return "EXAVITQu4vr4xnSDxMaL";
  };

  // Helper to generate TTS using ElevenLabs
  const generateElevenLabsTTS = async (text: string): Promise<string> => {
    const apiKey = process.env.API_Key_Eleven || process.env.API_KEY_ELEVEN || process.env.ELEVEN_API_KEY;
    if (!apiKey) {
      throw new Error("ElevenLabs API Key (API_Key_Eleven) is missing. Set it in Secrets.");
    }

    const cleanedText = cleanTranslationText(text);
    if (!cleanedText) {
      console.log("[ElevenLabs] Text became empty after sanitization. Returning empty audio representation.");
      return "";
    }

    const voiceId = await getElevenLabsVoiceId(apiKey);
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        "accept": "audio/mpeg"
      },
      body: JSON.stringify({
        text: cleanedText,
        model_id: "eleven_multilingual_v2",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.05,
          use_speaker_boost: true
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`ElevenLabs API returned status ${response.status}: ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    return buffer.toString("base64");
  };

  // API Route for combined Translation + TTS to reduce latency
  app.post("/api/ai/fast-tts", async (req, res) => {
    const { text, targetLanguage, langCode } = req.body;
    if (!text || !targetLanguage || !langCode) return res.status(400).json({ error: "Missing required fields" });

    try {
      const startTime = Date.now();
      
      // 1. Translate (unless already in target code)
      let textToSpeak = text;
      // Preprocess technical words before translation so automated translators don't fail (e.g., translating "Part No" to "נ"צ")
      if (langCode !== 'en' && /[a-zA-Z]/.test(textToSpeak)) {
        textToSpeak = textToSpeak
          .replace(/\bPart\s*No\.?\s*:/gi, "Part Number:")
          .replace(/\bPart\s*No\.?\b/gi, "Part Number")
          .replace(/\bPart\s*Number\s*:/gi, "Part Number:")
          .replace(/\bP\/?N\s*:/gi, "Part Number:")
          .replace(/\bP\s*N\s*:/gi, "Part Number:")
          .replace(/\bP\.N\.\s*:/gi, "Part Number:")
          .replace(/\bPart\s*ID\s*:/gi, "Part Number:")
          .replace(/\bPart\s*ID\b/gi, "Part Number")
          .replace(/\bOEM\s*:/gi, "OEM Manufacturer:")
          .replace(/\bOEM\b/gi, "OEM Manufacturer");
      }
      const isHebrew = langCode === 'he';
      const isArabic = langCode === 'ar';
      const isRussian = langCode === 'ru';
      const hasHebrew = /[\u0590-\u05FF]/.test(text);
      const hasArabic = /[\u0600-\u06FF]/.test(text);
      const hasRussian = /[\u0400-\u04FF]/.test(text);
      const hasLatin = /[a-zA-Z]/.test(text);

      const ai = getAI();
      const needsTranslation = (langCode !== 'en' && hasLatin) || (isHebrew && !hasHebrew) || (isArabic && !hasArabic) || (isRussian && !hasRussian);

      if (needsTranslation && ai) {
        const transPrompt = `Translate this text to ${targetLanguage}. Return ONLY the direct translation. Do NOT include any explanations, surrounding quotes, markdown formatting, or introductory text. If there are technical parts or measurements, translate them naturally so they can be read aloud comfortably. Text: "${text}"`;
        const transResult = await ai.models.generateContent({
          model: "gemini-3.5-flash",
          contents: [{ role: "user", parts: [{ text: transPrompt }] }]
        });
        textToSpeak = cleanTranslationText(transResult.text || text);
        console.log(`[FAST-TTS] Translation succeeded: "${text}" -> "${textToSpeak}"`);
      }

      // 2. TTS Generation (EXCLUSIVE to ElevenLabs)
      const ttsStartTime = Date.now();
      let audioBase64 = "";

      try {
        audioBase64 = await generateElevenLabsTTS(textToSpeak);
      } catch (elevenErr: any) {
        console.error(`[FAST-TTS] ElevenLabs audio generation failed: ${elevenErr.message || elevenErr}`);
        return res.status(500).json({ error: "ElevenLabs Generation failed", details: elevenErr.message || String(elevenErr) });
      }

      console.log(`[FAST-TTS] Total time: ${Date.now() - startTime}ms (ElevenLabs TTS portion: ${Date.now() - ttsStartTime}ms)`);

      if (audioBase64 !== undefined) {
        res.json({ audio: audioBase64, translatedText: textToSpeak });
      } else {
        res.status(500).json({ error: "No audio generated from ElevenLabs" });
      }
    } catch (err: any) {
      console.error("Fast TTS Error:", err);
      res.status(500).json({ error: "Fast TTS failed", details: err.message || String(err) });
    }
  });

  // API Route for TTS
  app.post("/api/ai/tts", async (req, res) => {
    const { text } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    const startTime = Date.now();
    try {
      // EXCLUSIVE to ElevenLabs, no fallbacks to Google's TTS
      const audioBase64 = await generateElevenLabsTTS(text);
      console.log(`[TTS] ElevenLabs generated in ${Date.now() - startTime}ms for text length: ${text.length}`);

      if (audioBase64 !== undefined) {
        res.json({ audio: audioBase64 });
      } else {
        res.status(500).json({ error: "No audio generated from ElevenLabs" });
      }
    } catch (err: any) {
      console.error("TTS API Error:", err);
      res.status(500).json({ error: "TTS failed", details: err.message || String(err) });
    }
  });

  // API Route for listing local textures
  app.get("/api/local/textures", (req, res) => {
    try {
      const files = fs.readdirSync(uploadDir);
      const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds"];
      const textures = files
        .filter(file => imageExtensions.some(ext => file.toLowerCase().endsWith(ext)))
        .map(file => ({
          key: `uploads/${file}`,
          name: file,
          url: `/uploads/${file}`
        }));
      res.json({ textures });
    } catch (error: any) {
      res.status(500).json({ error: "Failed to list local textures", details: error.message });
    }
  });

  // API Route for listing R2 files
  app.get("/api/r2/files", async (req, res) => {
    try {
      const bucket = process.env.R2_BUCKET_NAME;
      if (!bucket) {
        return res.status(400).json({ error: "R2 bucket name not configured" });
      }

      const client = getR2Client();
      if (!client) {
        return res.status(400).json({ error: "R2 credentials or Account ID missing" });
      }

      const command = new ListObjectsV2Command({
        Bucket: bucket,
      });

      const response = await client.send(command);
      
      // Filter for FBX files and generate proxy URLs
      const files = (response.Contents || [])
        .filter(obj => obj.Key?.toLowerCase().endsWith(".fbx"))
        .map((obj) => {
          return {
            key: obj.Key,
            name: obj.Key?.split("/").pop() || "Unknown",
            size: obj.Size,
            lastModified: obj.LastModified,
            // Use our proxy endpoint instead of a direct signed URL to avoid CORS issues
            url: `/api/r2/proxy?key=${encodeURIComponent(obj.Key || "")}`
          };
        });

      res.json({ files });
    } catch (error: any) {
      console.error("Error listing R2 files:", error);
      res.status(500).json({ error: "Failed to list R2 files", details: error.message });
    }
  });

  // API Route for listing R2 textures (images)
  app.get("/api/r2/textures", async (req, res) => {
    try {
      const bucket = process.env.R2_BUCKET_NAME;
      if (!bucket) {
        return res.status(400).json({ error: "R2 bucket name not configured" });
      }

      const client = getR2Client();
      if (!client) {
        return res.status(400).json({ error: "R2 credentials or Account ID missing" });
      }

      let allObjects: any[] = [];
      let isTruncated = true;
      let continuationToken: string | undefined;

      while (isTruncated) {
        const command: ListObjectsV2Command = new ListObjectsV2Command({
          Bucket: bucket,
          ContinuationToken: continuationToken
        });

        const response = await client.send(command);
        allObjects = allObjects.concat(response.Contents || []);
        isTruncated = response.IsTruncated || false;
        continuationToken = response.NextContinuationToken;
      }
      
      // Filter for image files
      const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds"];
      const textures = allObjects
        .filter(obj => imageExtensions.some(ext => obj.Key?.toLowerCase().endsWith(ext)))
        .map((obj) => {
          return {
            key: obj.Key,
            name: obj.Key?.split("/").pop() || "Unknown",
            url: `/api/r2/proxy?key=${encodeURIComponent(obj.Key || "")}`
          };
        });

      res.json({ textures });
    } catch (error: any) {
      console.error("Error listing R2 textures:", error);
      res.status(500).json({ error: "Failed to list R2 textures", details: error.message });
    }
  });

  // NEW: API Route to get images by model name (from R2)
  app.get("/api/r2/get-images-by-model", async (req, res) => {
    const { folder, modelName } = req.query;
    
    if (!folder || !modelName) {
      return res.status(400).json({ error: "Folder and model name are required." });
    }

    if (folder !== "images" && folder !== "files") {
      return res.status(400).json({ error: "Folder must be 'images' or 'files'." });
    }

    try {
      const bucket = process.env.R2_BUCKET_NAME;
      if (!bucket) return res.status(400).json({ error: "R2 bucket name not configured" });

      const client = getR2Client();
      if (!client) return res.status(400).json({ error: "R2 credentials missing" });

      // List ALL objects in the specified prefix (folder) with pagination
      const prefix = `${folder}/`;
      let allFiles: any[] = [];
      let isTruncated = true;
      let continuationToken: string | undefined;

      while (isTruncated) {
        const command: ListObjectsV2Command = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        });

        const response = await client.send(command);
        allFiles = allFiles.concat(response.Contents || []);
        isTruncated = response.IsTruncated || false;
        continuationToken = response.NextContinuationToken;
      }

      console.log(`[R2] Found ${allFiles.length} total files in bucket under prefix ${prefix}`);
      
      const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds", ".gif", ".bmp"];
      const modelNameStr = (modelName as string).toLowerCase();

      const isModelTextureMatch = (fileName: string, modelName: string): boolean => {
        if (!fileName || !modelName) return false;

        // 1. Remove standard extensions from ends of names before comparison
        const cleanExtension = (str: string) => {
          return str.replace(/\.(fbx|obj|gltf|glb|png|jpg|jpeg|webp|tga|dds|gif|bmp|tiff)$/i, '').trim();
        };

        const fNameNoExt = cleanExtension(fileName);
        const mNameNoExt = cleanExtension(modelName);

        // 2. Normalize by converting to lowercase and replacing word separators with single underscore
        const normalize = (str: string) => {
          return str.toLowerCase().trim().replace(/[\s\-_.]+/g, '_');
        };

        const fNorm = normalize(fNameNoExt);
        const mNorm = normalize(mNameNoExt);

        // 3. Verify that the texture base name starts with the model base name
        if (!fNorm.startsWith(mNorm)) return false;

        // 4. Ensure word boundary matching to avoid substrings like 'Desk' matching 'Desktop'
        const nextChar = fNorm.charAt(mNorm.length);
        if (!nextChar) return true; // exact match

        const isAlphanumeric = /[a-z0-9]/.test(nextChar);
        return !isAlphanumeric;
      };

      let filteredFiles = allFiles
        .filter(obj => {
          const key = (obj.Key || "").toLowerCase();
          const ext = path.extname(key).toLowerCase();
          if (!imageExtensions.includes(ext)) return false;
          
          const fileName = path.basename(key);
          return isModelTextureMatch(fileName, modelNameStr);
        });

      console.log(`[R2] Filtered down to ${filteredFiles.length} images matching '${modelName}'`);

      if (filteredFiles.length === 0) {
        console.warn(`[R2] No images found for '${modelName}'. Check if the name in the bucket matches the model name pattern.`);
        return res.json([]);
      }

      const result = filteredFiles.map(obj => {
        const key = obj.Key || "";
        const fileName = path.basename(key);
        
        return {
          FileName: fileName,
          FullPath: key,
          ContentType: `image/${path.extname(key).slice(1)}`.replace("image/jpg", "image/jpeg"),
          Url: `/api/r2/proxy?key=${encodeURIComponent(key)}`
        };
      });

      res.json(result);
    } catch (error: any) {
      console.error("Error in get-images-by-model:", error);
      res.status(500).json({ error: "Failed to fetch images", details: error.message });
    }
  });

  // Proxy route to fetch files from R2 and serve them from our domain (bypasses CORS)
  app.get("/api/r2/proxy", async (req, res) => {
    const key = req.query.key as string;
    if (!key) return res.status(400).send("Key is required");

    try {
      const bucket = process.env.R2_BUCKET_NAME;
      if (!bucket) throw new Error("R2_BUCKET_NAME is not configured");

      const client = getR2Client();
      if (!client) throw new Error("R2 credentials or Account ID missing");

      const command = new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      });

      console.log(`Proxying R2 file: Bucket=${bucket}, Key=${key}`);
      const response = await client.send(command);
      
      // Set Content-Type from response or fallback based on extension
      let contentType = response.ContentType;
      if (!contentType || contentType === 'application/octet-stream') {
        const ext = path.extname(key).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.webp': 'image/webp',
          '.tga': 'image/tga',
          '.dds': 'image/vnd.ms-dds',
          '.fbx': 'application/octet-stream'
        };
        contentType = mimeTypes[ext] || 'application/octet-stream';
      }
      
      res.setHeader("Content-Type", contentType);
      
      if (response.ContentLength) {
        res.setHeader("Content-Length", response.ContentLength.toString());
      }
      
      // Add CORS and caching headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=31536000");

      // Stream the body to the response
      const body = response.Body as any;
      if (body && typeof body.pipe === 'function') {
        try {
          // Use pipeline to handle the stream and ensure proper cleanup
          await pipeline(body, res);
        } catch (streamError: any) {
          // If headers were already sent, we can't send a 500 error response.
          if (res.headersSent) {
            // "Premature close" usually means the client (browser) disconnected before the stream finished.
            // This is common when navigating or when an image is no longer needed.
            if (streamError.message === 'Premature close' || streamError.code === 'ERR_STREAM_PREMATURE_CLOSE') {
              // Log as a warning/info instead of an error to reduce noise
              console.warn(`Stream for "${key}" was closed prematurely (likely client disconnect)`);
            } else {
              console.error(`Stream error after headers sent for "${key}":`, streamError.message);
            }
            
            if (!res.writableEnded) {
              res.end();
            }
          } else {
            throw streamError;
          }
        }
      } else if (body && typeof body.transformToByteArray === 'function') {
        const bytes = await body.transformToByteArray();
        res.send(Buffer.from(bytes));
      } else if (body && body.getReader) {
        // Fallback if it's a Web Stream (e.g. in some environments)
        const reader = body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch (readerError: any) {
          if (res.headersSent) {
            console.error(`Reader error after headers sent for "${key}":`, readerError.message);
            res.end();
          } else {
            throw readerError;
          }
        }
      } else {
        if (!res.headersSent) {
          res.status(500).send("Unsupported body type from R2 response");
        } else {
          res.end();
        }
      }
    } catch (error: any) {
      console.error(`Proxy error for key "${key}":`, error);
      if (error.stack) console.error(error.stack);
      
      if (!res.headersSent) {
        if (error.name === "NoSuchKey") {
          res.status(404).send(`File not found in R2: ${key}`);
        } else {
          res.status(500).send(`Failed to proxy file: ${error.message}`);
        }
      } else {
        // Headers already sent, just end the response
        if (!res.writableEnded) {
          res.end();
        }
      }
    }
  });

  // NEW: Save UV Map SVG route
  app.post("/api/save-uv-svg", (req, res) => {
    const { svg, filename } = req.body;
    if (!svg) return res.status(400).json({ error: "svg is required" });
    const name = filename || "axe_uv_map.svg";
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "");
    const targetPath = path.join(process.cwd(), safeName);
    try {
      fs.writeFileSync(targetPath, svg, "utf8");
      console.log(`[UV Saver] Saved UV map to ${targetPath}`);
      return res.json({ success: true, path: targetPath, filename: safeName });
    } catch (err: any) {
      console.error(`[UV Saver] Failed to save UV map:`, err);
      return res.status(500).json({ error: err.message || "Failed to save file" });
    }
  });

  // Serve uploaded files statically
  app.use("/uploads", express.static(uploadDir));

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Serve static files in production
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.use((req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("=== API CONFIGURATION DIAGNOSTICS ===");
    const hasTranslateKey = !!(process.env.GOOGLE_TRANSLATE_API_KEY || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY);
    const hasElevenKey = !!(process.env.API_Key_Eleven || process.env.API_KEY_ELEVEN || process.env.ELEVEN_API_KEY);
    const hasGeminiKey = !!(process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY);
    console.log(`- Google Translate API Key: ${hasTranslateKey ? "CONFIGURED (OK)" : "MISSING ⚠️"}`);
    console.log(`- ElevenLabs API Key: ${hasElevenKey ? "CONFIGURED (OK)" : "MISSING ⚠️"}`);
    console.log(`- Gemini API Key: ${hasGeminiKey ? "CONFIGURED (OK)" : "MISSING ⚠️"}`);
    console.log("=====================================");
  });
}

startServer();
