
export type Language = 'en' | 'he' | 'ar' | 'ru';

export interface Translations {
  all: string;
  categories: string;
  searchAssets: string;
  noAssetsFound: string;
  variant: string;
  default: string;
  nightMode: string;
  dayMode: string;
  lightsOn: string;
  lightsOff: string;
  zoomIn: string;
  zoomOut: string;
  resetView: string;
  playAnimation: string;
  stopAnimation: string;
  productsCatalog: string;
  settings: string;
  initializing: string;
  processingAsset: string;
  refreshTextures: string;
  outOfStock: string;
  translating: string;
  partDetails: string;
  productInfo: string;
  productDescription: string;
  loading: string;
  noDescription: string;
  viewDetails: string;
  modelParts: string;
  labelPartKey: string;
  labelPartName: string;
  labelPartDescription: string;
  inStock: string;
  inStockCount: string;
  flipY: string;
  wireframe: string;
  textureResolution?: string;
  textureAnisotropy?: string;
}

export const translations: Record<Language, Translations> = {
  en: {
    all: "All",
    categories: "Categories",
    searchAssets: "Search assets...",
    noAssetsFound: "No assets found",
    variant: "Variant",
    default: "Default",
    nightMode: "Night Mode",
    dayMode: "Day Mode",
    lightsOn: "Lights On",
    lightsOff: "Lights Off",
    zoomIn: "Zoom In",
    zoomOut: "Zoom Out",
    resetView: "Reset View",
    playAnimation: "Play Animation",
    stopAnimation: "Stop Animation",
    productsCatalog: "Products Catalog",
    settings: "Settings",
    initializing: "Initializing...",
    processingAsset: "Processing Asset...",
    refreshTextures: "Refresh Textures",
    outOfStock: "Out of Stock",
    translating: "Translating...",
    partDetails: "Part Details",
    productInfo: "Product Info",
    productDescription: "Product Description",
    loading: "Loading...",
    noDescription: "No description available",
    viewDetails: "View Details",
    modelParts: "Relateble",
    labelPartKey: "Key",
    labelPartName: "Name",
    labelPartDescription: "Description",
    inStock: "In Stock",
    inStockCount: "Qty",
    flipY: "Flip UV (Y-Axis)",
    wireframe: "Wireframe mode",
    textureResolution: "Texture Quality / Resolution",
    textureAnisotropy: "Anisotropic Filtering (Sharpness)",
  },
  he: {
    all: "הכל",
    categories: "קטגוריות",
    searchAssets: "חיפוש נכסים...",
    noAssetsFound: "לא נמצאו נכסים",
    variant: "גרסה",
    default: "ברירת מחדל",
    nightMode: "מצב לילה",
    dayMode: "מצב יום",
    lightsOn: "תאורה דולקת",
    lightsOff: "תאורה כבויה",
    zoomIn: "זום פנימה",
    zoomOut: "זום החוצה",
    resetView: "איפוס מבט",
    playAnimation: "הפעל אנימציה",
    stopAnimation: "עצור אנימציה",
    productsCatalog: "קטלוג מוצרים",
    settings: "הגדרות",
    initializing: "מאתחל...",
    processingAsset: "מעבד נכס...",
    refreshTextures: "רענן טקסטורות",
    outOfStock: "אזל מהמלאי",
    translating: "מתרגם...",
    partDetails: "פרטי חלק",
    productInfo: "מידע על המוצר",
    productDescription: "תיאור מוצר",
    loading: "טוען...",
    noDescription: "אין פירוט",
    viewDetails: "צפה בפרטים",
    modelParts: "חלקים קשורים",
    labelPartKey: "מפתח",
    labelPartName: "שם",
    labelPartDescription: "תיאור",
    inStock: "במלאי",
    inStockCount: "כמות",
    flipY: "היפוך ציר Y של הטקסטורה (UV)",
    wireframe: "תצוגת רשת קווים (Wireframe)",
    textureResolution: "איכות ורזולוציית טקסטורות",
    textureAnisotropy: "סינון אנאיזוטרופי (חדות וטשטוש)",
  },
  ar: {
    all: "الكل",
    categories: "الفئات",
    searchAssets: "البحث عن الأصول...",
    noAssetsFound: "لم يتم العثور على أصول",
    variant: "البديل",
    default: "افتراضي",
    nightMode: "وضع الليل",
    dayMode: "وضع النهار",
    lightsOn: "الأضواء تعمل",
    lightsOff: "الأضواء مطفأة",
    zoomIn: "تكبير",
    zoomOut: "تصغير",
    resetView: "إعادة ضبط العرض",
    playAnimation: "تشغيل الرسوم المتحركة",
    stopAnimation: "إيقاف الرسوم المتحركة",
    productsCatalog: "كتالوج المنتجات",
    settings: "الإعدادات",
    initializing: "جاري التهيئة...",
    processingAsset: "جاري معالجة الأصل...",
    refreshTextures: "تحديث الأنسجة",
    outOfStock: "نفدت الكمية",
    translating: "جاري الترجمة...",
    partDetails: "تفاصيل الجزء",
    productInfo: "معلومات المنتج",
    productDescription: "وصف المنتج",
    loading: "جاري التحميل...",
    noDescription: "لا يوجد وصف متاح",
    viewDetails: "عرض التفاصيل",
    modelParts: "أجزاء ذات صلة",
    labelPartKey: "مفتاح",
    labelPartName: "اسم",
    labelPartDescription: "وصف",
    inStock: "في المخزن",
    inStockCount: "الكمية",
    flipY: "عكس الـ UV (محور Y)",
    wireframe: "مظهر شبكي (Wireframe)",
    textureResolution: "دقة وجودة الأنسجة",
    textureAnisotropy: "تصفية تباين الاتجاهات (مستوى الحدوة)",
  },
  ru: {
    all: "Все",
    categories: "Категории",
    searchAssets: "Поиск ресурсов...",
    noAssetsFound: "Ресурсы не найдены",
    variant: "Вариант",
    default: "По умолчанию",
    nightMode: "Ночной режим",
    dayMode: "Дневной режим",
    lightsOn: "Свет включен",
    lightsOff: "Свет выключен",
    zoomIn: "Увеличить",
    zoomOut: "Уменьшить",
    resetView: "Сбросить вид",
    playAnimation: "Запустить анимацию",
    stopAnimation: "Остановить анимацию",
    productsCatalog: "Каталог товаров",
    settings: "Настройки",
    initializing: "Инициализация...",
    processingAsset: "Обработка ресурса...",
    refreshTextures: "Обновить текстуры",
    outOfStock: "Нет в наличии",
    translating: "Перевод...",
    partDetails: "Детали детали",
    productInfo: "Информация о продукте",
    productDescription: "Описание продукта",
    loading: "Загрузка...",
    noDescription: "Описание отсутствует",
    viewDetails: "Посмотреть детали",
    modelParts: "Связанные части",
    labelPartKey: "Ключ",
    labelPartName: "Имя",
    labelPartDescription: "Описание",
    inStock: "В наличии",
    inStockCount: "Кол-во",
    flipY: "Зеркально UV (ось Y)",
    wireframe: "Каркасный вид (Wireframe)",
    textureResolution: "Качество и разрешение текстур",
    textureAnisotropy: "Анизотропная фильтрация (Резкость)",
  },
};
