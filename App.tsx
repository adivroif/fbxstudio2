
import React, { useState, Suspense, useCallback, useRef, useEffect, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Environment, Float, Html, Center } from '@react-three/drei';
import * as THREE from 'three';
import './types';
import FBXModel from './components/FBXModel';
import Sidebar from './components/Sidebar';
import CameraControls from './components/CameraControls';
import { MaterialSettings, SceneModelInstance, ModelPart, ColorVariant, TextureSet } from './types';
import { speakText, stopSpeaking, translateText, translateBatch } from './services/ttsService';
import { Language, translations } from './src/translations';
import { parseTextureSets } from './Parsetexturesets';

const CameraHandler: React.FC<{ 
  targetView: { pos: THREE.Vector3, lookAt: THREE.Vector3 } | null, 
  controlsRef: any,
  activePartMesh?: THREE.Mesh | null
}> = ({ targetView, controlsRef, activePartMesh }) => {
  const { camera } = useThree();
  useFrame(() => {
    if (controlsRef.current) {
      if (activePartMesh) {
        // Calculate current world position of the mesh for dynamic tracking
        const box = new THREE.Box3().setFromObject(activePartMesh);
        const center = new THREE.Vector3();
        box.getCenter(center);
        
        // Target the center of the mesh
        controlsRef.current.target.lerp(center, 0.02);
        
        // If we have a targetView, maintain the relative offset from the moving center
        if (targetView) {
          const offset = targetView.pos.clone().sub(targetView.lookAt);
          const dynamicTargetPos = center.clone().add(offset);
          camera.position.lerp(dynamicTargetPos, 0.02);
        }
      } else if (targetView) {
        camera.position.lerp(targetView.pos, 0.02);
        controlsRef.current.target.lerp(targetView.lookAt, 0.02);
      }
      controlsRef.current.update();
    }
  });
  return null;
};

const App: React.FC = () => {
  const [models, setModels] = useState<SceneModelInstance[]>([]);
  const [catalogFiles, setCatalogFiles] = useState<any[]>([]);
  const [isLoadingCatalog, setIsLoadingCatalog] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isMoveMode, setIsMoveMode] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isNightMode, setIsNightMode] = useState(false);
  const [isProductInfoOpen, setIsProductInfoOpen] = useState(false);
  const [isFetchingDetails, setIsFetchingDetails] = useState(false);
  const [language, setLanguage] = useState<Language>('en');
  const [productDetails, setProductDetails] = useState<{ 
    title: string, 
    description: string, 
    originalTitle: string, 
    originalDescription: string,
    linkTo?: string
  } | null>(null);
  const [productTitles, setProductTitles] = useState<Record<string, string>>({});
  const [translatedSelectedModelName, setTranslatedSelectedModelName] = useState<string>('');
  const [isMobile, setIsMobile] = useState(typeof window !== 'undefined' && window.innerWidth < 768);
  const t = translations[language];

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const selectedModel = models.find(m => m.id === selectedId);

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
          const clientName = 'tenantBד';
          const response = await fetch(`/api/files/get-images-by-model?folder=${encodeURIComponent(folder)}&modelName=${encodeURIComponent(modelName)}&clientName=${clientName}`);
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
        const response = await fetch('/api/files/get-files?folder=tenants&clientName=tenantB');
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
              const url = `/api/files/get-file?folder=tenants&clientName=tenantB&fileName=${encodeURIComponent(name)}`;
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
    if (selectedModel) {
      const fetchProductDetails = async () => {
        setIsFetchingDetails(true);
        try {
          const response = await fetch(`/api/product-details?modelName=${encodeURIComponent(selectedModel.name)}`);
          if (response.ok) {
            const text = await response.text();
            if (text && text.trim().length > 0) {
              try {
                const data = JSON.parse(text);
                if (data) {
                  const result = Array.isArray(data) ? data[0] : data;
                  if (result) {
                    const apiTitle = result.productTitle || result.title || result.name || selectedModel.name;
                    const desc = result.productDescription || result.description || '';
                    
                    // Store title for sidebar and catalog consistency
                    const normalizedName = selectedModel.name.trim().toLowerCase();
                    setProductTitles(prev => ({ ...prev, [normalizedName]: apiTitle }));
                    
                    setProductDetails({
                      title: apiTitle,
                      description: desc,
                      originalTitle: apiTitle,
                      originalDescription: desc,
                      linkTo: result.linkTo
                    });
                    
                    // Auto-open on large screens only
                    if (window.innerWidth >= 1024) {
                      setIsProductInfoOpen(true);
                    }
                  }
                }
              } catch (parseErr) {
                console.error('Failed to parse product details JSON:', parseErr);
                setProductDetails(null);
              }
            } else {
              setProductDetails(null);
            }
          } else {
            setProductDetails(null);
          }
        } catch (error) {
          console.error('Failed to fetch product details:', error);
          setProductDetails(null);
        } finally {
          setIsFetchingDetails(false);
        }
      };
      fetchProductDetails();
    } else {
      setProductDetails(null);
      setIsFetchingDetails(false);
      setIsProductInfoOpen(false);
    }
  }, [selectedModel]);

  // Translate product info when language changes
  useEffect(() => {
    const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
    
    if (productDetails && langName !== 'English') {
      const translateInfo = async () => {
        const [tTitle, tDesc] = await Promise.all([
          translateText(productDetails.originalTitle, langName),
          translateText(productDetails.originalDescription, langName)
        ]);
        setProductDetails(prev => prev ? { ...prev, title: tTitle, description: tDesc, linkTo: prev.linkTo } : null);
      };
      translateInfo();
    } else if (productDetails && langName === 'English') {
      setProductDetails(prev => prev ? { ...prev, title: prev.originalTitle, description: prev.originalDescription, linkTo: prev.linkTo } : null);
    }
  }, [language, productDetails?.originalDescription, productDetails?.originalTitle]);

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
  const [modelParts, setModelParts] = useState<ModelPart[]>([]);
  const [isFetchingParts, setIsFetchingParts] = useState(false);
  const [hoveredPartId, setHoveredPartId] = useState<string | null>(null);
  const [translatedParts, setTranslatedParts] = useState<Record<string, { name: string, description: string }>>({});
  const [activePart, setActivePart] = useState<{ id: string, name: string, description: string, position?: THREE.Vector3, size?: THREE.Vector3, mesh?: THREE.Mesh } | null>(null);

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
    // Reset states for the new model immediately
    setModelParts([]);
    setTranslatedParts({});
    
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
        if (!response.ok) {
          console.warn(`Server responded with ${response.status} for model parts`);
          setIsFetchingParts(false);
          return;
        }
        const text = await response.text();
        if (text && (text.trim().startsWith('[') || text.trim().startsWith('{'))) { 
          try {
            const data = JSON.parse(text);
            const parts = Array.isArray(data) ? data : (data.parts || []);
            if (parts.length > 0) {
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
                    const newTranslatedParts: Record<string, { name: string, description: string }> = {};
                    
                    let resultIdx = 0;
                    mapping.forEach(item => {
                      const tName = translatedResults[resultIdx++];
                      const tDesc = translatedResults[resultIdx++];
                      newTranslatedParts[item.id] = { name: tName, description: tDesc };
                    });
                    
                    setTranslatedParts(newTranslatedParts);
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
        setIsFetchingParts(false);
      }
    };

    fetchModelParts();
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
    colorVariants: [], activeVariant: null
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
        fetch('/api/files/get-files?folder=images&clientName=tenantB').then(async r => {
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
          
          // Check if texture name starts with model name or contains it as a distinct word
          const isPrefixMatch = texNameNoExt.startsWith(modelNameBase);
          const isWordMatch = new RegExp(`(^|[\\s_\\d])${modelNameBase}([\\s_\\d]|$)`, 'i').test(texNameNoExt);
          const isCleanMatch = cleanTexName.includes(cleanModelName);
          
          let isModelMatch = isPrefixMatch || isWordMatch || isCleanMatch;

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

          // Find part number - look for numbers that aren't part of the model name
          const nameWithoutModel = texNameNoExt.replace(modelNameBase, '');
          const texNumMatch = nameWithoutModel.match(/\d+/);
          const texNum = texNumMatch ? texNumMatch[0] : null;

          // Find target material
          let targetMat = null;
          if (texNum !== null) {
            const parsedTexNum = parseInt(texNum);
            // Priority 1: Exact number match in material name
            targetMat = sortedMaterials.find(m => {
              const mNumMatch = m.match(/\d+/);
              if (!mNumMatch) return false;
              const mNum = parseInt(mNumMatch[0]);
              return mNum === parsedTexNum;
            });
            
            // Priority 2: Index match (1-based)
            if (!targetMat) {
              const idx = parsedTexNum - 1;
              if (idx >= 0 && idx < sortedMaterials.length) targetMat = sortedMaterials[idx];
            }
          }
          
          // Priority 3: Segment-based name match
          if (!targetMat) {
            const segments = texNameNoExt.split(/[\s_]/);
            targetMat = sortedMaterials.find(m => {
              const cleanM = m.toLowerCase().replace(/[^a-z0-9]/g, '');
              // Check if any segment (that isn't the model name or a color) matches the material name
              return segments.some(seg => {
                if (seg === cleanModelName || colorNames.includes(seg)) return false;
                return seg === cleanM || (cleanM.length > 2 && seg.length > 2 && (cleanM.includes(seg) || seg.includes(cleanM)));
              });
            });
          }

          // Priority 4: Original fuzzy match
          if (!targetMat) {
            targetMat = sortedMaterials.find(m => {
              const cleanM = m.toLowerCase().replace(/[^a-z0-9]/g, '');
              // Remove model name from material name to compare only the "part" part
              const cleanMPart = cleanM.replace(cleanModelName, '');
              const cleanTexPart = cleanTexName.replace(cleanModelName, '');
              return (cleanMPart && cleanTexPart && (cleanTexPart.includes(cleanMPart) || cleanMPart.includes(cleanTexPart))) ||
                     cleanTexName.includes(cleanM) || cleanM.includes(cleanTexName);
            });
          }

          // Fallback: if only one material, everything matches it
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

        Object.entries(matchesByType).forEach(([type, matches]) => {
          // If there's only one texture of this type for the whole model, 
          // apply it to ALL materials (Global Mapping)
          if (matches.length === 1 && !matches[0].colorName) {
            const m = matches[0];
            sortedMaterials.forEach(matName => {
              if (type === 'base') newSettings.materialMappings[matName] = m.tex.url;
              else if (type === 'normal') newSettings.normalMappings[matName] = m.tex.url;
              else if (type === 'metal') newSettings.metalMappings[matName] = m.tex.url;
              else if (type === 'rough') newSettings.roughMappings[matName] = m.tex.url;
              else if (type === 'alpha') newSettings.alphaMappings[matName] = m.tex.url;
              else if (type === 'emissive') newSettings.emissiveMappings[matName] = m.tex.url;
              else if (type === 'ao') newSettings.aoMappings[matName] = m.tex.url;
              else if (type === 'height') newSettings.heightMappings[matName] = m.tex.url;
              else if (type === 'specular') newSettings.specularMappings[matName] = m.tex.url;
            });
          } else {
            // If there are multiple, use the specific matching logic
            matches.forEach((data: any) => {
              const { tex, targetMat, colorName } = data;
              
              const isVariant = colorName && actualVariants.has(colorName);
              const targetMaterials = targetMat ? [targetMat] : sortedMaterials;

              if (isVariant) {
                if (!variantsMap[colorName]) {
                  variantsMap[colorName] = { 
                    name: colorName, mappings: {}, normalMappings: {}, metalMappings: {}, roughMappings: {}, 
                    alphaMappings: {}, emissiveMappings: {}, aoMappings: {}, heightMappings: {}, specularMappings: {} 
                  };
                }
                
                targetMaterials.forEach(mat => {
                  if (type === 'base') {
                    variantsMap[colorName].mappings[mat] = tex.url;
                    if (!newSettings.materialMappings[mat]) {
                      newSettings.materialMappings[mat] = tex.url;
                      newSettings.activeVariant = colorName;
                    }
                  } 
                  else if (type === 'normal') variantsMap[colorName].normalMappings![mat] = tex.url;
                  else if (type === 'metal') variantsMap[colorName].metalMappings![mat] = tex.url;
                  else if (type === 'rough') variantsMap[colorName].roughMappings![mat] = tex.url;
                  else if (type === 'alpha') variantsMap[colorName].alphaMappings![mat] = tex.url;
                  else if (type === 'emissive') variantsMap[colorName].emissiveMappings![mat] = tex.url;
                  else if (type === 'ao') variantsMap[colorName].aoMappings![mat] = tex.url;
                  else if (type === 'height') variantsMap[colorName].heightMappings![mat] = tex.url;
                  else if (type === 'specular') variantsMap[colorName].specularMappings![mat] = tex.url;
                });
              } else {
                targetMaterials.forEach(mat => {
                  if (type === 'base') newSettings.materialMappings[mat] = tex.url;
                  else if (type === 'normal') newSettings.normalMappings[mat] = tex.url;
                  else if (type === 'metal') newSettings.metalMappings[mat] = tex.url;
                  else if (type === 'rough') newSettings.roughMappings[mat] = tex.url;
                  else if (type === 'alpha') newSettings.alphaMappings[mat] = tex.url;
                  else if (type === 'emissive') newSettings.emissiveMappings[mat] = tex.url;
                  else if (type === 'ao') newSettings.aoMappings[mat] = tex.url;
                  else if (type === 'height') newSettings.heightMappings[mat] = tex.url;
                  else if (type === 'specular') newSettings.specularMappings[mat] = tex.url;
                });
              }
            });
          }
        });

        newSettings.colorVariants = Object.values(variantsMap);
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

  return (
    <div className={`relative w-screen h-screen overflow-hidden bg-transparent text-zinc-900 font-sans transition-colors duration-500 ${isRTL ? 'rtl' : 'ltr'}`} dir={isRTL ? 'rtl' : 'ltr'}>
      {/* BACKGROUND LAYER */}
      <div className={`fixed inset-0 z-[-2] transition-colors duration-1000 ${isNightMode ? 'bg-zinc-900' : 'bg-white'}`} />

      {/* FULL SCREEN WATERMARK BACKGROUND */}
      <div 
        className={`fixed inset-0 pointer-events-none z-[-1] flex items-center justify-center transition-all duration-1000 ${isNightMode ? 'opacity-[0.6] brightness-[300%]' : 'opacity-[0.08]'}`}
        style={{
          backgroundImage: 'url(/api/files/get-file?folder=images&fileName=wallpaper_customer_maxis.png)',
          backgroundPosition: 'center',
          backgroundRepeat: 'no-repeat',
          backgroundSize: '70%',
        }}
      />

      {/* TOP LEFT LOGO/SQUARE */}
      <div className="fixed top-4 left-4 z-[60] flex flex-row gap-3 items-center pointer-events-none" dir="ltr">
        <a 
          href="https://fbxstudio.co.il/" 
          target="_blank" 
          rel="noopener noreferrer"
          className="w-12 h-12 sm:w-16 sm:h-16 bg-white/80 backdrop-blur-xl rounded-xl sm:rounded-2xl border border-black/5 shadow-2xl overflow-hidden flex items-center justify-center pointer-events-auto transition-transform hover:scale-105 active:scale-95"
        >
          <img 
            src="/api/files/get-file?folder=images&fileName=wallpaper_customer_maxis_only_logo.png" 
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
      <div className="absolute top-4 sm:top-6 z-50 flex flex-row items-start gap-3 right-4 sm:right-6" dir="ltr">
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
            <div className="absolute top-full mt-2 flex flex-col gap-2 p-2 bg-white/90 backdrop-blur-xl rounded-2xl border border-black/5 shadow-2xl animate-in fade-in zoom-in-95 duration-200 right-0">
              {/* Day/Night Mode */}
              <button 
                onClick={() => setIsNightMode(!isNightMode)}
                className={`w-10 h-10 sm:w-12 sm:h-12 rounded-xl border border-black/5 flex items-center justify-center transition-all group ${isNightMode ? 'bg-zinc-800 text-yellow-400' : 'bg-white text-zinc-400 hover:text-yellow-500'}`}
                title={isNightMode ? t.dayMode : t.nightMode}
              >
                {isNightMode ? (
                  <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m0-11.314l.707.707m11.314 11.314l.707.707M12 5a7 7 0 100 14 7 7 0 000-14z" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5 sm:w-6 sm:h-6" fill="currentColor" viewBox="0 0 24 24">
                    <path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                  </svg>
                )}
              </button>

              {/* Language Selector */}
              <div className="flex flex-col gap-1 bg-zinc-50 p-1 rounded-xl border border-black/5">
                {(['en', 'he', 'ar', 'ru'] as Language[]).map((lang) => (
                  <button
                    key={lang}
                    onClick={() => setLanguage(lang)}
                    className={`w-8 h-8 sm:w-10 sm:h-10 rounded-lg flex items-center justify-center text-[10px] font-black uppercase transition-all ${language === lang ? 'bg-yellow-500 text-white shadow-lg' : 'text-zinc-400 hover:bg-zinc-100 hover:text-zinc-800'}`}
                  >
                    {lang}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* HAMBURGER MENU BUTTON */}
        <button 
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="w-10 h-10 sm:w-12 sm:h-12 bg-white rounded-xl sm:rounded-2xl shadow-xl border border-black/5 flex items-center justify-center hover:bg-zinc-50 transition-all group"
        >
          <div className="space-y-1 sm:space-y-1.5">
            <div className={`w-4 sm:w-5 h-0.5 bg-zinc-800 transition-all ${isSidebarOpen ? 'rotate-45 translate-y-1.5 sm:translate-y-2' : ''}`}></div>
            <div className={`w-4 sm:w-5 h-0.5 bg-zinc-800 transition-all ${isSidebarOpen ? 'opacity-0' : ''}`}></div>
            <div className={`w-4 sm:w-5 h-0.5 bg-zinc-800 transition-all ${isSidebarOpen ? '-rotate-45 -translate-y-1.5 sm:translate-y-2' : ''}`}></div>
          </div>
        </button>
      </div>

      {/* CENTER - VIEWPORT */}
      <div className={`absolute inset-0 z-10 transition-colors duration-1000 ${isNightMode ? 'bg-zinc-800/50' : 'bg-transparent'}`}>
        <Canvas 
          shadows 
          dpr={[1, 2]} 
          gl={{ 
            antialias: true, 
            alpha: true,
            sortObjects: true,
            logarithmicDepthBuffer: true
          }} 
          className="relative z-20"
          style={{ background: 'transparent' }}
          onPointerDown={() => { if (isMoveMode) setIsMoveMode(false); setTargetView(null); setActivePart(null); stopSpeaking(); }}
        >
          <PerspectiveCamera makeDefault position={isMobile ? [0, 40, 180] : [0, 30, 120]} fov={35} near={0.1} far={2000} />
          <CameraHandler targetView={targetView} controlsRef={controlsRef} activePartMesh={activePart?.mesh} />
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
              <Environment preset="city" />
            )}
            {models.map((model) => (
              <group key={model.id} position={model.position} onPointerDown={(e) => { e.stopPropagation(); if (selectedId !== model.id) setSelectedId(model.id); }}>
                <FBXModel 
                  url={model.url} 
                  settings={model.settings} 
                  textureSets={model.textureSets}
                  modelParts={modelParts}
                  activePartId={activePart?.id}
                  onPartClick={handlePartClick}
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
              />
              </group>
            ))}
          </Suspense>
          <OrbitControls 
            ref={controlsRef} 
            makeDefault 
            enableDamping 
            minDistance={5} 
            maxDistance={500} 
            enabled={!isMoveMode} 
            onStart={() => setTargetView(null)}
          />
        </Canvas>

        {/* COLOR VARIANTS - BOTTOM CENTER */}
        {selectedModel && (relevantVariants.length > 1 || activePart) && (
          <div className="absolute bottom-24 sm:bottom-14 left-1/2 -translate-x-1/2 z-30 flex items-center gap-2 sm:gap-4 bg-white/80 backdrop-blur-2xl px-4 sm:px-8 py-3 sm:py-5 rounded-[2rem] sm:rounded-[3rem] border border-black/5 shadow-2xl animate-in slide-in-from-bottom-10 duration-1000 max-w-[90vw] overflow-x-auto no-scrollbar">
            {relevantVariants.length > 1 ? (
              <>
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
              </>
            ) : (
              <div className="flex items-center gap-4">
                {activePart && (
                   <div className="text-[10px] font-black uppercase tracking-widest text-zinc-400">
                     {activePart.name}
                   </div>
                )}
              </div>
            )}
          </div>
        )}


        {/* PRODUCT INFO TAB - LEFT SIDE */}
        {selectedModel && (
          <div className="absolute left-0 top-[60%] -translate-y-1/2 z-[110] flex items-center pointer-events-none">
            <button
              onClick={() => setIsProductInfoOpen(!isProductInfoOpen)}
              className={`group relative flex items-center justify-center w-8 h-20 sm:w-12 sm:h-28 bg-white/95 backdrop-blur-xl border border-black/10 shadow-2xl transition-all duration-500 pointer-events-auto opacity-100 visible ${
                isProductInfoOpen ? 'translate-x-[280px] sm:translate-x-[320px]' : 'translate-x-0'
              }`}
              style={{
                clipPath: 'polygon(0% 0%, 100% 50%, 0% 100%)',
                borderRadius: '0 12px 12px 0',
                zIndex: 111
              }}
            >
              <div className={`transition-transform duration-500 ${isProductInfoOpen ? 'rotate-180' : ''}`}>
                <svg className="w-4 h-4 sm:w-5 sm:h-5 text-zinc-400 group-hover:text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" d="M9 5l7 7-7 7" />
                </svg>
              </div>
              {!isProductInfoOpen && (
                <div className="absolute left-1 flex flex-col items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-1 h-1 bg-yellow-500 rounded-full animate-pulse" />
                  <div className="w-1 h-1 bg-yellow-500 rounded-full animate-pulse delay-75" />
                  <div className="w-1 h-1 bg-yellow-500 rounded-full animate-pulse delay-150" />
                </div>
              )}
            </button>

            {/* PRODUCT INFO PANEL */}
            <div 
              className={`absolute top-1/2 -translate-y-1/2 left-0 w-[280px] sm:w-[320px] h-[70vh] backdrop-blur-3xl shadow-[25px_0_80px_rgba(0,0,0,0.15)] transition-all duration-500 transform overflow-hidden flex flex-col pointer-events-auto antialiased font-sans ${
                isProductInfoOpen ? 'translate-x-0 opacity-100' : '-translate-x-full opacity-0'
              } rounded-r-[3rem] ${
                isNightMode 
                  ? 'bg-zinc-900/95 border-t border-r border-b border-white/60' 
                  : 'bg-white/98 border-r border-black/10'
              }`}
              dir={isRTL ? 'rtl' : 'ltr'}
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
                    {/* Description Section */}
                    <div className={`p-6 rounded-3xl border ${
                      isNightMode ? 'bg-zinc-800/50 border-white/30' : 'bg-zinc-50/50 border-black/5'
                    }`}>
                      <h3 className={`text-[9px] font-black ${isRTL ? '' : 'uppercase'} ${isRTL ? 'tracking-normal' : 'tracking-[0.15em]'} mb-4 ${isNightMode ? 'text-zinc-500' : 'text-zinc-400'}`}>
                        {t.productDescription}
                      </h3>
                      <p className={`text-sm leading-relaxed font-normal ${isNightMode ? 'text-zinc-300' : 'text-zinc-700'}`}>
                        {isFetchingDetails ? t.loading : (productDetails?.description || t.noDescription)}
                      </p>
                    </div>

                    {/* Parts Section */}
                    {(isFetchingParts || (modelParts && modelParts.length > 0)) && (
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
                        ) : (
                          <div className="grid gap-2">
                            {modelParts
                              .filter(part => part.presentAtSite !== false)
                              .map((part) => {
                                const tr = translatedParts[part.id];
                                const name = tr?.name || part.partName;
                                const description = tr?.description || part.description;
                                const isActive = activePart?.id === part.id;
                                
                                // HIGHLIGHTING: Use partName or partKey for mesh matching 
                                const meshMatchTarget = part.partName || part.partKey || part.id;
                                const isHovered = hoveredPartId === meshMatchTarget;
                                
                                // Find the matching model file
                                const partNameForMatch = part.partName.toLowerCase().replace(/_/g, ' ').replace(/-/g, ' ').trim();
                                const partKeyForMatch = (part.partKey || '').toLowerCase().replace(/_/g, ' ').replace(/-/g, ' ').trim();
                                const match = catalogFiles.find(file => {
                                  const fileName = file.name.replace(/\.fbx$/i, '').toLowerCase().replace(/_/g, ' ').replace(/-/g, ' ').trim();
                                  return fileName === partNameForMatch || fileName === partKeyForMatch;
                                });

                                return (
                                  <button
                                    key={part.id}
                                    onMouseEnter={() => setHoveredPartId(meshMatchTarget)}
                                    onMouseLeave={() => setHoveredPartId(null)}
                                    onClick={() => {
                                      if (activePart?.id === part.id) {
                                        handlePartClick(null);
                                        return;
                                      }
                                      
                                      const p = {
                                        id: part.id,
                                        name: translatedParts[part.id]?.name || part.partName,
                                        description: translatedParts[part.id]?.description || part.description,
                                        position: new THREE.Vector3(),
                                        size: new THREE.Vector3(),
                                        mesh: undefined as any
                                      };
                                      handlePartClick(p);
                                      if (match) {
                                        handleAddFromUrl(match.url, match.name);
                                      }
                                    }}
                                    className={`flex flex-col p-4 rounded-2xl border transition-all text-start relative group cursor-pointer ${
                                      isActive 
                                        ? 'bg-yellow-50 border-yellow-500 border-2 shadow-lg shadow-yellow-900/10 text-yellow-950' 
                                        : isHovered
                                          ? isNightMode ? 'bg-yellow-900/30 border-yellow-500/50 text-white shadow-sm transform scale-[1.01]' : 'bg-yellow-50 border-yellow-300 text-yellow-900 shadow-sm transform scale-[1.01]'
                                          : isNightMode ? 'bg-zinc-800/80 border-white/20 text-zinc-400 hover:border-white/40' : 'bg-white border-black/5 text-zinc-600 hover:border-yellow-500/30'
                                    }`}
                                  >
                                    <div className="space-y-2">
                                      <div className="flex items-start justify-between gap-2">
                                        <div className="flex items-start gap-2">
                                          <span className={`text-[10px] font-bold ${isRTL ? '' : 'uppercase'} w-20 shrink-0 opacity-60 ${isActive ? 'text-yellow-800' : isNightMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                                            {t.labelPartKey}:
                                          </span>
                                          <span className={`text-[10px] font-black uppercase tracking-tight ${isActive ? 'text-yellow-900' : isNightMode ? 'text-zinc-300' : 'text-zinc-700'}`}>
                                            {part.partKey || part.id.substring(0, 8)}
                                          </span>
                                        </div>
                                        {match && (
                                          <div className={`p-1.5 rounded-full ${isActive ? 'bg-yellow-500/20' : 'bg-yellow-500/10'} group-hover:scale-110 transition-transform ${isRTL ? 'rotate-180' : ''}`}>
                                            <svg className={`w-3.5 h-3.5 ${isActive ? 'text-yellow-600' : 'text-yellow-600'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                                            </svg>
                                          </div>
                                        )}
                                      </div>
                                      
                                      <div className="flex items-start gap-2">
                                        <span className={`text-[10px] font-bold ${isRTL ? '' : 'uppercase'} w-20 shrink-0 opacity-60 ${isActive ? 'text-yellow-800' : isNightMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                                          {t.labelPartName}:
                                        </span>
                                        <span className={`text-[11px] font-black ${isRTL ? '' : 'uppercase'} ${isActive ? 'text-zinc-900' : isNightMode ? 'text-white' : 'text-zinc-900'}`}>
                                          {name}
                                        </span>
                                      </div>

                                      <div className="flex flex-col gap-0.5">
                                        <span className={`text-[10px] font-bold ${isRTL ? '' : 'uppercase'} opacity-60 ${isActive ? 'text-yellow-800' : isNightMode ? 'text-zinc-400' : 'text-zinc-500'}`}>
                                          {t.labelPartDescription}:
                                        </span>
                                        <p className={`text-[11px] leading-snug line-clamp-3 ${isActive ? 'text-zinc-800' : isNightMode ? 'text-zinc-300' : 'text-zinc-500'}`}>
                                          {description}
                                        </p>
                                      </div>
                                    </div>
                                    
                                    {isActive && (
                                      <div className="absolute top-4 right-4 w-1.5 h-1.5 bg-yellow-600 rounded-full animate-pulse" />
                                    )}
                                  </button>
                                );
                              })
                            }
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* BOTTOM LEFT DESCRIPTION BOX */}
        {activePart && (
          <div className={`absolute bottom-24 sm:bottom-6 left-6 z-50 w-[calc(100%-3rem)] sm:w-80 p-5 sm:p-6 bg-white/90 backdrop-blur-2xl rounded-[2rem] shadow-[0_25px_60px_rgba(0,0,0,0.2)] border border-white/40 animate-in slide-in-from-bottom-10 fade-in duration-500 max-h-[40vh] flex flex-col`} dir={isRTL ? 'rtl' : 'ltr'}>
            <div className="flex items-center justify-between mb-3 sm:mb-4 shrink-0">
              <div className="flex flex-col">
                <span className="text-[8px] font-black uppercase tracking-[0.3em] text-blue-600 leading-none mb-1">{t.partDetails}</span>
                <h3 className="text-base sm:text-lg font-black text-zinc-800 uppercase tracking-tight truncate max-w-[180px] sm:max-w-none">{activePart.name}</h3>
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
            <div className="overflow-y-auto pr-2 no-scrollbar">
              <p className="text-xs sm:text-sm text-zinc-600 leading-relaxed font-medium">
                {activePart.description || t.noDescription}
              </p>
            </div>
          </div>
        )}
      </div>

      {/* FLOATING ASSET LIBRARY */}
      <div className={`fixed inset-0 sm:inset-auto sm:top-24 sm:bottom-0 sm:w-[340px] z-40 transition-all duration-500 transform ${
        isSidebarOpen ? 'translate-x-0 opacity-100' : 'translate-x-full sm:translate-x-12 opacity-0 pointer-events-none'
      } right-0 sm:right-6`}>
        <div className={`w-full h-full bg-white/95 sm:bg-white/90 backdrop-blur-2xl sm:rounded-t-[2.5rem] border-b sm:border border-black/5 shadow-2xl overflow-hidden flex flex-col`}>
          {/* Mobile Close Button */}
          <div className="sm:hidden flex justify-end p-4 border-b border-black/5">
            <button onClick={() => setIsSidebarOpen(false)} className="p-2 text-zinc-400">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
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
          />
        </div>
      </div>

      <CameraControls 
        onAction={handleCameraAction} 
        isPlayingAnimation={selectedModel?.settings.isPlayingAnimation}
        onToggleAnimation={handleToggleAnimation}
        language={language}
        hasAnimations={selectedModel?.hasAnimations}
        isSidebarOpen={isSidebarOpen}
      />
    </div>
  );
};

export default App;
