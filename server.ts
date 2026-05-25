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
import { GoogleGenAI, Modality, Type } from "@google/genai";
import { v2 } from '@google-cloud/translate';

const { Translate } = v2;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize Gemini
let aiInstance: GoogleGenAI | null = null;
let isGeminiQuotaExceeded = false;
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
    const apiKey = process.env.GOOGLE_TRANSLATE_API_KEY;
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

async function startServer() {
  validateR2Config();
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Global logger for API routes
  app.use("/api", (req, res, next) => {
    console.log(`[API Request] ${req.method} ${req.originalUrl}`);
    next();
  });

  // Ensure uploads directory exists
  const uploadDir = path.join(__dirname, "public", "uploads");
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

    const tryFetchParts = async (name: string) => {
      // Clean name: remove extension and use strictly for the API call
      const cleanName = name.replace(/\.[^/.]+$/, "");
      const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/ModelsParts/productName/${encodeURIComponent(cleanName)}`;
      
      try {
        console.log(`Strict Fetching model parts: ${azureApiUrl}`);
        const response = await fetchWithTimeout(azureApiUrl, {}, 15000); // 15s timeout
        
        if (!response.ok) return null;

        const text = await response.text();
        if (!text || text.trim() === "") return null;
        
        try {
          const data = JSON.parse(text);
          // Standardize response to part objects
          const rawParts = Array.isArray(data) ? data : (data.parts || data.data || data.items || []);
          
          if (rawParts.length === 0) return null;

          return rawParts.map((item: any) => ({
            id: (item.partId || item.PartId || Math.random().toString(36).substr(2, 9)).toString(),
            modelName: name,
            partName: item.displayName || item.display_name || item.partName || item.PartName || item.partKey || item.PartKey || "Unnamed Part",
            partKey: item.partKey || item.PartKey || "",
            description: item.description || item.Description || "",
            presentAtSite: item.presentAtSite ?? item.PresentAtSite ?? true // Default to true if not provided by API
          }));
        } catch (jsonErr) {
          console.error("Invalid JSON for parts:", jsonErr);
          return null;
        }
      } catch (err) {
        console.error(`Parts fetch failed for ${cleanName}:`, err);
        return null;
      }
    };

    try {
      // Use strictly the modelName (usually the filename) for the parts lookup
      const parts = await tryFetchParts(modelName);

      if (parts && parts.length > 0) {
        return res.json(parts);
      }
      
      // If no strict match found, return empty array (NO fallbacks/mocks)
      console.warn(`No DB parts found for strictly matched model: ${modelName}`);
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
      const response = await fetchWithTimeout(azureApiUrl, {}, 45000);
      
      if (!response.ok) {
        throw new Error(`Azure API responded with status: ${response.status}`);
      }

      const text = await response.text();
      if (!text || text.trim() === "") return res.send("10"); // Default to 10 if empty
      
      if (text.trim().toLowerCase().startsWith("<!doctype") || text.trim().toLowerCase().startsWith("<html")) {
        console.warn(`Azure returned HTML instead of JSON for inventory for ${productName}.`);
        return res.send("10");
      }
      
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
      console.error("Azure Inventory API Error:", err);
      res.status(500).send("10"); // Default to 10 on error
    }
  });

  // API Route for product details from Azure Web Service
  app.get("/api/product-details", async (req, res) => {
    const modelName = req.query.modelName as string;
    if (!modelName) return res.status(400).json({ error: "modelName is required" });

    const tryFetch = async (title: string) => {
      try {
        const url = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/Products/productTitle/${encodeURIComponent(title)}`;
        const resp = await fetchWithTimeout(url, {}, 45000);
        if (!resp.ok) return null;
        
        const text = await resp.text();
        if (!text || text.trim() === "") return null;
        
        // Check if response is HTML instead of JSON
        if (text.trim().toLowerCase().startsWith("<!doctype") || text.trim().toLowerCase().startsWith("<html")) {
          console.warn(`Azure returned HTML instead of JSON for product ${title}. Likely an error page.`);
          return null;
        }
        
        try {
          const parsed = JSON.parse(text);
          // If it's an array, make sure it has at least one item
          if (Array.isArray(parsed)) {
            return parsed.length > 0 ? parsed[0] : null;
          }
          return parsed;
        } catch (jsonErr) {
          console.error(`Failed to parse JSON for product ${title}:`, jsonErr);
          return null;
        }
      } catch (err) {
        console.error(`Fetch failed for product ${title}:`, err);
        return null;
      }
    };

    try {
      // Create variations to try
      const variations = [
        modelName,
        modelName.replace(/_/g, ' '),         // My_Model -> My Model
        modelName.replace(/-/g, ' '),         // My-Model -> My Model
        modelName.charAt(0).toUpperCase() + modelName.slice(1), // camel -> Camel
        modelName.toLowerCase(),
        modelName.toUpperCase()
      ];

      // Remove duplicates and try each
      const uniqueVariations = Array.from(new Set(variations));
      
      let data = null;
      for (const variant of uniqueVariations) {
        data = await tryFetch(variant);
        if (data) {
          console.log(`Matched product using variation: ${variant}`);
          break;
        }
      }
      
      // Final fallback to "Connector" only if absolutely necessary and not already tried
      if (!data && !uniqueVariations.includes("Connector")) {
        data = await tryFetch("Connector");
      }

      if (data) {
        return res.json(data);
      }

      res.status(404).json({ error: "Product not found" });
    } catch (err: any) {
      console.error("Azure Product Details API Error:", err);
      res.status(500).json({ error: "Failed to fetch product details", details: err.message });
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

      const rawText = await response.text();
      if (!rawText || rawText.trim() === "") {
        return res.json([]);
      }

      if (rawText.trim().toLowerCase().startsWith("<!doctype") || rawText.trim().toLowerCase().startsWith("<html")) {
        console.warn(`Azure returned HTML instead of JSON for categories listing. Possible tenant mismatch or Azure error.`);
        return res.json([]);
      }

      const data = JSON.parse(rawText);
      res.json(data);
    } catch (err: any) {
      console.error("Azure Categories API Error:", err);
      res.status(500).json({ error: "Failed to fetch categories from Azure", details: err.message });
    }
  });

  // NEW: API Route for get-files from Azure Web Service
  app.get("/api/files/get-files", async (req, res) => {
    const { folder, clientName, fileName } = req.query;
    if (!folder || !clientName) return res.status(400).json({ error: "folder and clientName are required" });

    // If fileName is provided, we act as a proxy for the file content (as requested for FBX)
    if (fileName) {
      const azureFileUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=${folder}&clientName=${clientName}`;
      try {
        console.log(`Proxying Azure FBX file via get-files: ${azureFileUrl}`);
        const response = await fetchWithTimeout(azureFileUrl, {}, 60000); // 60s for large FBX
        if (!response.ok) return res.status(response.status).send(`Azure responded with ${response.status}`);
        
        const contentType = response.headers.get("Content-Type");
        if (contentType) res.setHeader("Content-Type", contentType);
        res.setHeader("Access-Control-Allow-Origin", "*");
        
        const body = response.body;
        if (body) {
          // @ts-ignore
          const reader = body.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } else {
          res.status(500).send("No body in Azure response");
        }
        return;
      } catch (err: any) {
        console.error("Azure FBX Proxy Error:", err);
        return res.status(500).send(`Failed to proxy FBX from Azure: ${err.message}`);
      }
    }

    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=${folder}&clientName=${clientName}`;

    try {
      console.log(`Fetching files from Azure API: ${azureApiUrl}`);
      let response;
      try {
        response = await fetchWithTimeout(azureApiUrl, {}, 45000);
      } catch (err) {
        console.warn(`Initial files fetch threw error, retrying...`, err);
        response = await fetchWithTimeout(azureApiUrl, {}, 60000);
      }
      
      // Also retry if not ok but didn't throw
      if (!response.ok) {
        console.warn(`Initial files fetch returned not-ok status, retrying...`);
        response = await fetchWithTimeout(azureApiUrl, {}, 60000);
      }

      if (!response.ok) {
        throw new Error(`Azure API responded with status: ${response.status}`);
      }

      const rawText = await response.text();
      if (!rawText || rawText.trim() === "") {
        return res.json([]);
      }

      if (rawText.trim().toLowerCase().startsWith("<!doctype") || rawText.trim().toLowerCase().startsWith("<html")) {
        console.warn(`Azure returned HTML instead of JSON for files listing. Possible tenant mismatch or Azure error.`);
        return res.json([]);
      }

      const data = JSON.parse(rawText);
      console.log(`Azure GET-FILES API Data (${folder}/${clientName}):`, JSON.stringify(data).substring(0, 500));
      
      // Helper to rewrite Azure URLs to local proxy
      const rewriteItem = (item: any) => {
        if (typeof item === 'string') return item;
        const fileName = item.fileName || item.FileName || item.name || item.Name || "";
        if (fileName) {
          const effectiveFolder = folder as string;
          const isFbx = fileName.toLowerCase().endsWith('.fbx');
          const proxyEndpoint = isFbx ? '/api/files/get-file' : '/api/files/get-file';
          
          const proxyUrl = `${proxyEndpoint}?folder=${encodeURIComponent(effectiveFolder)}&fileName=${encodeURIComponent(fileName)}&clientName=${encodeURIComponent(clientName as string)}`;
          
          return {
            ...item,
            url: proxyUrl,
            Url: proxyUrl
          };
        }
        return item;
      };

      // Handle both array and object responses
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

      res.json(rewrittenData);
    } catch (err: any) {
      console.error("Azure Get-Files API Error:", err);
      res.status(500).json({ error: "Failed to fetch files from Azure", details: err.message });
    }
  });

  // NEW: API Route for get-images-by-model from Azure Web Service
  app.get("/api/files/get-images-by-model", async (req, res) => {
    const { folder, modelName, clientName } = req.query;
    if (!folder || !modelName) return res.status(400).json({ error: "folder and modelName are required" });

    const activeClient = clientName || "tenantB";
    
    // We use get-files for listing since get-images-by-model doesn't seem to exist as a GET endpoint
    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=${folder}&clientName=${activeClient}`;

    try {
      console.log(`Fetching image list from Azure for model filtering: ${azureApiUrl}`);
      const response = await fetchWithTimeout(azureApiUrl, {}, 45000);
      
      if (!response.ok) {
        throw new Error(`Azure API responded with status: ${response.status}`);
      }

      const rawText = await response.text();
      if (!rawText || rawText.trim() === "") {
        return res.json([]);
      }

      if (rawText.trim().toLowerCase().startsWith("<!doctype") || rawText.trim().toLowerCase().startsWith("<html")) {
        console.warn(`Azure returned HTML instead of JSON for images listing. Possible tenant mismatch or Azure error.`);
        return res.json([]);
      }

      const rawData = JSON.parse(rawText);
      
      // Helper to find list in various response formats
      const getListData = (raw: any) => {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
          return raw.files || raw.items || raw.data || raw.images || raw.models || Object.values(raw).find(v => Array.isArray(v)) || [];
        }
        return [];
      };

      const allFiles = getListData(rawData);
      console.log(`[Azure Proxy] Found ${allFiles.length} total files in folder ${folder}`);
      
      const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds", ".gif", ".bmp"];
      const modelNameStr = (modelName as string).toLowerCase();
      const modelNameClean = modelNameStr.replace(/[^a-z0-9]/g, '');
      const modelParts = modelNameStr.split(/[\s_-]/).filter(p => p.length > 2);

      // Filter files that match the model name and are images
      const filteredFiles = allFiles
        .filter((item: any) => {
          const fileName = (item.fileName || item.FileName || item.name || item.Name || "").toLowerCase();
          if (!fileName) return false;
          
          const ext = path.extname(fileName);
          if (!imageExtensions.includes(ext)) return false;
          
          // Pattern 1: Contains full model name
          if (fileName.includes(modelNameStr)) return true;
          // Pattern 2: Contains clean name
          if (modelNameClean && fileName.replace(/[^a-z0-9]/g, '').includes(modelNameClean)) return true;
          // Pattern 3: Contains any significant part of the model name
          return modelParts.some(p => fileName.includes(p));
        });

      console.log(`[Azure Proxy] Filtered down to ${filteredFiles.length} images matching '${modelName}'`);

      // Rewrite URLs to local proxy
      const result = filteredFiles.map((item: any) => {
        const fileName = item.fileName || item.FileName || item.name || item.Name || "";
        const effectiveFolder = folder as string;
        const isFbx = fileName.toLowerCase().endsWith('.fbx');
        const proxyEndpoint = isFbx ? '/api/files/get-files' : '/api/files/get-file';
        
        const proxyUrl = `${proxyEndpoint}?folder=${encodeURIComponent(effectiveFolder)}&clientName=${encodeURIComponent(activeClient as string)}&fileName=${encodeURIComponent(fileName)}`;
        
        return {
          ...item,
          FileName: fileName,
          url: proxyUrl,
          Url: proxyUrl
        };
      });

      res.json(result);
    } catch (err: any) {
      console.error("Azure Images Listing Proxy Error:", err);
      res.status(500).json({ error: "Failed to fetch and filter images from Azure", details: err.message });
    }
  });

  // NEW: API Route for get-file from Azure Web Service (Proxy)
  app.get("/api/files/get-file", async (req, res) => {
    const { folder, fileName, clientName } = req.query;
    if (!folder || !fileName) return res.status(400).send("folder and fileName are required");

    // Default clientName if not passed
    const activeClient = clientName || "tenantB";

    const azureFileUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-file?folder=${folder}&fileName=${encodeURIComponent(fileName as string)}&clientName=${activeClient}`;

    try {
      console.log(`Proxying Azure file: ${azureFileUrl}`);
      const response = await fetchWithTimeout(azureFileUrl, {}, 60000);
      
      if (!response.ok) {
        return res.status(response.status).send(`Azure responded with ${response.status}`);
      }

      // Set headers from Azure response
      const contentType = response.headers.get("Content-Type");
      if (contentType) res.setHeader("Content-Type", contentType);
      
      // Check if we are receiving HTML for a file that isn't supposed to be HTML
      if (contentType && contentType.includes("text/html") && !fileName.toString().toLowerCase().endsWith(".html")) {
        console.warn(`[Proxy Error] Azure returned HTML instead of expected file ${fileName}. Returning 404.`);
        return res.status(404).send("File not found on remote server (Azure returned error page)");
      }
      
      const contentLength = response.headers.get("Content-Length");
      if (contentLength) res.setHeader("Content-Length", contentLength);

      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Cache-Control", "public, max-age=31536000");

      // Stream the body
      const body = response.body;
      if (body) {
        // @ts-ignore - body is a ReadableStream which is compatible enough for pipeline or manual stream
        const reader = body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        } catch (streamErr) {
          console.error("Error streaming Azure file:", streamErr);
          if (!res.writableEnded) res.end();
        }
      } else {
        res.status(500).send("No body in Azure response");
      }
    } catch (err: any) {
      console.error("Azure File Proxy Error:", err);
      res.status(500).send(`Failed to proxy file from Azure: ${err.message}`);
    }
  });

  // Offline auto-translators for mechanical/brakes industry keywords
  const phrasesToReplace: Record<string, Record<string, string>> = {
    'he': {
      "caliper bush 39 mm long type": "תותב קליפר 39 מ\"מ סוג ארוך",
      "caliper bush 39mm long type": "תותב קליפר 39 מ\"מ סוג ארוך",
      "caliper bush": "תותב קליפר",
      "long type": "סוג ארוך",
      "short type": "סוג קצר",
      "long version": "גרסה ארוכה",
      "short version": "גרסה קצרה",
      "39 mm": "39 מ״מ",
      "39mm": "39 מ״מ",
      "present at site": "קיים באתר",
      "no description available": "אין תיאור זמין",
      "unnamed part": "חלק ללא שם"
    },
    'ar': {
      "caliper bush 39 mm long type": "جلبة فرجار 39 مم نوع طويل",
      "caliper bush 39mm long type": "جلبة فرجار 39 مم نوع طويل",
      "caliper bush": "جلبة فرجار",
      "long type": "نوع طويل",
      "short type": "نوع قصير",
      "long version": "نسخة طويلة",
      "short version": "نسخة قصيرة",
      "39 mm": "39 مم",
      "39mm": "39 مم",
      "present at site": "متوفر في الموقع",
      "no description available": "لا يوجد وصف متاح",
      "unnamed part": "جزء غير مسمى"
    },
    'ru': {
      "caliper bush 39 mm long type": "направляющая суппорта втулка 39 мм длинная",
      "caliper bush 39mm long type": "направляющая суппорта втулка 39 мм длинная",
      "caliper bush": "направляющая суппорта втулка",
      "long type": "длинный тип",
      "short type": "короткий тип",
      "long version": "длинная версия",
      "short version": "короткая версия",
      "39 mm": "39 мм",
      "39mm": "39 мм",
      "present at site": "присутствует на сайте",
      "no description available": "описание отсутствует",
      "unnamed part": "безымянная деталь"
    }
  };

  const glossaryHe: Record<string, string> = {
    "caliper": "קליפר",
    "bush": "תותב",
    "bushing": "תותב (בושינג)",
    "long": "ארוך",
    "short": "קצר",
    "type": "סוג",
    "brake": "בלם",
    "brakes": "בלמים",
    "pad": "רפידה",
    "pads": "רפידות",
    "disc": "דיסק",
    "discs": "דיסקים",
    "rotor": "רוטור",
    "rotors": "רוטורים",
    "piston": "בוכנה",
    "pistons": "בוכנות",
    "seal": "אטם",
    "seals": "אטמים",
    "dust": "אבק",
    "boot": "גרמושקה",
    "boots": "גרמושקות",
    "spring": "קפיץ",
    "springs": "קפיצים",
    "pin": "פין",
    "pins": "פינים",
    "bolt": "בורג",
    "bolts": "ברגים",
    "screw": "בורג",
    "screws": "ברגים",
    "nut": "אום",
    "nuts": "אומים",
    "washer": "דיסקית (שייבה)",
    "washers": "דיסקיות",
    "clip": "תפס (קליפס)",
    "clips": "תפסים",
    "bracket": "תושבת",
    "brackets": "תושבות",
    "housing": "בית תושבת",
    "assembly": "מכלול",
    "cover": "כיסוי",
    "covers": "כיסויים",
    "cap": "מכסה",
    "caps": "מכסים",
    "hose": "צינור",
    "hoses": "צינורות",
    "tube": "צינורית",
    "tubes": "צינוריות",
    "valve": "שסתום",
    "valves": "שסתומים",
    "sensor": "חיישן",
    "sensors": "חיישנים",
    "cable": "כבל",
    "cables": "כבלים",
    "wire": "חוט",
    "wires": "חוטים",
    "plug": "פקק",
    "plugs": "פקקים",
    "adapter": "מתאם",
    "adapters": "מתאמים",
    "lever": "מנוף",
    "levers": "מנופים",
    "handle": "ידית",
    "handles": "ידיות",
    "shaft": "ציר",
    "shafts": "צירים",
    "bearing": "מיסב",
    "bearings": "מיסבים",
    "gear": "גלגל שיניים",
    "gears": "גלגלי שיניים",
    "pulley": "גלגלת",
    "pulleys": "גלגלות",
    "belt": "רצועה",
    "belts": "רצועות",
    "chain": "שרשרת",
    "chains": "שרשראות",
    "ring": "טבעת",
    "rings": "טבעות",
    "o-ring": "אטם טבעתי (O-ring)",
    "gasket": "אטם (גסקט)",
    "gaskets": "אטמים",
    "clamp": "חבק (קלאמפ)",
    "clamps": "חבקים",
    "plate": "פלטה (לוחית)",
    "plates": "לוחיות",
    "mount": "תושבת",
    "mounts": "תושבות",
    "link": "חוליה",
    "links": "חוליות",
    "arm": "זרוע",
    "arms": "זרועות",
    "suspension": "מתלה",
    "shock": "בולם זעזועים",
    "absorber": "בולמי זעזועים",
    "strut": "בולם",
    "struts": "בולמים",
    "joint": "מפרק",
    "joints": "מפרקים",
    "ball": "כדור",
    "rod": "מוט",
    "rods": "מוטות",
    "bar": "מוט",
    "bars": "מוטות",
    "wheel": "גלגל",
    "wheels": "גלגלים",
    "hub": "נאבה (טבור הגלגל)",
    "hubs": "נאבות",
    "rim": "ג'אנט",
    "rims": "ג'אנטים",
    "tire": "צמיג",
    "tires": "צמיגים",
    "tyre": "צמיג",
    "tyres": "צמיגים",
    "flange": "אוגן (פלנץ')",
    "flanges": "אוגנים",
    "collar": "טבעת הידוק",
    "sleeve": "שרוול",
    "sleeves": "שרוולים",
    "spacer": "ספייסר (מרחיק)",
    "spacers": "ספייסרים",
    "cylinder": "צילינדר",
    "cylinders": "צילינדרים",
    "manifold": "סעפת",
    "manifolds": "סעפות",
    "main": "ראשי",
    "secondary": "משני",
    "left": "שמאל (L)",
    "right": "ימין (R)",
    "front": "קדמי",
    "rear": "אחורי",
    "upper": "עליון",
    "lower": "תחתון",
    "inner": "פנימי",
    "outer": "חיצוני",
    "side": "צד",
    "middle": "אמצעי",
    "center": "מרכז",
    "large": "גדול",
    "small": "קטן",
    "medium": "בינוני",
    "heavy": "כבד",
    "light": "קל",
    "new": "חדש",
    "old": "ישן",
    "standard": "סטנדרטי",
    "custom": "מותאם אישית",
    "universal": "אוניברסלי",
    "spec": "מפרט",
    "details": "פרטים",
    "parts": "חלקים",
    "tenants": "לקוחות",
    "images": "תמונות",
    "mm": "מ״מ"
  };

  const glossaryAr: Record<string, string> = {
    "caliper": "فرجار",
    "bush": "جلبة",
    "bushing": "جلبة",
    "long": "طويل",
    "short": "قصير",
    "type": "نوع",
    "brake": "فرامل",
    "brakes": "فرامل",
    "pad": "وسادة فرملة",
    "pads": "وسادات فرملة",
    "disc": "قرص",
    "discs": "أقراص",
    "rotor": "دوار",
    "rotors": "دوارات",
    "piston": "مكبس",
    "pistons": "مكابس",
    "seal": "ختم",
    "seals": "أختام",
    "dust": "غبار",
    "boot": "غطاء غبار",
    "boots": "أغطية غبار",
    "spring": "نابض",
    "springs": "نوابض",
    "pin": "دبوس",
    "pins": "دبابيس",
    "bolt": "مسمار",
    "bolts": "مسامير",
    "screw": "برغي",
    "screws": "براغي",
    "nut": "صامولة",
    "nuts": "صواميل",
    "washer": "حلقة",
    "washers": "حلقات",
    "clip": "مشبك",
    "clips": "مشابك",
    "bracket": "كتيفة",
    "brackets": "كتيفات",
    "housing": "هيكل",
    "assembly": "تجميع",
    "cover": "غطاء",
    "covers": "أغطية",
    "cap": "غطاء",
    "caps": "أغطية",
    "hose": "خرطوم",
    "hoses": "خراطيم",
    "tube": "أنبوب",
    "tubes": "أنابيب",
    "valve": "صمام",
    "valves": "صمامات",
    "sensor": "مستشعر",
    "sensors": "مستشعرات",
    "cable": "كابل",
    "cables": "كابلات",
    "wire": "سلك",
    "wires": "أسلاك",
    "plug": "سدادة",
    "plugs": "سدادات",
    "adapter": "محول",
    "adapters": "محولات",
    "lever": "ذراع",
    "levers": "أذرع",
    "handle": "مقبض",
    "handles": "مقابض",
    "shaft": "عمود",
    "shafts": "أعمدة",
    "bearing": "محمل",
    "bearings": "محامل",
    "gear": "ترس",
    "gears": "تروس",
    "pulley": "بكرة",
    "pulleys": "بكرات",
    "belt": "حزام",
    "belts": "أحزمة",
    "chain": "سلسلة",
    "chains": "سلاسل",
    "ring": "حلقة",
    "rings": "حلقات",
    "o-ring": "حلقة دائرية",
    "gasket": "حشية",
    "gaskets": "حشيات",
    "clamp": "مشبك تثبيت",
    "clamps": "مشابك تثبيت",
    "plate": "صفيحة",
    "plates": "صفائح",
    "mount": "قاعدة",
    "mounts": "قواعد",
    "link": "وصلة",
    "links": "وصلات",
    "arm": "ذراع",
    "arms": "أذرع",
    "suspension": "نظام التعليق",
    "shock": "ممتص الصدمات",
    "absorber": "ممتص صدمات",
    "strut": "دعامة",
    "struts": "دعامة",
    "joint": "مفصل",
    "joints": "مفاصل",
    "ball": "كرة",
    "rod": "قضيب",
    "rods": "قضبان",
    "bar": "قضيب",
    "bars": "قضبان",
    "wheel": "عجلة",
    "wheels": "عجلات",
    "hub": "صرة",
    "hubs": "صرر",
    "rim": "إطار معدني",
    "rims": "إطارات معدنية",
    "tire": "إطار",
    "tires": "إطارات",
    "tyre": "إطار",
    "tyres": "إطارات",
    "flange": "شفة",
    "flanges": "شفاه",
    "collar": "طوق",
    "sleeve": "كم",
    "sleeves": "أكمام",
    "spacer": "فاصل",
    "spacers": "فواصل",
    "cylinder": "أسطوانة",
    "cylinders": "أسطوانات",
    "manifold": "متشعب",
    "manifolds": "متشعبات",
    "main": "رئيسي",
    "secondary": "ثانوي",
    "left": "يسار",
    "right": "يمين",
    "front": "أمامي",
    "rear": "خلفي",
    "upper": "علوي",
    "lower": "سفلي",
    "inner": "داخلي",
    "outer": "خارجي",
    "side": "جانبي",
    "middle": "أوسط",
    "center": "مركز",
    "large": "كبير",
    "small": "صغير",
    "medium": "متوسط",
    "heavy": "ثقيل",
    "light": "خفيف",
    "new": "جديد",
    "old": "قديم",
    "standard": "قياسي",
    "custom": "مخصص",
    "universal": "شامل",
    "spec": "مواصفات",
    "details": "تفاصيل",
    "parts": "أجزاء",
    "tenants": "المستأجرين",
    "images": "صور",
    "mm": "مم"
  };

  const glossaryRu: Record<string, string> = {
    "caliper": "суппорт",
    "bush": "втулка",
    "bushing": "втулка",
    "long": "длинный",
    "short": "короткий",
    "type": "тип",
    "brake": "тормоз",
    "brakes": "тормоза",
    "pad": "тормозная колодка",
    "pads": "колодки",
    "disc": "тормозной диск",
    "discs": "диски",
    "rotor": "ротор",
    "rotors": "роторы",
    "piston": "поршень",
    "pistons": "поршни",
    "seal": "сальник",
    "seals": "сальники",
    "dust": "пыль",
    "boot": "пыльник",
    "boots": "пыльники",
    "spring": "пружина",
    "springs": "пружины",
    "pin": "палец",
    "pins": "пальцы",
    "bolt": "болт",
    "bolts": "болты",
    "screw": "винт",
    "screws": "винты",
    "nut": "гайка",
    "nuts": "гайки",
    "washer": "шайба",
    "washers": "шайбы",
    "clip": "зажим",
    "clips": "зажимы",
    "bracket": "кронштейн",
    "brackets": "кронштейны",
    "housing": "корпус",
    "assembly": "узел в сборе",
    "cover": "крышка",
    "covers": "крышки",
    "cap": "колпачок",
    "caps": "колпачки",
    "hose": "шланг",
    "hoses": "шланги",
    "tube": "трубка",
    "tubes": "трубки",
    "valve": "клапан",
    "valves": "клапаны",
    "sensor": "датчик",
    "sensors": "датчики",
    "cable": "кабель",
    "cables": "кабели",
    "wire": "провод",
    "wires": "провода",
    "plug": "заглушка",
    "plugs": "заглушки",
    "adapter": "адаптер",
    "adapters": "адаптеры",
    "lever": "рычаг",
    "levers": "рычаги",
    "handle": "ручка",
    "handles": "ручки",
    "shaft": "вал",
    "shafts": "валы",
    "bearing": "подшипник",
    "bearings": "подшипники",
    "gear": "шестерня",
    "gears": "шестерни",
    "pulley": "шкив",
    "pulleys": "шкивы",
    "belt": "ремень",
    "belts": "ремни",
    "chain": "цепь",
    "chains": "цепи",
    "ring": "кольцо",
    "rings": "кольца",
    "o-ring": "уплотнительное кольцо",
    "gasket": "прокладка",
    "gaskets": "прокладки",
    "clamp": "хомут",
    "clamps": "хомуты",
    "plate": "пластина",
    "plates": "пластины",
    "mount": "крепление",
    "mounts": "крепления",
    "link": "звено",
    "links": "звенья",
    "arm": "рычаг",
    "arms": "рычаги",
    "suspension": "подвеска",
    "shock": "амортизатор",
    "absorber": "амортизаторы",
    "strut": "стойка амортизатора",
    "struts": "стойки",
    "joint": "шарнир",
    "joints": "шарниры",
    "ball": "шаровый",
    "rod": "тяга",
    "rods": "тяги",
    "bar": "штанга",
    "bars": "штанги",
    "wheel": "колесо",
    "wheels": "колеса",
    "hub": "ступица",
    "hubs": "ступицы",
    "rim": "обод",
    "rims": "ободья",
    "tire": "шина",
    "tires": "шины",
    "tyre": "шина",
    "tyres": "шины",
    "flange": "фланец",
    "flanges": "фланцы",
    "collar": "хомут крепления",
    "sleeve": "гильза",
    "sleeves": "гильзы",
    "spacer": "проставка",
    "spacers": "проставки",
    "cylinder": "цилиндр",
    "cylinders": "цилиндры",
    "manifold": "коллектор",
    "manifolds": "коллекторы",
    "main": "главный",
    "secondary": "вторичный",
    "left": "левый",
    "right": "правый",
    "front": "передний",
    "rear": "задний",
    "upper": "верхний",
    "lower": "нижний",
    "inner": "внутренний",
    "outer": "внешний",
    "side": "боковой",
    "middle": "средний",
    "center": "центральный",
    "large": "большой",
    "small": "маленький",
    "medium": "средний",
    "heavy": "тяжелый",
    "light": "легкий",
    "new": "новый",
    "old": "старый",
    "standard": "стандартный",
    "custom": "индивидуальный",
    "universal": "универсальный",
    "spec": "характеристики",
    "details": "детали",
    "parts": "части",
    "tenants": "клиенты",
    "images": "изображения",
    "mm": "мм"
  };

  const wordGlossaries: Record<string, Record<string, string>> = {
    'he': glossaryHe,
    'ar': glossaryAr,
    'ru': glossaryRu
  };

  const translateOffline = (text: string, langCode: string): string => {
    const code = langCode.toLowerCase().trim();
    const trimmed = text.trim();
    if (!trimmed) return "";
    
    // Remove extension for lookup but don't append it to keep UI names super beautiful
    let cleanText = trimmed;
    const fbxMatch = cleanText.match(/^(.*)\.fbx$/i);
    if (fbxMatch) {
      cleanText = fbxMatch[1].trim();
    }

    const lowerText = cleanText.toLowerCase();

    const phrases = phrasesToReplace[code];
    const glossary = wordGlossaries[code];

    if (!phrases && !glossary) {
      return trimmed;
    }

    if (phrases) {
      // Check for exact full phrase matches first
      if (phrases[lowerText]) {
        return phrases[lowerText];
      }
      
      let replaced = lowerText;
      
      // Sort keys descending by length to match longer phrases first to avoid greedy matching
      const sortedKeys = Object.keys(phrases).sort((a,b) => b.length - a.length);
      sortedKeys.forEach(eng => {
        const trans = phrases[eng];
        // Replace matching substrings (not strictly bound to words if they wrap numbers, like 39mm)
        if (replaced.includes(eng)) {
          replaced = replaced.split(eng).join(trans);
        }
      });

      if (glossary) {
        // Translate remaining standalone English words
        const regexWords = /([a-zA-Z]{3,})/g;
        replaced = replaced.replace(regexWords, (match) => {
          const wordLower = match.toLowerCase();
          if (glossary[wordLower]) {
            return glossary[wordLower];
          }
          if (phrases[wordLower]) {
            return phrases[wordLower];
          }
          return match;
        });
      }

      // Final cleanups and return
      let finalResult = replaced.trim();
      if (code === 'ru' && finalResult.length > 0) {
        // Capitalize first letter of Russian string
        finalResult = finalResult.charAt(0).toUpperCase() + finalResult.slice(1);
      }
      return finalResult;
    }

    return trimmed;
  };

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
      // If it's a long name not in map, default to something or try to use it as-is (might fail)
      console.warn(`Unknown language name: ${targetLanguage}, using as-is.`);
    } else if (lowerLang.includes('-')) {
      // Handle codes like he-IL -> he
      langCode = lowerLang.split('-')[0];
    }

    // Filter out invalid items to prevent API errors
    const uniqueTextsMap = new Map<string, number[]>();
    texts.forEach((t, i) => {
      const cleaned = (t === null || t === undefined) ? "" : String(t).trim();
      if (cleaned.length > 0) {
        if (!uniqueTextsMap.has(cleaned)) {
          uniqueTextsMap.set(cleaned, []);
        }
        uniqueTextsMap.get(cleaned)!.push(i);
      }
    });

    const uniqueValidTexts = Array.from(uniqueTextsMap.keys());
    
    if (uniqueValidTexts.length === 0) {
      console.log("No valid texts to translate, returning originals.");
      return res.json({ translated: texts });
    }

    // Primary: Attempt Gemini first as it's a major capability of this environment and more robust
    if (ai && !isGeminiQuotaExceeded) {
      try {
        console.log(`Using Gemini for translation to ${targetLanguage} (${uniqueValidTexts.length} unique items)...`);
        const prompt = `Translate the following list of strings to ${targetLanguage}. 
Return ONLY a valid JSON array of strings in the exact same order.
If you cannot translate a string, return the original text.

List to translate:
${JSON.stringify(uniqueValidTexts)}`;

        const result = await ai.models.generateContent({
          model: "gemini-3.1-flash-lite",
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          config: {
            responseMimeType: "application/json",
            responseSchema: {
              type: Type.ARRAY,
              items: { type: Type.STRING }
            }
          }
        });

        let translatedUnique: string[] = [];
        try {
          translatedUnique = JSON.parse(result.text || "[]");
        } catch (e) {
          console.error("Gemini returned invalid JSON for translation.");
        }
        
        if (translatedUnique.length === uniqueValidTexts.length) {
          const finalResults = new Array(texts.length).fill("");
          // Fill original texts for everything first
          texts.forEach((t, i) => finalResults[i] = t);
          
          // Map translated unique back to original indices
          uniqueValidTexts.forEach((originalText, uniqueIdx) => {
            const indices = uniqueTextsMap.get(originalText) || [];
            indices.forEach(originalIdx => {
              finalResults[originalIdx] = translatedUnique[uniqueIdx];
            });
          });
          
          return res.json({ translated: finalResults });
        } else {
          console.warn(`Gemini returned ${translatedUnique.length} items but expected ${uniqueValidTexts.length}. Falling back to secondary methods.`);
        }
      } catch (geminiErr: any) {
        const errMsg = geminiErr?.message || String(geminiErr);
        if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("depleted") || errMsg.includes("credits")) {
          isGeminiQuotaExceeded = true;
          console.warn("⚠️ [Translation] Gemini API credits are depleted or quota is exhausted. Automatically switching to high-fidelity offline translation engine for instant zero-latency processing.");
        } else {
          console.warn("Gemini translation attempt failed, checking for secondary methods:", errMsg);
        }
      }
    }

    // Secondary: Attempt Cloud Translation if Gemini failed or is unavailable
    if (translate && !isGeminiQuotaExceeded) {
      try {
        console.log(`Attempting Cloud Translation as fallback for ${uniqueValidTexts.length} unique items to codes='${langCode}'...`);
        
        const BATCH_SIZE = 50;
        const translatedResults: string[] = [];
        
        for (let i = 0; i < uniqueValidTexts.length; i += BATCH_SIZE) {
          const batch = uniqueValidTexts.slice(i, i + BATCH_SIZE);
          const [translations] = await translate.translate(batch, langCode);
          const results = Array.isArray(translations) ? translations : [translations];
          translatedResults.push(...results);
        }
        
        if (translatedResults.length === uniqueValidTexts.length) {
          const finalResults = new Array(texts.length).fill("");
          texts.forEach((t, i) => finalResults[i] = t);
          
          uniqueValidTexts.forEach((originalText, uniqueIdx) => {
            const indices = uniqueTextsMap.get(originalText) || [];
            indices.forEach(originalIdx => {
              finalResults[originalIdx] = translatedResults[uniqueIdx];
            });
          });
          
          return res.json({ translated: finalResults });
        }
      } catch (err: any) {
        if (err.message?.includes('blocked') || err.code === 403) {
          console.warn("Cloud Translation API is blocked or restricted. Using ultimate fallback.");
        } else {
          console.error("Cloud Translation API Error details:", err);
        }
      }
    }

    // Ultimate fallback: return translated via the powerful offline dictionary engine
    if (!isGeminiQuotaExceeded) {
      console.warn("All live translation APIs failed. Falling back to the ultimate offline dictionary engine.");
    }
    try {
      const offlineResults = texts.map(t => translateOffline(String(t), langCode));
      return res.json({ translated: offlineResults });
    } catch (offlineErr) {
      console.error("Offline helper translator failed:", offlineErr);
    }

    // Absolute fallback: return original texts
    res.json({ translated: texts });
  });

  // API Route for TTS
  app.post("/api/ai/tts", async (req, res) => {
    const { text, langCode } = req.body;
    if (!text) return res.status(400).json({ error: "text is required" });

    if (isGeminiQuotaExceeded) {
      return res.status(429).json({ error: "TTS quota exceeded or credits depleted. Falling back to native speech automatically." });
    }

    const ai = getAI();
    if (!ai) return res.status(500).json({ error: "Gemini API not configured" });

    try {
      const hint = langCode === 'he' ? `Speak this Hebrew text clearly: ${text}` : 
                 langCode === 'ar' ? `Speak this Arabic text clearly: ${text}` : text;

      const modelName = "gemini-3.1-flash-tts-preview";
      const result = await ai.models.generateContent({
        model: modelName,
        contents: [{ role: "user", parts: [{ text: hint }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore' 
              },
            },
          },
        },
      });

      const audioBase64 = result.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData?.data;

      if (audioBase64) {
        res.json({ audio: audioBase64 });
      } else {
        console.error("No audio content in Gemini 3.1 response:", JSON.stringify(result).substring(0, 500));
        res.status(500).json({ error: "No audio generated", details: "Response did not contain audio data" });
      }
    } catch (err: any) {
      console.error("TTS API Error:", err);
      const errMsg = err?.message || String(err);
      if (errMsg.includes("429") || errMsg.includes("RESOURCE_EXHAUSTED") || errMsg.includes("depleted") || errMsg.includes("credits")) {
        isGeminiQuotaExceeded = true;
        console.warn("⚠️ [TTS] Gemini API credits are depleted or quota is exhausted. Automatically switching to native speech on client-side for zero-latency gameplay.");
      }
      res.status(500).json({ error: "TTS failed", detail: err.message });
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
      const modelNameClean = modelNameStr.replace(/[^a-z0-9]/g, '');
      const modelParts = modelNameStr.split(/[\s_-]/).filter(p => p.length > 2);

      let filteredFiles = allFiles
        .filter(obj => {
          const key = (obj.Key || "").toLowerCase();
          const ext = path.extname(key).toLowerCase();
          if (!imageExtensions.includes(ext)) return false;
          
          // Pattern 1: Contains full model name
          if (key.includes(modelNameStr)) return true;
          // Pattern 2: Contains clean name
          if (modelNameClean && key.replace(/[^a-z0-9]/g, '').includes(modelNameClean)) return true;
          // Pattern 3: Contains any significant part of the model name
          return modelParts.some(p => key.includes(p));
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
    app.use(express.static(path.join(__dirname, "dist")));
    app.use((req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
