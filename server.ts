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

async function startServer() {
  validateR2Config();
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

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

      const data = await response.json();
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

      const rawData = await response.json();
      
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
