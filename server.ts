import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pipeline } from "stream/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
async function fetchWithTimeout(url: string, options: any = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
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

    // Use the provided Azure API URL structure
    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/ModelsParts/productName/${encodeURIComponent(modelName)}`;

    try {
      console.log(`Fetching model parts from Azure API: ${azureApiUrl}`);
      const response = await fetchWithTimeout(azureApiUrl, {}, 15000);
      
      if (!response.ok) {
        throw new Error(`Azure API responded with status: ${response.status}`);
      }

      const text = await response.text();
      if (!text || text.trim() === "") throw new Error("Azure API returned an empty response");
      
      let data;
      try {
        data = JSON.parse(text);
      } catch (jsonErr) {
        throw new Error("Azure API returned invalid JSON");
      }
      
      // Map the Azure API response to our ModelPart interface
      const parts = Array.isArray(data) ? data.map((item: any) => ({
        id: (item.partId || item.PartId || Math.random().toString(36).substr(2, 9)).toString(),
        modelName: modelName,
        partName: item.displayName || item.display_name || item.partKey || item.PartKey || "",
        partKey: item.partKey || item.PartKey || "",
        description: item.description || item.Description || "",
        linkTo: item.linkTo || item.LinkTo || ""
      })) : [];

      res.json(parts); // Send array directly as suggested by frontend update
    } catch (err: any) {
      console.error("Azure API Error:", err);
      
      // Fallback to mock data if the API call fails or is not yet configured
      console.warn("Falling back to mock data due to API error.");
      const mockParts = [
        { id: 'mock-1', modelName, partName: 'Axe_Head', partKey: 'HEAD-001', description: 'Heavy steel head, forged for maximum impact.' },
        { id: 'mock-2', modelName, partName: 'Handle', partKey: 'HNDL-042', description: 'Ergonomic wooden handle with leather grip.' }
      ];
      res.json(mockParts);
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
      const response = await fetchWithTimeout(azureApiUrl, {}, 15000);
      
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
        const resp = await fetchWithTimeout(url, {}, 15000);
        if (!resp.ok) return null;
        
        const text = await resp.text();
        if (!text || text.trim() === "") return null;
        
        try {
          return JSON.parse(text);
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
      // 1. Try exact name
      let data = await tryFetch(modelName);
      
      // 2. Try capitalized name (e.g. connector -> Connector)
      if (!data) {
        const capitalized = modelName.charAt(0).toUpperCase() + modelName.slice(1);
        if (capitalized !== modelName) {
          data = await tryFetch(capitalized);
        }
      }

      // 3. Fallback to "Connector"
      if (!data) {
        data = await tryFetch("Connector");
      }

      if (data) {
        // Handle if API returns an array instead of a single object
        const result = Array.isArray(data) ? data[0] : data;
        
        if (result) {
          console.log(`Successfully fetched details for ${modelName}:`, {
            productTitle: result.productTitle || result.title,
            hasDescription: !!(result.productDescription || result.description)
          });
          return res.json(result);
        }
      }

      res.status(404).json({ error: "Product not found" });
    } catch (err: any) {
      console.error("Azure Product Details API Error:", err);
      res.status(500).json({ error: "Failed to fetch product details", details: err.message });
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
      const response = await fetchWithTimeout(azureApiUrl, {}, 15000);
      
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

    const activeClient = clientName || "tenantA";
    
    // We use get-files for listing since get-images-by-model doesn't seem to exist as a GET endpoint
    const azureApiUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-files?folder=${folder}&clientName=${activeClient}`;

    try {
      console.log(`Fetching image list from Azure for model filtering: ${azureApiUrl}`);
      const response = await fetchWithTimeout(azureApiUrl, {}, 15000);
      
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
    const activeClient = clientName || "tenantA";

    const azureFileUrl = `https://fbx-studio-bnecb0euepare0ew.westeurope-01.azurewebsites.net/api/files/get-file?folder=${folder}&fileName=${encodeURIComponent(fileName as string)}&clientName=${activeClient}`;

    try {
      console.log(`Proxying Azure file: ${azureFileUrl}`);
      const response = await fetchWithTimeout(azureFileUrl, {}, 30000);
      
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
