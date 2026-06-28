
import React, { useState, Suspense, useCallback, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, Float, Html, Center, useProgress } from '@react-three/drei';
import * as THREE from 'three';
import './types';
import FBXModel, { generateSingleMeshUVSVG } from './components/FBXModel';
import { ModelErrorBoundary } from './components/ModelErrorBoundary';
import Sidebar from './components/Sidebar';
import CameraControls from './components/CameraControls';
import { MaterialSettings, SceneModelInstance, ModelPart, ColorVariant, TextureSet } from './types';
import { speakText, stopSpeaking, translateText, translateBatch } from './services/ttsService';
import { Language, translations } from './src/translations';
import { parseTextureSets } from './Parsetexturesets';

const cleanEscapedQuotes = (str: string): string => {
  if (!str) return '';
  // First, resolve double-escaped quotes like \\' or \\\"
  let cleaned = str.replace(/\\+(['"])/g, '$1');
  // Convert literal text "\r\n" or "\n" to real newlines
  cleaned = cleaned.replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  // Convert all actual newline characters to <br /> tags for HTML rendering
  cleaned = cleaned.replace(/\r\n/g, '<br />').replace(/\n/g, '<br />');
  return cleaned;
};

const CameraHandler: React.FC<{ 
  targetView: { pos: THREE.Vector3, lookAt: THREE.Vector3 } | null, 
  controlsRef: any,
  activePartMesh?: THREE.Mesh | null,
  orbitDirection?: 'up' | 'down' | 'left' | 'right' | null
}> = ({ targetView, controlsRef, activePartMesh, orbitDirection }) => {
  const { camera } = useThree();

  // Store dynamic props in refs to avoid R3F stale closures in useFrame
  const orbitDirectionRef = useRef(orbitDirection);
  const targetViewRef = useRef(targetView);
  const activePartMeshRef = useRef(activePartMesh);

  useEffect(() => {
    orbitDirectionRef.current = orbitDirection;
  }, [orbitDirection]);

  useEffect(() => {
    targetViewRef.current = targetView;
  }, [targetView]);

  useEffect(() => {
    activePartMeshRef.current = activePartMesh;
  }, [activePartMesh]);

  useFrame(() => {
    const currentOrbitDirection = orbitDirectionRef.current;
    const currentTargetView = targetViewRef.current;
    const currentActivePartMesh = activePartMeshRef.current;

    if (controlsRef.current) {
      // 1. Manual continuous orbiting via D-pad arrows
      if (currentOrbitDirection) {
        try {
          const controls = controlsRef.current;
          const target = controls.target || new THREE.Vector3(0, 0, 0);
          const offset = camera.position.clone().sub(target);
          const speed = 0.035; // smooth rotation speed in radians per frame

          if (currentOrbitDirection === 'left') {
            offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), speed);
          } else if (currentOrbitDirection === 'right') {
            offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), -speed);
          } else if (currentOrbitDirection === 'up') {
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
            offset.applyAxisAngle(right, speed);
          } else if (currentOrbitDirection === 'down') {
            const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
            offset.applyAxisAngle(right, -speed);
          }

          camera.position.copy(target).add(offset);
          camera.lookAt(target);
          controls.update();
        } catch (err) {
          console.warn("[CameraHandler] Failed manual orbit:", err);
        }
        return; // Skip default lerping behavior during manual orbit
      }

      let trackingSucceeded = false;
      
      // Fully validate that the mesh is valid, loaded, and not disposed/stale
      if (
        currentActivePartMesh && 
        currentActivePartMesh.isMesh && 
        currentActivePartMesh.geometry && 
        currentActivePartMesh.geometry.attributes && 
        currentActivePartMesh.geometry.attributes.position &&
        currentActivePartMesh.parent
      ) {
        try {
          // Calculate current world position of the mesh for dynamic tracking
          const box = new THREE.Box3();
          box.setFromObject(currentActivePartMesh);
          const center = new THREE.Vector3();
          box.getCenter(center);
          
          // Target the center of the mesh
          controlsRef.current.target.lerp(center, 0.02);
          
          // If we have a targetView, maintain the relative offset from the moving center
          if (currentTargetView) {
            const offset = currentTargetView.pos.clone().sub(currentTargetView.lookAt);
            const dynamicTargetPos = center.clone().add(offset);
            camera.position.lerp(dynamicTargetPos, 0.02);
          }
          
          trackingSucceeded = true;
        } catch (err) {
          console.warn("[CameraHandler] Failed to calculate dynamic tracking for activePartMesh:", err);
        }
      }

      // Fallback if no active part tracking is active or if tracking failed/mesh is stale
      if (!trackingSucceeded && currentTargetView) {
        try {
          camera.position.lerp(currentTargetView.pos, 0.02);
          controlsRef.current.target.lerp(currentTargetView.lookAt, 0.02);
        } catch (err) {
          console.warn("[CameraHandler] Failed to lerp targetView:", err);
        }
      }

      try {
        controlsRef.current.update();
      } catch (err) {
        console.warn("[CameraHandler] Failed to update controls:", err);
      }
    }
  });
  return null;
};

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

interface PrefetchItem {
  url: string;
  type: 'fbx' | 'texture';
  modelName: string;
  name: string;
}

async function fetchWithProgress(url: string, onProgress: (loaded: number, total: number) => void): Promise<Blob> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  
  const contentLength = response.headers.get('content-length');
  const total = contentLength ? parseInt(contentLength, 10) : 0;
  
  if (!response.body || total === 0) {
    const blob = await response.blob();
    onProgress(blob.size, blob.size);
    return blob;
  }
  
  const reader = response.body.getReader();
  let loaded = 0;
  const chunks: Uint8Array[] = [];
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.length;
      onProgress(loaded, total);
    }
  }
  
  return new Blob(chunks);
}


const App: React.FC = () => {
  const [models, setModels] = useState<SceneModelInstance[]>([]);
  const [catalogFiles, setCatalogFiles] = useState<any[]>([]);
  const [catalogTextures, setCatalogTextures] = useState<any[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isMoveMode, setIsMoveMode] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isCatalogCollapsed, setIsCatalogCollapsed] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [catalogSearchQuery, setCatalogSearchQuery] = useState('');
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isNightMode, setIsNightMode] = useState(false);
  const [isProductInfoOpen, setIsProductInfoOpen] = useState(false);
  const [orbitDirection, setOrbitDirection] = useState<'up' | 'down' | 'left' | 'right' | null>(null);
  const [isFetchingDetails, setIsFetchingDetails] = useState(false);
  const [language, setLanguage] = useState<Language>('en');
  const [productDetails, setProductDetails] = useState<{ 
    productId?: string,
    title: string, 
    description: string, 
    originalTitle: string, 
    originalDescription: string,
    linkTo?: string,
    category?: string,
    subCategory?: string,
    originalCategory?: string,
    originalSubCategory?: string,
    price?: number
  } | null>(null);
  const [productTitles, setProductTitles] = useState<Record<string, string>>({});
  const [translatedSelectedModelName, setTranslatedSelectedModelName] = useState<string>('');
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768);
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'success' } | null>(null);
  const [uvLayoutSvg, setUvLayoutSvg] = useState<string>('');
  const [uvLayoutFilename, setUvLayoutFilename] = useState<string>('');
  const [partUVMaps, setPartUVMaps] = useState<Record<string, { svg: string; filename: string }>>({});
  const [inspectedUVPart, setInspectedUVPart] = useState<{ name: string; svg: string; filename: string } | null>(null);
  
  // Unified 3D model & texture preloading progress tracking states
  const [fbxProgress, setFbxProgress] = useState(0);
  const [texturesLoaded, setTexturesLoaded] = useState(0);
  const [texturesTotal, setTexturesTotal] = useState(-1);
  const [isFbxDone, setIsFbxDone] = useState(false);
  const [smoothProgress, setSmoothProgress] = useState(0);

  // Background prefetching / caching states
  const [cachedUrls, setCachedUrls] = useState<Record<string, boolean>>({});
  const [activeModelBlobUrls, setActiveModelBlobUrls] = useState<Record<string, string>>({});
  const [prefetchQueue, setPrefetchQueue] = useState<PrefetchItem[]>([]);
  const [currentPrefetchIndex, setCurrentPrefetchIndex] = useState(-1);
  const [isPrefetchPaused, setIsPrefetchPaused] = useState(false);
  const [currentPrefetchProgress, setCurrentPrefetchProgress] = useState(0);
  const [prefetchSummary, setPrefetchSummary] = useState({ loaded: 0, total: 0 });
  const isPrefetchingActive = useRef(false);

  // Derive model fully loaded state checks mapped above our hooks to safely prevent closures locking onto stale body evaluations
  const isTargetFullyLoaded = isFbxDone && texturesTotal >= 0 && (texturesTotal === 0 || texturesLoaded >= texturesTotal);
  const isModelFullyLoaded = isTargetFullyLoaded && smoothProgress >= 99.9;

  // 1. Initial Cache storage loader - queries keys without instantiating massive Object URLs in RAM
  useEffect(() => {
    const loadExistingCache = async () => {
      try {
        const cache = await caches.open('model-assets-cache');
        const keys = await cache.keys();
        const mappings: Record<string, boolean> = {};
        
        console.log(`[CacheLoader] Found ${keys.length} raw cache records. Storing lightweight offline index...`);
        
        for (const req of keys) {
          mappings[req.url] = true;
        }
        
        setCachedUrls(mappings);
      } catch (err) {
        console.warn('[CacheLoader] Error loading initial Cache Storage keys:', err);
      }
    };
    
    loadExistingCache();
  }, []);

  // 2. Queue builder when catalog files and textures are ready
  useEffect(() => {
    if (catalogFiles.length === 0) return;
    
    const queue: PrefetchItem[] = [];
    
    catalogFiles.forEach(file => {
      const originalDisplayName = file.name.replace(/\.fbx$/i, '');
      
      // FBX Model itself
      queue.push({
        url: file.url,
        type: 'fbx',
        modelName: originalDisplayName,
        name: file.name
      });
      
      // Related Textures
      const matchingTextures = catalogTextures.filter(tex => isModelTextureMatch(tex.name, originalDisplayName));
      matchingTextures.forEach(tex => {
        queue.push({
          url: tex.url,
          type: 'texture',
          modelName: originalDisplayName,
          name: tex.name
        });
      });
    });
    
    setPrefetchQueue(queue);
    setPrefetchSummary({ loaded: 0, total: queue.length });
    setCurrentPrefetchIndex(0);
  }, [catalogFiles, catalogTextures]);

  // 3. Sequentially process next prefetch queue item - purely writing to cache storage, not generating Memory Blobs
  useEffect(() => {
    let active = true;
    
    const processNextQueueItem = async () => {
      if (!active) return;
      
      // Freeze caching entirely if an active model is busy loading (maximizing IO and CPU for interactive render)
      const isModelLoading = catalogFiles.length > 0 && !isModelFullyLoaded;
      
      if (isPrefetchPaused || isModelLoading || currentPrefetchIndex < 0 || currentPrefetchIndex >= prefetchQueue.length) {
        isPrefetchingActive.current = false;
        return;
      }
      
      if (isPrefetchingActive.current) return;
      isPrefetchingActive.current = true;
      
      const item = prefetchQueue[currentPrefetchIndex];
      
      // Skip download if we already verified caching
      if (cachedUrls[item.url]) {
        setPrefetchSummary(prev => ({ ...prev, loaded: Math.min(prev.loaded + 1, prev.total) }));
        isPrefetchingActive.current = false;
        setCurrentPrefetchIndex(prev => prev + 1);
        return;
      }
      
      // Skip download if it's in Cache Storage but just not in cachedUrls yet
      try {
        const cache = await caches.open('model-assets-cache');
        const matched = await cache.match(item.url);
        if (matched) {
          setCachedUrls(prev => ({ ...prev, [item.url]: true }));
          setPrefetchSummary(prev => ({ ...prev, loaded: Math.min(prev.loaded + 1, prev.total) }));
          isPrefetchingActive.current = false;
          setCurrentPrefetchIndex(prev => prev + 1);
          return;
        }
      } catch (e) {
        console.warn('[Prefetch] Match error:', e);
      }
      
      // Perform progressive background fetch
      try {
        console.log(`[Prefetch] Background fetch: ${item.name} (${currentPrefetchIndex + 1}/${prefetchQueue.length})`);
        setCurrentPrefetchProgress(0);
        
        const blob = await fetchWithProgress(item.url, (loaded, total) => {
          if (!active) return;
          const progress = total > 0 ? Math.round((loaded / total) * 100) : 0;
          setCurrentPrefetchProgress(progress);
        });
        
        if (!active) return;
        
        const cache = await caches.open('model-assets-cache');
        const responseToCache = new Response(blob, {
          headers: {
            'Content-Type': item.type === 'fbx' ? 'application/octet-stream' : 'image/jpeg',
            'Content-Length': blob.size.toString()
          }
        });
        await cache.put(item.url, responseToCache);
        
        setCachedUrls(prev => ({ ...prev, [item.url]: true }));
        setPrefetchSummary(prev => ({ ...prev, loaded: Math.min(prev.loaded + 1, prev.total) }));
        
        console.log(`[Prefetch] Completed and cached locally to offline disk storage: ${item.name}`);
      } catch (err) {
        console.warn(`[Prefetch] Failed caching item ${item.name}:`, err);
      } finally {
        if (active) {
          isPrefetchingActive.current = false;
          setCurrentPrefetchProgress(0);
          setCurrentPrefetchIndex(prev => prev + 1);
        }
      }
    };
    
    // Give browser a tiny 1-sec breath before sequentially starting background queue task
    const timer = setTimeout(() => {
      processNextQueueItem();
    }, 1000);
    
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [prefetchQueue, currentPrefetchIndex, isPrefetchPaused, isModelFullyLoaded, cachedUrls, catalogFiles.length]);

  // 4. Resolve Cache to Object URLs for ONLY the active models in the scene (prevents OOM / crashes)
  useEffect(() => {
    let active = true;
    const oldActiveBlobUrls = { ...activeModelBlobUrls };

    const resolveActiveModels = async () => {
      if (models.length === 0) {
        if (active) setActiveModelBlobUrls({});
        // Revoke all prior active object URLs
        Object.values(oldActiveBlobUrls).forEach(url => {
          try { URL.revokeObjectURL(url); } catch (e) { console.warn('Error revoking URL:', e); }
        });
        return;
      }

      const cache = await caches.open('model-assets-cache');
      const newBlobUrls: Record<string, string> = {};

      for (const model of models) {
        // Resolve FBX model structure
        try {
          if (oldActiveBlobUrls[model.url]) {
            newBlobUrls[model.url] = oldActiveBlobUrls[model.url];
          } else {
            const matched = await cache.match(model.url);
            if (matched) {
              const blob = await matched.blob();
              newBlobUrls[model.url] = URL.createObjectURL(blob);
              console.log(`[CacheResolver] Resolved active scene model FBX to memory: ${model.name}`);
            }
          }
        } catch (e) {
          console.warn('[CacheResolver] Match error or file not yet cached for FBX:', model.url, e);
        }

        // Resolve textures for this specific model
        const originalDisplayName = model.name.replace(/\.fbx$/i, '');
        const matchingTextures = catalogTextures.filter(tex => isModelTextureMatch(tex.name, originalDisplayName));

        for (const tex of matchingTextures) {
          try {
            if (oldActiveBlobUrls[tex.url]) {
              newBlobUrls[tex.url] = oldActiveBlobUrls[tex.url];
            } else {
              const matched = await cache.match(tex.url);
              if (matched) {
                const blob = await matched.blob();
                newBlobUrls[tex.url] = URL.createObjectURL(blob);
              }
            }
          } catch (e) {
            console.warn('[CacheResolver] Match error or texture not yet cached:', tex.url, e);
          }
        }
      }

      if (!active) {
        // Clean up any newly instantiated Object URLs if component was aborted
        Object.keys(newBlobUrls).forEach(url => {
          if (!oldActiveBlobUrls[url]) {
            try { URL.revokeObjectURL(newBlobUrls[url]); } catch (e) { console.warn('Error revoking URL:', e); }
          }
        });
        return;
      }

      // Identify and revoke obsoleted active blob URLs to completely free up memory immediately
      Object.keys(oldActiveBlobUrls).forEach(url => {
        if (!newBlobUrls[url]) {
          try { URL.revokeObjectURL(oldActiveBlobUrls[url]); } catch (e) { console.warn('Error revoking URL:', e); }
        }
      });

      setActiveModelBlobUrls(newBlobUrls);
    };

    resolveActiveModels();

    return () => {
      active = false;
    };
  }, [models, catalogTextures]);

  useEffect(() => {
    // Safely subscribe to global Drei loader progress outside the React render path 
    const unsubscribe = useProgress.subscribe((state) => {
      const p = state.progress;
      setTimeout(() => {
        setFbxProgress(Math.floor(p));
      }, 0);
    });
    return () => unsubscribe();
  }, []);

  const selectedModel = models.find(m => m.id === selectedId);

  useEffect(() => {
    if (selectedModel?.url) {
      setFbxProgress(0);
      setTexturesLoaded(0);
      setTexturesTotal(-1);
      setIsFbxDone(false);
      setSmoothProgress(0);
    }
  }, [selectedModel?.id, selectedModel?.url]);

  const t = translations[language];

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const loggedViewProductIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => {
        setToast(null);
      }, 5000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  const fetchingModels = useRef(new Set<string>());

  useEffect(() => {
    // For every model loaded, fetch dedicated texture sets from the API
    models.forEach(model => {
      if (model.textureSets || fetchingModels.current.has(model.id)) return;

      fetchingModels.current.add(model.id);
      const fetchTextureSets = async () => {
        try {
          const folder = 'images';
          const modelName = model.name;
          const clientName = 'tenantA';
          const response = await fetch(`/api/files/get-images-by-model?folder=${encodeURIComponent(folder)}&modelName=${encodeURIComponent(modelName)}&clientName=${clientName}&v=3`);
          if (!response.ok) {
            fetchingModels.current.delete(model.id);
            return;
          }

          const data = await response.json();
          let rawFiles: any[] = [];
          if (Array.isArray(data)) {
            rawFiles = data;
          } else if (data.files && Array.isArray(data.files)) {
            rawFiles = data.files;
          }

          const files = rawFiles.map((f: any) => {
            if (typeof f === 'string') return f;
            return f.Url || f.url || f.FileName || f.name || f.FullPath || '';
          }).filter(f => f !== '');

          console.log(`[App] 📥 Received ${files.length} files from API for model: ${modelName}`);

          if (files.length > 0) {
            const sets = parseTextureSets(files, { prefix: modelName });
            updateModelData(model.id, { textureSets: sets });
          } else {
            updateModelData(model.id, { textureSets: [] });
          }
        } catch (error) {
          console.error(`Failed to fetch texture sets for ${model.name}:`, error);
          fetchingModels.current.delete(model.id);
        }
      };
      
      fetchTextureSets();
    });
  }, [models]);

  useEffect(() => {
    const fetchCatalog = async () => {
      setIsLoadingCatalog(true);
      try {
        const response = await fetch('/api/files/get-files?folder=tenants&clientName=tenantA&v=3');
        if (response.ok) {
          const rawData = await response.json();
          const getListData = (raw: any) => {
            if (Array.isArray(raw)) return raw;
            if (raw && typeof raw === 'object') {
              return raw.files || raw.items || raw.data || Object.values(raw).find(v => Array.isArray(v)) || [];
            }
            return [];
          };
          const modelsData = getListData(rawData);
          const files = modelsData
            .map((item: any) => {
              if (typeof item === 'string') return { key: item, name: item, url: item };
              const name = item.fileName || item.FileName || item.filename || item.Name || item.name || "";
              const key = item.fullPath || item.FullPath || item.fullpath || item.Key || item.item_key || item.key || name || "";
              const itemUrl = item.url || item.Url || "";
              const url = (itemUrl && itemUrl.includes("pub-")) 
                ? itemUrl 
                : `https://pub-721b92b9c051433d993f7185396e4c79.r2.dev/tenants/tenantA/${encodeURIComponent(name)}`;
              return { key, name, url };
            })
            .filter((f: any) => f.name.toLowerCase().endsWith(".fbx") || f.key.toLowerCase().endsWith(".fbx"));
          setCatalogFiles(files);
        }
      } catch (err) {
        console.error("Failed to fetch catalog in App:", err);
      } finally {
        setIsLoadingCatalog(false);
      }
    };
    fetchCatalog();
  }, []);

  useEffect(() => {
    const fetchTextures = async () => {
      try {
        const response = await fetch('/api/files/get-files?folder=images&clientName=tenantA&v=3');
        if (response.ok) {
          const raw = await response.json();
          const getListData = (r: any) => {
            if (Array.isArray(r)) return r;
            if (r && typeof r === 'object') {
              return r.files || r.items || r.data || r.images || r.models || Object.values(r).find(v => Array.isArray(v)) || [];
            }
            return [];
          };
          const list = getListData(raw);
          const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds", ".gif", ".bmp"];
          const extracted = list.map((item: any) => {
            const name = item.fileName || item.FileName || item.filename || item.Name || item.name || item.Title || item.title || "";
            const key = item.fullPath || item.FullPath || item.fullpath || item.Key || item.item_key || item.key || item.FilePath || name || "";
            // Textures/images are loaded directly from R2 public bucket path
            const itemUrl = item.url || item.Url || "";
            const url = (itemUrl && itemUrl.includes("pub-"))
              ? itemUrl
              : `https://pub-721b92b9c051433d993f7185396e4c79.r2.dev/images/${encodeURIComponent(name)}`;
            return { key, name, url };
          }).filter((f: any) => {
            const lowName = f.name.toLowerCase();
            return imageExtensions.some(ext => lowName.endsWith(ext));
          });
          setCatalogTextures(extracted);
        }
      } catch (err) {
        console.error("Failed to fetch textures in App:", err);
      }
    };
    fetchTextures();
  }, []);

  useEffect(() => {
    if (models.length > 0 && !selectedId) {
      setSelectedId(models[0].id);
    }
  }, [models, selectedId]);

  useEffect(() => {
    if (selectedId && selectedModel && selectedModel.detectedMaterials.length > 0 && selectedModel.settings.colorVariants.length === 0) {
      autoMapTextures(selectedId, selectedModel.detectedMaterials);
    }
  }, [selectedId, selectedModel?.detectedMaterials.length]);

  useEffect(() => {
    let active = true;
    
    // Clear old details immediately so we don't display stale info during loads!
    setProductDetails(null);
    setIsFetchingDetails(false);

    if (selectedModel) {
      const fetchProductDetails = async () => {
        setIsFetchingDetails(true);
        try {
          const response = await fetch(`/api/product-details?modelName=${encodeURIComponent(selectedModel.name)}&v=3`);
          if (!active) return;
          if (response.ok) {
            const text = await response.text();
            if (!active) return;
            if (text && text.trim().length > 0) {
              try {
                const data = JSON.parse(text);
                if (data && active) {
                  const result = Array.isArray(data) ? data[0] : data;
                  if (result) {
                    const apiTitle = cleanEscapedQuotes(result.productDisplayTitle || result.productTitle || result.title || result.name || selectedModel.name);
                    const desc = cleanEscapedQuotes(result.productDescription || result.description || '');
                    const pId = result.productId || result.ProductId || result.id || '';
                    
                    if (pId && loggedViewProductIdRef.current !== pId) {
                      // Trigger view tracker API only once
                      loggedViewProductIdRef.current = pId;
                      fetch(`/api/products/${pId}/view`, { method: 'PUT' })
                        .catch(err => console.error('Error auto-logging view trigger:', err));
                    }
                    
                    // Store title for sidebar and catalog consistency
                    const normalizedName = selectedModel.name.trim().toLowerCase();
                    setProductTitles(prev => ({ ...prev, [normalizedName]: apiTitle }));
                    
                    if (active) {
                      const pPrice = result.productPrice !== undefined ? Number(result.productPrice) : (result.price !== undefined ? Number(result.price) : undefined);
                      setProductDetails({
                        productId: pId,
                        title: apiTitle,
                        description: desc,
                        originalTitle: apiTitle,
                        originalDescription: desc,
                        linkTo: result.linkTo,
                        category: result.productCategory || result.category || '',
                        subCategory: result.productSubCategory || result.subCategory || result.subcategory || '',
                        originalCategory: result.productCategory || result.category || '',
                        originalSubCategory: result.productSubCategory || result.subCategory || result.subcategory || '',
                        price: pPrice
                      });
                      
                      // Auto-open on large screens only
                      if (window.innerWidth >= 1024) {
                        setIsProductInfoOpen(true);
                      }
                    }
                  }
                }
              } catch (parseErr) {
                console.error('Failed to parse product details JSON:', parseErr);
                if (active) setProductDetails(null);
              }
            } else {
              if (active) setProductDetails(null);
            }
          } else {
            if (active) setProductDetails(null);
          }
        } catch (error) {
          console.error('Failed to fetch product details:', error);
          if (active) setProductDetails(null);
        } finally {
          if (active) setIsFetchingDetails(false);
        }
      };
      fetchProductDetails();
    } else {
      loggedViewProductIdRef.current = null;
      setProductDetails(null);
      setIsFetchingDetails(false);
      setIsProductInfoOpen(false);
    }

    return () => {
      active = false;
    };
  }, [selectedId, selectedModel?.name]);

  // Translate product info when language changes
  useEffect(() => {
    const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
    
    if (productDetails) {
      const translateInfo = async () => {
        const promises = [
          translateText(productDetails.originalTitle, langName),
          translateText(productDetails.originalDescription, langName)
        ];
        if (productDetails.originalCategory) {
          promises.push(translateText(productDetails.originalCategory, langName));
        } else {
          promises.push(Promise.resolve(''));
        }
        if (productDetails.originalSubCategory) {
          promises.push(translateText(productDetails.originalSubCategory, langName));
        } else {
          promises.push(Promise.resolve(''));
        }

        const [tTitle, tDesc, tCat, tSub] = await Promise.all(promises);
        setProductDetails(prev => prev ? { 
          ...prev, 
          title: tTitle, 
          description: tDesc, 
          category: tCat || prev.originalCategory,
          subCategory: tSub || prev.originalSubCategory
        } : null);
      };
      translateInfo();
    }
  }, [language, productDetails?.originalDescription, productDetails?.originalTitle, productDetails?.originalCategory, productDetails?.originalSubCategory]);

  // Translate selected model name
  useEffect(() => {
    if (!selectedModel) {
      setTranslatedSelectedModelName('');
      return;
    }
    const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
    const originalDisplayName = selectedModel.name;
    const cleanFileName = originalDisplayName.replace(/_/g, ' ').replace(/-/g, ' ');
    const displayTitle = productDetails?.originalTitle || cleanFileName;
    if (langName === 'English') {
      setTranslatedSelectedModelName(displayTitle);
      return;
    }
    const translateName = async () => {
      const translated = await translateText(displayTitle, langName);
      setTranslatedSelectedModelName(translated);
    };
    translateName();
  }, [language, selectedModel?.name, productDetails?.originalTitle]);

  const [targetView, setTargetView] = useState<{ pos: THREE.Vector3, lookAt: THREE.Vector3 } | null>(null);
  const [environmentUrl, setEnvironmentUrl] = useState<string | null>(null);
  const [envPreset, setEnvPreset] = useState<string>('sunset');
  
  const envPresetLabels = useMemo(() => ({
    en: {
      title: "Environment",
      city: "City",
      studio: "Studio",
      warehouse: "Warehouse",
      lobby: "Lobby",
      sunset: "Sunset"
    },
    he: {
      title: "תאורת סביבה",
      city: "עירוני",
      studio: "סטודיו נקי",
      warehouse: "מחסן תעשייתי",
      lobby: "לובי",
      sunset: "שקיעה חמה"
    },
    ar: {
      title: "إضاءة البيئة",
      city: "شارع المدينة",
      studio: "استوديو",
      warehouse: "مستودع",
      lobby: "ردهة",
      sunset: "غروب الشمس"
    },
    ru: {
      title: "Окружение",
      city: "Город",
      studio: "Студия",
      warehouse: "Склад",
      lobby: "Холл",
      sunset: "Закат"
    }
  }), []);

  const [modelParts, setModelParts] = useState<ModelPart[]>([]);
  const [isFetchingParts, setIsFetchingParts] = useState(false);
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);
  const [hoveredPartTooltip, setHoveredPartTooltip] = useState<{
    name: string;
    description: string;
    image: string | null;
    rect: DOMRect;
  } | null>(null);
  const [translatedParts, setTranslatedParts] = useState<Record<string, { name: string, description: string }>>({});
  const [activePart, setActivePart] = useState<{ id: string, name: string, description: string, position?: THREE.Vector3, size?: THREE.Vector3, mesh?: THREE.Mesh } | null>(null);

  // Synchronously reset parts, translatedParts, and productDetails during render when selectedId changes
  // to prevent stale parts/descriptions of the previous model from "jumping in" or flashing in the UI.
  const [prevSelectedId, setPrevSelectedId] = useState<string | null>(null);
  if (selectedId !== prevSelectedId) {
    setPrevSelectedId(selectedId);
    setModelParts([]);
    setTranslatedParts({});
    setProductDetails(null);
    setActivePart(null);
    setIsFetchingParts(false);
    setIsFetchingDetails(false);
  }

  // Translate detected meshes when no modelParts are available
  useEffect(() => {
    const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
    if (langName === 'English' || modelParts.length > 0 || !selectedModel?.detectedMeshes?.length) {
      return;
    }

    const translateMeshes = async () => {
      try {
        const results = await translateBatch(selectedModel.detectedMeshes, langName);
        const newTranslatedParts: Record<string, { name: string, description: string }> = {};
        selectedModel.detectedMeshes.forEach((mesh, idx) => {
          newTranslatedParts[mesh] = { name: results[idx], description: '' };
        });
        setTranslatedParts(prev => ({ ...prev, ...newTranslatedParts }));
      } catch (err) {
        console.error("Mesh translation failed:", err);
      }
    };
    translateMeshes();
  }, [language, selectedModel?.detectedMeshes, modelParts.length]);
  const controlsRef = useRef<any>(null);
  const selectedModelForFetch = models.find(m => m.id === selectedId);
  const modelNameForFetch = selectedModelForFetch?.name;
  
  useEffect(() => {
    let active = true;

    // Reset states for the new model immediately
    setModelParts([]);
    setTranslatedParts({});
    setIsFetchingParts(false);
    
    // We prefer fetching parts based on the specific model filename first, 
    // as it's often more unique than the readable title.
    const searchName = modelNameForFetch || productDetails?.originalTitle;

    if (!selectedId || !searchName) {
      return;
    }

    // Fetch from our local API which connects to Azure
    const fetchModelParts = async () => {
      setIsFetchingParts(true);
      try {
        const response = await fetch(`/api/model-parts?modelName=${encodeURIComponent(searchName)}`);
        if (!active) return;
        if (!response.ok) {
          console.warn(`Server responded with ${response.status} for model parts`);
          if (active) setIsFetchingParts(false);
          return;
        }
        const text = await response.text();
        if (!active) return;
        if (text && (text.trim().startsWith('[') || text.trim().startsWith('{'))) { 
          try {
            const data = JSON.parse(text);
            const parts = Array.isArray(data) ? data : (data.parts || []);
            if (parts.length > 0 && active) {
              setModelParts(parts);
              
              // Pre-translate descriptions in the background for current language
              const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
              if (langName !== 'English') {
                const translateParts = async () => {
                  const textsToTranslate: string[] = [];
                  const mapping: { id: string, name: string, desc: string }[] = [];
                  
                  for (const p of parts) {
                    textsToTranslate.push(p.partName);
                    textsToTranslate.push(p.description);
                    mapping.push({ id: p.id, name: p.partName, desc: p.description });
                  }

                  try {
                    const translatedResults = await translateBatch(textsToTranslate, langName);
                    if (!active) return;
                    const newTranslatedParts: Record<string, { name: string, description: string }> = {};
                    
                    let resultIdx = 0;
                    mapping.forEach(item => {
                      const tName = translatedResults[resultIdx++];
                      const tDesc = translatedResults[resultIdx++];
                      newTranslatedParts[item.id] = { name: tName, description: tDesc };
                    });
                    
                    if (active) {
                      setTranslatedParts(newTranslatedParts);
                    }
                  } catch (err) {
                    console.error("Initial batch part translation failed:", err);
                  }
                };
                translateParts();
              }
            }
          } catch (parseErr) {
            console.error("Failed to parse model parts JSON:", parseErr, "Text preview:", text.substring(0, 100));
          }
        } else {
          console.warn("Received non-JSON response from model-parts API");
        }
      } catch (err) {
        console.error("Failed to fetch model parts from Azure API:", err)
      } finally {
        if (active) setIsFetchingParts(false);
      }
    };

    fetchModelParts();

    return () => {
      active = false;
    };
  }, [selectedId, modelNameForFetch, productDetails?.originalTitle]);

  useEffect(() => {
    const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
    
    if (modelParts.length > 0) {
      const translateAllParts = async () => {
        const textsToTranslate: string[] = [];
        const mapping: { id: string, name: string, desc: string }[] = [];
        
        for (const p of modelParts) {
          textsToTranslate.push(p.partName);
          textsToTranslate.push(p.description);
          mapping.push({ id: p.id, name: p.partName, desc: p.description });
        }

        try {
          const translatedResults = await translateBatch(textsToTranslate, langName);
          const newTranslatedParts: Record<string, { name: string, description: string }> = {};
          
          let resultIdx = 0;
          mapping.forEach(item => {
            const tName = translatedResults[resultIdx++];
            const tDesc = translatedResults[resultIdx++];
            newTranslatedParts[item.id] = { name: tName, description: tDesc };
          });
          
          setTranslatedParts(newTranslatedParts);
        } catch (err) {
          console.error("Batch part translation failed:", err);
        }
      };
      translateAllParts();
    }
  }, [language, modelParts]);

  // Update activePart translation when language or translatedParts change
  useEffect(() => {
    if (activePart && translatedParts[activePart.id]) {
      const tr = translatedParts[activePart.id];
      if (activePart.name !== tr.name || activePart.description !== tr.description) {
        setActivePart(prev => prev ? { ...prev, name: tr.name, description: tr.description } : null);
      }
    }
  }, [language, translatedParts, activePart?.id]);

  const defaultCamPos = isMobile ? new THREE.Vector3(0, 40, 180) : new THREE.Vector3(0, 30, 120);

  const createDefaultSettings = (): MaterialSettings => ({
    opacity: 1.0, metalness: 0.5, roughness: 0.5, emissiveIntensity: 1.0,
    color: '#ffffff', transparent: false, materialMappings: {},
    normalMappings: {}, metalMappings: {}, roughMappings: {}, alphaMappings: {},
    emissiveMappings: {}, aoMappings: {},
    heightMappings: {}, specularMappings: {},
    hoveredMaterial: null, isExploded: false, explodeFactor: 0,
    isPlayingAnimation: false,
    animationDirection: 'backward',
    colorVariants: [], activeVariant: null,
    flipY: true,
    wireframe: false,
    maxTextureSize: 4096,
    anisotropy: 16
  });

  const handlePartClick = useCallback(async (part: { id: string, name: string, description: string, position: THREE.Vector3, size: THREE.Vector3, mesh: THREE.Mesh } | null) => {
    // 0. Stop any current speech
    stopSpeaking();

    if (part) {
      // Toggle logic: if clicking the same part, close it
      if (activePart?.id === part.id) {
        setActivePart(null);
        if (selectedId) updateModelSettings(selectedId, { targetPartId: undefined });
        setTargetView({ pos: defaultCamPos, lookAt: new THREE.Vector3(0, 0, 0) });
        return;
      }

      // 1. Zoom to the part
      // Get the world position of the part
      const model = models.find(m => m.id === selectedId);
      const worldPartPos = part.position.clone();
      if (model) {
        worldPartPos.add(new THREE.Vector3(...model.position));
      }

      // Fixed zoom distance for all parts as requested
      const zoomDistance = 50;
      
      // Calculate a "good" viewing position for the part
      // We calculate a direction from the model's center to the part
      // to ensure the camera always looks at the part from the "outside"
      const modelCenter = model ? new THREE.Vector3(...model.position) : new THREE.Vector3(0, 0, 0);
      const dirToPart = worldPartPos.clone().sub(modelCenter).normalize();
      
      // If the part is at the center, default to a front-top view
      if (dirToPart.lengthSq() < 0.01) {
        dirToPart.set(0, 0.5, 1).normalize();
      } else {
        // Add some Y elevation for a better 3D perspective (looking slightly down at the part)
        dirToPart.y += 0.6;
        dirToPart.normalize();
      }

      const targetPos = worldPartPos.clone().add(dirToPart.multiplyScalar(zoomDistance));
      setTargetView({ pos: targetPos, lookAt: worldPartPos });

      // 2. Set active part IMMEDIATELY with translating state
      const currentTranslation = translatedParts[part.id];
      setActivePart({ 
        ...part, 
        name: currentTranslation?.name || part.name,
        description: currentTranslation?.description || t.translating 
      });

      // 3. Speak the description in the background (and translate it)
      // Use existing translation if available to skip redundant network calls inside speakText
      const descToSpeak = currentTranslation?.description || part.description;
      speakText(descToSpeak, language).then(translated => {
        // 4. Update UI state with translated text once ready
        if (translated) {
          // Also update the translatedParts cache if it wasn't there
          if (!currentTranslation) {
             setTranslatedParts(prev => ({
               ...prev,
               [part.id]: { ...prev[part.id], description: translated }
             }));
          }
          setActivePart(prev => prev?.id === part.id ? { ...prev, description: translated } : prev);
        }
      });
    } else {
      setActivePart(null);
      if (selectedId) updateModelSettings(selectedId, { targetPartId: undefined });
      // Reset view to default if part is deselected
      setTargetView({ pos: defaultCamPos, lookAt: new THREE.Vector3(0, 0, 0) });
    }
  }, [language, defaultCamPos, activePart?.id]);

  const handleAddFile = async (file: File) => {
    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    
    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (data.url) {
        const id = Math.random().toString(36).substr(2, 9);
        // Replace existing models with the new one
        setModels([{
          id, name: file.name.replace(/\.fbx$/i, ''), url: data.url,
          settings: createDefaultSettings(), detectedMaterials: [], detectedMeshes: [], position: [0, 0, 0]
        }]);
        setSelectedId(id);
        setTargetView({ pos: defaultCamPos.clone(), lookAt: new THREE.Vector3(0, 0, 0) });
        setIsSidebarOpen(false);
      }
    } catch (error) {
      console.error('Upload failed:', error);
    } finally {
      setIsUploading(false);
    }
  };

  const handleAddFromUrl = (url: string, name: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    // Replace existing models with the new one
    setModels([{
      id, name: name.replace(/\.fbx$/i, ''), url,
      settings: createDefaultSettings(), detectedMaterials: [], detectedMeshes: [], position: [0, 0, 0]
    }]);
    setSelectedId(id);
    setTargetView({ pos: defaultCamPos.clone(), lookAt: new THREE.Vector3(0, 0, 0) });
    setIsSidebarOpen(false);
    setIsCatalogCollapsed(true);
  };

  const updateModelData = (id: string, updates: Partial<SceneModelInstance>) => {
    setModels(prev => prev.map(m => {
      if (m.id !== id) return m;

      // Check if updates actually change anything to avoid infinite loops and unnecessary re-renders
      const hasChanges = Object.entries(updates).some(([key, value]) => {
        const currentValue = m[key as keyof SceneModelInstance];
        
        if (Array.isArray(value) && Array.isArray(currentValue)) {
          if (value.length !== currentValue.length) return true;
          return JSON.stringify(value) !== JSON.stringify(currentValue);
        }
        
        return currentValue !== value;
      });

      return hasChanges ? { ...m, ...updates } : m;
    }));
  };

  const updateModelSettings = (id: string, settingsUpdates: Partial<MaterialSettings>) => {
    setModels(prev => prev.map(m => m.id === id ? { 
      ...m, 
      settings: { ...m.settings, ...settingsUpdates } 
    } : m));
  };

  const autoMapTextures = useCallback(async (modelId: string, materials: string[]) => {
    console.log(`Starting auto-map for model ${modelId} with materials:`, materials);
    try {
      const [r2Res, localRes] = await Promise.all([
        fetch('/api/files/get-files?folder=images&clientName=tenantA').then(async r => {
          if (!r.ok) return { textures: [] };
          const data = await r.json();
          const items = Array.isArray(data) ? data : (data.files || data.items || data.data || []);
          return { 
            textures: items.map((item: any) => ({
              name: item.fileName || item.FileName || item.Name || item.name || "Unknown",
              url: item.url || item.Url || item.Link || item.link || ""
            }))
          };
        }).catch(() => ({ textures: [] })),
        fetch('/api/local/textures').then(async r => {
          if (!r.ok) return { textures: [] };
          const text = await r.text();
          return text ? JSON.parse(text) : { textures: [] };
        }).catch(() => ({ textures: [] }))
      ]);
      
      const allTextures = [...(r2Res.textures || []), ...(localRes.textures || [])];
      if (allTextures.length === 0) return;

      const filteredTextures = allTextures.filter((tex: any) => !tex.name.toLowerCase().includes('preview'));
      const colorNames = ['red', 'blue', 'green', 'yellow', 'black', 'white', 'orange', 'purple', 'pink', 'gray', 'grey', 'gold', 'silver', 'brown', 'lite', 'dark'];

      setModels(prev => prev.map(model => {
        if (model.id !== modelId) return model;
        
        const sortedMaterials = [...materials].sort((a, b) => {
          const numA = parseInt(a.match(/\d+/)?.[0] || '0');
          const numB = parseInt(b.match(/\d+/)?.[0] || '0');
          if (numA && numB) return numA - numB;
          return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        });

        const newSettings = { 
          ...model.settings, 
          materialMappings: { ...model.settings.materialMappings },
          normalMappings: { ...model.settings.normalMappings },
          metalMappings: { ...model.settings.metalMappings },
          roughMappings: { ...model.settings.roughMappings },
          alphaMappings: { ...model.settings.alphaMappings },
          emissiveMappings: { ...model.settings.emissiveMappings },
          aoMappings: { ...model.settings.aoMappings },
          heightMappings: { ...model.settings.heightMappings },
          specularMappings: { ...model.settings.specularMappings },
          colorVariants: [] 
        };
        
        const variantsMap: Record<string, ColorVariant> = {};
        const materialOptions: Record<string, Set<string>> = {}; 
        
        // 1. Pre-process textures to find potential matches and variants
        const textureMatches = filteredTextures.map((tex: any) => {
          const lowTex = tex.name.toLowerCase();
          const texNameNoExt = tex.name.split('.')[0].toLowerCase();
          const cleanTexName = texNameNoExt.replace(/[^a-z0-9]/g, '');

          // Map types
          const isNormal = lowTex.includes('normal') || lowTex.includes('_n') || lowTex.includes('nm') || lowTex.includes('_nor') || lowTex.includes('bump') || lowTex.includes('nrm') || lowTex.includes('norm');
          const isMetal = lowTex.includes('metal') || lowTex.includes('_m') || lowTex.includes('metallic') || lowTex.includes('_met') || lowTex.includes('metalness') || lowTex.includes('metalrough') || lowTex.includes('_orm');
          const isRough = lowTex.includes('rough') || lowTex.includes('_r') || lowTex.includes('roughness') || lowTex.includes('_rog') || lowTex.includes('metalrough') || lowTex.includes('_orm');
          const isAlpha = lowTex.includes('alpha') || lowTex.includes('opacity') || lowTex.includes('trans') || lowTex.includes('_alpha') || lowTex.includes('mask');
          const isEmissive = lowTex.includes('emissive') || lowTex.includes('_e') || lowTex.includes('glow') || lowTex.includes('selfillum');
          const isAO = lowTex.includes('ao') || lowTex.includes('occlusion') || lowTex.includes('ambient') || lowTex.includes('_orm');
          const isHeight = lowTex.includes('height') || lowTex.includes('displacement') || lowTex.includes('_h') || lowTex.includes('_disp');
          const isSpecular = lowTex.includes('specular') || lowTex.includes('_s') || lowTex.includes('spec');
          const isBaseColor = lowTex.includes('basecolor') || lowTex.includes('diffuse') || lowTex.includes('albedo') || lowTex.includes('_d') || lowTex.includes('_c') || lowTex.includes('_a') || lowTex.includes('color') || lowTex.includes('bc') ||
                             (!isNormal && !isMetal && !isRough && !isAlpha && !isEmissive && !isAO && !isHeight && !isSpecular);

          // STRICT MODEL NAME CHECK
          const modelNameBase = model.name.toLowerCase().split('.')[0];
          const cleanModelName = modelNameBase.replace(/[^a-z0-9]/g, '');
          
          let isModelMatch = isModelTextureMatch(texNameNoExt, modelNameBase);

          // Prevent "Axe" matching "AxeHead" if "AxeHead" is another model
          if (isModelMatch) {
            const otherModels = prev.filter(m => m.id !== modelId).map(m => m.name.toLowerCase().split('.')[0]);
            for (const other of otherModels) {
              const cleanOther = other.replace(/[^a-z0-9]/g, '');
              // If the texture matches another model name better (longer match), skip this one
              if (cleanOther.length > cleanModelName.length && cleanTexName.includes(cleanOther)) {
                isModelMatch = false;
                break;
              }
            }
          }
          
          if (!isModelMatch) return null;

          // ── SCORED MATERIAL MATCHING ──────────────────────────────────────
          let targetMat = null;
          let bestScore = -1;

          const normalizeWord = (w: string) => {
            let s = w.toLowerCase().trim();
            if (s.startsWith('p')) {
              if (s.startsWith('pgolden')) s = s.slice(1);
              else if (s.startsWith('pgold')) s = s.slice(1);
              else if (s.startsWith('psilvers')) s = s.slice(1);
              else if (s.startsWith('psilver')) s = s.slice(1);
              else if (s.startsWith('pwooden')) s = s.slice(1);
              else if (s.startsWith('pblue')) s = s.slice(1);
            }
            return s
              .replace(/golden/g, 'gold')
              .replace(/silvers/g, 'silver')
              .replace(/wooden/g, 'wood')
              .replace(/handel/g, 'handle')
              .replace(/middel/g, 'middle')
              .replace(/colour/g, 'color');
          };

          const colorWords = [...colorNames, 'golden', 'silver', 'blue', 'gray', 'grey', 'yellow', 'wooden', 'wood', 'steel', 'metal', 'psilver', 'pblue', 'pgold', 'pgolden', 'pwooden'];

          // Clean texture tokens - de-duplicate to avoid double matching single words
          const texTokens = Array.from(new Set(
            texNameNoExt
              .split(/[\s_.-]+/)
              .map((t: string) => normalizeWord(t))
              .filter((t: string) => t && t !== cleanModelName && t !== 'png')
          )) as string[];
          const texTokensNoColor: string[] = texTokens.filter((t: string) => !colorWords.includes(t));

          for (const mat of sortedMaterials) {
            const cleanM = mat.toLowerCase().replace(/[^a-z0-9]/g, '');
            const matTokens = Array.from(new Set(
              mat.toLowerCase()
                .split(/[\s_.-]+/)
                .map((t: string) => normalizeWord(t))
                .filter((t: string) => t && t !== cleanModelName)
            )) as string[];
            const matTokensNoColor: string[] = matTokens.filter((t: string) => !colorWords.includes(t));

            let score = 0;

            // 1. Exact match
            if (cleanM === cleanTexName) {
              score += 1000;
            }

            // 2. Token overlap score
            let matchedTokenCount = 0;
            for (const tTok of texTokensNoColor) {
              for (const mTok of matTokensNoColor) {
                if (tTok === mTok) {
                  matchedTokenCount++;
                } else if (tTok.includes(mTok) || mTok.includes(tTok)) {
                  if (tTok.length > 2 && mTok.length > 2) {
                    matchedTokenCount += 0.5;
                  }
                }
              }
            }

            let structuralMatches = matchedTokenCount * 50;
            let densityBonus = 0;
            if (matchedTokenCount > 0 && matTokensNoColor.length > 0) {
              const density = Math.min(matchedTokenCount / matTokensNoColor.length, 1.0);
              densityBonus = density * 150; 
            }
            score += structuralMatches + densityBonus;

            // 2.5 Smart Agnostic Part-Matching (handles filtered-out model name edge cases)
            const mapTypeKeywords = [
              'basecolor', 'diffuse', 'albedo', 'color', 'bc', 'albedom', 'base_color', 'diffuse_color',
              'normal', 'nor', 'nrm', 'bump', 'height', 'displacement', 'disp',
              'metal', 'metallic', 'metalness', 'met', 'rough', 'roughness', 'rog', 'rough_metal', 'metalrough', 'orm',
              'alpha', 'opacity', 'trans', 'mask', 'emissive', 'glow', 'selfillum',
              'ao', 'occlusion', 'ambient', 'specular', 'spec'
            ];
            
            let cleanAgnosticTexName = cleanTexName;
            mapTypeKeywords.forEach(kw => {
              cleanAgnosticTexName = cleanAgnosticTexName.replace(kw, '');
            });
            cleanAgnosticTexName = cleanAgnosticTexName.replace(/_+/g, '');

            const agnosticM = cleanM.replace(cleanModelName, '');
            const agnosticT = cleanAgnosticTexName.replace(cleanModelName, '');

            if (cleanM === cleanAgnosticTexName) {
              score += 800;
            } else if (agnosticM && agnosticT && agnosticM === agnosticT) {
              score += 600;
            } else if (cleanAgnosticTexName && cleanM && (cleanAgnosticTexName.includes(cleanM) || cleanM.includes(cleanAgnosticTexName))) {
              score += 200;
            }

            // 3. Color matchmaking
            const texColors = texTokens.filter((t: string) => colorWords.includes(t));
            const matColors = matTokens.filter((t: string) => colorWords.includes(t));

            let colorMismatch = false;
            let colorMatch = false;

            if (texColors.length > 0 && matColors.length > 0) {
              const hasSharedColor = texColors.some((tc: string) => matColors.some((mc: string) => {
                const c1 = tc.replace(/^p/i, '');
                const c2 = mc.replace(/^p/i, '');
                return c1 === c2 || c1.includes(c2) || c2.includes(c1);
              }));

              if (hasSharedColor) {
                colorMatch = true;
              } else {
                colorMismatch = true;
              }
            }

            if (colorMatch) score += 100;
            if (colorMismatch) score -= 20;

            // 4. Substring containment support
            if (matchedTokenCount > 0) {
              const mPart = cleanM.replace(cleanModelName, '');
              const tPart = cleanTexName.replace(cleanModelName, '');
              if (mPart && tPart) {
                if (tPart.includes(mPart)) {
                  score += 15;
                } else if (mPart.includes(tPart)) {
                  score += 10;
                }
              }
            }

            if (score > bestScore && score > 0) {
              bestScore = score;
              targetMat = mat;
            }
          }

          // Absolute Fallback: if only one material, match it
          if (!targetMat && sortedMaterials.length === 1) {
            targetMat = sortedMaterials[0];
          }

          // Color detection
          const detectedColors = colorNames.filter(c => {
            const regex = new RegExp(`([\\s_]|^)${c}([\\s_\\d]|$)`, 'i');
            return regex.test(texNameNoExt);
          });
          const colorName = detectedColors.length > 0 ? detectedColors.map(c => c.charAt(0).toUpperCase() + c.slice(1)).join(' ') : null;

          // Even if targetMat is null, we keep the match if it's a model match
          // This allows for "Global Variants" that apply to all materials
          return { tex, targetMat, isNormal, isMetal, isRough, isAlpha, isEmissive, isAO, isHeight, isSpecular, isBaseColor, colorName };
        }).filter(Boolean);

        console.log(`Matched ${textureMatches.length} textures for model ${modelId}`);
        textureMatches.forEach((m: any) => console.log(`  - ${m.tex.name} -> ${m.targetMat || 'GLOBAL'} (${m.colorName || 'Default'})`));

        // 2. Determine actual variants (multiple options for at least one material OR global colors)
        const actualVariants = new Set<string>();
        const globalColors = new Set<string>();
        
        textureMatches.forEach((m: any) => {
          if (m.isBaseColor && m.colorName) {
            if (m.targetMat) {
              if (!materialOptions[m.targetMat]) materialOptions[m.targetMat] = new Set();
              materialOptions[m.targetMat].add(m.colorName);
            } else {
              globalColors.add(m.colorName);
            }
          }
        });

        Object.values(materialOptions).forEach(options => {
          if (options.size > 1) options.forEach(opt => actualVariants.add(opt));
        });
        // Any global color is also a variant
        globalColors.forEach(opt => actualVariants.add(opt));

        // 3. Apply mappings
        // Group matches by type to handle global vs part-specific mapping
        const matchesByType: Record<string, any[]> = {};
        textureMatches.forEach((m: any) => {
          const type = m.isNormal ? 'normal' : m.isMetal ? 'metal' : m.isRough ? 'rough' : 
                       m.isAlpha ? 'alpha' : m.isEmissive ? 'emissive' : m.isAO ? 'ao' : 
                       m.isHeight ? 'height' : m.isSpecular ? 'specular' : 'base';
          if (!matchesByType[type]) matchesByType[type] = [];
          matchesByType[type].push(m);
        });

        // helper to check if a mapping exists for a material + type (either global or in variant)
        const hasExistingMapping = (mat: string, type: string, colorName: string | null) => {
          const isVariant = colorName && actualVariants.has(colorName);
          if (isVariant) {
            const v = variantsMap[colorName!];
            if (!v) return false;
            if (type === 'base') return !!v.mappings[mat];
            if (type === 'normal') return !!v.normalMappings?.[mat];
            if (type === 'metal') return !!v.metalMappings?.[mat];
            if (type === 'rough') return !!v.roughMappings?.[mat];
            if (type === 'alpha') return !!v.alphaMappings?.[mat];
            if (type === 'emissive') return !!v.emissiveMappings?.[mat];
            if (type === 'ao') return !!v.aoMappings?.[mat];
            if (type === 'height') return !!v.heightMappings?.[mat];
            if (type === 'specular') return !!v.specularMappings?.[mat];
            return false;
          } else {
            if (type === 'base') return !!newSettings.materialMappings[mat];
            if (type === 'normal') return !!newSettings.normalMappings[mat];
            if (type === 'metal') return !!newSettings.metalMappings[mat];
            if (type === 'rough') return !!newSettings.roughMappings[mat];
            if (type === 'alpha') return !!newSettings.alphaMappings[mat];
            if (type === 'emissive') return !!newSettings.emissiveMappings[mat];
            if (type === 'ao') return !!newSettings.aoMappings[mat];
            if (type === 'height') return !!newSettings.heightMappings[mat];
            if (type === 'specular') return !!newSettings.specularMappings[mat];
            return false;
          }
        };

        const setMapping = (mat: string, type: string, url: string, colorName: string | null) => {
          const isVariant = colorName && actualVariants.has(colorName);
          if (isVariant) {
            if (!variantsMap[colorName!]) {
              variantsMap[colorName!] = { 
                name: colorName!, mappings: {}, normalMappings: {}, metalMappings: {}, roughMappings: {}, 
                alphaMappings: {}, emissiveMappings: {}, aoMappings: {}, heightMappings: {}, specularMappings: {} 
              };
            }
            const v = variantsMap[colorName!];
            if (type === 'base') {
              v.mappings[mat] = url;
              if (!newSettings.materialMappings[mat]) {
                newSettings.materialMappings[mat] = url;
                newSettings.activeVariant = colorName!;
              }
            } 
            else if (type === 'normal') { if (!v.normalMappings) v.normalMappings = {}; v.normalMappings[mat] = url; }
            else if (type === 'metal') { if (!v.metalMappings) v.metalMappings = {}; v.metalMappings[mat] = url; }
            else if (type === 'rough') { if (!v.roughMappings) v.roughMappings = {}; v.roughMappings[mat] = url; }
            else if (type === 'alpha') { if (!v.alphaMappings) v.alphaMappings = {}; v.alphaMappings[mat] = url; }
            else if (type === 'emissive') { if (!v.emissiveMappings) v.emissiveMappings = {}; v.emissiveMappings[mat] = url; }
            else if (type === 'ao') { if (!v.aoMappings) v.aoMappings = {}; v.aoMappings[mat] = url; }
            else if (type === 'height') { if (!v.heightMappings) v.heightMappings = {}; v.heightMappings[mat] = url; }
            else if (type === 'specular') { if (!v.specularMappings) v.specularMappings = {}; v.specularMappings[mat] = url; }
          } else {
            if (type === 'base') newSettings.materialMappings[mat] = url;
            else if (type === 'normal') newSettings.normalMappings[mat] = url;
            else if (type === 'metal') newSettings.metalMappings[mat] = url;
            else if (type === 'rough') newSettings.roughMappings[mat] = url;
            else if (type === 'alpha') newSettings.alphaMappings[mat] = url;
            else if (type === 'emissive') newSettings.emissiveMappings[mat] = url;
            else if (type === 'ao') newSettings.aoMappings[mat] = url;
            else if (type === 'height') newSettings.heightMappings[mat] = url;
            else if (type === 'specular') newSettings.specularMappings[mat] = url;
          }
        };

        Object.entries(matchesByType).forEach(([type, matches]) => {
          // 1. Separate matches into SPECIFIC parts vs GLOBAL fallbacks
          const specificMatches = matches.filter(m => m.targetMat !== null);
          const globalMatches = matches.filter(m => m.targetMat === null);

          // 2. Apply all SPECIFIC matches first (so they take precedence and block global overrides!)
          specificMatches.forEach((m: any) => {
            const { tex, targetMat, colorName } = m;
            setMapping(targetMat, type, tex.url, colorName);
          });

          // 3. Apply GLOBAL matches to any materials that don't have a mapping yet for this type
          globalMatches.forEach((m: any) => {
            const { tex, colorName } = m;
            sortedMaterials.forEach((matName) => {
              // Special case for alpha/opacity maps to prevent them from making solid parts disappear
              if (type === 'alpha') {
                const matLower = matName.toLowerCase();
                const isAlphaMaterial = ['middle', 'glass', 'lens', 'trans', 'alpha', 'window', 'acrylic']
                  .some(k => matLower.includes(k));
                if (!isAlphaMaterial && sortedMaterials.length > 1) {
                  // Skip this material as it should remain opaque
                  return;
                }
              }
              if (!hasExistingMapping(matName, type, colorName)) {
                setMapping(matName, type, tex.url, colorName);
              }
            });
          });
        });

        newSettings.colorVariants = Object.values(variantsMap);

        // Ensure the active variant's mappings are applied to the active settings on initialization
        if (newSettings.activeVariant) {
          const activeVar = variantsMap[newSettings.activeVariant];
          if (activeVar) {
            newSettings.materialMappings = { ...newSettings.materialMappings, ...activeVar.mappings };
            if (activeVar.normalMappings) newSettings.normalMappings = { ...newSettings.normalMappings, ...activeVar.normalMappings };
            if (activeVar.metalMappings) newSettings.metalMappings = { ...newSettings.metalMappings, ...activeVar.metalMappings };
            if (activeVar.roughMappings) newSettings.roughMappings = { ...newSettings.roughMappings, ...activeVar.roughMappings };
            if (activeVar.alphaMappings) newSettings.alphaMappings = { ...newSettings.alphaMappings, ...activeVar.alphaMappings };
            if (activeVar.emissiveMappings) newSettings.emissiveMappings = { ...newSettings.emissiveMappings, ...activeVar.emissiveMappings };
            if (activeVar.aoMappings) newSettings.aoMappings = { ...newSettings.aoMappings, ...activeVar.aoMappings };
            if (activeVar.heightMappings) newSettings.heightMappings = { ...newSettings.heightMappings, ...activeVar.heightMappings };
            if (activeVar.specularMappings) newSettings.specularMappings = { ...newSettings.specularMappings, ...activeVar.specularMappings };
          }
        }

        return { ...model, settings: newSettings, detectedMaterials: materials };
      }));
    } catch (error) {
      console.error('Auto-mapping failed:', error);
    }
  }, []);

  const handleSwitchVariant = (variantName: string) => {
    if (!selectedId) return;
    const model = models.find(m => m.id === selectedId);
    if (!model) return;
    
    const variant = model.settings.colorVariants.find(v => v.name === variantName);
    if (variant) {
      updateModelSettings(selectedId, {
        activeVariant: variantName,
        materialMappings: { ...model.settings.materialMappings, ...variant.mappings },
        normalMappings: { ...model.settings.normalMappings, ...(variant.normalMappings || {}) },
        metalMappings: { ...model.settings.metalMappings, ...(variant.metalMappings || {}) },
        roughMappings: { ...model.settings.roughMappings, ...(variant.roughMappings || {}) },
        alphaMappings: { ...model.settings.alphaMappings, ...(variant.alphaMappings || {}) },
        emissiveMappings: { ...model.settings.emissiveMappings, ...(variant.emissiveMappings || {}) },
        aoMappings: { ...model.settings.aoMappings, ...(variant.aoMappings || {}) },
        heightMappings: { ...model.settings.heightMappings, ...(variant.heightMappings || {}) },
        specularMappings: { ...model.settings.specularMappings, ...(variant.specularMappings || {}) },
      });
    }
  };

  const handleCameraAction = (action: string, point?: THREE.Vector3) => {
    if (action === 'focus' && point) {
      // Adjusted offset to be more centered during focus
      setTargetView({ pos: point.clone().add(new THREE.Vector3(0, 25, 60)), lookAt: point.clone() });
      return;
    }
    if (action === 'reset') {
      setTargetView({ pos: defaultCamPos.clone(), lookAt: new THREE.Vector3(0, 0, 0) });
      setActivePart(null);
      stopSpeaking();
      return;
    }
    setTargetView(null); 
    if (!controlsRef.current) return;
    const controls = controlsRef.current;
    
    if (action === 'zoomIn') controls.object.position.multiplyScalar(0.8);
    if (action === 'zoomOut') controls.object.position.divideScalar(0.8);

    if (action === 'left' || action === 'right' || action === 'up' || action === 'down') {
      try {
        const camera = controls.object;
        const target = controls.target || new THREE.Vector3(0, 0, 0);
        const offset = camera.position.clone().sub(target);
        const speed = 0.15; // single click rotation speed in radians

        if (action === 'left') {
          offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), speed);
        } else if (action === 'right') {
          offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), -speed);
        } else if (action === 'up') {
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
          offset.applyAxisAngle(right, speed);
        } else if (action === 'down') {
          const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
          offset.applyAxisAngle(right, -speed);
        }

        camera.position.copy(target).add(offset);
        camera.lookAt(target);
      } catch (err) {
        console.warn("[handleCameraAction] Failed manual orbit step:", err);
      }
    }

    controls.update();
  };

  const handleRemoveModel = (id: string) => {
    setModels(prev => prev.filter(m => m.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const isRTL = language === 'he' || language === 'ar';

  const handleTextureUpload = useCallback(async (file: File, type: string, matName?: string) => {
    if (!selectedId) return;
    setIsUploading(true);
    
    const formData = new FormData();
    formData.append('file', file);

    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed with status ${response.status}: ${errorText.substring(0, 100)}`);
      }

      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (data.url) {
        const url = data.url;
        const model = models.find(m => m.id === selectedId);
        if (!model) return;
        const newSettings = { ...model.settings };
        if (matName) {
          if (type === 'base') newSettings.materialMappings = { ...newSettings.materialMappings, [matName]: url };
          if (type === 'normal') newSettings.normalMappings = { ...newSettings.normalMappings, [matName]: url };
          if (type === 'metal') newSettings.metalMappings = { ...newSettings.metalMappings, [matName]: url };
          if (type === 'rough') newSettings.roughMappings = { ...newSettings.roughMappings, [matName]: url };
          if (type === 'alpha') newSettings.alphaMappings = { ...newSettings.alphaMappings, [matName]: url };
        }
        updateModelData(selectedId, { settings: newSettings });
      }
    } catch (error) {
      console.error('Texture upload failed:', error);
    } finally {
      setIsUploading(false);
    }
  }, [selectedId, models, updateModelData]);

  const handleTextureRemove = useCallback((type: string, matName: string) => {
    if (!selectedId) return;
    const model = models.find(m => m.id === selectedId);
    if (!model) return;
    
    const newSettings = { ...model.settings };
    if (type === 'base') {
      const { [matName]: _, ...rest } = newSettings.materialMappings || {};
      newSettings.materialMappings = rest;
    } else if (type === 'normal') {
      const { [matName]: _, ...rest } = newSettings.normalMappings || {};
      newSettings.normalMappings = rest;
    } else if (type === 'metal') {
      const { [matName]: _, ...rest } = newSettings.metalMappings || {};
      newSettings.metalMappings = rest;
    } else if (type === 'rough') {
      const { [matName]: _, ...rest } = newSettings.roughMappings || {};
      newSettings.roughMappings = rest;
    }
    
    updateModelData(selectedId, { settings: newSettings });
  }, [selectedId, models, updateModelData]);

  const handleEnvironmentUpload = useCallback(async (file: File) => {
    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await response.json();
      if (data.url) {
        setEnvironmentUrl(data.url);
      }
    } catch (error) {
      console.error('Environment upload failed:', error);
    } finally {
      setIsUploading(false);
    }
  }, []);

  const getColorFromName = (name: string) => {
    const n = name.toLowerCase();
    if (n.includes('red')) return '#ef4444';
    if (n.includes('blue')) return '#3b82f6';
    if (n.includes('green')) return '#22c55e';
    if (n.includes('yellow')) return '#eab308';
    if (n.includes('black')) return '#18181b';
    if (n.includes('white')) return '#ffffff';
    if (n.includes('orange')) return '#f97316';
    if (n.includes('purple')) return '#a855f7';
    if (n.includes('pink')) return '#ec4899';
    if (n.includes('gray') || n.includes('grey')) return '#71717a';
    if (n.includes('gold')) return '#eab308';
    if (n.includes('silver')) return '#d4d4d8';
    
    // If it's a number, generate a distinct color
    const num = parseInt(name);
    if (!isNaN(num)) {
      const colors = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#ec4899', '#06b6d4', '#8b5cf6', '#10b981', '#f43f5e', '#6366f1'];
      return colors[num % colors.length];
    }
    
    return '#facc15'; // Default yellow
  };

  const handleToggleAnimation = () => {
    if (!selectedId || !selectedModel) return;
    
    const isPlaying = selectedModel.settings.isPlayingAnimation;
    
    if (!isPlaying) {
      // Start forward
      updateModelData(selectedId, {
        settings: {
          ...selectedModel.settings,
          isPlayingAnimation: true,
          animationDirection: 'forward'
        }
      });
    } else {
      // Already in "Play" state (could be at the end). Start backward.
      updateModelData(selectedId, {
        settings: {
          ...selectedModel.settings,
          animationDirection: 'backward'
        }
      });
    }
  };

  const handleAnimationFinished = () => {
    if (!selectedId || !selectedModel) return;
    
    // Only set isPlayingAnimation to false if we just finished a backward animation
    if (selectedModel.settings.animationDirection === 'backward') {
      updateModelData(selectedId, {
        settings: {
          ...selectedModel.settings,
          isPlayingAnimation: false
        }
      });
    }
  };

  const activeMesh = activePart?.mesh;
  const activeMaterial = activeMesh ? (Array.isArray(activeMesh.material) ? activeMesh.material[0] : activeMesh.material) : null;
  const activeMaterialName = activeMaterial?.name;

  const relevantVariants = useMemo(() => {
    if (!selectedModel) return [];
    if (!activeMaterialName) return selectedModel.settings.colorVariants;
    // Filter variants that have multiple BaseColor options for the currently selected part's material
    // This ensures the color bar only opens if there are actual color choices to make
    const baseColorVariants = selectedModel.settings.colorVariants.filter(v => v.mappings[activeMaterialName]);
    return baseColorVariants.length > 1 ? baseColorVariants : [];
  }, [selectedModel, activeMaterialName]);

  // Compute unified percentage progress
  let unifiedProgress = 0;
  if (!isFbxDone) {
    // FBX stage handles 0% to 30%
    unifiedProgress = Math.round(fbxProgress * 0.3);
  } else {
    // Textures stage handles 30% to 100%
    if (texturesTotal <= 0) {
      unifiedProgress = texturesTotal === 0 ? 100 : 30;
    } else {
      unifiedProgress = Math.round(30 + (texturesLoaded / texturesTotal) * 70);
    }
  }
  // Clamp progress
  unifiedProgress = Math.min(100, Math.max(0, unifiedProgress));

  // Frame-by-frame interpolation of smoothProgress towards unifiedProgress for maximum fluid response
  useEffect(() => {
    let rAF: number;
    const update = () => {
      setSmoothProgress((prev) => {
        if (prev < unifiedProgress) {
          const diff = unifiedProgress - prev;
          // Calculate step with easing, ensuring a minimal speed to avoid getting stuck
          const step = Math.max(0.18, diff * 0.04);
          const next = prev + step;
          return next >= unifiedProgress ? unifiedProgress : next;
        } else if (prev > unifiedProgress) {
          return unifiedProgress;
        }
        return prev;
      });
      rAF = requestAnimationFrame(update);
    };
    rAF = requestAnimationFrame(update);
    return () => cancelAnimationFrame(rAF);
  }, [unifiedProgress]);

  const showModelLoadingScreen = !!selectedModel && !isModelFullyLoaded;

  return (
    <div className={`relative w-screen h-screen overflow-hidden bg-transparent text-zinc-900 font-sans transition-colors duration-500 ${isRTL ? 'rtl' : 'ltr'}`} dir={isRTL ? 'rtl' : 'ltr'}>
      {/* BACKGROUND LAYER */}
      <div className={`fixed inset-0 z-[-2] transition-colors duration-1000 ${isNightMode ? 'bg-zinc-900' : 'bg-white'}`} />


      {/* TOP LEFT LOGO/SQUARE */}
      <div className="fixed top-4 left-4 z-[60] flex flex-row gap-3 items-center pointer-events-none" dir="ltr">
        <a 
          href="https://fbxstudio.co.il/" 
          target="_blank" 
          rel="noopener noreferrer"
          className="w-12 h-12 sm:w-16 sm:h-16 bg-white/80 backdrop-blur-xl rounded-xl sm:rounded-2xl border border-black/5 shadow-2xl overflow-hidden flex items-center justify-center pointer-events-auto transition-transform hover:scale-105 active:scale-95"
        >
          <img 
            src="https://pub-721b92b9c051433d993f7185396e4c79.r2.dev/images/wallpaper_customer_maxis_only_logo.png" 
            alt="Customer Logo" 
            className="w-full h-full object-contain p-2"
            referrerPolicy="no-referrer"
          />
        </a>
        {selectedModel && (
          <div className="animate-in fade-in slide-in-from-left-4 duration-500 pointer-events-auto max-w-[150px] sm:max-w-[50%] text-left">
            <div className={`text-xl sm:text-3xl font-black uppercase tracking-tight leading-tight ${isNightMode ? 'text-white' : 'text-zinc-800'}`}>
              {translatedSelectedModelName || selectedModel.name}
            </div>
          </div>
        )}
      </div>

      {/* TOP CONTROLS */}
      <div className="absolute top-4 sm:top-6 z-[1001] flex flex-row items-center gap-3 right-4 sm:right-6" dir="ltr">
        {/* Search Control */}
        <div className="relative flex items-center">
          <div className={`relative flex items-center transition-all duration-300 ${isSearchOpen ? 'w-48 sm:w-64 opacity-100 mr-2' : 'w-0 opacity-0 pointer-events-none overflow-hidden'}`}>
            <input
              type="text"
              value={catalogSearchQuery}
              onChange={(e) => {
                const val = e.target.value;
                setCatalogSearchQuery(val);
                if (val && isCatalogCollapsed) {
                  setIsCatalogCollapsed(false);
                }
              }}
              placeholder={language === 'he' ? 'חפש מוצר...' : 'Search product...'}
              dir={isRTL ? 'rtl' : 'ltr'}
              className="w-full h-10 sm:h-12 pl-4 pr-10 rounded-xl sm:rounded-2xl shadow-xl border border-black/5 bg-white text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-yellow-500/50 text-xs sm:text-sm font-medium"
            />
            {catalogSearchQuery && (
              <button
                onClick={() => setCatalogSearchQuery('')}
                className="absolute right-3 text-zinc-400 hover:text-zinc-600 transition-colors p-1"
                title={language === 'he' ? 'נקה' : 'Clear'}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <button
            onClick={() => {
              const nextState = !isSearchOpen;
              setIsSearchOpen(nextState);
              if (nextState && isCatalogCollapsed) {
                setIsCatalogCollapsed(false);
              }
            }}
            className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl shadow-xl border border-black/5 flex items-center justify-center transition-all group ${isSearchOpen ? 'bg-zinc-800 text-white' : 'bg-white text-zinc-400 hover:text-zinc-800'}`}
            title={language === 'he' ? 'חיפוש' : 'Search'}
          >
            <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </button>
        </div>

        {/* Settings Gear Button */}
        <div className="relative">
          <button 
            onClick={() => setIsSettingsOpen(!isSettingsOpen)}
            className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl sm:rounded-2xl shadow-xl border border-black/5 flex items-center justify-center transition-all group ${isSettingsOpen ? 'bg-zinc-800 text-white' : 'bg-white text-zinc-400 hover:text-zinc-800'}`}
            title={t.settings}
          >
            <svg className={`w-5 h-5 sm:w-6 sm:h-6 transition-transform duration-500 ${isSettingsOpen ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </button>

          {/* Settings Dropdown Menu */}
          {isSettingsOpen && (
            <div 
              className={`absolute top-full mt-2 w-72 sm:w-80 flex flex-col gap-4 p-5 bg-white/95 backdrop-blur-2xl rounded-3xl border border-zinc-200/80 shadow-[0_20px_50px_rgba(0,0,0,0.15)] animate-in fade-in zoom-in-95 duration-200 right-0 z-[1000]`}
              dir={isRTL ? 'rtl' : 'ltr'}
            >
              <div className="flex items-center justify-between border-b border-zinc-100 pb-3">
                <span className="text-xs font-black uppercase tracking-wider text-zinc-500">
                  {t.settings}
                </span>
                {/* Close/Toggle Settings */}
                <button 
                  onClick={() => setIsSettingsOpen(false)}
                  className="text-zinc-400 hover:text-zinc-600 p-0.5"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              {/* Day/Night Theme Switcher */}
              <div className="flex items-center justify-between gap-3 bg-zinc-50/50 p-2 rounded-2xl border border-black/5">
                <span className="text-xs font-bold text-zinc-600">
                  {isNightMode ? t.dayMode : t.nightMode}
                </span>
                <button 
                  onClick={() => setIsNightMode(!isNightMode)}
                  className={`w-10 h-10 rounded-xl border border-black/5 flex items-center justify-center transition-all ${isNightMode ? 'bg-zinc-800 text-yellow-400' : 'bg-white text-zinc-400 hover:text-yellow-500 hover:shadow-sm'}`}
                  title={isNightMode ? t.dayMode : t.nightMode}
                >
                  {isNightMode ? (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-11.314l.707.707m11.314 11.314l.707.707M12 5a7 7 0 100 14 7 7 0 000-14z" />
                    </svg>
                  ) : (
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                    </svg>
                  )}
                </button>
              </div>

              {/* Language Code Selector */}
              <div className="flex flex-col gap-2">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400 leading-none">
                  {language === 'he' ? 'שפת ממשק' : 'Interface Language'}
                </span>
                <div className="grid grid-cols-4 gap-1.5 bg-zinc-50/50 p-1 rounded-xl border border-black/5">
                  {(['en', 'he', 'ar', 'ru'] as Language[]).map((lang) => (
                    <button
                      key={lang}
                      onClick={() => setLanguage(lang)}
                      className={`h-8 rounded-lg flex items-center justify-center text-[10px] font-black uppercase transition-all ${language === lang ? 'bg-yellow-500 text-white shadow-md' : 'text-zinc-400 hover:bg-zinc-100/80 hover:text-zinc-800'}`}
                    >
                      {lang}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* CENTER - VIEWPORT */}
      <div 
        className={`absolute top-0 left-0 right-0 bottom-0 z-10 transition-colors duration-1000 ${isNightMode ? 'bg-zinc-800/50' : 'bg-transparent'}`}
      >
        
        {showModelLoadingScreen && (
          <div className="absolute inset-0 z-40 bg-stone-50/98 backdrop-blur-xl dark:bg-zinc-950/98 flex flex-col items-center justify-center animate-in fade-in duration-300">
            {/* Elegant Circular Progress Loader with percentages and continuous rotation */}
            <div className="relative w-28 h-28 flex items-center justify-center">
              {/* Spinning/progress SVG circle - spinning continuously */}
              <svg className="w-full h-full transform -rotate-90 animate-spin" style={{ animationDuration: '3s' }}>
                {/* Background circle */}
                <circle
                  cx="56"
                  cy="56"
                  r="48"
                  className="stroke-zinc-200 dark:stroke-zinc-800"
                  strokeWidth="5"
                  fill="none"
                />
                {/* Progress circle */}
                <circle
                  cx="56"
                  cy="56"
                  r="48"
                  className="stroke-yellow-500 transition-all duration-300 ease-out"
                  strokeWidth="5"
                  strokeDasharray={2 * Math.PI * 48}
                  strokeDashoffset={2 * Math.PI * 48 * (1 - smoothProgress / 100)}
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
              {/* Percentage number centrally positioned inside */}
              <div className="absolute inset-0 flex flex-col items-center justify-center leading-none">
                <span className="text-2xl font-black text-zinc-950 dark:text-white font-mono tracking-tight">{Math.round(smoothProgress)}%</span>
              </div>
            </div>
          </div>
        )}

        <Canvas 
          shadows 
          dpr={[1, 2]} 
          gl={{ 
            antialias: true, 
            alpha: true,
            sortObjects: true,
            logarithmicDepthBuffer: false
          }} 
          onCreated={({ gl }) => {
            gl.debug.checkShaderErrors = false;
          }}
          className="relative z-20"
          style={{ background: 'transparent' }}
          onPointerDown={() => { if (isMoveMode) setIsMoveMode(false); setTargetView(null); }}
        >
          <PerspectiveCamera makeDefault position={isMobile ? [0, 40, 180] : [0, 30, 120]} fov={35} near={0.1} far={2000} />
          <CameraHandler targetView={targetView} controlsRef={controlsRef} activePartMesh={activePart?.mesh} orbitDirection={orbitDirection} />

          <Suspense fallback={<Html center><div className="text-yellow-500 font-black uppercase tracking-[0.5em] animate-pulse text-[10px]">{t.initializing}</div></Html>}>
            {isUploading && (
              <Html center>
                <div className="bg-white/90 backdrop-blur-xl px-8 py-4 rounded-3xl shadow-2xl border border-black/5 flex items-center gap-4">
                  <div className="w-5 h-5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                  <span className="text-yellow-500 font-black text-[11px] tracking-widest uppercase">{t.processingAsset}</span>
                </div>
              </Html>
            )}

            <ambientLight intensity={1.2} />
            <spotLight position={[50, 50, 50]} angle={0.15} penumbra={1} intensity={2} castShadow />
            <directionalLight position={[-10, 20, 10]} intensity={1} />
            
            {environmentUrl ? (
              <Environment files={environmentUrl} />
            ) : (
              <Environment preset={envPreset as any} />
            )}
            {models.map((model) => (
              <group key={model.id} position={model.position} visible={true} onPointerDown={(e) => { e.stopPropagation(); if (selectedId !== model.id) setSelectedId(model.id); }}>
                <ModelErrorBoundary
                  modelName={model.name}
                  language={language}
                  onRetry={() => {
                    console.log(`[ErrorBoundary Option] Retrying model load for: ${model.name}`);
                    const hasQuery = model.url.includes('?');
                    const freshUrl = model.url.includes('v=')
                      ? model.url.replace(/([?&])v=\d+/, `$1v=${Date.now()}`)
                      : `${model.url}${hasQuery ? '&' : '?'}v=${Date.now()}`;
                    updateModelData(model.id, { url: freshUrl });
                  }}
                >
                  <FBXModel 
                    url={activeModelBlobUrls[model.url] || model.url} 
                    settings={model.settings} 
                    textureSets={model.textureSets}
                    modelParts={modelParts}
                    activePartId={activePart?.id}
                    onPartClick={handlePartClick}
                    onFbxLoaded={() => setIsFbxDone(true)}
                    onMaterialsLoaded={(mats) => {
                      updateModelData(model.id, { detectedMaterials: mats });
                      if (model.detectedMaterials.length === 0) {
                        autoMapTextures(model.id, mats);
                      }
                    }}
                    onMeshesLoaded={(meshes) => {
                      updateModelData(model.id, { detectedMeshes: meshes });
                    }} 
                    onAnimationsDetected={(has) => {
                      if (model.hasAnimations !== has) {
                        updateModelData(model.id, { hasAnimations: has });
                      }
                    }}
                    onAnimationFinished={handleAnimationFinished}
                    translatedParts={translatedParts}
                    isMobile={isMobile}
                    hoveredPartId={hoveredPartId}
                    onTexturesProgress={(loaded, total) => {
                      setTexturesLoaded(loaded);
                      setTexturesTotal(total);
                    }}
                    onUVLayoutGenerated={(svg, filename) => {
                      setUvLayoutSvg(svg);
                      setUvLayoutFilename(filename);
                    }}
                    onPartUVLayoutGenerated={(meshName, svg, filename) => {
                      setPartUVMaps(prev => ({
                        ...prev,
                        [meshName]: { svg, filename }
                      }));
                    }}
                    cachedBlobUrls={activeModelBlobUrls}
                  />
                </ModelErrorBoundary>
              </group>
            ))}
          </Suspense>
          <OrbitControls 
            ref={controlsRef} 
            makeDefault 
            enableDamping 
            enablePan={false}
            minDistance={5} 
            maxDistance={500} 
            enabled={!isMoveMode} 
            onStart={() => setTargetView(null)}
          />
        </Canvas>

        {/* COLOR VARIANTS - BOTTOM CENTER */}
        {selectedModel && relevantVariants.length > 1 && (
          <div 
            className="absolute left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 sm:gap-4 bg-white/80 backdrop-blur-2xl px-4 sm:px-8 py-3 sm:py-5 rounded-[2rem] sm:rounded-[3rem] border border-black/5 shadow-2xl animate-in slide-in-from-bottom-10 duration-1000 max-w-[90vw] overflow-x-auto no-scrollbar transition-all duration-500 ease-in-out"
            style={{ bottom: isCatalogCollapsed ? '24px' : '254px' }}
          >
            <div className="flex flex-col mr-2 sm:mr-4 shrink-0">
              <span className="text-[7px] sm:text-[8px] font-black uppercase tracking-[0.3em] text-zinc-400 leading-none mb-1">
                {activePart ? activePart.name : t.variant}
              </span>
              <span className="text-[10px] sm:text-[12px] font-black text-zinc-800 uppercase tracking-tight truncate max-w-[60px] sm:max-w-none">
                {selectedModel.settings.activeVariant || t.default}
              </span>
            </div>
            <div className="h-6 sm:h-8 w-[1px] bg-black/5 mr-1 sm:mr-2 shrink-0"></div>
            <div className="flex items-center gap-2 sm:gap-3">
              {relevantVariants.map((variant) => (
                <button
                  key={variant.name}
                  onClick={() => handleSwitchVariant(variant.name)}
                  className={`group relative w-8 h-8 sm:w-10 sm:h-10 rounded-full transition-all duration-500 shrink-0 ${
                    selectedModel.settings.activeVariant === variant.name 
                    ? 'scale-110 sm:scale-125 shadow-xl ring-4 ring-yellow-500/20' 
                    : 'hover:scale-110'
                  }`}
                  title={variant.name}
                >
                  <div 
                    className="absolute inset-0 rounded-full border-2 border-white shadow-inner overflow-hidden"
                    style={{ backgroundColor: getColorFromName(variant.name) }}
                  >
                    {activeMaterialName && variant.mappings[activeMaterialName] && (
                      <img 
                        src={variant.mappings[activeMaterialName]} 
                        className="w-full h-full object-cover" 
                        referrerPolicy="no-referrer"
                        alt={variant.name}
                      />
                    )}
                  </div>
                  {selectedModel.settings.activeVariant === variant.name && (
                    <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 w-1.5 h-1.5 bg-yellow-500 rounded-full"></div>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}


        {/* PRODUCT INFO TAB - LEFT SIDE */}
        {selectedModel && (
          <div className="fixed left-0 top-0 bottom-0 z-[110] pointer-events-none w-full">
            <button
              onClick={() => setIsProductInfoOpen(true)}
              className={`group absolute left-4 top-[76px] sm:top-[104px] flex items-center justify-center w-12 h-12 sm:w-16 sm:h-16 bg-white/95 dark:bg-zinc-900/95 backdrop-blur-xl border border-black/10 dark:border-white/10 shadow-2xl transition-all duration-300 pointer-events-auto rounded-xl sm:rounded-2xl ${
                isProductInfoOpen ? 'opacity-0 scale-75 pointer-events-none' : 'opacity-100 scale-100'
              }`}
              style={{
                zIndex: 112
              }}
              title={language === 'he' ? 'מידע על המוצר' : 'Product Info'}
            >
              <div className="transition-transform duration-300">
                <svg className="w-5 h-5 sm:w-6 sm:h-6 text-zinc-500 dark:text-zinc-400 group-hover:text-yellow-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
            </button>

            {/* PRODUCT INFO PANEL */}
            <div 
              className={`absolute top-1/2 -translate-y-1/2 left-0 w-[280px] sm:w-[320px] lg:w-[380px] h-[55vh] sm:h-[80vh] backdrop-blur-3xl shadow-[25px_0_80px_rgba(0,0,0,0.15)] transition-all duration-500 transform overflow-hidden flex flex-col pointer-events-auto antialiased font-sans ${
                isProductInfoOpen ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'
              } rounded-r-[3rem] ${
                isNightMode 
                  ? 'bg-zinc-900/95 border-t border-r border-b border-white/60' 
                  : 'bg-white/98 border-r border-black/10'
              }`}
              dir={isRTL ? 'rtl' : 'ltr'}
              style={{
                zIndex: 111
              }}
            >
              <div className="p-8 flex flex-col h-full">
                <div className="flex items-center justify-between mb-8">
                  <div 
                    className={`flex flex-col ${productDetails?.linkTo ? 'cursor-pointer group/title' : ''}`}
                    onClick={() => {
                      if (productDetails?.linkTo) {
                        window.open(productDetails.linkTo, '_blank', 'noopener,noreferrer');
                      }
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className={`text-[9px] font-black ${isRTL ? '' : 'uppercase'} ${isRTL ? 'tracking-normal' : 'tracking-[0.2em]'} text-yellow-600 leading-none mb-1`}>{t.productInfo}</span>
                      {productDetails?.linkTo && (
                        <svg className={`w-2.5 h-2.5 text-yellow-600 opacity-0 group-hover/title:opacity-100 transition-opacity mb-1 ${isRTL ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                        </svg>
                      )}
                    </div>
                    <h2 className={`text-xl sm:text-2xl font-black ${isRTL ? '' : 'uppercase'} ${isRTL ? 'tracking-normal leading-tight' : 'tracking-tighter leading-none'} transition-colors ${
                      isNightMode 
                        ? 'text-white group-hover/title:text-yellow-400' 
                        : 'text-zinc-800 group-hover/title:text-yellow-600'
                    }`}>{productDetails?.title || translatedSelectedModelName || selectedModel.name}</h2>
                  </div>
                  <button 
                    onClick={() => setIsProductInfoOpen(false)}
                    className={`w-10 h-10 flex items-center justify-center rounded-2xl transition-all ${
                      isNightMode ? 'bg-zinc-800 hover:bg-zinc-700 text-white border border-white/20' : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-400'
                    }`}
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 19l-7-7 7-7" />
                    </svg>
                  </button>
                </div>
                
                <div className="flex-1 overflow-y-auto pr-4 no-scrollbar">
                  <div className="space-y-6">
                    {/* Category & Subcategory Badges */}
                    {(productDetails?.category || productDetails?.subCategory || productDetails?.price !== undefined) && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        {productDetails?.category && (
                          <div className={`px-3 py-1.5 rounded-2xl text-[10px] font-black uppercase tracking-wider flex items-center gap-1.5 border shadow-sm ${
                            isNightMode 
                              ? 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20' 
                              : 'bg-yellow-50 text-yellow-700 border-yellow-200'
                          }`}>
                            <span className="opacity-60">{language === 'he' ? 'קטגוריה:' : 'Category:'}</span>
                            <span>{productDetails.category}</span>
                          </div>
                        )}
                        {productDetails?.subCategory && (
                          <div className={`px-3 py-1.5 rounded-2xl text-[10px] font-black uppercase tracking-wider flex items-center gap-1.5 border shadow-sm ${
                            isNightMode 
                              ? 'bg-zinc-800/80 text-zinc-300 border-zinc-700/80' 
                              : 'bg-zinc-100 text-zinc-600 border-zinc-200'
                          }`}>
                            <span className="opacity-60">{language === 'he' ? 'קטגוריה משנית:' : 'Subcategory:'}</span>
                            <span>{productDetails.subCategory}</span>
                          </div>
                        )}
                        {productDetails?.price !== undefined && (
                          <div className={`px-3 py-1.5 rounded-2xl text-[10px] font-black uppercase tracking-wider flex items-center gap-1.5 border shadow-sm ${
                            isNightMode 
                              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' 
                              : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          }`}>
                            <span className="opacity-60">{t.price || (language === 'he' ? 'מחיר:' : 'Price:')}</span>
                            <span>₪{productDetails.price.toLocaleString()}</span>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Description Section */}
                    <div className={`p-6 rounded-3xl border ${
                      isNightMode ? 'bg-zinc-800/50 border-white/30' : 'bg-zinc-50/50 border-black/5'
                    }`}>
                      <h3 className={`text-[9px] font-black ${isRTL ? '' : 'uppercase'} ${isRTL ? 'tracking-normal' : 'tracking-[0.15em]'} mb-4 ${isNightMode ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        {t.productDescription}
                      </h3>
                      {isFetchingDetails ? (
                        <p className={`text-sm leading-relaxed font-normal ${isNightMode ? 'text-zinc-300' : 'text-zinc-700'} whitespace-pre-wrap`}>
                          {t.loading}
                        </p>
                      ) : (
                        <div 
                          className={`text-sm leading-relaxed font-normal ${isNightMode ? 'text-zinc-300' : 'text-zinc-700'} whitespace-pre-wrap`}
                          dangerouslySetInnerHTML={{ __html: productDetails?.description || t.noDescription }}
                        />
                      )}
                    </div>

                    {/* Parts Section */}
                    {(() => {
                      const visibleParts = modelParts ? modelParts.filter(part => part.presentAtSite !== false) : [];
                      if (!isFetchingParts && visibleParts.length === 0) return null;
                      return (
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 mb-2">
                              <div className={`w-1 h-3 bg-yellow-500 rounded-full ${isRTL ? 'ml-0' : ''}`}></div>
                              <h3 className={`text-[9px] font-black ${isRTL ? '' : 'uppercase'} ${isRTL ? 'tracking-normal' : 'tracking-[0.15em]'} ${isNightMode ? 'text-white' : 'text-zinc-800'}`}>
                                {t.modelParts}
                              </h3>
                            </div>
                            
                            {isFetchingParts ? (
                          <div className="space-y-2">
                            {[1, 2, 3].map(i => (
                              <div key={i} className={`h-24 rounded-2xl animate-pulse flex flex-col p-4 gap-2 ${isNightMode ? 'bg-zinc-800/80' : 'bg-zinc-100'}`}>
                                <div className={`h-2 w-16 rounded ${isNightMode ? 'bg-zinc-700' : 'bg-zinc-200'}`} />
                                <div className={`h-4 w-32 rounded ${isNightMode ? 'bg-zinc-700' : 'bg-zinc-200'}`} />
                                <div className={`h-3 w-full rounded mt-auto ${isNightMode ? 'bg-zinc-700' : 'bg-zinc-200'}`} />
                              </div>
                            ))}
                          </div>
                        ) : (() => {
                          const visibleParts = modelParts ? modelParts.filter(part => part.presentAtSite !== false) : [];
                          return (
                            <div className="grid gap-2">
                              {visibleParts.map((part) => {
                                const tr = translatedParts[part.id];
                                const name = tr?.name || part.partName;
                                const description = tr?.description || part.description;
                                const isActive = activePart?.id === part.id;
                                
                                // HIGHLIGHTING: Use partName or partKey for mesh matching 
                                const meshMatchTarget = part.partName || part.partKey || part.id;
                                const isHovered = hoveredPartId === meshMatchTarget;
                                
                                // Filter catalogTextures to only those belonging to the currently selected model to prevent across-model mixups
                                const selectedModelName = selectedModel?.name || '';
                                const modelSpecificTextures = catalogTextures.filter(t => isModelTextureMatch(t.name, selectedModelName));
                                
                                // Find the matching model file
                                const partNameForMatch = part.partName.toLowerCase().replace(/_/g, ' ').replace(/-/g, ' ').trim();
                                const partKeyForMatch = (part.partKey || '').toLowerCase().replace(/_/g, ' ').replace(/-/g, ' ').trim();
                                const match = catalogFiles.find(file => {
                                  const fileName = file.name.replace(/\.fbx$/i, '').toLowerCase().replace(/_/g, ' ').replace(/-/g, ' ').trim();
                                  return fileName === partNameForMatch || fileName === partKeyForMatch;
                                });

                                // Prioritize textures matching the matched catalog file name
                                let partThumbnailUrl = '';
                                if (match) {
                                  const modelBaseName = match.name.replace(/\.fbx$/i, '').toLowerCase();

                                  const matchedTex = modelSpecificTextures.find(t => {
                                    const lowTex = t.name.toLowerCase();
                                    return lowTex.startsWith(modelBaseName) && lowTex.includes('preview');
                                  }) || modelSpecificTextures.find(t => t.name.toLowerCase().startsWith(modelBaseName));
                                  if (matchedTex) {
                                    partThumbnailUrl = matchedTex.url;
                                  }
                                }
                                
                                // If not found via match, find directly using partName or partKey
                                if (!partThumbnailUrl) {
                                  const pName = part.partName.toLowerCase();
                                  const pKey = (part.partKey || '').toLowerCase();
                                  const directTex = modelSpecificTextures.find(t => {
                                    const lowTex = t.name.toLowerCase();
                                    return (lowTex.startsWith(pName) || lowTex.startsWith(pKey)) && lowTex.includes('preview');
                                  }) || modelSpecificTextures.find(t => {
                                    const lowTex = t.name.toLowerCase();
                                    return lowTex.startsWith(pName) || lowTex.startsWith(pKey);
                                  });
                                  if (directTex) {
                                    partThumbnailUrl = directTex.url;
                                  }
                                }

                                return (
                                  <button
                                    key={part.id}
                                    onMouseEnter={(e) => {
                                      setHoveredPartId(meshMatchTarget);
                                      if (isMobile) return;
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      setHoveredPartTooltip({
                                        name: name,
                                        description: description || '',
                                        image: partThumbnailUrl || null,
                                        rect
                                      });
                                    }}
                                    onMouseLeave={() => {
                                      setHoveredPartId(null);
                                      setHoveredPartTooltip(null);
                                    }}
                                    onClick={() => {
                                      if (activePart?.id === part.id) {
                                        handlePartClick(null);
                                        return;
                                      }
                                      
                                      if (selectedId) {
                                        updateModelSettings(selectedId, { targetPartId: part.id });
                                      } else {
                                        const p = {
                                          id: part.id,
                                          name: translatedParts[part.id]?.name || part.partName,
                                          description: translatedParts[part.id]?.description || part.description,
                                          position: new THREE.Vector3(),
                                          size: new THREE.Vector3(),
                                          mesh: undefined as any
                                        };
                                        handlePartClick(p);
                                      }
                                      
                                      if (match) {
                                        handleAddFromUrl(match.url, match.name);
                                      }
                                    }}
                                    className={`flex flex-col sm:flex-row items-stretch p-4 rounded-2xl border transition-all text-start relative group cursor-pointer h-full gap-4 ${
                                      isActive 
                                        ? 'bg-yellow-50 border-yellow-500 border-2 shadow-lg shadow-yellow-900/10 text-yellow-950' 
                                        : isHovered
                                          ? isNightMode ? 'bg-yellow-900/30 border-yellow-500/50 text-white shadow-sm transform scale-[1.01]' : 'bg-yellow-50 border-yellow-300 text-yellow-900 shadow-sm transform scale-[1.01]'
                                          : isNightMode ? 'bg-zinc-800/80 border-white/20 text-zinc-400 hover:border-white/40' : 'bg-white border-black/5 text-zinc-600 hover:border-yellow-500/30'
                                    }`}
                                  >
                                    {/* Preview Image with Border Frame */}
                                    <div className="shrink-0 self-start sm:self-center">
                                      <div className={`w-14 h-14 sm:w-16 sm:h-16 rounded-xl relative overflow-hidden border transition-colors duration-300 ${
                                        isActive 
                                          ? 'border-yellow-400 bg-white' 
                                          : isNightMode 
                                            ? 'border-white/10 bg-zinc-900' 
                                            : 'border-black/5 bg-zinc-50'
                                      } shadow-sm flex items-center justify-center`}>
                                        {partThumbnailUrl ? (
                                          <img 
                                            src={partThumbnailUrl} 
                                            alt={name}
                                            className="w-full h-full object-cover transition-transform duration-500 group-hover:scale-110"
                                            referrerPolicy="no-referrer"
                                          />
                                        ) : (
                                          <div className={`w-full h-full flex items-center justify-center ${isActive ? 'text-yellow-600' : 'text-zinc-400'}`}>
                                            {/* Cuboid icon representing component part */}
                                            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                                            </svg>
                                          </div>
                                        )}
                                      </div>
                                    </div>

                                    {/* Details layout */}
                                    <div className="flex-1 space-y-2 min-w-0">
                                      <div className="flex items-start justify-between gap-2 min-w-0 w-full">
                                        <div className="flex items-start gap-2 min-w-0 flex-1">
                                          <span className={`text-[10px] font-bold ${isRTL ? '' : 'uppercase'} w-14 sm:w-16 shrink-0 opacity-60 ${isActive ? 'text-yellow-800' : isNightMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                                            {t.labelPartKey}:
                                          </span>
                                          <span className={`text-[10px] font-black uppercase tracking-tight break-all ${isActive ? 'text-yellow-900' : isNightMode ? 'text-zinc-300' : 'text-zinc-700'}`}>
                                            {part.partKey || part.id.substring(0, 8)}
                                          </span>
                                        </div>
                                        {match && (
                                          <div className={`p-1.5 rounded-full ${isActive ? 'bg-yellow-500/20' : 'bg-yellow-500/10'} group-hover:scale-110 transition-transform ${isRTL ? 'rotate-180' : ''} shrink-0`}>
                                            <svg className={`w-3.5 h-3.5 ${isActive ? 'text-yellow-600' : 'text-yellow-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                            </svg>
                                          </div>
                                        )}
                                      </div>
                                      
                                      <div className="flex items-start gap-2 min-w-0 w-full">
                                        <span className={`text-[10px] font-bold ${isRTL ? '' : 'uppercase'} w-14 sm:w-16 shrink-0 opacity-60 ${isActive ? 'text-yellow-800' : isNightMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                                          {t.labelPartName}:
                                        </span>
                                        <span className={`text-[11px] font-black ${isRTL ? '' : 'uppercase'} ${isActive ? 'text-zinc-900' : isNightMode ? 'text-white' : 'text-zinc-900'} break-words whitespace-normal min-w-0 flex-1`}>
                                          {name}
                                        </span>
                                      </div>

                                      <div className="flex flex-col gap-0.5">
                                        <span className={`text-[10px] font-bold ${isRTL ? '' : 'uppercase'} opacity-60 ${isActive ? 'text-yellow-800' : isNightMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                                          {t.labelPartDescription}:
                                        </span>
                                        <div 
                                          className={`text-[11px] leading-snug line-clamp-3 whitespace-pre-wrap ${isActive ? 'text-zinc-800' : isNightMode ? 'text-zinc-300' : 'text-zinc-500'}`}
                                          dangerouslySetInnerHTML={{ __html: description }}
                                        />
                                      </div>
                                    </div>
                                    
                                    {isActive && (
                                      <div className="absolute top-4 right-4 w-1.5 h-1.5 bg-yellow-600 rounded-full animate-pulse" />
                                    )}
                                  </button>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </div>
                      );
                    })()}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* BOTTOM LEFT DESCRIPTION BOX */}
        {activePart && (
          <div 
            className={`absolute left-6 z-50 w-[calc(100%-3rem)] sm:w-80 p-5 sm:p-6 bg-white/95 backdrop-blur-2xl rounded-[2rem] shadow-[0_25px_60px_rgba(0,0,0,0.2)] border border-white/40 animate-in slide-in-from-bottom-10 fade-in duration-500 max-h-[70vh] flex flex-col transition-all duration-500 ease-in-out`} 
            style={{ bottom: isCatalogCollapsed ? '24px' : '254px' }}
            dir={isRTL ? 'rtl' : 'ltr'}
          >
            <div className="flex items-center justify-between mb-3 sm:mb-4 shrink-0">
              <div className="flex flex-col">
                <span className="text-[8px] font-black uppercase tracking-[0.3em] text-blue-600 leading-none mb-1">{t.partDetails}</span>
                <h3 className="text-base sm:text-lg font-black text-zinc-800 uppercase tracking-tight break-words whitespace-normal max-w-[180px] sm:max-w-none">{activePart.name}</h3>
              </div>
              <button 
                onClick={() => { 
                  if (selectedId) updateModelSettings(selectedId, { targetPartId: undefined });
                  setActivePart(null); 
                  stopSpeaking(); 
                  setTargetView({ pos: defaultCamPos, lookAt: new THREE.Vector3(0, 0, 0) });
                }}
                className={`w-8 h-8 sm:w-10 sm:h-10 flex items-center justify-center rounded-xl sm:rounded-2xl bg-zinc-100 hover:bg-zinc-200 text-zinc-400 hover:text-zinc-800 transition-all ${isRTL ? 'mr-auto' : 'ml-auto'}`}
              >
                <svg className="w-4 h-4 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <div className="h-[1px] w-full bg-zinc-100 mb-3 sm:mb-4 shrink-0"></div>
            <div className="overflow-y-auto pr-2 no-scrollbar flex-1">
              <div 
                className="text-xs sm:text-sm text-zinc-600 leading-relaxed font-medium whitespace-pre-wrap"
                dangerouslySetInnerHTML={{ __html: activePart.description || t.noDescription }}
              />

              {activePart.mesh && (
                <button
                  onClick={() => {
                    if (activePart.mesh) {
                      const svg = generateSingleMeshUVSVG(activePart.mesh);
                      if (svg) {
                        const cleanMeshName = activePart.mesh.name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
                        setInspectedUVPart({
                          name: activePart.name,
                          svg: svg,
                          filename: `${selectedModel?.name || 'model'}_part_${cleanMeshName}_uv_layout.svg`
                        });
                      }
                    }
                  }}
                  className="mt-4 flex items-center justify-center gap-2 w-full py-2.5 px-4 rounded-xl bg-gradient-to-r from-blue-50 to-indigo-50 text-blue-600 hover:from-blue-100 hover:to-indigo-100 font-extrabold text-[11px] sm:text-xs transition-all border border-blue-100/50 hover:border-blue-200/50 shadow-sm cursor-pointer"
                >
                  <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                  </svg>
                  {language === 'he' ? 'הצג קואורדינטות UV לחלק זה' : 'Inspect Mesh UV Map'}
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      {/* STATIC BOTTOM CATALOG PANEL */}
      <div 
        className="fixed bottom-0 left-0 right-0 z-40 h-[230px] bg-white/90 dark:bg-zinc-950/90 backdrop-blur-2xl border-t border-black/15 dark:border-white/15 rounded-t-[2rem] shadow-[0_-12px_40px_rgba(0,0,0,0.12)] flex flex-col transition-transform duration-500 ease-in-out"
        style={{
          transform: `translateY(${isCatalogCollapsed ? '230px' : '0px'})`
        }}
      >
        {/* Toggle Collapse/Expand Button */}
        <button
          onClick={() => setIsCatalogCollapsed(!isCatalogCollapsed)}
          className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-[calc(100%-1px)] w-28 h-8 bg-white/90 dark:bg-zinc-950/90 backdrop-blur-2xl border-t border-x border-black/15 dark:border-white/15 shadow-[0_-12px_24px_rgba(0,0,0,0.08)] flex items-center justify-center rounded-t-2xl z-50 group hover:text-yellow-600 dark:hover:text-yellow-500 transition-all duration-300 pointer-events-auto cursor-pointer"
          title={language === 'he' ? (isCatalogCollapsed ? 'פתח קטלוג' : 'סגור קטלוג') : (isCatalogCollapsed ? 'Open Catalog' : 'Close Catalog')}
        >
          <div className="flex items-center justify-center w-full h-full pb-0.5">
            <div className={`transition-transform duration-500 ease-in-out ${isCatalogCollapsed ? 'rotate-180' : ''}`}>
              <svg className="w-5 h-5 text-zinc-400 group-hover:text-yellow-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M19 9l-7 7-7-7" />
              </svg>
            </div>
          </div>
        </button>

        <Sidebar 
          models={models} 
          selectedId={selectedId} 
          onSelect={setSelectedId} 
          onAddFile={handleAddFile} 
          onAddFromUrl={handleAddFromUrl}
          onRemove={handleRemoveModel} 
          language={language}
          isMobile={isMobile}
          catalogFiles={catalogFiles}
          isLoadingCatalog={isLoadingCatalog}
          cachedUrls={cachedUrls}
          prefetchSummary={prefetchSummary}
          isPrefetchPaused={isPrefetchPaused}
          currentPrefetchFile={prefetchQueue[currentPrefetchIndex]?.name || ''}
          onTogglePrefetchPause={() => setIsPrefetchPaused(prev => !prev)}
          searchQuery={catalogSearchQuery}
        />
      </div>

      <CameraControls 
        onAction={handleCameraAction} 
        isPlayingAnimation={selectedModel?.settings.isPlayingAnimation}
        onToggleAnimation={handleToggleAnimation}
        language={language}
        hasAnimations={selectedModel?.hasAnimations}
        isSidebarOpen={false}
        onOrbitStart={(dir) => {
          setTargetView(null);
          setActivePart(null);
          stopSpeaking();
          setOrbitDirection(dir);
        }}
        onOrbitEnd={() => setOrbitDirection(null)}
      />

      {/* PART PREVIEW TOOLTIP */}
      {hoveredPartTooltip && createPortal(
        <div 
          className="fixed z-[9999] pointer-events-none transition-all duration-300 animate-in fade-in zoom-in-95"
          style={{
            top: Math.min(hoveredPartTooltip.rect.top, window.innerHeight - 400),
            left: hoveredPartTooltip.rect.right + 16, 
            width: '300px',
          }}
        >
          <div className="bg-white/98 backdrop-blur-3xl rounded-[2rem] border border-black/10 shadow-[0_30px_100px_rgba(0,0,0,0.25)] overflow-hidden flex flex-col p-4 gap-3">
            <div className="aspect-[4/3] w-full bg-zinc-50 rounded-[1.5rem] overflow-hidden border border-black/5 flex items-center justify-center">
              {hoveredPartTooltip.image ? (
                <img 
                  src={hoveredPartTooltip.image} 
                  alt={hoveredPartTooltip.name}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center bg-zinc-50">
                  <svg className="w-12 h-12 text-zinc-300 animate-pulse" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
              )}
            </div>
            
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className={`text-[9px] font-black uppercase tracking-[0.2em] text-blue-600 leading-none mb-1 ${isRTL ? 'text-start animate-pulse' : ''}`}>
                  {t.partDetails || 'PART DETAILS'}
                </span>
                <h3 className={`text-lg font-black text-zinc-900 leading-tight uppercase tracking-tight break-words whitespace-normal ${isRTL ? 'text-start' : ''}`}>
                  {hoveredPartTooltip.name}
                </h3>
              </div>
              
              {hoveredPartTooltip.description && (
                <p className={`text-xs text-zinc-500 leading-relaxed font-medium line-clamp-3 whitespace-pre-wrap ${isRTL ? 'text-start text-xs font-normal' : ''}`}>
                  {hoveredPartTooltip.description}
                </p>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
      {inspectedUVPart && (
        <div className="fixed inset-0 bg-stone-950/80 backdrop-blur-xl z-[9999] flex items-center justify-center p-4 sm:p-6 animate-in fade-in duration-300">
          <div className="bg-stone-900 border border-zinc-800 rounded-[2.5rem] w-full max-w-2xl overflow-hidden shadow-[0_30px_80px_rgba(0,0,0,0.8)] flex flex-col max-h-[90vh] animate-in zoom-in-95 duration-300" dir={isRTL ? 'rtl' : 'ltr'}>
            
            {/* Header */}
            <div className="p-6 border-b border-zinc-800 flex items-center justify-between shrink-0">
              <div className="flex flex-col gap-1">
                <span className="text-[10px] font-black uppercase tracking-[0.2em] text-yellow-500">
                  {language === 'he' ? 'קואורדינטות UV מבודדות' : 'Isolated UV Coordinates Map'}
                </span>
                <h3 className="text-xl font-black text-white uppercase tracking-tight">
                  {inspectedUVPart.name}
                </h3>
              </div>
              <button 
                onClick={() => setInspectedUVPart(null)}
                className="w-10 h-10 bg-zinc-800 hover:bg-zinc-750 text-zinc-400 hover:text-white rounded-full flex items-center justify-center transition-all"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* SVG Content Container */}
            <div className="flex-1 bg-stone-950 p-6 flex items-center justify-center overflow-auto min-h-0 relative select-none">
              <div 
                className="w-full max-w-md aspect-square flex items-center justify-center [&_svg]:w-full [&_svg]:h-full border border-zinc-800/60 rounded-2xl p-4 bg-stone-900/40 relative shadow-inner"
                dangerouslySetInnerHTML={{ __html: inspectedUVPart.svg }}
              />
            </div>

            {/* Info and Actions Footer */}
            <div className="p-6 border-t border-zinc-800 bg-stone-900/60 flex flex-col gap-4 shrink-0">
              <div className="flex flex-col gap-1">
                <span className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">
                  {language === 'he' ? 'זיהוי UDIM והמלצת חומרים' : 'UDIM Tile & Material Recommendation'}
                </span>
                <p className="text-xs text-zinc-400 leading-relaxed font-normal">
                  {language === 'he' 
                    ? 'מפת ה-UV הזו נוצרה עבור חלק תלת-המימד הספציפי הזה ללא חפיפה. אנו ממליצים על טקסטורת PBR מרובעת מותאמת אישית ברזולוציית 2048x2048 לקבלת חדות מירבית.' 
                    : 'This isolated UV map lets you target this mesh wireframe individually on its specific UDIM region. We recommend loading a high-detail custom PBR texture set (2048x2048 or higher) for optimal material representation.'}
                </p>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2">
                <button
                  onClick={() => setInspectedUVPart(null)}
                  className="px-5 py-2.5 bg-yellow-500 hover:bg-yellow-600 text-stone-950 font-black text-xs tracking-wide uppercase rounded-xl transition-all shadow-lg"
                >
                  {language === 'he' ? 'סגור' : 'Close'}
                </button>
              </div>
            </div>

          </div>
        </div>
      )}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[10000] px-6 py-3.5 bg-zinc-900 border border-white/10 text-white rounded-2xl shadow-2xl flex items-center gap-3 animate-in fade-in slide-in-from-bottom-5 duration-300">
          <div className="w-2 h-2 rounded-full bg-yellow-500 animate-ping"></div>
          <span className="text-[12px] font-black tracking-wide leading-none">{toast.message}</span>
        </div>
      )}
    </div>
  );
};

export default App;
