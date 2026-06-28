import React, { useEffect, useMemo, useState, useRef } from 'react';
import { useLoader, useFrame } from '@react-three/fiber';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader.js';
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader.js';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import * as SkeletonUtils from 'three/examples/jsm/utils/SkeletonUtils.js';
import '../types';
import { MaterialSettings, ModelPart, TextureSet } from '../types';

const R2_PUBLIC_BASE_URL = 'https://pub-721b92b9c051433d993f7185396e4c79.r2.dev/';
const R2_PROXY_BASE_URL = '';

function safeDecodeRepeated(value: string): string {
  let current = value;
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

function buildR2PublicUrl(key: string): string {
  const decodedKey = safeDecodeRepeated(key.replace(/^\/+/, ''));
  // Ensure we don't end up with double slashes
  const baseUrl = R2_PUBLIC_BASE_URL.endsWith('/') ? R2_PUBLIC_BASE_URL : `${R2_PUBLIC_BASE_URL}/`;
  return `${baseUrl}${decodedKey}`;
}

function normalizeTextureLoadUrl(url: string): string {
  if (!url || typeof url !== 'string') return url;

  try {
    const parsed = new URL(url, 'https://local.invalid');
    if (parsed.pathname === '/api/r2/proxy') {
      const key = parsed.searchParams.get('key');
      if (key) return buildR2PublicUrl(key);
    }
  } catch {
    // Keep original URL when it is not parseable.
  }

  return url;
}

/**
 * Automatically generates planar/box UV coordinates based on dominant normals for geometries that lack them
 * or have dummy/corrupted UV coordinates (all zero or all identical) to prevent rendering them completely black.
 */
function ensureUVs(geometry: THREE.BufferGeometry) {
  if (!geometry || !geometry.attributes) return;

  const positionAttribute = geometry.attributes.position;
  if (!positionAttribute) return;

  const uvAttr = geometry.attributes.uv;
  if (uvAttr && uvAttr.count > 0) return; // Always preserve original artist UV coordinates when present!

  console.log(`[FBXModel] 🛠️ Generating missing UV coordinates for geometry`);
  const count = positionAttribute.count;
  const uvs = new Float32Array(count * 2);

  // Compute bounding box to know the dimensions for normalization
  if (!geometry.boundingBox) {
    geometry.computeBoundingBox();
  }
  const bbox = geometry.boundingBox || new THREE.Box3();
  const min = bbox.min;
  const max = bbox.max;
  
  const width = Math.max(max.x - min.x, 0.0001);
  const height = Math.max(max.y - min.y, 0.0001);
  const depth = Math.max(max.z - min.z, 0.0001);

  const normalAttr = geometry.attributes.normal;

  for (let i = 0; i < count; i++) {
    const x = positionAttribute.getX(i);
    const y = positionAttribute.getY(i);
    const z = positionAttribute.getZ(i);

    // Default normal points up (along Y-axis)
    let nx = 0, ny = 1, nz = 0;
    if (normalAttr) {
      nx = Math.abs(normalAttr.getX(i));
      ny = Math.abs(normalAttr.getY(i));
      nz = Math.abs(normalAttr.getZ(i));
    }

    let u = 0;
    let v = 0;

    // Smart tri-planar projection: select plane based on the dominant axis of the vertex normal
    if (nx >= ny && nx >= nz) {
      // Normal points mostly in X direction -> project on Y-Z plane
      u = (y - min.y) / height;
      v = (z - min.z) / depth;
    } else if (ny >= nx && ny >= nz) {
      // Normal points mostly in Y direction -> project on X-Z plane
      u = (x - min.x) / width;
      v = (z - min.z) / depth;
    } else {
      // Normal points mostly in Z direction -> project on X-Y plane
      u = (x - min.x) / width;
      v = (y - min.y) / height;
    }

    uvs[i * 2] = u;
    uvs[i * 2 + 1] = v;
  }

  geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  if (geometry.attributes.uv) {
    geometry.attributes.uv.needsUpdate = true;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// Matching & UDIM helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Detects the UDIM tile of a THREE.BufferGeometry based on its average UV coordinates.
 * Returns a number matching standard UDIM format (1001-1100), or null if unable to detect.
 */
function detectUDIMTile(geometry: THREE.BufferGeometry): number | null {
  if (!geometry || !geometry.attributes || !geometry.attributes.uv) {
    return null;
  }
  const uv = geometry.attributes.uv;
  if (uv.count === 0) return null;

  let sumU = 0;
  let sumV = 0;
  let validCount = 0;
  const sampleCount = Math.min(uv.count, 200);

  for (let i = 0; i < sampleCount; i++) {
    const u = uv.getX(i);
    const v = uv.getY(i);
    if (isNaN(u) || isNaN(v)) continue;
    sumU += u;
    sumV += v;
    validCount++;
  }

  if (validCount === 0) return null;

  const avgU = sumU / validCount;
  const avgV = sumV / validCount;

  // Standard UDIM tile calculation: 1001 + floor(u) + 10 * floor(v)
  const floorU = Math.max(0, Math.floor(avgU));
  const floorV = Math.max(0, Math.floor(avgV));

  const tile = 1001 + floorU + (floorV * 10);
  if (tile >= 1001 && tile <= 1100) {
    return tile;
  }
  return null;
}

/**
 * Extracts a UDIM tile ID (1001-1100) from a URL or filename string.
 */
function extractUDIMFromUrl(url: string | undefined): number | null {
  if (!url) return null;
  // Look for .1011. or _1011_ or similar UDIM markers in file name
  const match = url.match(/[._-](10\d{2})[._-]/) || url.match(/(10\d{2})/);
  if (match) {
    const val = parseInt(match[1], 10);
    if (val >= 1001 && val <= 1100) return val;
  }
  return null;
}

/**
 * Extracts UDIM tile for a whole TextureSet by looking up any defined map URLs.
 */
function getTextureSetUDIM(set: TextureSet): number | null {
  const mapKeys: Array<keyof TextureSet> = [
    'baseColor', 'normal', 'metalness', 'roughness', 
    'alpha', 'emissive', 'ao', 'height'
  ];
  for (const k of mapKeys) {
    const val = set[k];
    if (typeof val === 'string') {
      const udim = extractUDIMFromUrl(val);
      if (udim !== null) return udim;
    }
  }
  return null;
}

/**
 * Returns true when `name` matches at least one pattern in `targets`.
 * Patterns support a simple wildcard (*).
 */
function matchesAny(name: string, targets: string[]): boolean {
  const n = name.toLowerCase().trim();
  return targets.some((pattern) => {
    const p = pattern.toLowerCase().trim();
    if (p === '*') return true;
    if (!p.includes('*')) return n === p || n.includes(p);
    // convert glob to regex: escape dots, replace * with .*
    const re = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    return re.test(n);
  });
}

/**
 * For a given mesh or material name, finds the best-matching TextureSet.
 * Priority: UDIM tile alignment > exact name > partial include > wildcard fallback.
 * Returns null when nothing matches.
 */
function resolveBestSet(
  meshName: string,
  matName: string,
  sets: TextureSet[],
  geometry?: THREE.BufferGeometry
): TextureSet | null {
  let best: TextureSet | null = null;
  let bestScore = 0;

  const geomUDIM = geometry ? detectUDIMTile(geometry) : null;

  const normalizeWord = (w: string) => {
    let s = w.toLowerCase().trim();
    if (s.startsWith('p')) {
      if (s.startsWith('pgolden')) s = s.slice(1); // golden
      else if (s.startsWith('pgold')) s = s.slice(1); // gold
      else if (s.startsWith('psilvers')) s = s.slice(1); // silvers
      else if (s.startsWith('psilver')) s = s.slice(1); // silver
      else if (s.startsWith('pwooden')) s = s.slice(1); // wooden
      else if (s.startsWith('pblue')) s = s.slice(1); // blue
    }
    s = s
      .replace(/golden/g, 'gold')
      .replace(/silvers/g, 'silver')
      .replace(/wooden/g, 'wood')
      .replace(/handel/g, 'handle')
      .replace(/middel/g, 'middle')
      .replace(/colour/g, 'color');
    return s;
  };

  const getNormalizedWords = (name: string) => {
    const rawWords = name
      .replace(/([a-z])([A-Z])/g, '$1_$2') // Split camelCase
      .split(/[\s\-_.]+/)
      .map(w => w.trim().toLowerCase())
      .filter(w => w !== '' && !/^\d+$/.test(w)); // omit digits
    return rawWords.map(normalizeWord);
  };

  for (const set of sets) {
    if (!set.targets || set.targets.length === 0) {
      if (bestScore === 0) { best = set; bestScore = 0.1; }
      continue;
    }

    const setUDIM = getTextureSetUDIM(set);

    // CRITICAL: If UDIM tile mismatches, REJECT this candidate set immediately!
    if (geomUDIM !== null && setUDIM !== null && geomUDIM !== setUDIM) {
      continue;
    }

    for (const candidate of [meshName, matName]) {
      const c = candidate.toLowerCase().trim();
      const cNoDigits = c.replace(/\d+/g, '').replace(/_+/g, '_').replace(/^_+|_+$/g, '');

      for (const pattern of set.targets) {
        const p = pattern.toLowerCase().trim();
        const pNoDigits = p.replace(/\d+/g, '').replace(/_+/g, '_').replace(/^_+|_+$/g, '');

        let score = 0;
        if (c === p || (cNoDigits && pNoDigits && cNoDigits === pNoDigits)) {
          score = 4;
        } else if (!p.includes('*') && (c.includes(p) || p.includes(c) || (cNoDigits && pNoDigits && (cNoDigits.includes(pNoDigits) || pNoDigits.includes(cNoDigits))))) {
          const matchLen = p.length;
          const wordBoundaryReward = c.includes(`_${p}`) || c.includes(`${p}_`) ? 0.2 : 0;
          score = 3 + (matchLen / 100) + wordBoundaryReward;
        } else if (p.includes('*') && (matchesAny(c, [p]) || (cNoDigits && pNoDigits && matchesAny(cNoDigits, [pNoDigits])))) {
          score = 2;
        } else if (p === '*') {
          score = 1;
        }

        // ── Robust Word Overlap Fallback ──────────────────────────────────────
        const cWords = getNormalizedWords(candidate);
        const pWords = getNormalizedWords(pattern);
        
        if (cWords.length > 0 && pWords.length > 0) {
          let overlapCount = 0;
          for (const cw of cWords) {
            if (pWords.includes(cw)) overlapCount++;
          }
          
          if (overlapCount > 0) {
            const overlapRatio = overlapCount / Math.max(cWords.length, 1);
            const patternRatio = overlapCount / Math.max(pWords.length, 1);
            
            if (overlapRatio === 1 || patternRatio === 1) {
              const overlapScore = 3.5 + (overlapCount / 20) + (overlapRatio * 0.1);
              if (overlapScore > score) {
                score = overlapScore;
              }
            } else if (overlapCount >= 2) {
              const overlapScore = 3.1 + (overlapCount / 20) + (overlapRatio * 0.1);
              if (overlapScore > score) {
                score = overlapScore;
              }
            }
          }
        }

        // Give a generous matching bonus if UDIM tiles perfectly align
        if (geomUDIM !== null && setUDIM !== null && geomUDIM === setUDIM) {
          score += 10.0;
        }

        if (score > bestScore) {
          bestScore = score;
          best = set;
        }
      }
    }
  }
  return best;
}

/**
 * Generates an elegant and high-fidelity SVG file showing the combined UDIM UV layouts
 * of all meshes in the FBX model, color-coded by mesh.
 */
export function generateUVSVG(group: THREE.Object3D): string {
  const meshes: THREE.Mesh[] = [];
  group.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      meshes.push(child as THREE.Mesh);
    }
  });

  if (meshes.length === 0) return '';

  const tileInfoList: {
    meshName: string;
    uvs: THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    tile: number;
    index: THREE.BufferAttribute | null;
    vertexCount: number;
  }[] = [];
  const tilesSet = new Set<number>();

  meshes.forEach((mesh) => {
    const geometry = mesh.geometry;
    if (!geometry || !geometry.attributes || !geometry.attributes.uv) return;
    const uvAttr = geometry.attributes.uv as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
    if (uvAttr.count === 0) return;

    const tile = detectUDIMTile(geometry) || 1001;
    tilesSet.add(tile);

    tileInfoList.push({
      meshName: mesh.name,
      uvs: uvAttr,
      tile,
      index: geometry.index as THREE.BufferAttribute | null,
      vertexCount: uvAttr.count
    });
  });

  if (tileInfoList.length === 0) return '';

  const sortedTiles = Array.from(tilesSet).sort((a, b) => a - b);
  const tileSize = 600;
  const padding = 80;
  const numGridCols = Math.min(sortedTiles.length, 3);
  const numGridRows = Math.ceil(sortedTiles.length / numGridCols);

  const svgWidth = numGridCols * (tileSize + padding) + padding;
  const svgHeight = numGridRows * (tileSize + padding) + padding + 120; // Extra room for title at top

  let svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n`;
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" style="background-color: #121214; font-family: sans-serif;">\n`;

  // Draw elegant title
  svg += `  <text x="40" y="50" fill="#facc15" font-size="28" font-weight="950" letter-spacing="1">AXE MODEL UV WIREFRAME LAYOUT MAP</text>\n`;
  svg += `  <text x="40" y="80" fill="#71717a" font-size="14" font-weight="500">Auto-extracted from High-Fidelity 3D Assets • Standard UDIM coordinates</text>\n`;

  sortedTiles.forEach((tile, tileIdx) => {
    const colIdx = tileIdx % numGridCols;
    const rowIdx = Math.floor(tileIdx / numGridCols);

    const xOffset = padding + colIdx * (tileSize + padding);
    const yOffset = 120 + padding + rowIdx * (tileSize + padding);

    // Draw tile border frame
    svg += `  <!-- TILE ${tile} FRAME -->\n`;
    svg += `  <rect x="${xOffset}" y="${yOffset}" width="${tileSize}" height="${tileSize}" fill="#18181b" stroke="#3f3f46" stroke-width="2" rx="16" />\n`;
    svg += `  <text x="${xOffset + 24}" y="${yOffset + 40}" fill="#22c55e" font-size="18" font-weight="800">UDIM ${tile}</text>\n`;

    const tileInfos = tileInfoList.filter((info) => info.tile === tile);

    const meshColors = [
      '#3b82f6', // Bright Blue
      '#f97316', // Orange
      '#ec4899', // Pink
      '#10b981', // Green
      '#8b5cf6', // Violet
      '#f59e0b', // Amber
    ];

    tileInfos.forEach((info, meshIdx) => {
      const strokeColor = meshColors[meshIdx % meshColors.length];
      svg += `  <!-- MESH: ${info.meshName} -->\n`;
      svg += `  <g stroke="${strokeColor}" stroke-width="0.5" fill="none" opacity="0.65">\n`;

      const uvs = info.uvs;
      const index = info.index;
      const vertexCount = info.vertexCount;
      const totalTris = index ? index.count / 3 : vertexCount / 3;

      // Limit to max 1200 triangles drawn per mesh in the combined layout to prevent HUGE SVGs and CPU blocking!
      const step = totalTris > 1200 ? Math.ceil(totalTris / 1200) : 1;

      for (let i = 0; i < totalTris; i += step) {
        let idx0, idx1, idx2;
        if (index) {
          idx0 = index.getX(i * 3);
          idx1 = index.getX(i * 3 + 1);
          idx2 = index.getX(i * 3 + 2);
        } else {
          idx0 = i * 3;
          idx1 = i * 3 + 1;
          idx2 = i * 3 + 2;
        }

        const u0 = uvs.getX(idx0);
        const v0 = uvs.getY(idx0);
        const u1 = uvs.getX(idx1);
        const v1 = uvs.getY(idx1);
        const u2 = uvs.getX(idx2);
        const v2 = uvs.getY(idx2);

        const tU0 = u0 - Math.floor(u0);
        const tV0 = v0 - Math.floor(v0);
        const tU1 = u1 - Math.floor(u1);
        const tV1 = v1 - Math.floor(v1);
        const tU2 = u2 - Math.floor(u2);
        const tV2 = v2 - Math.floor(v2);

        const x0 = xOffset + (tU0 * tileSize);
        const y0 = yOffset + tileSize - (tV0 * tileSize);
        const x1 = xOffset + (tU1 * tileSize);
        const y1 = yOffset + tileSize - (tV1 * tileSize);
        const x2 = xOffset + (tU2 * tileSize);
        const y2 = yOffset + tileSize - (tV2 * tileSize);

        svg += `    <polygon points="${x0.toFixed(1)},${y0.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" />\n`;
      }

      svg += `  </g>\n`;
      const legendY = yOffset + tileSize - 32 - (meshIdx * 20);
      svg += `  <rect x="${xOffset + 24}" y="${legendY - 10}" width="12" height="12" fill="${strokeColor}" rx="3" />\n`;
      svg += `  <text x="${xOffset + 44}" y="${legendY}" fill="#e4e4e7" font-size="11" font-weight="600">${info.meshName}</text>\n`;
    });
  });

  svg += `</svg>\n`;
  return svg;
}

/**
 * Generates an elegant and high-fidelity SVG file showing the UV layout of a SINGLE mesh,
 * fully isolated with zero overlaps from other meshes.
 */
export function generateSingleMeshUVSVG(mesh: THREE.Mesh): string {
  const geometry = mesh.geometry;
  if (!geometry || !geometry.attributes || !geometry.attributes.uv) return '';
  const uvAttr = geometry.attributes.uv as THREE.BufferAttribute | THREE.InterleavedBufferAttribute;
  if (uvAttr.count === 0) return '';

  const tile = detectUDIMTile(geometry) || 1001;
  const index = geometry.index as THREE.BufferAttribute | null;
  const vertexCount = uvAttr.count;

  const tileSize = 600;
  const padding = 80;
  const svgWidth = tileSize + padding * 2;
  const svgHeight = tileSize + padding * 2 + 120; // Extra room for title/legend at top

  let svg = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n`;
  svg += `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" style="background-color: #0c0a09; font-family: sans-serif;">\n`;

  // Draw elegant title
  const partNameUpper = mesh.name.toUpperCase() || 'PART';
  svg += `  <text x="40" y="50" fill="#facc15" font-size="24" font-weight="950" letter-spacing="1">UV WIREFRAME: ${partNameUpper}</text>\n`;
  svg += `  <text x="40" y="80" fill="#78716c" font-size="14" font-weight="500">Isolated 3D Mesh Wireframe • UDIM ${tile}</text>\n`;

  const xOffset = padding;
  const yOffset = 120 + padding;

  // Draw tile border frame
  svg += `  <!-- TILE ${tile} FRAME -->\n`;
  svg += `  <rect x="${xOffset}" y="${yOffset}" width="${tileSize}" height="${tileSize}" fill="#1c1917" stroke="#44403c" stroke-width="2" rx="16" />\n`;
  svg += `  <text x="${xOffset + 24}" y="${yOffset + 40}" fill="#22c55e" font-size="18" font-weight="800">UDIM ${tile}</text>\n`;

  // Draw mesh triangles
  svg += `  <!-- MESH: ${mesh.name} -->\n`;
  svg += `  <g stroke="#3b82f6" stroke-width="0.75" fill="none" opacity="0.8">\n`;

  const totalTris = index ? index.count / 3 : vertexCount / 3;
  // Limit to max 2000 triangles drawn for single mesh layout to keep SVG clean and render-friendly
  const step = totalTris > 2000 ? Math.ceil(totalTris / 2000) : 1;

  for (let i = 0; i < totalTris; i += step) {
    let idx0, idx1, idx2;
    if (index) {
      idx0 = index.getX(i * 3);
      idx1 = index.getX(i * 3 + 1);
      idx2 = index.getX(i * 3 + 2);
    } else {
      idx0 = i * 3;
      idx1 = i * 3 + 1;
      idx2 = i * 3 + 2;
    }

    const u0 = uvAttr.getX(idx0);
    const v0 = uvAttr.getY(idx0);
    const u1 = uvAttr.getX(idx1);
    const v1 = uvAttr.getY(idx1);
    const u2 = uvAttr.getX(idx2);
    const v2 = uvAttr.getY(idx2);

    const tU0 = u0 - Math.floor(u0);
    const tV0 = v0 - Math.floor(v0);
    const tU1 = u1 - Math.floor(u1);
    const tV1 = v1 - Math.floor(v1);
    const tU2 = u2 - Math.floor(u2);
    const tV2 = v2 - Math.floor(v2);

    const x0 = xOffset + (tU0 * tileSize);
    const y0 = yOffset + tileSize - (tV0 * tileSize);
    const x1 = xOffset + (tU1 * tileSize);
    const y1 = yOffset + tileSize - (tV1 * tileSize);
    const x2 = xOffset + (tU2 * tileSize);
    const y2 = yOffset + tileSize - (tV2 * tileSize);

    svg += `    <polygon points="${x0.toFixed(1)},${y0.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${x2.toFixed(1)},${y2.toFixed(1)}" />\n`;
  }

  svg += `  </g>\n`;

  const legendY = yOffset + tileSize - 32;
  svg += `  <rect x="${xOffset + 24}" y="${legendY - 10}" width="12" height="12" fill="#3b82f6" rx="3" />\n`;
  svg += `  <text x="${xOffset + 44}" y="${legendY}" fill="#f5f5f4" font-size="12" font-weight="600">Mesh ID: ${mesh.name}</text>\n`;

  svg += `</svg>\n`;
  return svg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component props
// ─────────────────────────────────────────────────────────────────────────────

interface FBXModelProps {
  url: string;
  settings: MaterialSettings;
  /** Unlimited PBR texture bundles – each bundle targets one or more meshes/materials */
  textureSets?: TextureSet[];
  modelParts?: ModelPart[];
  activePartId?: string | null;
  onPartClick?: (part: { id: string, name: string, description: string, position: THREE.Vector3, size: THREE.Vector3, mesh: THREE.Mesh } | null) => void;
  onMaterialsLoaded?: (materials: string[]) => void;
  onMeshesLoaded?: (meshes: string[]) => void;
  onAnimationFinished?: () => void;
  onAnimationsDetected?: (hasAnimations: boolean) => void;
  translatedParts?: Record<string, { name: string, description: string }>;
  isMobile?: boolean;
  hoveredPartId?: string | null;
  onUVLayoutGenerated?: (svg: string, filename: string) => void;
  onPartUVLayoutGenerated?: (meshName: string, svg: string, filename: string) => void;
  onTexturesProgress?: (loaded: number, total: number) => void;
  onFbxLoaded?: () => void;
  cachedBlobUrls?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const FBXModel: React.FC<FBXModelProps> = ({
  url, settings,
  textureSets = [],
  modelParts = [], activePartId, onPartClick, onMaterialsLoaded, onMeshesLoaded,
  onAnimationFinished, onAnimationsDetected,
  translatedParts = {}, isMobile = false,
  hoveredPartId = null,
  onUVLayoutGenerated,
  onPartUVLayoutGenerated,
  onTexturesProgress,
  onFbxLoaded,
  cachedBlobUrls = {}
}) => {
  const originalFbx = useLoader(FBXLoader, url);

  // Use refs for callbacks to prevent infinite loops when parent re-renders with new function identities
  const onMaterialsLoadedRef = useRef(onMaterialsLoaded);
  const onMeshesLoadedRef = useRef(onMeshesLoaded);
  const onAnimationsDetectedRef = useRef(onAnimationsDetected);
  const onUVLayoutGeneratedRef = useRef(onUVLayoutGenerated);
  const onPartUVLayoutGeneratedRef = useRef(onPartUVLayoutGenerated);
  const onTexturesProgressRef = useRef(onTexturesProgress);
  const onFbxLoadedRef = useRef(onFbxLoaded);

  useEffect(() => { onMaterialsLoadedRef.current = onMaterialsLoaded; }, [onMaterialsLoaded]);
  useEffect(() => { onMeshesLoadedRef.current = onMeshesLoaded; }, [onMeshesLoaded]);
  useEffect(() => { onAnimationsDetectedRef.current = onAnimationsDetected; }, [onAnimationsDetected]);
  useEffect(() => { onTexturesProgressRef.current = onTexturesProgress; }, [onTexturesProgress]);
  useEffect(() => { onUVLayoutGeneratedRef.current = onUVLayoutGenerated; }, [onUVLayoutGenerated]);
  useEffect(() => { onPartUVLayoutGeneratedRef.current = onPartUVLayoutGenerated; }, [onPartUVLayoutGenerated]);
  useEffect(() => { onFbxLoadedRef.current = onFbxLoaded; }, [onFbxLoaded]);

  const fbx = useMemo(() => {
    const clone = SkeletonUtils.clone(originalFbx);

    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (mesh.geometry) {
          ensureUVs(mesh.geometry);
        }
        const convert = (m: THREE.Material | null | undefined): THREE.Material => {
          if (!m) return new THREE.MeshStandardMaterial({ color: 0xcccccc, name: 'Fallback' });
          
          // Create a NEW material for every mesh to ensure isolation
          const originalColor = (m as any).color ? (m as any).color.clone() : new THREE.Color(0xffffff);
          const isTransparent = (m as any).transparent || (m as any).opacity < 1.0 || !!(m as any).alphaMap;
          
          const pbr = new THREE.MeshStandardMaterial({
            name: m.name || `Material_${Math.random().toString(36).substr(2, 5)}`,
            color: originalColor,
            map: (m as any).map || null,
            side: THREE.DoubleSide,
            transparent: isTransparent,
            opacity: (m as any).opacity !== undefined ? (m as any).opacity : 1.0,
            alphaTest: (m as any).alphaTest || 0.05,
            roughness: 1.0,
            metalness: 0.0,
            depthWrite: !isTransparent
          });

          pbr.userData.isPBR = true;
          pbr.userData.originalColor = originalColor;
          pbr.userData.originalMap = (m as any).map || null;
          pbr.userData.originalTransparent = isTransparent;
          pbr.userData.originalOpacity = (m as any).opacity !== undefined ? (m as any).opacity : 1.0;
          
          if ((m as any).normalMap) pbr.normalMap = (m as any).normalMap;
          if ((m as any).roughnessMap) pbr.roughnessMap = (m as any).roughnessMap;
          if ((m as any).metalnessMap) pbr.metalnessMap = (m as any).metalnessMap;
          if ((m as any).alphaMap) { 
            pbr.alphaMap = (m as any).alphaMap; 
            pbr.userData.originalAlphaMap = (m as any).alphaMap; 
          }
          return pbr;
        };
        
        if (Array.isArray(mesh.material)) mesh.material = mesh.material.map(m => convert(m));
        else mesh.material = convert(mesh.material);
      }
    });

    if (originalFbx.animations) clone.animations = [...originalFbx.animations];
    return clone;
  }, [originalFbx]);

  useEffect(() => {
    if (fbx && onFbxLoadedRef.current) {
      const cb = onFbxLoadedRef.current;
      setTimeout(() => {
        cb();
      }, 0);
    }
  }, [fbx]);

  const mixer = useMemo(() => fbx ? new THREE.AnimationMixer(fbx) : null, [fbx]);
  const actions = useMemo(() => {
    const res: { [key: string]: THREE.AnimationAction } = {};
    if (fbx && fbx.animations && mixer) {
      fbx.animations.forEach(clip => { res[clip.name] = mixer.clipAction(clip); });
    }
    return res;
  }, [mixer, fbx?.animations]);

  // ── Texture cache: url → THREE.Texture ──────────────────────────────────
  const [textureCache, setTextureCache] = useState<{ [url: string]: THREE.Texture }>({});
  const textureCacheRef = useRef<{ [url: string]: THREE.Texture }>({});
  const textureLoader = useRef(new THREE.TextureLoader());
  const tgaLoader = useRef(new TGALoader());
  const ddsLoader = useRef(new DDSLoader());

  const initialPositions = useRef<Map<THREE.Object3D, THREE.Vector3>>(new Map());
  const explodeDirections = useRef<Map<THREE.Object3D, THREE.Vector3>>(new Map());
  const rootPos = useRef(new THREE.Vector3());
  const rootRot = useRef(new THREE.Euler());
  const rootScale = useRef(new THREE.Vector3(1, 1, 1));
  const internalExplodeFactorRef = useRef(0);
  const prevPlayingRef = useRef(false);
  const accumulatorRef = useRef(0);
  const frameTime = 1 / 25;
  const prevDirectionRef = useRef(settings.animationDirection);

  const entryProgressRef = useRef(0);
  const outerGroupRef = useRef<THREE.Group>(null);

  useEffect(() => {
    entryProgressRef.current = 0;
  }, [url, fbx]);

  // ── Compute full serialized list of all texture URLs needed for the model ──
  const textureUrlsKey = useMemo(() => {
    const seen = new Set<string>();
    const urls: { url: string; isColor: boolean }[] = [];

    const add = (u: unknown, isColor: boolean) => {
      if (!u || typeof u !== 'string') return;
      if (seen.has(u)) return;
      seen.add(u);
      urls.push({ url: u, isColor });
    };

    // New textureSets API
    textureSets.forEach(set => {
      add(set.baseColor, true);
      add(set.normal, false);
      add(set.metalness, false);
      add(set.roughness, false);
      add(set.alpha, false);
      add(set.emissive, true);
      add(set.ao, false);
      add(set.height, false);
    });

    // Legacy settings maps (kept for backwards compatibility)
    Object.values(settings.materialMappings || {}).forEach(u => add(u, true));
    Object.values(settings.normalMappings || {}).forEach(u => add(u, false));
    Object.values(settings.metalMappings || {}).forEach(u => add(u, false));
    Object.values(settings.roughMappings || {}).forEach(u => add(u, false));
    Object.values(settings.alphaMappings || {}).forEach(u => add(u, false));
    Object.values(settings.emissiveMappings || {}).forEach(u => add(u, true));
    Object.values(settings.aoMappings || {}).forEach(u => add(u, false));
    Object.values(settings.heightMappings || {}).forEach(u => add(u, false));
    Object.values(settings.specularMappings || {}).forEach(u => add(u, false));

    // Preload ALL texture mappings from color variants to enable instant material switching
    if (settings.colorVariants && Array.isArray(settings.colorVariants)) {
      settings.colorVariants.forEach(variant => {
        if (variant.mappings) {
          Object.values(variant.mappings || {}).forEach(u => add(u, true));
        }
        if (variant.normalMappings) {
          Object.values(variant.normalMappings || {}).forEach(u => add(u, false));
        }
        if (variant.metalMappings) {
          Object.values(variant.metalMappings || {}).forEach(u => add(u, false));
        }
        if (variant.roughMappings) {
          Object.values(variant.roughMappings || {}).forEach(u => add(u, false));
        }
        if (variant.alphaMappings) {
          Object.values(variant.alphaMappings || {}).forEach(u => add(u, false));
        }
        if (variant.emissiveMappings) {
          Object.values(variant.emissiveMappings || {}).forEach(u => add(u, true));
        }
        if (variant.aoMappings) {
          Object.values(variant.aoMappings || {}).forEach(u => add(u, false));
        }
        if (variant.heightMappings) {
          Object.values(variant.heightMappings || {}).forEach(u => add(u, false));
        }
        if (variant.specularMappings) {
          Object.values(variant.specularMappings || {}).forEach(u => add(u, false));
        }
      });
    }

    return JSON.stringify(urls);
  }, [textureSets, settings.materialMappings, settings.normalMappings, settings.metalMappings, settings.roughMappings, settings.alphaMappings, settings.emissiveMappings, settings.aoMappings, settings.heightMappings, settings.specularMappings, settings.colorVariants]);

  // ── Pre-load the remaining textures in a controlled background queue ───────
  useEffect(() => {
    let active = true;

    // Parse the full target texture URLs list
    const allUrls: { url: string; isColor: boolean }[] = JSON.parse(textureUrlsKey);

    // Only load ones that aren't already cache-hits
    const toLoad = allUrls.filter(item => !textureCacheRef.current[item.url]);

    console.log(`[FBXModel] 📦 Queuing ${toLoad.length} unique textures to load (sequential/batch queue)`);

    if (onTexturesProgressRef.current) {
      const cb = onTexturesProgressRef.current;
      const totalCount = toLoad.length;
      setTimeout(() => {
        cb(0, totalCount);
      }, 0);
    }

    if (toLoad.length === 0) return;

    // Controlled queue execution to prevent WebGL/Browser freezing under heavy parallel decode load
    let currentIndex = 0;
    const activeLoadsLimit = 8; // Process up to 8 textures concurrently to speed up loading and match browser network pipelines

    const loadSingleTexture = ({ url: u, isColor }: { url: string; isColor: boolean }): Promise<void> => {
      return new Promise<void>((resolve) => {
        const done = () => resolve();

        if (!active) {
          done();
          return;
        }

        const cachedUrl = cachedBlobUrls[u];
        const loadUrl = cachedUrl || normalizeTextureLoadUrl(u);

        const lo = u.toLowerCase();
        // Inspect if URL points to a TGA/DDS file (handles files served via proxy endpoints with query params)
        let isTgaFile = false;
        let isDdsFile = false;

        if (lo.includes('filename=')) {
          const fileParam = lo.split('filename=')[1].split('&')[0];
          isTgaFile = fileParam.endsWith('.tga');
          isDdsFile = fileParam.endsWith('.dds');
        } else {
          isTgaFile = lo.endsWith('.tga') || lo.includes('.tga?');
          isDdsFile = lo.endsWith('.dds') || lo.includes('.dds?');
        }

        if (isTgaFile || isDdsFile) {
          let loader: any = isTgaFile ? tgaLoader.current : ddsLoader.current;
          let triedDirect = false;
          let currentLoadUrl = loadUrl;

          const executeLoad = (targetUrl: string) => {
            loader.load(targetUrl, (tex: THREE.Texture) => {
              if (!active) {
                tex.dispose();
                done();
                return;
              }
              tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
              tex.wrapS = THREE.RepeatWrapping;
              tex.wrapT = THREE.RepeatWrapping;
              const shouldFlipY = settings.flipY !== undefined ? settings.flipY : true;
              tex.flipY = shouldFlipY;
              tex.anisotropy = settings.anisotropy !== undefined ? settings.anisotropy : 16;
              tex.needsUpdate = true;
              textureCacheRef.current[u] = tex;
              setTextureCache(prev => {
                if (!active) return prev;
                return { ...prev, [u]: tex };
              });
              done();
            }, undefined, (err: any) => {
              if (triedDirect) {
                console.warn(`[FBXModel] Direct R2 load failed for ${u}. Retrying via proxy: ${loadUrl}`);
                triedDirect = false;
                executeLoad(loadUrl);
              } else {
                console.error(`[FBXModel] ❌ Failed to load TGA/DDS file: "${loadUrl}"`, err);
                done();
              }
            });
          };

          executeLoad(currentLoadUrl);
        } else {
          // Optimized standard image loader with smart Canvas downscaling and fast self-healing direct-R2/proxy-fallback logic
          const img = new Image();
          img.crossOrigin = 'anonymous';
          img.referrerPolicy = 'no-referrer';
          img.decoding = 'async'; // Request async out-of-thread decoding so the browser main thread remains butter smooth
          
          let triedDirect = false;
          img.src = loadUrl;

          img.onload = () => {
            if (!active) {
              done();
              return;
            }
            try {
              // Cap max size according to settings or fallback to 4096 for gorgeous resolution
              const maxDim = settings.maxTextureSize !== undefined ? settings.maxTextureSize : 4096;
              let w = img.width;
              let h = img.height;
              let finalSource: HTMLImageElement | HTMLCanvasElement = img;

              if (maxDim > 0 && (w > maxDim || h > maxDim)) {
                const ratio = Math.min(maxDim / w, maxDim / h);
                w = Math.round(w * ratio);
                h = Math.round(h * ratio);

                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext('2d');
                if (ctx) {
                  // Use higher quality image smoothing on canvas scale down
                  ctx.imageSmoothingEnabled = true;
                  ctx.imageSmoothingQuality = 'high';
                  ctx.drawImage(img, 0, 0, w, h);
                  finalSource = canvas;
                  console.log(`[TextureOptimizer] Downscaled ${img.src} from ${img.width}x${img.height} to ${w}x${h} (Cap: ${maxDim})`);
                }
              }

              const tex = new THREE.Texture(finalSource);
              tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
              tex.wrapS = THREE.RepeatWrapping;
              tex.wrapT = THREE.RepeatWrapping;
              const shouldFlipY = settings.flipY !== undefined ? settings.flipY : true;
              tex.flipY = shouldFlipY;
              tex.anisotropy = settings.anisotropy !== undefined ? settings.anisotropy : 16;
              tex.needsUpdate = true;

              textureCacheRef.current[u] = tex;
              setTextureCache(prev => {
                if (!active) {
                  tex.dispose();
                  return prev;
                }
                return { ...prev, [u]: tex };
              });
              done();
            } catch (e) {
              console.error('[TextureOptimizer] Error processing texture canvas downscaling, falling back:', e);
              if (!active) {
                done();
                return;
              }
              // Fallback load
              const fallbackLoader = new THREE.TextureLoader();
              fallbackLoader.load(img.src, (tex) => {
                if (!active) {
                  tex.dispose();
                  done();
                  return;
                }
                tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                const shouldFlipY = settings.flipY !== undefined ? settings.flipY : true;
                tex.flipY = shouldFlipY;
                tex.anisotropy = settings.anisotropy !== undefined ? settings.anisotropy : 16;
                tex.needsUpdate = true;
                textureCacheRef.current[u] = tex;
                setTextureCache(prev => {
                  if (!active) return prev;
                  return { ...prev, [u]: tex };
                });
                done();
              }, undefined, (err) => {
                console.error(`[FBXModel] ❌ Fallback failed: "${img.src}"`, err);
                done();
              });
            }
          };

          img.onerror = (err) => {
            if (triedDirect) {
              console.warn(`[TextureOptimizer] Direct R2 load failed (CORS or network error) for "${u}". Falling back to proxy: "${loadUrl}"`);
              triedDirect = false;
              img.src = loadUrl;
            } else {
              console.error(`[TextureOptimizer] Image load error for ${loadUrl} (original: "${u}"). Trying legacy loader as fallback:`, err);
              if (!active) {
                done();
                return;
              }
              const fallbackLoader = new THREE.TextureLoader();
              fallbackLoader.load(loadUrl, (tex) => {
                if (!active) {
                  tex.dispose();
                  done();
                  return;
                }
                tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                tex.wrapS = THREE.RepeatWrapping;
                tex.wrapT = THREE.RepeatWrapping;
                const shouldFlipY = settings.flipY !== undefined ? settings.flipY : true;
                tex.flipY = shouldFlipY;
                tex.anisotropy = settings.anisotropy !== undefined ? settings.anisotropy : 16;
                tex.needsUpdate = true;
                textureCacheRef.current[u] = tex;
                setTextureCache(prev => {
                  if (!active) return prev;
                  return { ...prev, [u]: tex };
                });
                done();
              }, undefined, (fallbackErr) => {
                console.error(`[FBXModel] ❌ Fallback failed too: "${loadUrl}" (original: "${u}")`, fallbackErr);
                done();
              });
            }
          };
        }
      });
    };

    let loadedCount = 0;
    const runQueue = () => {
      if (!active || currentIndex >= toLoad.length) return;
      const nextItem = toLoad[currentIndex++];
      loadSingleTexture(nextItem).then(() => {
        if (!active) return;
        loadedCount++;
        if (onTexturesProgressRef.current) {
          const cb = onTexturesProgressRef.current;
          const currentLoaded = loadedCount;
          const totalCount = toLoad.length;
          setTimeout(() => {
            cb(currentLoaded, totalCount);
          }, 0);
        }
        runQueue();
      });
    };

    // Spawn up to activeLoadsLimit concurrent queue workers
    const initialWorkersCount = Math.min(activeLoadsLimit, toLoad.length);
    for (let i = 0; i < initialWorkersCount; i++) {
      runQueue();
    }

    return () => {
      active = false;
    };
  }, [textureUrlsKey]);

  useEffect(() => { textureCacheRef.current = textureCache; }, [textureCache]);

  // Clean up and dispose all loaded textures on unmount to prevent GPU memory leaks and WebGL context crashes
  useEffect(() => {
    return () => {
      console.log("[FBXModel] 🧹 Disposing cached custom PBR textures to free GPU memory...");
      const cache = textureCacheRef.current;
      if (cache) {
        Object.values(cache).forEach((tex) => {
          if (tex && typeof tex.dispose === 'function') {
            try {
              tex.dispose();
            } catch (e) {
              console.warn("[FBXModel] Error disposing texture:", e);
            }
          }
        });
      }
      textureCacheRef.current = {};
    };
  }, []);

  // Synchronize flipY setting changes to all cached textures immediately
  useEffect(() => {
    const shouldFlipY = settings.flipY !== undefined ? settings.flipY : true;
    let updated = false;
    Object.values(textureCache).forEach((tex) => {
      if (tex.flipY !== shouldFlipY) {
        tex.flipY = shouldFlipY;
        tex.needsUpdate = true;
        updated = true;
      }
    });
    if (updated && fbx) {
      fbx.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((mat) => {
            if (mat) {
              mat.needsUpdate = true;
            }
          });
        }
      });
    }
  }, [settings.flipY, textureCache, fbx]);

  // Synchronize anisotropy setting changes to all cached textures immediately
  useEffect(() => {
    const activeAnisotropy = settings.anisotropy !== undefined ? settings.anisotropy : 16;
    let updated = false;
    Object.values(textureCache).forEach((tex) => {
      if (tex.anisotropy !== activeAnisotropy) {
        tex.anisotropy = activeAnisotropy;
        tex.needsUpdate = true;
        updated = true;
      }
    });
    if (updated && fbx) {
      fbx.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const mesh = child as THREE.Mesh;
          const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          materials.forEach((mat) => {
            if (mat) {
              mat.needsUpdate = true;
            }
          });
        }
      });
    }
  }, [settings.anisotropy, textureCache, fbx]);

  // Flush texture cache when max resolution limit changes so textures are re-rendered at the new cap size
  useEffect(() => {
    if (settings.maxTextureSize === undefined) return;
    console.log("[FBXModel] 🔄 Texture resolution limit changed. Flushing cache to re-decode at:", settings.maxTextureSize);
    
    // Dispose previous textures to free up GPU memory
    Object.values(textureCacheRef.current).forEach((tex) => {
      if (tex && typeof tex.dispose === 'function') {
        try {
          tex.dispose();
        } catch (e) {
          console.warn("[FBXModel] Error disposing texture:", e);
        }
      }
    });
    
    textureCacheRef.current = {};
    setTextureCache({});
  }, [settings.maxTextureSize]);

  // ── Animation control ────────────────────────────────────────────────────
  useEffect(() => {
    if (!actions || !mixer) return;
    const onFinished = () => { if (onAnimationFinished) onAnimationFinished(); };
    mixer.addEventListener('finished', onFinished);
    const actionList = Object.values(actions);
    if (actionList.length > 0) {
      const { isPlayingAnimation: isPlaying, animationDirection: direction } = settings;
      const isPlayingChanged = isPlaying !== prevPlayingRef.current;
      const directionChanged = direction !== prevDirectionRef.current;
      if (isPlayingChanged || (isPlaying && directionChanged)) {
        if (isPlaying) {
          if (directionChanged && !isPlayingChanged) {
            accumulatorRef.current = 0;
            actionList.forEach(action => {
              if (action) { action.paused = false; action.enabled = true; action.setEffectiveTimeScale(direction === 'backward' ? -1 : 1); action.setEffectiveWeight(1); action.play(); }
            });
          } else {
            accumulatorRef.current = 0;
            actionList.forEach(action => {
              if (!action) return;
              const clip = action.getClip();
              action.reset(); action.setLoop(THREE.LoopOnce, 1); action.clampWhenFinished = true; action.setEffectiveWeight(1);
              if (direction === 'backward') { action.setEffectiveTimeScale(-1); action.time = clip.duration; }
              else { action.setEffectiveTimeScale(1); action.time = 0; }
              action.play();
            });
          }
        } else {
          actionList.forEach(action => { if (action && action.isRunning()) action.stop(); });
        }
        prevPlayingRef.current = isPlaying;
        prevDirectionRef.current = direction;
      }
    }
    return () => { mixer.removeEventListener('finished', onFinished); };
  }, [actions, mixer, settings.isPlayingAnimation, settings.animationDirection, onAnimationFinished]);

  useEffect(() => { return () => { if (mixer) mixer.stopAllAction(); }; }, [mixer]);

  // ── useFrame: root lock + animation stepping + explosion ─────────────────
  useFrame((state, delta) => {
    if (!fbx) return;
    fbx.position.copy(rootPos.current); fbx.rotation.copy(rootRot.current); fbx.scale.copy(rootScale.current); fbx.updateMatrixWorld(true);

    // Smooth entry transition animation and breathing float
    entryProgressRef.current = THREE.MathUtils.lerp(entryProgressRef.current, 1.0, 0.04);
    const progress = entryProgressRef.current;

    if (outerGroupRef.current) {
      // Scale: start from 0 and scale up smoothly to scaleFactor
      const animScale = progress * scaleFactor;
      outerGroupRef.current.scale.set(animScale, animScale, animScale);

      // Position: start from slightly lower and float up gracefully
      // Add a subtle premium floating breathing idle motion
      const hoverY = progress > 0.95 ? Math.sin(state.clock.getElapsedTime() * 1.5) * 0.12 : 0;
      const startYOffset = -12 * (1 - progress);
      outerGroupRef.current.position.set(
        centeringOffset[0],
        centeringOffset[1] + startYOffset + hoverY,
        centeringOffset[2]
      );
      
      // Gentle spin on entry
      outerGroupRef.current.rotation.y = (1 - progress) * 0.45;
    }

    if (mixer) {
      const isPlaying = settings.isPlayingAnimation;
      const isAnyRunning = Object.values(actions).some(a => a?.isRunning());
      if (isPlaying || isAnyRunning) {
        accumulatorRef.current += Math.min(delta, 0.1);
        while (accumulatorRef.current >= frameTime) { mixer.update(frameTime); accumulatorRef.current -= frameTime; }
      } else if (accumulatorRef.current > 0) { mixer.update(accumulatorRef.current); accumulatorRef.current = 0; }
    }
    const target = settings.isExploded ? 1.0 : 0.0;
    const nextFactor = THREE.MathUtils.lerp(internalExplodeFactorRef.current, target, 0.05);
    internalExplodeFactorRef.current = nextFactor;
    const isAnyActionRunning = mixer && Object.values(actions).some(a => a?.isRunning());
    if (nextFactor > 0.001 && !isAnyActionRunning) {
      fbx.traverse((child) => {
        if ((child as THREE.Mesh).isMesh) {
          const original = initialPositions.current.get(child);
          const direction = explodeDirections.current.get(child);
          if (original && direction) {
            const mag = nextFactor * 25;
            child.position.set(original.x + direction.x * mag, original.y + direction.y * mag, original.z + direction.z * mag);
          }
        }
      });
    }
  });

  // ── Material synchronisation ─────────────────────────────────────────────
  useEffect(() => {
    if (!fbx) return;
    fbx.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      if (mesh.name.endsWith('_BackPass') || mesh.name.endsWith('_BackFacePass')) return;

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      materials.forEach((mat) => {
        // Apply wireframe mode to all materials dynamically
        if (mat) {
          (mat as any).wireframe = !!settings.wireframe;
          mat.needsUpdate = true;
        }
        if (mesh.userData.backFaceMat) {
          (mesh.userData.backFaceMat as any).wireframe = !!settings.wireframe;
          (mesh.userData.backFaceMat as any).needsUpdate = true;
        }

        if (!(mat instanceof THREE.MeshStandardMaterial) || !mat.userData.isPBR) return;

        // ── 1. Resolve best TextureSet for this mesh/material ──────────────
        const set = resolveBestSet(mesh.name, mat.name, textureSets, mesh.geometry);

        // ── 1.5 Validate client settings mappings against mesh geometry UDIM 
        const geomUDIM = mesh.geometry ? detectUDIMTile(mesh.geometry) : null;
        const getValidMappingUrl = (url: string | undefined) => {
          if (!url) return undefined;
          if (geomUDIM !== null) {
            const texUDIM = extractUDIMFromUrl(url);
            if (texUDIM !== null && texUDIM !== geomUDIM) {
              return undefined;
            }
          }
          return url;
        };

        // ── 2. Helper to get a cached texture ─────────────────────────────
        const tex = (url: string | undefined) => (url ? textureCache[url] : undefined);

        // ── 3. Base color / albedo ─────────────────────────────────────────
        const baseColorTex = tex(getValidMappingUrl(settings.materialMappings?.[mat.name])) ?? tex(set?.baseColor);
        if (baseColorTex) { 
          mat.map = baseColorTex; 
          mat.color.set(0xffffff); 
        } else { 
          mat.map = mat.userData.originalMap || null; 
          mat.color.copy(mat.userData.originalColor || new THREE.Color(0xffffff)); 
        }

        // ── 4. Normal ──────────────────────────────────────────────────────
        const normalTex = tex(getValidMappingUrl(settings.normalMappings?.[mat.name])) ?? tex(set?.normal);
        mat.normalMap = normalTex || null;
        if (normalTex) { 
          mat.normalScale.set(1, 1); 
        }

        // ── 5. Metalness ───────────────────────────────────────────────────
        const metalTex = tex(getValidMappingUrl(settings.metalMappings?.[mat.name])) ?? tex(set?.metalness);
        mat.metalnessMap = metalTex || null;

        // ── 6. Roughness ───────────────────────────────────────────────────
        const roughTex = tex(getValidMappingUrl(settings.roughMappings?.[mat.name])) ?? tex(set?.roughness);
        mat.roughnessMap = roughTex || null;

        // ── 7. Alpha ───────────────────────────────────────────────────────
        const alphaTex = tex(getValidMappingUrl(settings.alphaMappings?.[mat.name])) ?? tex(set?.alpha);
        mat.alphaMap = alphaTex || mat.userData.originalAlphaMap || null;

        // ── 8. Emissive ────────────────────────────────────────────────────
        const emissiveTex = tex(getValidMappingUrl(settings.emissiveMappings?.[mat.name])) ?? tex(set?.emissive);
        mat.emissiveMap = emissiveTex || null;
        if (emissiveTex) { 
          mat.emissive.set(0xffffff); 
          mat.emissiveIntensity = settings.emissiveIntensity || 1.0; 
        }

        // ── 9. AO ──────────────────────────────────────────────────────────
        const aoTex = tex(getValidMappingUrl(settings.aoMappings?.[mat.name])) ?? tex(set?.ao);
        mat.aoMap = aoTex || null;
        if (aoTex) { 
          mat.aoMapIntensity = 1.0; 
          if (mesh.geometry && (!mesh.geometry.attributes || !mesh.geometry.attributes.uv2)) {
            aoTex.channel = 0;
          }
        }

        // ── 10. Height / displacement ──────────────────────────────────────
        const heightTex = tex(getValidMappingUrl(settings.heightMappings?.[mat.name])) ?? tex(set?.height);
        mat.displacementMap = heightTex || null;
        if (heightTex) { 
          mat.displacementScale = 0.1; 
        }

        // ── 11. PBR scalars ────────────────────────────────────────────────
        mat.metalness = mat.metalnessMap ? 1.0 : settings.metalness;
        mat.roughness = mat.roughnessMap ? 1.0 : settings.roughness;

        // ── 12. Transparency ───────────────────────────────────────────────
        const isTransparent = !!mat.alphaMap || settings.opacity < 1.0 || !!mat.userData.originalTransparent;
        
        mat.transparent = isTransparent;
        mat.opacity = settings.opacity;

        if (isTransparent) {
          const pn = mesh.name.toLowerCase();
          const isInner = ['inner','rod','core','shaft','inside','piston','valve','internal','component','mechanism','heart','center','hidden','contained','inner_','inside_','solid','mass','axle','hub','engine','motor'].some(k => pn.includes(k));
          const isShell = !isInner && ['glass','case','enclosure','housing','outer','envelope','window','transparent','translucent','acrylic','plexiglass','lens_'].some(k => pn.includes(k));
          
          // Use a small alphaTest for textured transparency (like leaves or grilles)
          if (mat.alphaMap) mat.alphaTest = 0.1;

          // Stable transparency sorting
          mat.depthWrite = settings.opacity > 0.85; // Keep depth write for high-opacity objects (including those with alpha maps) to prevent sorting glitched faces!
          mesh.frustumCulled = false; 
          
          if (isShell) {
            mat.side = THREE.FrontSide;
            mesh.renderOrder = 5000; 
            
            if (!mesh.userData.backFaceMesh) {
              const bMat = mat.clone();
              bMat.side = THREE.BackSide;
              bMat.depthWrite = false;
              bMat.transparent = true;
              const bMesh = new THREE.Mesh(mesh.geometry, bMat);
              bMesh.frustumCulled = false;
              bMesh.renderOrder = 4000; 
              mesh.add(bMesh);
              mesh.userData.backFaceMesh = bMesh;
              mesh.userData.backFaceMat = bMat;
            } else {
              const bMat = mesh.userData.backFaceMat as THREE.MeshStandardMaterial;
              const bMesh = mesh.userData.backFaceMesh as THREE.Mesh;
              bMat.color.copy(mat.color);
              bMat.opacity = mat.opacity * 0.5; // Slightly dimmer backface
              bMat.side = THREE.BackSide;
              bMat.depthWrite = false;
              bMat.transparent = true;
              bMesh.renderOrder = 4000;
              bMat.needsUpdate = true;
            }
          } else {
            mat.side = THREE.DoubleSide;
            mesh.renderOrder = isInner ? 1000 : 2000; 
            if (mesh.userData.backFaceMesh) {
              mesh.remove(mesh.userData.backFaceMesh);
              delete mesh.userData.backFaceMesh;
              delete mesh.userData.backFaceMat;
            }
          }
        } else {
          mat.transparent = false;
          mat.depthWrite = true;
          mat.side = THREE.DoubleSide;
          mesh.renderOrder = 0; 
          mesh.frustumCulled = false; 
          if (mesh.userData.backFaceMesh) {
            mesh.remove(mesh.userData.backFaceMesh);
            delete mesh.userData.backFaceMesh;
            delete mesh.userData.backFaceMat;
          }
        }

        mat.depthTest = true; 
        mat.needsUpdate = true;

        // ── 13. Global tint & hover ────────────────────────────────────────
        if (settings.color !== '#ffffff') mat.color.set(settings.color);
        
        // Highlight logic
        const isPartHighlighted = (() => {
          if (!activePartId && !hoveredPartId) return false;
          
          const targetId = hoveredPartId || activePartId;
          const targetLower = targetId.toLowerCase().trim();
          const meshNameLower = mesh.name.toLowerCase().trim();
          
          // 1. DIRECT NAME MATCH (Most common for hover via name/key)
          if (meshNameLower === targetLower || meshNameLower.includes(targetLower)) return true;
          
          // 2. SEMANTIC MATCH (Via part ID)
          const partById = modelParts.find(p => p.id === targetId);
          if (partById) {
            const pName = partById.partName.toLowerCase().trim();
            const pKey = (partById.partKey || "").toLowerCase().trim();
            return meshNameLower === pName || meshNameLower.includes(pName) || 
                   (pKey && (meshNameLower === pKey || meshNameLower.includes(pKey)));
          }
          
          // 3. Fallback to material name match
          if (mat.name === targetId) return true;

          return false;
        })();

        if (isPartHighlighted || settings.hoveredMaterial === mat.name) {
          mat.emissive.setHex(0xeab308); // Yellow (Tailwind yellow-500)
          mat.emissiveIntensity = 0.8;
        }
        else {
          mat.emissive.setHex(0x000000);
          mat.emissiveIntensity = 0;
        }

        mat.needsUpdate = true;
      });
    });
  }, [fbx, settings, textureSets, textureCache, activePartId, hoveredPartId, modelParts]);

  // ── Pre-process: center, scale, extract material names ───────────────────
  const [materialNames, setMaterialNames] = useState<string[]>([]);
  const [meshNames, setMeshNames] = useState<string[]>([]);

  const { scaleFactor, centeringOffset, names, meshes } = useMemo(() => {
    if (!fbx) {
      return { scaleFactor: 1, centeringOffset: [0, 0, 0] as [number, number, number], names: [], meshes: [] };
    }
    fbx.position.set(0,0,0); fbx.rotation.set(0,0,0); fbx.scale.setScalar(1); fbx.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(fbx);
    const size = new THREE.Vector3(); box.getSize(size);
    const center = new THREE.Vector3(); box.getCenter(center);
    const targetSize = 35;
    const maxDim = Math.max(size.x, size.y, size.z);
    const factor = maxDim > 0 ? targetSize / maxDim : 1;
    const matNames: string[] = [];
    const mshNames: string[] = [];
    let meshCounter = 0;
    fbx.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        if (!mesh.name || mesh.name.trim() === '') mesh.name = `Part_${meshCounter++}`;
        if (!mshNames.includes(mesh.name)) mshNames.push(mesh.name);
        
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (mat) {
          if (!mat.name) mat.name = `Material_${matNames.length}`;
          if (!matNames.includes(mat.name)) matNames.push(mat.name);
          const sm = (mat instanceof THREE.MeshStandardMaterial) ? mat : (() => {
            const s = new THREE.MeshStandardMaterial();
            s.name = mat.name;
            if ((mat as any).color) s.color.copy((mat as any).color);
            if ((mat as any).map) s.map = (mat as any).map;
            if ((mat as any).normalMap) s.normalMap = (mat as any).normalMap;
            if ((mat as any).opacity !== undefined) s.opacity = (mat as any).opacity;
            if ((mat as any).transparent !== undefined) s.transparent = (mat as any).transparent;
            if (Array.isArray(mesh.material)) mesh.material[0] = s; else mesh.material = s;
            return s;
          })();
          sm.userData.isPBR = true;
          if (!sm.userData.originalMap) sm.userData.originalMap = sm.map;
          if (!sm.userData.originalColor) sm.userData.originalColor = sm.color.clone();
        }
        initialPositions.current.set(child, child.position.clone());
        const wp = new THREE.Vector3(); child.getWorldPosition(wp);
        explodeDirections.current.set(child, wp.normalize());
      }
    });
    return { scaleFactor: factor, centeringOffset: [-center.x*factor, -center.y*factor, -center.z*factor] as [number,number,number], names: matNames, meshes: mshNames };
  }, [fbx]);

  // ── Hotspots ──────────────────────────────────────────────────────────────
  const hotspots = useMemo(() => {
    if (!fbx) return [];
    const detected: { id: string, mesh: THREE.Mesh, description: string, name: string }[] = [];
    fbx.updateMatrixWorld(true);
    const modelBox = new THREE.Box3().setFromObject(fbx);
    const modelSize = new THREE.Vector3(); modelBox.getSize(modelSize);
    const maxDim = Math.max(modelSize.x, modelSize.y, modelSize.z);
    fbx.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
        const partInfo = modelParts.find(p =>
          (p.presentAtSite !== false) && (
            p.partName.toLowerCase().trim() === mesh.name.toLowerCase().trim() ||
            mesh.name.toLowerCase().trim().includes(p.partName.toLowerCase().trim())
          )
        );
        if (partInfo?.description) {
          const tr = translatedParts[partInfo.id];
          detected.push({ id: partInfo.id, mesh, description: tr?.description || partInfo.description, name: tr?.name || mesh.name });
        }
      }
    });
    detected.sort((a, b) => {
      const ab = new THREE.Box3().setFromObject(a.mesh); const bb = new THREE.Box3().setFromObject(b.mesh);
      const ac = new THREE.Vector3(); const bc = new THREE.Vector3();
      ab.getCenter(ac); bb.getCenter(bc); return ac.x - bc.x;
    });
    const topY = modelSize.y * 0.5 + maxDim * 0.12;
    const startX = -modelSize.x * 0.3; const endX = modelSize.x * 0.3;
    const stepX = detected.length > 1 ? (endX - startX) / (detected.length - 1) : 0;
    return detected.map((part, i) => {
      const pointPos = new THREE.Vector3(startX + i * stepX, topY, 0);
      const mb = new THREE.Box3().setFromObject(part.mesh);
      const mc = new THREE.Vector3(); const ms = new THREE.Vector3();
      mb.getCenter(mc); mb.getSize(ms);
      const lc = fbx.worldToLocal(mc.clone());
      return { id: part.id, mesh: part.mesh, anchorPosition: lc, pointPosition: pointPos, description: part.description, partName: part.name, size: ms };
    });
  }, [fbx, modelParts, translatedParts]);

  useEffect(() => {
    setMaterialNames(names);
    setMeshNames(meshes);
    if (onAnimationsDetectedRef.current) {
      const cb = onAnimationsDetectedRef.current;
      const hasAnim = !!(fbx && fbx.animations && fbx.animations.length > 0);
      setTimeout(() => {
        cb(hasAnim);
      }, 0);
    }
  }, [fbx, names, meshes]);

  useEffect(() => {
    if (onMaterialsLoadedRef.current && materialNames.length > 0) {
      const cb = onMaterialsLoadedRef.current;
      const mats = materialNames;
      setTimeout(() => {
        cb(mats);
      }, 0);
    }
  }, [materialNames]);

  useEffect(() => {
    if (onMeshesLoadedRef.current && meshNames.length > 0) {
      const cb = onMeshesLoadedRef.current;
      const msh = meshNames;
      setTimeout(() => {
        cb(msh);
      }, 0);
    }
  }, [meshNames]);

  // NEW: Automatically generate reference combined UV layout map once on load without heavy isolated files
  useEffect(() => {
    if (!fbx) return;
    
    let isCancelled = false;
    
    const generateAndSaveCombinedMap = async () => {
      try {
        const combinedSvg = generateUVSVG(fbx);
        if (combinedSvg && !isCancelled) {
          let lastPart = url.split('/').pop() || '';
          if (lastPart.includes('?')) {
            try {
              const searchParams = new URLSearchParams(lastPart.split('?')[1]);
              const qFileName = searchParams.get('fileName') || searchParams.get('filename');
              if (qFileName) {
                lastPart = qFileName;
              } else {
                lastPart = lastPart.split('?')[0];
              }
            } catch (e) {
              lastPart = lastPart.split('?')[0];
            }
          }
          const baseName = lastPart.toLowerCase().replace(/\.fbx$/i, '');
          const combinedFilename = `${baseName}_uv_layout.svg`;

          if (onUVLayoutGeneratedRef.current) {
            onUVLayoutGeneratedRef.current(combinedSvg, combinedFilename);
          }

          console.log(`[UV Auto-Saver] Saving combined model UV layout: ${combinedFilename}`);
          await fetch('/api/save-uv-svg', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ svg: combinedSvg, filename: combinedFilename })
          })
          .catch(err => console.warn(`[UV Auto-Saver] Error saving combined:`, err));
        }
      } catch (err) {
        console.warn(`[UV Auto-Saver] Error generating combined UV map:`, err);
      }
    };

    // Run combined map generation after a brief delay to let materials render first
    const timer = setTimeout(() => {
      generateAndSaveCombinedMap();
    }, 1500);

    return () => {
      isCancelled = true;
      clearTimeout(timer);
    };
  }, [fbx, url]);

  // Handle programmatic focus from Sidebar
  useEffect(() => {
    if (settings.targetPartId) {
      const hs = hotspots.find(h => h.id === settings.targetPartId);
      if (hs && onPartClick && activePartId !== hs.id) {
        onPartClick({
          id: hs.id,
          name: hs.partName,
          description: hs.description,
          position: hs.anchorPosition.clone().multiplyScalar(scaleFactor).add(new THREE.Vector3(...centeringOffset)),
          size: hs.size.clone().multiplyScalar(scaleFactor),
          mesh: hs.mesh
        });
      }
    }
  }, [settings.targetPartId, hotspots, onPartClick, scaleFactor, centeringOffset, activePartId]);

  // Extreme Memory leak prevention: Dispose materials & sub-meshes when fbx changes or unmounts
  useEffect(() => {
    return () => {
      if (fbx) {
        console.log("[FBXModel] 🧹 Unmount / Change cleanup: Disposing instanced model materials and backface passes...");
        fbx.traverse((child) => {
          if ((child as THREE.Mesh).isMesh) {
            const mesh = child as THREE.Mesh;
            
            // Dispose backface pass materials and meshes
            if (mesh.userData?.backFaceMesh) {
              const bMesh = mesh.userData.backFaceMesh as THREE.Mesh;
              if (bMesh.material) {
                const bMats = Array.isArray(bMesh.material) ? bMesh.material : [bMesh.material];
                bMats.forEach((m) => {
                  if (m && typeof m.dispose === "function") {
                    try { m.dispose(); } catch (err) { console.warn("Error disposing backFace Material:", err); }
                  }
                });
              }
              try { mesh.remove(bMesh); } catch(e) {}
            }
            if (mesh.userData?.backFaceMat) {
              const bMat = mesh.userData.backFaceMat;
              if (bMat && typeof bMat.dispose === "function") {
                try { bMat.dispose(); } catch (err) { console.warn("Error disposing backFaceMat userData:", err); }
              }
            }
            
            // Dispose normal materials assigned to the mesh
            if (mesh.material) {
              const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              mats.forEach((mat) => {
                if (mat) {
                  // Dispose maps of the material if they exist
                  if ((mat as any).map && typeof (mat as any).map.dispose === "function") { try { (mat as any).map.dispose(); } catch (e) {} }
                  if ((mat as any).normalMap && typeof (mat as any).normalMap.dispose === "function") { try { (mat as any).normalMap.dispose(); } catch (e) {} }
                  if ((mat as any).roughnessMap && typeof (mat as any).roughnessMap.dispose === "function") { try { (mat as any).roughnessMap.dispose(); } catch (e) {} }
                  if ((mat as any).metalnessMap && typeof (mat as any).metalnessMap.dispose === "function") { try { (mat as any).metalnessMap.dispose(); } catch (e) {} }
                  if ((mat as any).alphaMap && typeof (mat as any).alphaMap.dispose === "function") { try { (mat as any).alphaMap.dispose(); } catch (e) {} }
                  
                  if (typeof mat.dispose === "function") {
                    try { mat.dispose(); } catch (err) { console.warn("Error disposing Mesh Material:", err); }
                  }
                }
              });
            }
          }
        });
      }
    };
  }, [fbx]);

  if (!fbx) return null;

  return (
    <group ref={outerGroupRef}>
      <primitive key={url} object={fbx} />
      {hotspots.map((hs) => (
        <group key={hs.id} position={hs.anchorPosition}>
          <Html distanceFactor={15}>
            <div className="relative">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (onPartClick) {
                    onPartClick(activePartId === hs.id ? null : {
                      id: hs.id, name: hs.partName, description: hs.description,
                      position: hs.anchorPosition.clone().multiplyScalar(scaleFactor).add(new THREE.Vector3(...centeringOffset)),
                      size: hs.size.clone().multiplyScalar(scaleFactor), mesh: hs.mesh
                    });
                  }
                }}
                className={`w-6 h-6 sm:w-8 sm:h-8 rounded-full border-2 border-white shadow-2xl transition-all duration-300 transform hover:scale-110 ${
                  activePartId === hs.id ? 'bg-yellow-500 ring-[8px] ring-yellow-500/30 scale-110' : 'bg-yellow-600'
                }`}
              />
            </div>
          </Html>
        </group>
      ))}
    </group>
  );
};

export default FBXModel;