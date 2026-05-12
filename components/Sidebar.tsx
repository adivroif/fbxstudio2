
import React from 'react';
import { createPortal } from 'react-dom';
import { SceneModelInstance } from '../types';
import { Language, translations } from '../src/translations';
import { translateText } from '../services/ttsService';

interface SidebarProps {
  models: SceneModelInstance[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onAddFile: (file: File) => void;
  onRemove: (id: string) => void;
  onAddFromUrl: (url: string, name: string) => void;
  language: Language;
  isMobile?: boolean;
}

const Sidebar: React.FC<SidebarProps> = ({ 
  models, selectedId, onSelect, onAddFile, onRemove, onAddFromUrl, language, isMobile = false
}) => {
  const [r2Files, setR2Files] = React.useState<any[]>([]);
  const [r2Textures, setR2Textures] = React.useState<any[]>([]);
  const [isLoadingR2, setIsLoadingR2] = React.useState(false);
  const [r2Error, setR2Error] = React.useState<string | null>(null);
  const [activeTab, setActiveTab] = React.useState<'all' | 'categories'>('all');
  const [expandedCategory, setExpandedCategory] = React.useState<string | null>(null);
  const [inventory, setInventory] = React.useState<Record<string, number>>({});
  const [descriptions, setDescriptions] = React.useState<Record<string, string>>({});
  const [apiTitles, setApiTitles] = React.useState<Record<string, string>>({});
  const [apiCategories, setApiCategories] = React.useState<any[]>([]);
  const [displayStatus, setDisplayStatus] = React.useState<Record<string, boolean>>({});
  const [productToCategory, setProductToCategory] = React.useState<Record<string, string>>({});
  const [translatedModels, setTranslatedModels] = React.useState<Record<string, { name: string, description: string }>>({});

  const [hoveredProduct, setHoveredProduct] = React.useState<{
    name: string;
    description: string;
    image: string | null;
    inventory: number | undefined;
    rect: DOMRect;
  } | null>(null);

  const t = translations[language];
  const isRTL = language === 'he' || language === 'ar';

  const fetchInventory = async (productName: string) => {
    const normalizedName = productName.trim().toLowerCase();
    try {
      // Use the server proxy to avoid CORS issues
      const res = await fetch(`/api/inventory?productName=${encodeURIComponent(productName.trim())}`);
      
      if (res.ok) {
        const text = await res.text();
        const parsed = parseInt(text.trim());
        if (!isNaN(parsed)) {
          setInventory(prev => ({ ...prev, [normalizedName]: parsed }));
          return;
        }
      }
      
      setInventory(prev => ({ ...prev, [normalizedName]: 10 }));
    } catch (err) {
      console.error(`Failed to fetch inventory for ${productName}:`, err);
      setInventory(prev => ({ ...prev, [normalizedName]: 10 }));
    }
  };

  const fetchDescription = async (productName: string) => {
    const normalizedName = productName.trim().toLowerCase();
    try {
      const res = await fetch(`/api/product-details?modelName=${encodeURIComponent(productName.trim())}`);
      if (res.ok) {
        const text = await res.text();
        if (!text || text.trim() === "") return;
        
        try {
          const data = JSON.parse(text);
          if (data) {
            const result = Array.isArray(data) ? data[0] : data;
            if (result) {
              const apiTitle = result.productTitle || result.title || result.name || '';
              const desc = result.productDescription || result.description || '';
              
              if (apiTitle) {
                setApiTitles(prev => ({ ...prev, [normalizedName]: apiTitle }));
              }
              if (desc) {
                setDescriptions(prev => ({ ...prev, [normalizedName]: desc }));
              }
              
              const category = result.productCategory || result.category || result.categoryId || '';
              if (category) {
                setProductToCategory(prev => ({ ...prev, [normalizedName]: category }));
              }
              
              // Handle displayInSite flag (Handle boolean, string, or number)
              const rawDisplay = result.displayInSite ?? result.DisplayInSite;
              const display = rawDisplay === true || 
                            rawDisplay === 1 || 
                            String(rawDisplay).toLowerCase() === 'true';
              
              setDisplayStatus(prev => ({ ...prev, [normalizedName]: display }));
            } else {
              // Product found but empty - hide by default
              setDisplayStatus(prev => ({ ...prev, [normalizedName]: false }));
            }
          }
        } catch (jsonErr) {
          console.error("Failed to parse product JSON:", jsonErr);
          setDisplayStatus(prev => ({ ...prev, [normalizedName]: false }));
        }
      } else if (res.status === 404) {
        // Product not found in DB - Hide by default
        console.log(`Product ${productName} not found in DB, hiding.`);
        setDisplayStatus(prev => ({ ...prev, [normalizedName]: false }));
      } else {
        // Error case - Hide by default
        setDisplayStatus(prev => ({ ...prev, [normalizedName]: false }));
      }
    } catch (err) {
      console.error("Fetch error for product:", err);
      setDisplayStatus(prev => ({ ...prev, [normalizedName]: false }));
    }
  };

  const fetchCategories = async () => {
    try {
      const res = await fetch('/api/categories/tenantB');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setApiCategories(data);
        }
      }
    } catch (err) {
      console.error("Failed to fetch categories:", err);
    }
  };


  const fetchCatalogFiles = async () => {
    setIsLoadingR2(true);
    setR2Error(null);
    try {
      console.log("Fetching catalog from Azure...");
      // Fetch models and textures in parallel from their respective folders
      const [modelsRes, texturesRes] = await Promise.all([
        fetch('/api/files/get-files?folder=tenants&clientName=tenantB'),
        fetch('/api/files/get-files?folder=images&clientName=tenantB')
      ]);
      
      const rawModelsData = modelsRes.ok ? await modelsRes.json() : [];
      const rawTexturesData = texturesRes.ok ? await texturesRes.json() : [];
      
      console.log("RAW MODELS DATA:", rawModelsData);
      console.log("RAW TEXTURES DATA:", rawTexturesData);
      
      // Helper to find list in various response formats
      const getListData = (raw: any) => {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
          return raw.files || raw.items || raw.data || raw.images || raw.models || Object.values(raw).find(v => Array.isArray(v)) || [];
        }
        return [];
      };

      const modelsData = getListData(rawModelsData);
      const texturesData = getListData(rawTexturesData);
      
      // Helper to extract values from items with various property names
      const extractItem = (item: any, sourceFolder: string, forceType?: 'fbx' | 'texture') => {
        if (typeof item === 'string') return { key: item, name: item, url: item };
        
        const name = item.fileName || item.FileName || item.filename || item.Name || item.name || item.Title || item.title || "";
        const key = item.fullPath || item.FullPath || item.fullpath || item.Key || item.item_key || item.key || item.FilePath || name || "";
        
        const isFbx = forceType === 'fbx' || name.toLowerCase().endsWith('.fbx');
        const clientName = "tenantB";

        // Logic based on user request:
        // FBX -> get-files
        // Textures -> get-file
        let url = "";
        if (isFbx) {
          url = `/api/files/get-file?folder=${encodeURIComponent(sourceFolder)}&clientName=${clientName}&fileName=${encodeURIComponent(name)}`;
        } else {
          url = `/api/files/get-file?folder=${encodeURIComponent(sourceFolder)}&clientName=${clientName}&fileName=${encodeURIComponent(name)}`;
        }
        
        return { key, name, url };
      };

      if (modelsData && modelsData.length > 0) {
        const files = modelsData
          .map(item => extractItem(item, 'tenants', 'fbx'))
          .filter(f => f.name.toLowerCase().endsWith(".fbx") || f.key.toLowerCase().endsWith(".fbx"));
          
        console.log("PARSED MODELS:", files);
        setR2Files(files);
      } else {
        console.warn("No models found in Azure response");
      }

      if (texturesData && texturesData.length > 0) {
        const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds", ".gif", ".bmp"];
        const textures = texturesData
          .map(item => extractItem(item, 'images', 'texture'))
          .filter(f => {
            const name = f.name.toLowerCase();
            return imageExtensions.some(ext => name.endsWith(ext));
          });
          
        console.log("PARSED TEXTURES:", textures);
        setR2Textures(textures);
      } else {
        console.warn("No textures found in Azure response, checking fallback R2");
        // Fallback to fetch textures from R2 if no images found in the images folder
        try {
          const r2TexturesRes = await fetch('/api/r2/textures');
          if (r2TexturesRes.ok) {
            const r2TexturesData = await r2TexturesRes.json();
            if (r2TexturesData.textures) {
              setR2Textures(r2TexturesData.textures);
            }
          }
        } catch (texErr) {
          console.error("Failed to fetch fallback R2 textures:", texErr);
        }
      }
    } catch (err) {
      console.error("Catalog Fetch Error:", err);
      setR2Error('Failed to fetch product catalog');
    } finally {
      setIsLoadingR2(false);
    }
  };

  const fetchR2Files = fetchCatalogFiles; // Keep the name for compatibility with existing code

  React.useEffect(() => {
    fetchR2Files();
    fetchCategories();
  }, []);

  React.useEffect(() => {
    if (r2Files.length > 0) {
      r2Files.forEach(file => {
        const displayName = file.name.replace(/\.fbx$/i, '');
        const normalizedName = displayName.trim().toLowerCase();
        if (inventory[normalizedName] === undefined) {
          fetchInventory(displayName);
        }
        // Always try to fetch if we don't have a definitive displayStatus
        if (displayStatus[normalizedName] === undefined) {
          fetchDescription(displayName);
        }
      });
    }
  }, [r2Files, inventory, displayStatus]);

  React.useEffect(() => {
    const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
    
    if (langName === 'English') {
      setTranslatedModels({});
      return;
    }

    const translateModelInfo = async () => {
      const filesToTranslate = [...r2Files];
      if (filesToTranslate.length === 0) return;

      const itemsToTranslate: string[] = [];
      const mapping: { name: string; desc: string; normalized: string }[] = [];

      filesToTranslate.forEach(file => {
        const originalDisplayName = file.name.replace(/\.fbx$/i, '');
        const normalizedName = originalDisplayName.trim().toLowerCase();
        const apiName = apiTitles[normalizedName] || originalDisplayName;
        const description = descriptions[normalizedName] || '';
        
        itemsToTranslate.push(apiName);
        if (description) itemsToTranslate.push(description);
        
        mapping.push({ name: apiName, desc: description, normalized: normalizedName });
      });

      try {
        const { translateBatch } = await import('../services/ttsService');
        const translatedResults = await translateBatch(itemsToTranslate, langName);
        
        const newTranslations: Record<string, { name: string, description: string }> = {};
        let resultIdx = 0;
        
        mapping.forEach(item => {
          const tName = translatedResults[resultIdx++];
          const tDesc = item.desc ? translatedResults[resultIdx++] : '';
          newTranslations[item.normalized] = { name: tName, description: tDesc };
        });

        setTranslatedModels(newTranslations);
      } catch (err) {
        console.error("Failed to translate model info:", err);
      }
    };

    translateModelInfo();
  }, [language, r2Files, descriptions]);

  const visibleFiles = React.useMemo(() => {
    return r2Files.filter(file => {
      const displayName = file.name.replace(/\.fbx$/i, '');
      const normalizedName = displayName.trim().toLowerCase();
      // Strictly show only those set to true
      return displayStatus[normalizedName] === true;
    });
  }, [r2Files, displayStatus]);

  // Group files by category (associate with DB productCategory)
  const categories = React.useMemo(() => {
    const groups: Record<string, any[]> = {};
    
    // Create a set of valid category titles from API for easier matching
    const apiCategoryTitles = apiCategories.map(c => (c.categoryName || c.name || c.title || '').toString().toLowerCase());
    
    visibleFiles.forEach(file => {
      const originalDisplayName = file.name.replace(/\.fbx$/i, '');
      const normalizedName = originalDisplayName.trim().toLowerCase();
      
      // Try to get category from product metadata
      let category = productToCategory[normalizedName] || 'General';
      
      // Validate that the category actually exists in our apiCategories list
      // If it doesn't match exactly, we might want to check the folder fallback
      const lowCategory = category.toLowerCase();
      const matchedCategory = apiCategories.find(c => {
        const name = (c.categoryName || c.name || c.title || '').toString().toLowerCase();
        const id = (c.categoryId || c.id || '').toString().toLowerCase();
        return name === lowCategory || id === lowCategory;
      });

      if (matchedCategory) {
        category = matchedCategory.categoryName || matchedCategory.name || matchedCategory.title || category;
      } else {
        // Fallback to original folder grouping if no DB association found
        const parts = file.key.split('/');
        if (parts.length > 1) {
          if (parts[0].toLowerCase() === 'files') {
            category = parts.length > 2 ? parts[1] : 'General';
          } else {
            category = parts[0];
          }
        } else {
          category = 'General';
        }
      }
      
      if (!groups[category]) groups[category] = [];
      groups[category].push(file);
    });

    // Ensure all API categories are present even if empty (optional, but requested for better UI)
    apiCategories.forEach(c => {
      const name = c.categoryName || c.name || c.title;
      if (name && !groups[name]) {
        groups[name] = [];
      }
    });

    return groups;
  }, [visibleFiles, productToCategory, apiCategories]);

  const selectedModel = models.find(m => m.id === selectedId);

  return (
    <div className="flex-1 flex flex-col p-4 overflow-y-auto custom-scroll bg-white">
      
      {/* 1. Products Catalog Section */}
      <div className="bg-zinc-50 rounded-3xl p-5 border border-black/5">
          <div className="flex items-center justify-between mb-8">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-1.5 bg-orange-500 rounded-full"></div>
              <h2 className={`text-[14px] font-black ${isRTL ? '' : 'uppercase'} ${isRTL ? 'tracking-normal' : 'tracking-[0.3em]'} text-zinc-800`}>{t.productsCatalog}</h2>
            </div>
            <button 
              onClick={fetchR2Files}
              className="p-2 hover:bg-black/5 rounded-lg text-zinc-400 hover:text-yellow-500 transition-all"
            >
              <svg className={`w-4 h-4 ${isLoadingR2 ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>

          <div className="flex items-center justify-center mb-6">
            <div className="flex bg-zinc-200/50 p-1 rounded-xl">
              <button 
                onClick={() => setActiveTab('all')}
                className={`px-3 py-1.5 text-[8px] font-black uppercase tracking-wider rounded-lg transition-all ${activeTab === 'all' ? 'bg-white text-zinc-800 shadow-sm' : 'text-zinc-400 hover:text-zinc-600'}`}
              >
                {t.all}
              </button>
              <button 
                onClick={() => setActiveTab('categories')}
                className={`px-3 py-1.5 text-[8px] font-black uppercase tracking-wider rounded-lg transition-all ${activeTab === 'categories' ? 'bg-white text-zinc-800 shadow-sm' : 'text-zinc-400 hover:text-zinc-600'}`}
              >
                {t.categories}
              </button>
            </div>
          </div>
          
          {isLoadingR2 ? (
            <div className="flex items-center justify-center py-10">
              <div className="w-6 h-6 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : r2Error ? (
            <div className="text-[9px] text-red-500 font-bold text-center py-4">{r2Error}</div>
          ) : r2Files.length === 0 ? (
            <div className="text-[9px] text-zinc-400 font-bold text-center py-4 italic">{t.noAssetsFound}</div>
          ) : (
            <div className="flex flex-col gap-4 overflow-y-auto custom-scroll pr-2">
              {activeTab === 'all' ? (
                visibleFiles.length === 0 ? (
                  <div className="text-[9px] text-zinc-400 font-bold text-center py-4 italic">{t.noAssetsFound}</div>
                ) : (
                  visibleFiles.map((file) => {
                    const originalDisplayName = file.name.replace(/\.fbx$/i, '');
                    const cleanFileName = originalDisplayName.replace(/_/g, ' ').replace(/-/g, ' ');
                    const normalizedName = originalDisplayName.trim().toLowerCase();
                    const translation = translatedModels[normalizedName];
                    const displayName = translation?.name || apiTitles[normalizedName] || cleanFileName;
                    
                    const thumbnail = r2Textures.find(t => {
                      const lowTex = t.name.toLowerCase();
                      const lowModel = originalDisplayName.toLowerCase();
                      return lowTex.startsWith(lowModel) && lowTex.includes('preview');
                    }) || r2Textures.find(t => t.name.toLowerCase().startsWith(originalDisplayName.toLowerCase()));
                    
                    const isOutOfStock = inventory[normalizedName] === 0;
                    const description = translation?.description || descriptions[normalizedName];
                    
                    return (
                      <div 
                        key={file.key}
                        onMouseEnter={(e) => {
                          if (isMobile) return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          setHoveredProduct({
                            name: displayName,
                            description: description || '',
                            image: thumbnail?.url || null,
                            inventory: inventory[normalizedName],
                            rect
                          });
                        }}
                        onMouseLeave={() => setHoveredProduct(null)}
                        onClick={(e) => {
                          if (isOutOfStock) {
                            e.preventDefault();
                            e.stopPropagation();
                            return;
                          }
                          onAddFromUrl(file.url, file.name);
                        }}
                        className={`flex flex-row gap-2 p-1.5 bg-white rounded-2xl border border-black/5 transition-all group shadow-sm overflow-hidden relative items-start hover:scale-[1.02] active:scale-[0.98] ${
                          isOutOfStock ? 'cursor-not-allowed opacity-70' : 'hover:bg-yellow-50 hover:border-yellow-200 cursor-pointer'
                        }`}
                      >
                        {isOutOfStock && (
                          <div className="absolute inset-0 z-50 pointer-events-auto flex items-center justify-center bg-zinc-100/60 backdrop-grayscale cursor-not-allowed">
                            <div className="w-[150%] h-[2px] bg-red-500/40 rotate-45 absolute" />
                            <div className="w-[150%] h-[2px] bg-red-500/40 -rotate-45 absolute" />
                            <div className="bg-zinc-800 text-white text-[8px] font-black uppercase tracking-[0.2em] px-3 py-1.5 rounded-lg shadow-2xl z-[60] border border-white/20">
                              {t.outOfStock}
                            </div>
                          </div>
                        )}

                        <div className="shrink-0">
                          <div className="w-12 h-12 bg-zinc-50 rounded-xl relative overflow-hidden border border-black/5">
                            {thumbnail ? (
                              <img 
                                src={thumbnail.url} 
                                alt={displayName}
                                className={`w-full h-full object-cover transition-transform duration-500 ${!isOutOfStock && 'group-hover:scale-110'}`}
                                referrerPolicy="no-referrer"
                              />
                            ) : (
                              <div className="w-full h-full flex items-center justify-center bg-zinc-50">
                                <svg className="w-6 h-6 text-zinc-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                                </svg>
                              </div>
                            )}
                          </div>
                        </div>

                        <div className="flex flex-col gap-1 min-w-0 flex-1">
                          <span className={`text-[12px] font-black uppercase tracking-wider transition-colors leading-tight ${
                            isOutOfStock ? 'text-zinc-400 line-through decoration-red-500/50 decoration-2' : 'text-zinc-800 group-hover:text-yellow-600'
                          }`}>
                            {displayName}
                          </span>
                          {description && (
                            <p className="text-[11px] text-zinc-500 font-medium leading-relaxed line-clamp-3">
                              {description}
                            </p>
                          )}
                        </div>
                      </div>
                    );
                  })
                )
              ) : (
                Object.entries(categories).map(([category, files]) => (
                  <div key={category} className="space-y-3">
                    <button 
                      onClick={() => setExpandedCategory(expandedCategory === category ? null : category)}
                      className="w-full flex items-center justify-between p-4 bg-zinc-100/50 hover:bg-zinc-100 rounded-2xl border border-black/5 transition-all group"
                    >
                      <div className="flex items-center gap-2">
                        <div className="w-1.5 h-1.5 bg-zinc-400 rounded-full group-hover:bg-yellow-500 transition-colors"></div>
                        <span className="text-[10px] font-black uppercase tracking-widest text-zinc-600">{category}</span>
                        <span className="text-[9px] font-mono text-zinc-400">({files.length})</span>
                      </div>
                      <svg className={`w-3 h-3 text-zinc-400 transition-transform ${expandedCategory === category ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    
                    {expandedCategory === category && (
                      <div className="flex flex-col gap-4 animate-in fade-in slide-in-from-top-2 duration-300">
                        {files.map((file) => {
                          const originalDisplayName = file.name.replace(/\.fbx$/i, '');
                          const cleanFileName = originalDisplayName.replace(/_/g, ' ').replace(/-/g, ' ');
                          const normalizedName = originalDisplayName.trim().toLowerCase();
                          const translation = translatedModels[normalizedName];
                          const displayName = translation?.name || apiTitles[normalizedName] || cleanFileName;

                          // Prioritize textures that match the model name and contain "preview"
                          const thumbnail = r2Textures.find(t => {
                            const lowTex = t.name.toLowerCase();
                            const lowModel = originalDisplayName.toLowerCase();
                            return lowTex.startsWith(lowModel) && lowTex.includes('preview');
                          }) || r2Textures.find(t => t.name.toLowerCase().startsWith(originalDisplayName.toLowerCase()));

                          const isOutOfStock = inventory[normalizedName] === 0;
                          const description = translation?.description || descriptions[normalizedName];

                          return (
                            <div 
                              key={file.key}
                              onMouseEnter={(e) => {
                                if (isMobile) return;
                                const rect = e.currentTarget.getBoundingClientRect();
                                setHoveredProduct({
                                  name: displayName,
                                  description: description || '',
                                  image: thumbnail?.url || null,
                                  inventory: inventory[normalizedName],
                                  rect
                                });
                              }}
                              onMouseLeave={() => setHoveredProduct(null)}
                              onClick={(e) => {
                                if (isOutOfStock) {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  return;
                                }
                                onAddFromUrl(file.url, file.name);
                              }}
                               className={`flex flex-row gap-2 p-1.5 bg-white rounded-2xl border border-black/5 transition-all group shadow-sm overflow-hidden relative items-start hover:scale-[1.02] active:scale-[0.98] ${
                                 isOutOfStock ? 'cursor-not-allowed opacity-70' : 'hover:bg-yellow-50 hover:border-yellow-200 cursor-pointer'
                               }`}
                             >
                               {/* Out of Stock Overlay */}
                               {isOutOfStock && (
                                 <div className="absolute inset-0 z-50 pointer-events-auto flex items-center justify-center bg-zinc-100/60 backdrop-grayscale cursor-not-allowed">
                                   <div className="w-[150%] h-[2px] bg-red-500/60 rotate-45 absolute" />
                                   <div className="w-[150%] h-[2px] bg-red-500/60 -rotate-45 absolute" />
                                   <div className="bg-zinc-800 text-white text-[8px] font-black uppercase tracking-[0.2em] px-3 py-1.5 rounded-lg shadow-2xl z-[60] border border-white/20">
                                     {t.outOfStock}
                                   </div>
                                 </div>
                               )}
 
                               {/* Preview Image - Side by side */}
                               <div className="shrink-0">
                                 <div className="w-12 h-12 bg-zinc-50 rounded-xl relative overflow-hidden border border-black/5">
                                  {thumbnail ? (
                                    <img 
                                      src={thumbnail.url} 
                                      alt={displayName}
                                      className={`w-full h-full object-cover transition-transform duration-500 ${!isOutOfStock && 'group-hover:scale-110'}`}
                                      referrerPolicy="no-referrer"
                                    />
                                  ) : (
                                    <div className="w-full h-full flex items-center justify-center bg-zinc-50">
                                      <svg className="w-6 h-6 text-zinc-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                                      </svg>
                                    </div>
                                  )}
                                </div>
                              </div>

                              <div className="flex flex-col gap-1 min-w-0 flex-1">
                                <span className={`text-[12px] font-black uppercase tracking-wider transition-colors leading-tight ${
                                  isOutOfStock ? 'text-zinc-400 line-through decoration-red-500/50 decoration-2' : 'text-zinc-800 group-hover:text-yellow-600'
                                }`}>
                                  {displayName}
                                </span>
                                {description && (
                                  <p className="text-[11px] text-zinc-500 font-medium leading-relaxed line-clamp-3">
                                    {description}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>

      {/* PRODUCT PREVIEW TOOLTIP */}
      {hoveredProduct && createPortal(
        <div 
          className="fixed z-[9999] pointer-events-none transition-all duration-300 animate-in fade-in zoom-in-95"
          style={{
            top: Math.min(hoveredProduct.rect.top, window.innerHeight - 400),
            left: isRTL 
              ? hoveredProduct.rect.left + hoveredProduct.rect.width + 10
              : hoveredProduct.rect.left - 310, 
            width: '300px',
          }}
        >
          <div className="bg-white/98 backdrop-blur-3xl rounded-[2rem] border border-black/10 shadow-[0_30px_100px_rgba(0,0,0,0.25)] overflow-hidden flex flex-col p-4 gap-3">
            <div className="aspect-[4/3] w-full bg-zinc-50 rounded-[1.5rem] overflow-hidden border border-black/5">
              {hoveredProduct.image ? (
                <img 
                  src={hoveredProduct.image} 
                  alt={hoveredProduct.name}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <svg className="w-10 h-10 text-zinc-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
              )}
            </div>
            
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className={`text-[9px] font-black uppercase tracking-[0.2em] text-yellow-600 leading-none ${isRTL ? 'text-end' : ''}`}>
                  {t.productInfo}
                </span>
                <h3 className={`text-lg font-black text-zinc-900 leading-tight uppercase tracking-tight ${isRTL ? 'text-end' : ''}`}>
                  {hoveredProduct.name}
                </h3>
              </div>
              
              {hoveredProduct.description && (
                <p className={`text-xs text-zinc-500 font-medium leading-relaxed line-clamp-4 ${isRTL ? 'text-end' : ''}`}>
                  {hoveredProduct.description}
                </p>
              )}

              <div className={`flex items-center justify-between pt-2 border-t border-black/5 mt-1 ${isRTL ? 'flex-row-reverse' : ''}`}>
                <div className={`flex items-center gap-1.5 ${isRTL ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${(hoveredProduct.inventory || 0) > 0 ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-red-500'}`} />
                  <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-widest">
                    {(hoveredProduct.inventory || 0) > 0 ? t.inStock : t.outOfStock}
                  </span>
                </div>
                {hoveredProduct.inventory !== undefined && (
                  <span className="text-[9px] font-mono text-zinc-400">{t.inStockCount}: {hoveredProduct.inventory}</span>
                )}
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

    </div>
  );
};

export default Sidebar;
