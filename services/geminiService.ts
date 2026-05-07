
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export const suggestMaterials = async (modelDescription: string) => {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Suggest physically accurate PBR material settings for a 3D model described as: "${modelDescription}". Return suggestions for Opacity, Metalness, and Roughness.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          opacity: { type: Type.NUMBER, description: "Transparency level (0-1)" },
          metalness: { type: Type.NUMBER, description: "Metalness level (0-1)" },
          roughness: { type: Type.NUMBER, description: "Roughness level (0-1)" },
          explanation: { type: Type.STRING, description: "Brief reason for these settings" }
        },
        required: ["opacity", "metalness", "roughness", "explanation"]
      }
    }
  });

  try {
    const text = response.text;
    if (!text) return null;
    return JSON.parse(text.trim());
  } catch (e) {
    console.error("Failed to parse Gemini response", e);
    return null;
  }
};

/**
 * Generates a creative and professional description for a specific part of a 3D model.
 */
export const generateHotspotDescription = async (partName: string, modelName: string) => {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: `You are a world-class architectural critic and 3D design expert. 
      Generate a short, professional, and inspiring one-sentence description for the component named "${partName}" which is part of a larger 3D model: "${modelName}". 
      The description MUST be in Hebrew (עברית) and focus on design aesthetics, material quality, or structural significance. 
      Do not include the part name in the description. Make it sound elegant.`,
    });
    return response.text?.trim() || "חלק מעוצב התורם לאסתטיקה הכללית של המודל.";
  } catch (e) {
    console.error("Gemini Description Error:", e);
    return "חלק מעוצב ואיכותי כחלק מהקומפוזיציה הכוללת.";
  }
};
