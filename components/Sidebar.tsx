
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
  catalogFiles: any[];
  isLoadingCatalog: boolean;
  cachedUrls?: Record<string, boolean>;
  prefetchSummary?: { loaded: number; total: number };
  isPrefetchPaused?: boolean;
  currentPrefetchFile?: string;
  onTogglePrefetchPause?: () => void;
  searchQuery?: string;
}

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

const stripHtmlTags = (str: string): string => {
  if (!str) return '';
  return str.replace(/<[^>]*>/g, '');
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

const Sidebar: React.FC<SidebarProps> = ({ 
  models, selectedId, onSelect, onAddFile, onRemove, onAddFromUrl, language, isMobile = false,
  catalogFiles, isLoadingCatalog,
  cachedUrls = {},
  prefetchSummary = { loaded: 0, total: 0 },
  isPrefetchPaused = false,
  currentPrefetchFile = '',
  onTogglePrefetchPause = () => {},
  searchQuery = ''
}) => {
  const [r2Files, setR2Files] = React.useState<any[]>([]);
  const [r2Textures, setR2Textures] = React.useState<any[]>([]);
  const [isLoadingR2, setIsLoadingR2] = React.useState(false);
  const [r2Error, setR2Error] = React.useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = React.useState<string>('all');
  const [selectedSubCategory, setSelectedSubCategory] = React.useState<string>('all');
  const [inventory, setInventory] = React.useState<Record<string, number>>({});
  const [descriptions, setDescriptions] = React.useState<Record<string, string>>({});
  const [apiTitles, setApiTitles] = React.useState<Record<string, string>>({});
  const [apiCategories, setApiCategories] = React.useState<any[]>([]);
  const [displayStatus, setDisplayStatus] = React.useState<Record<string, boolean>>({});
  const [productToCategory, setProductToCategory] = React.useState<Record<string, string>>({});
  const [productToSubCategory, setProductToSubCategory] = React.useState<Record<string, string>>({});
  const [translatedModels, setTranslatedModels] = React.useState<Record<string, { name: string, description: string }>>({});
  const [translatedCategories, setTranslatedCategories] = React.useState<Record<string, string>>({});
  const [translatedSubCategories, setTranslatedSubCategories] = React.useState<Record<string, string>>({});

  const [productIds, setProductIds] = React.useState<Record<string, string>>({});
  const [likesCounts, setLikesCounts] = React.useState<Record<string, number>>({});
  const [viewsCounts, setViewsCounts] = React.useState<Record<string, number>>({});
  const [prices, setPrices] = React.useState<Record<string, number>>({});
  const [likedProducts, setLikedProducts] = React.useState<Record<string, boolean>>(() => {
    try {
      const saved = localStorage.getItem('liked_products_map');
      return saved ? JSON.parse(saved) : {};
    } catch {
      return {};
    }
  });

  const uploadTranslations = {
    en: {
      uploadTitle: "Upload Custom Model",
      uploadDesc: "Drag & drop your FBX file here, or click to browse",
      activeModel: "Active Loaded Model",
      removeModel: "Remove Model",
      onlyFBX: "Only .fbx format is supported",
    },
    he: {
      uploadTitle: "העלאת מודל אישי",
      uploadDesc: "גרור ושחרר קובץ FBX כאן, או לחץ לבחירת קובץ",
      activeModel: "מודל אישי טעון",
      removeModel: "הסר מודל",
      onlyFBX: "רק קבצי .fbx נתמכים במערכת",
    },
    ar: {
      uploadTitle: "تحميل نموذج مخصص",
      uploadDesc: "اسحب وأسقط ملف FBX هنا، أو انقر للتصفح",
      activeModel: "النموذج النشط",
      removeModel: "إزالة النموذج",
      onlyFBX: "صيغة .fbx فقط مدعومة",
    },
    ru: {
      uploadTitle: "Загрузить свою модель",
      uploadDesc: "Перетащите файл FBX сюда или нажмите для выбора",
      activeModel: "Активная модель",
      removeModel: "Удалить модель",
      onlyFBX: "Поддерживается только формат .fbx",
    }
  };

  const ut = uploadTranslations[language] || uploadTranslations['en'];
  const [isDragging, setIsDragging] = React.useState(false);
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    setUploadError(null);
    
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      if (file.name.toLowerCase().endsWith('.fbx')) {
        onAddFile(file);
      } else {
        setUploadError(ut.onlyFBX);
        setTimeout(() => setUploadError(null), 5000);
      }
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setUploadError(null);
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      if (file.name.toLowerCase().endsWith('.fbx')) {
        onAddFile(file);
      } else {
        setUploadError(ut.onlyFBX);
        setTimeout(() => setUploadError(null), 5000);
      }
    }
  };

  const toggleLike = async (e: React.MouseEvent, productName: string) => {
    e.stopPropagation();
    const normalizedName = productName.trim().toLowerCase();
    const pId = productIds[normalizedName];
    if (!pId) {
      console.warn(`Cannot like/dislike: NO productId found for ${productName}`);
      return;
    }

    const currentlyLiked = !!likedProducts[normalizedName];
    const newLikedState = !currentlyLiked;
    
    // Update local state and localStorage
    const updatedLikes = { ...likedProducts, [normalizedName]: newLikedState };
    setLikedProducts(updatedLikes);
    localStorage.setItem('liked_products_map', JSON.stringify(updatedLikes));

    // Optimistic UI updates
    setLikesCounts(prev => ({
      ...prev,
      [normalizedName]: Math.max(0, (prev[normalizedName] ?? 0) + (newLikedState ? 1 : -1))
    }));

    // Send API Call
    const endpoint = `/api/products/${pId}/${newLikedState ? 'like' : 'dislike'}`;
    try {
      console.log(`Sending like trigger to: ${endpoint}`);
      const res = await fetch(endpoint, { method: 'PUT' });
      if (res.ok) {
        console.log(`Successfully sent ${newLikedState ? 'like' : 'dislike'} for ${productName}`);
        const updatedProduct = await res.json();
        const serverLikes = updatedProduct.likesCount ?? updatedProduct.LikesCount ?? 0;
        setLikesCounts(prev => ({ ...prev, [normalizedName]: serverLikes }));
      } else {
        console.warn(`Failed to send like update for ${productName}`);
      }
    } catch (err) {
      console.warn(`Error sending like update for ${productName}:`, err);
    }
  };

  const [hoveredProduct, setHoveredProduct] = React.useState<{
    name: string;
    description: string;
    image: string | null;
    inventory: number | undefined;
    rect: DOMRect;
    price?: number;
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
      console.warn(`Failed to fetch inventory for ${productName}:`, err);
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
              const apiTitle = cleanEscapedQuotes(result.productDisplayTitle || result.productTitle || result.title || result.name || '');
              const desc = cleanEscapedQuotes(result.productDescription || result.description || '');
              
              const pId = result.productId || result.id || result.ProductId;
              if (pId) {
                setProductIds(prev => ({ ...prev, [normalizedName]: String(pId) }));
              }

              const priceVal = result.productPrice !== undefined ? result.productPrice : result.price;
              if (priceVal !== undefined && priceVal !== null) {
                setPrices(prev => ({ ...prev, [normalizedName]: Number(priceVal) }));
              }

              const likes = result.likesCount ?? result.LikesCount ?? 0;
              setLikesCounts(prev => ({ ...prev, [normalizedName]: likes }));

              const views = result.viewsCount ?? result.ViewsCount ?? 0;
              setViewsCounts(prev => ({ ...prev, [normalizedName]: views }));
              
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

              const subCategory = result.productSubCategory || result.subCategory || result.subcategory || '';
              if (subCategory) {
                setProductToSubCategory(prev => ({ ...prev, [normalizedName]: subCategory }));
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
          console.warn("Failed to parse product JSON:", jsonErr);
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
      console.warn("Fetch error for product:", err);
      setDisplayStatus(prev => ({ ...prev, [normalizedName]: false }));
    }
  };

  const fetchCategories = async () => {
    try {
      const res = await fetch('/api/categories/tenantA');
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setApiCategories(data);
        }
      }
    } catch (err) {
      console.warn("Failed to fetch categories:", err);
    }
  };


  const fetchCatalogFiles = async () => {
    setIsLoadingR2(true);
    setR2Error(null);
    try {
      console.log("Fetching textures catalog from Azure...");
      // We only need to fetch textures here, models come from props
      const texturesRes = await fetch('/api/files/get-files?folder=images&clientName=tenantA&v=3');
      const rawTexturesData = texturesRes.ok ? await texturesRes.json() : [];
      
      const getListData = (raw: any) => {
        if (Array.isArray(raw)) return raw;
        if (raw && typeof raw === 'object') {
          return raw.files || raw.items || raw.data || raw.images || raw.models || Object.values(raw).find(v => Array.isArray(v)) || [];
        }
        return [];
      };

      const texturesData = getListData(rawTexturesData);
      
      const extractItem = (item: any, sourceFolder: string) => {
        if (typeof item === 'string') return { key: item, name: item, url: item };
        const name = item.fileName || item.FileName || item.filename || item.Name || item.name || item.Title || item.title || "";
        const key = item.fullPath || item.FullPath || item.fullpath || item.Key || item.item_key || item.key || item.FilePath || name || "";
        
        let url = item.url || item.Url || "";
        if (!url) {
          if (sourceFolder === "images" || sourceFolder.toLowerCase().includes("image")) {
            url = `https://pub-721b92b9c051433d993f7185396e4c79.r2.dev/images/${encodeURIComponent(name)}`;
          } else {
            // Build the appropriate direct R2 public URL
            let r2Path = "";
            if (sourceFolder.startsWith("tenants")) {
              if (sourceFolder.includes("/")) {
                r2Path = `${sourceFolder}/${name}`;
              } else {
                r2Path = `tenants/tenantA/${name}`;
              }
            } else {
              r2Path = `${sourceFolder}/${name}`;
            }
            url = `https://pub-721b92b9c051433d993f7185396e4c79.r2.dev/${r2Path.split("/").map(encodeURIComponent).join("/")}`;
          }
        } else {
          // If the url exists but is not on the R2 public host, rewrite it to R2 public host
          if (!url.includes("pub-")) {
            let r2Path = "";
            if (sourceFolder === "images" || sourceFolder.toLowerCase().includes("image")) {
              r2Path = `images/${name}`;
            } else if (sourceFolder.startsWith("tenants")) {
              if (sourceFolder.includes("/")) {
                r2Path = `${sourceFolder}/${name}`;
              } else {
                r2Path = `tenants/tenantA/${name}`;
              }
            } else {
              r2Path = `${sourceFolder}/${name}`;
            }
            url = `https://pub-721b92b9c051433d993f7185396e4c79.r2.dev/${r2Path.split("/").map(encodeURIComponent).join("/")}`;
          }
        }
        return { key, name, url };
      };

      if (texturesData && texturesData.length > 0) {
        const imageExtensions = [".png", ".jpg", ".jpeg", ".webp", ".tga", ".dds", ".gif", ".bmp"];
        const textures = texturesData
          .map(item => extractItem(item, 'images'))
          .filter(f => {
            const name = f.name.toLowerCase();
            return imageExtensions.some(ext => name.endsWith(ext));
          });
          
        setR2Textures(textures);
      }
    } catch (err) {
      console.warn("Catalog Texture Fetch Error:", err);
    } finally {
      setIsLoadingR2(false);
    }
  };

  const fetchR2Files = fetchCatalogFiles;

  React.useEffect(() => {
    setR2Files(catalogFiles);
  }, [catalogFiles]);

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
  }, [language, r2Files, descriptions, apiTitles]);

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

    // Only return categories that actually contain products (filter out empty/administrative categories like Tenants or Products)
    const filteredGroups: Record<string, any[]> = {};
    Object.entries(groups).forEach(([cat, files]) => {
      if (files.length > 0) {
        filteredGroups[cat] = files;
      }
    });

    return filteredGroups;
  }, [visibleFiles, productToCategory, apiCategories]);

  React.useEffect(() => {
    setSelectedSubCategory('all');
  }, [selectedCategory]);

  const availableSubCategories = React.useMemo(() => {
    if (selectedCategory === 'all') {
      const subs = apiCategories
        .map(c => c.subCategory || c.subcategory)
        .filter(Boolean);
      return Array.from(new Set(subs));
    } else {
      const subs = apiCategories
        .filter(c => {
          const name = (c.categoryName || c.name || c.title || '').toString().toLowerCase();
          const id = (c.categoryId || c.id || '').toString().toLowerCase();
          const selected = selectedCategory.toLowerCase();
          return name === selected || id === selected;
        })
        .map(c => c.subCategory || c.subcategory)
        .filter(Boolean);
      return Array.from(new Set(subs));
    }
  }, [selectedCategory, apiCategories]);

  React.useEffect(() => {
    const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
    
    if (availableSubCategories.length === 0) return;

    const translateSubs = async () => {
      try {
        const { translateBatch } = await import('../services/ttsService');
        const translatedResults = await translateBatch(availableSubCategories, langName);
        
        const newTranslations: Record<string, string> = {};
        availableSubCategories.forEach((sub, idx) => {
          newTranslations[sub] = translatedResults[idx] || sub;
        });
        setTranslatedSubCategories(newTranslations);
      } catch (err) {
        console.error("Failed to translate subcategories:", err);
      }
    };

    translateSubs();
  }, [language, availableSubCategories]);

  React.useEffect(() => {
    const langName = language === 'he' ? 'Hebrew' : language === 'ar' ? 'Arabic' : language === 'ru' ? 'Russian' : 'English';
    
    const uniqueCategories = Object.keys(categories);
    if (uniqueCategories.length === 0) return;

    const translateCats = async () => {
      try {
        const { translateBatch } = await import('../services/ttsService');
        const translatedResults = await translateBatch(uniqueCategories, langName);
        
        const newTranslations: Record<string, string> = {};
        uniqueCategories.forEach((cat, idx) => {
          newTranslations[cat] = translatedResults[idx] || cat;
        });
        setTranslatedCategories(newTranslations);
      } catch (err) {
        console.error("Failed to translate categories:", err);
      }
    };

    translateCats();
  }, [language, categories]);

  const selectedModel = models.find(m => m.id === selectedId);

  const filteredProducts = React.useMemo(() => {
    let base = selectedCategory === 'all' ? visibleFiles : (categories[selectedCategory] || []);
    
    if (selectedSubCategory !== 'all') {
      base = base.filter(file => {
        const originalDisplayName = file.name.replace(/\.fbx$/i, '');
        const normalizedName = originalDisplayName.trim().toLowerCase();
        
        let subCategory = productToSubCategory[normalizedName] || '';
        if (!subCategory) {
          const prodCat = (productToCategory[normalizedName] || 'General').toLowerCase();
          const matchedCat = apiCategories.find(c => {
            const name = (c.categoryName || c.name || c.title || '').toString().toLowerCase();
            const id = (c.categoryId || c.id || '').toString().toLowerCase();
            return name === prodCat || id === prodCat;
          });
          if (matchedCat) {
            subCategory = matchedCat.subCategory || matchedCat.subcategory || '';
          }
        }
        return subCategory.toLowerCase() === selectedSubCategory.toLowerCase();
      });
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase().trim();
      base = base.filter(file => {
        const displayNameRaw = file.name.replace(/\.fbx$/i, '');
        const normalizedName = displayNameRaw.trim().toLowerCase();
        const translation = translatedModels[normalizedName];
        
        if (file.name.toLowerCase().includes(q)) return true;
        if (displayNameRaw.toLowerCase().includes(q)) return true;
        
        const apiTitle = apiTitles[normalizedName];
        if (apiTitle && apiTitle.toLowerCase().includes(q)) return true;
        
        const translatedTitle = translation?.name;
        if (translatedTitle && translatedTitle.toLowerCase().includes(q)) return true;
        
        return false;
      });
    }
    return base;
  }, [selectedCategory, selectedSubCategory, visibleFiles, categories, searchQuery, translatedModels, apiTitles, productToSubCategory, productToCategory, apiCategories]);

  return (
    <div className="w-full h-full flex flex-col p-2.5 sm:p-3 overflow-hidden select-none bg-white dark:bg-zinc-950" dir={isRTL ? 'rtl' : 'ltr'}>
      {/* Top row: Title, Refresh Button, and Categories scroll */}
      <div className="flex flex-row items-center justify-between gap-3 px-1 sm:px-3 mb-2 h-9 shrink-0">
        <div className="flex items-center gap-1.5 shrink-0">
          <div className="w-1.5 h-1.5 bg-orange-500 rounded-full animate-pulse"></div>
          <h2 className={`text-[11px] sm:text-[12px] font-black ${isRTL ? '' : 'uppercase'} ${isRTL ? 'tracking-normal' : 'tracking-wider'} text-zinc-800 dark:text-zinc-200`}>
            {t.productsCatalog}
          </h2>
          <button 
            onClick={fetchR2Files}
            className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded-lg text-zinc-400 hover:text-yellow-500 transition-all ml-1 shrink-0"
            title={language === 'he' ? 'רענן' : 'Refresh'}
          >
            <svg className={`w-3.5 h-3.5 ${isLoadingR2 ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Categories horizontal list */}
        <div className="flex-1 flex flex-row gap-1.5 overflow-x-auto overflow-y-hidden scrollbar-none py-0.5 px-1 items-center justify-start min-w-0" style={{ scrollbarWidth: 'none' }}>
          <button
            onClick={() => setSelectedCategory('all')}
            className={`px-3 py-1 text-[9px] sm:text-[10px] font-black uppercase tracking-wider rounded-lg transition-all whitespace-nowrap shrink-0 border ${
              selectedCategory === 'all'
                ? 'bg-yellow-500 text-zinc-950 border-yellow-500 shadow-sm font-black'
                : 'bg-zinc-100 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-200/60 border-transparent dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'
            }`}
          >
            {t.all}
          </button>
          {Object.keys(categories).map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1 text-[9px] sm:text-[10px] font-black uppercase tracking-wider rounded-lg transition-all whitespace-nowrap shrink-0 border ${
                selectedCategory === cat
                  ? 'bg-yellow-500 text-zinc-950 border-yellow-500 shadow-sm font-black'
                  : 'bg-zinc-100 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-200/60 border-transparent dark:bg-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-200 dark:hover:bg-zinc-800'
              }`}
            >
              {translatedCategories[cat] || cat}
              <span className="mx-1 text-[8px] font-mono opacity-50 inline-block" dir="ltr">({categories[cat]?.length || 0})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Subcategories Row */}
      {availableSubCategories.length > 0 && (
        <div className="flex flex-row items-center gap-2 px-1 sm:px-3 mb-2 h-8 shrink-0 border-t border-black/5 dark:border-white/5 pt-1.5" dir={isRTL ? 'rtl' : 'ltr'}>
          <span className="text-[8px] sm:text-[9px] font-black uppercase tracking-wider text-zinc-400 dark:text-zinc-500 shrink-0">
            {language === 'he' ? 'קטגוריה משנית:' : 'Subcategory:'}
          </span>
          <div className="flex-1 flex flex-row gap-1.5 overflow-x-auto overflow-y-hidden scrollbar-none py-0.5 items-center justify-start min-w-0" style={{ scrollbarWidth: 'none' }}>
            <button
              onClick={() => setSelectedSubCategory('all')}
              className={`px-2.5 py-0.5 text-[8px] sm:text-[9px] font-black uppercase tracking-wider rounded-md transition-all whitespace-nowrap shrink-0 border ${
                selectedSubCategory === 'all'
                  ? 'bg-yellow-500/20 text-yellow-700 border-yellow-500/30 dark:text-yellow-400 font-bold'
                  : 'bg-zinc-100 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/40 border-transparent dark:bg-zinc-900/50 dark:text-zinc-500 dark:hover:text-zinc-300'
              }`}
            >
              {t.all}
            </button>
            {availableSubCategories.map((sub) => (
              <button
                key={sub}
                onClick={() => setSelectedSubCategory(sub)}
                className={`px-2.5 py-0.5 text-[8px] sm:text-[9px] font-black uppercase tracking-wider rounded-md transition-all whitespace-nowrap shrink-0 border ${
                  selectedSubCategory === sub
                    ? 'bg-yellow-500/20 text-yellow-700 border-yellow-500/30 dark:text-yellow-400 font-bold'
                    : 'bg-zinc-100 text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200/40 border-transparent dark:bg-zinc-900/50 dark:text-zinc-500 dark:hover:text-zinc-300'
                }`}
              >
                {translatedSubCategories[sub] || sub}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Bottom row: Horizontal scrolling cards */}
      <div className="flex-1 min-h-0 relative overflow-hidden">
        {isLoadingR2 ? (
          <div className="flex items-center justify-center h-full">
            <div className="w-5 h-5 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : r2Error ? (
          <div className="text-[10px] text-red-500 font-bold text-center py-4">{r2Error}</div>
        ) : r2Files.length === 0 ? (
          <div className="text-[10px] text-zinc-400 font-bold text-center py-4 italic">{t.noAssetsFound}</div>
        ) : (
          <div className="w-full h-full flex flex-row gap-3 overflow-x-auto overflow-y-hidden custom-scroll items-center pb-1 px-1.5 scrollbar-thin select-none">
            {filteredProducts.length === 0 ? (
              <div className="text-[10px] text-zinc-400 font-bold text-center py-4 italic w-full">
                {t.noAssetsFound}
              </div>
            ) : (
              filteredProducts.map((file) => {
                const originalDisplayName = file.name.replace(/\.fbx$/i, '');
                const cleanFileName = originalDisplayName.replace(/_/g, ' ').replace(/-/g, ' ');
                const normalizedName = originalDisplayName.trim().toLowerCase();
                const translation = translatedModels[normalizedName];
                const displayName = translation?.name || apiTitles[normalizedName] || cleanFileName;
                
                const thumbnail = r2Textures.find(t => {
                  return isModelTextureMatch(t.name, originalDisplayName) && t.name.toLowerCase().includes('preview');
                }) || r2Textures.find(t => isModelTextureMatch(t.name, originalDisplayName));
                
                const isOutOfStock = inventory[normalizedName] === 0;
                const description = translation?.description || descriptions[normalizedName];
                const isSelected = selectedId === file.id || selectedModel?.url === file.url;

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
                        rect,
                        price: prices[normalizedName]
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
                    className={`flex flex-row gap-2.5 p-2 bg-zinc-50/70 dark:bg-zinc-900/60 border rounded-2xl transition-all group shadow-sm overflow-hidden relative items-center hover:scale-[1.02] active:scale-[0.98] w-[230px] sm:w-[250px] h-[86px] shrink-0 cursor-pointer ${
                      isSelected 
                        ? 'border-yellow-500 bg-yellow-50/20 dark:bg-yellow-500/10 font-bold' 
                        : isOutOfStock 
                          ? 'cursor-not-allowed opacity-70 border-black/5 bg-zinc-100/50' 
                          : 'border-black/5 dark:border-white/5 hover:bg-yellow-50/40 dark:hover:bg-yellow-500/5 hover:border-yellow-200'
                    }`}
                  >
                    {isOutOfStock && (
                      <div className="absolute inset-0 z-50 pointer-events-auto flex items-center justify-center bg-zinc-100/60 dark:bg-zinc-900/60 backdrop-grayscale cursor-not-allowed">
                        <div className="w-[150%] h-[1px] bg-red-500/30 rotate-[15deg] absolute" />
                        <div className="w-[150%] h-[1px] bg-red-500/30 -rotate-[15deg] absolute" />
                        <div className="bg-zinc-800 text-white text-[8px] font-black uppercase tracking-[0.2em] px-2 py-1 rounded-md shadow-lg z-[60] border border-white/10">
                          {t.outOfStock}
                        </div>
                      </div>
                    )}

                    <div className="shrink-0">
                      <div className="w-[64px] h-[64px] bg-white dark:bg-zinc-800 rounded-xl relative overflow-hidden border border-black/5 dark:border-white/5">
                        {thumbnail ? (
                          <img 
                            src={thumbnail.url} 
                            alt={displayName}
                            className={`w-full h-full object-cover transition-transform duration-500 ${!isOutOfStock && 'group-hover:scale-110'}`}
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center bg-zinc-50 dark:bg-zinc-800">
                            <svg className="w-5 h-5 text-zinc-300 dark:text-zinc-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                            </svg>
                          </div>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1 w-full">
                        <span className={`text-[11px] font-black uppercase tracking-wider transition-colors leading-tight truncate ${
                          isOutOfStock ? 'text-zinc-400 line-through decoration-red-500/50 decoration-2' : isSelected ? 'text-yellow-600 dark:text-yellow-500' : 'text-zinc-800 dark:text-zinc-200 group-hover:text-yellow-600 dark:group-hover:text-yellow-500'
                        }`}>
                          {displayName}
                        </span>
                        
                        {/* Like Emoji Button */}
                        {productIds[normalizedName] && (
                          <button
                            onClick={(e) => toggleLike(e, originalDisplayName)}
                            className="p-1 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-all focus:outline-none shrink-0"
                            title={likedProducts[normalizedName] ? 'הסר לייק' : 'לייק'}
                          >
                            <span className={`inline-block text-[12px] transition-all duration-300 ${
                              likedProducts[normalizedName] 
                                ? 'scale-[1.2] filter-none opacity-100 animate-pulse' 
                                : 'opacity-40 grayscale hover:opacity-80 scale-100'
                            }`}>
                              ❤️
                            </span>
                          </button>
                        )}
                      </div>
                      <div className="flex items-center justify-between gap-1.5 w-full mt-0.5">
                        {description ? (
                          <div 
                            className="text-[10px] text-zinc-500 dark:text-zinc-400 font-medium leading-tight line-clamp-1 flex-1"
                            dangerouslySetInnerHTML={{ __html: description }}
                          />
                        ) : (
                          <div className="flex-1" />
                        )}
                        {prices[normalizedName] !== undefined && (
                          <span className="text-[10px] font-black text-yellow-600 dark:text-yellow-500 shrink-0 bg-yellow-500/5 dark:bg-yellow-500/10 px-1.5 py-0.5 rounded-md border border-yellow-500/10 dark:border-yellow-500/20 leading-none">
                            ₪{prices[normalizedName].toLocaleString()}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      {/* PRODUCT PREVIEW TOOLTIP */}
      {hoveredProduct && createPortal(
        <div 
          className="fixed z-[9999] pointer-events-none transition-all duration-300 animate-in fade-in zoom-in-95"
          style={{
            top: Math.max(16, hoveredProduct.rect.top - 290),
            left: Math.max(16, Math.min(window.innerWidth - 320, hoveredProduct.rect.left + (hoveredProduct.rect.width - 300) / 2)),
            width: '300px',
          }}
        >
          <div className="bg-white/98 dark:bg-zinc-900/98 backdrop-blur-3xl rounded-[2rem] border border-black/10 dark:border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.2)] overflow-hidden flex flex-col p-4 gap-3">
            <div className="aspect-[4/3] w-full bg-zinc-50 dark:bg-zinc-800 rounded-[1.5rem] overflow-hidden border border-black/5 dark:border-white/5">
              {hoveredProduct.image ? (
                <img 
                  src={hoveredProduct.image} 
                  alt={hoveredProduct.name}
                  className="w-full h-full object-cover"
                  referrerPolicy="no-referrer"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <svg className="w-10 h-10 text-zinc-200 dark:text-zinc-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.5" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                </div>
              )}
            </div>
            
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <div className={`flex items-center justify-between ${isRTL ? 'flex-row-reverse' : ''}`}>
                  <span className="text-[9px] font-black uppercase tracking-[0.2em] text-yellow-600 dark:text-yellow-500 leading-none">
                    {t.productInfo}
                  </span>
                  {hoveredProduct.price !== undefined && (
                    <span className="text-xs sm:text-sm font-black text-yellow-600 dark:text-yellow-500">
                      ₪{hoveredProduct.price.toLocaleString()}
                    </span>
                  )}
                </div>
                <h3 className={`text-lg font-black text-zinc-900 dark:text-zinc-100 leading-tight uppercase tracking-tight ${isRTL ? 'text-end' : ''}`}>
                  {hoveredProduct.name}
                </h3>
              </div>
              
              {hoveredProduct.description && (
                <div 
                  className={`text-xs text-zinc-500 dark:text-zinc-400 font-medium leading-relaxed line-clamp-4 ${isRTL ? 'text-end' : ''}`}
                  dangerouslySetInnerHTML={{ __html: hoveredProduct.description }}
                />
              )}

              <div className={`flex items-center justify-between pt-2 border-t border-black/5 dark:border-white/5 mt-1 ${isRTL ? 'flex-row-reverse' : ''}`}>
                <div className={`flex items-center gap-1.5 ${isRTL ? 'flex-row-reverse' : ''}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${(hoveredProduct.inventory || 0) > 0 ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.4)]' : 'bg-red-500'}`} />
                  <span className="text-[9px] font-bold text-zinc-500 dark:text-zinc-400 uppercase tracking-widest">
                    {(hoveredProduct.inventory || 0) > 0 ? t.inStock : t.outOfStock}
                  </span>
                </div>
                {hoveredProduct.inventory !== undefined && (
                  <span className="text-[9px] font-mono text-zinc-400 dark:text-zinc-500">{t.inStockCount}: {hoveredProduct.inventory}</span>
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
