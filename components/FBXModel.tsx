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

// ─────────────────────────────────────────────────────────────────────────────
// Matching helpers
// ─────────────────────────────────────────────────────────────────────────────

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
 * Priority: exact name > partial include > wildcard fallback.
 * Returns null when nothing matches.
 */
function resolveBestSet(
  meshName: string,
  matName: string,
  sets: TextureSet[]
): TextureSet | null {
  // Score: 3 = exact match, 2 = substring, 1 = wildcard fallback, 0 = no match
  let best: TextureSet | null = null;
  let bestScore = 0;

  for (const set of sets) {
    if (!set.targets || set.targets.length === 0) {
      // Fallback bundle – only use when nothing better is found
      if (bestScore === 0) { best = set; bestScore = 0; }
      continue;
    }
    for (const candidate of [meshName, matName]) {
      const c = candidate.toLowerCase().trim();
      for (const pattern of set.targets) {
        const p = pattern.toLowerCase().trim();
        let score = 0;
        if (c === p) score = 4;
        else if (!p.includes('*') && (c.includes(p) || p.includes(c))) score = 3; 
        else if (p.includes('*') && matchesAny(c, [p])) score = 2;
        else if (p === '*') score = 1;

        if (score > bestScore) {
          bestScore = score;
          best = set;
        }
      }
    }
  }
  return best;
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
  hoveredPartId = null
}) => {
  const originalFbx = useLoader(FBXLoader, url);

  // Use refs for callbacks to prevent infinite loops when parent re-renders with new function identities
  const onMaterialsLoadedRef = useRef(onMaterialsLoaded);
  const onMeshesLoadedRef = useRef(onMeshesLoaded);
  const onAnimationsDetectedRef = useRef(onAnimationsDetected);

  useEffect(() => { onMaterialsLoadedRef.current = onMaterialsLoaded; }, [onMaterialsLoaded]);
  useEffect(() => { onMeshesLoadedRef.current = onMeshesLoaded; }, [onMeshesLoaded]);
  useEffect(() => { onAnimationsDetectedRef.current = onAnimationsDetected; }, [onAnimationsDetected]);

  const fbx = useMemo(() => {
    const clone = SkeletonUtils.clone(originalFbx);

    clone.traverse((child) => {
      if ((child as THREE.Mesh).isMesh) {
        const mesh = child as THREE.Mesh;
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

  const mixer = useMemo(() => new THREE.AnimationMixer(fbx), [fbx]);
  const actions = useMemo(() => {
    const res: { [key: string]: THREE.AnimationAction } = {};
    if (fbx.animations) fbx.animations.forEach(clip => { res[clip.name] = mixer.clipAction(clip); });
    return res;
  }, [mixer, fbx.animations]);

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
  const [internalExplodeFactor, setInternalExplodeFactor] = useState(0);
  const prevPlayingRef = useRef(false);
  const accumulatorRef = useRef(0);
  const frameTime = 1 / 25;
  const prevDirectionRef = useRef(settings.animationDirection);

  // ── Collect ALL texture URLs from textureSets + legacy settings ──────────
  useEffect(() => {
    // Use a Set to deduplicate URLs within this same effect run,
    // AND check textureCacheRef to skip already-loaded ones.
    const seen = new Set<string>();
    const toLoad: { url: string; isColor: boolean }[] = [];

    const add = (u: unknown, isColor: boolean) => {
      if (!u || typeof u !== 'string') return;
      if (textureCacheRef.current[u]) return; // already loaded
      if (seen.has(u)) return;                // duplicate in this batch
      seen.add(u);
      toLoad.push({ url: u, isColor });
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

    console.log(`[FBXModel] 📦 Queuing ${toLoad.length} unique textures to load`);

    toLoad.forEach(({ url: u, isColor }) => {
      const lo = u.toLowerCase();
      let loader: any = textureLoader.current;
      if (lo.endsWith('.tga')) loader = tgaLoader.current;
      else if (lo.endsWith('.dds')) loader = ddsLoader.current;
      loader.load(u, (tex: THREE.Texture) => {
        tex.colorSpace = isColor ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.needsUpdate = true;
        textureCacheRef.current[u] = tex;
        setTextureCache(prev => ({ ...prev, [u]: tex }));
      }, undefined, (err: any) => console.error(`[FBXModel] ❌ Failed: "${u}"`, err));
    });
  }, [textureSets, settings]);

  useEffect(() => { textureCacheRef.current = textureCache; }, [textureCache]);

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
  useFrame((_, delta) => {
    if (fbx) { fbx.position.copy(rootPos.current); fbx.rotation.copy(rootRot.current); fbx.scale.copy(rootScale.current); fbx.updateMatrixWorld(true); }
    if (mixer) {
      const isPlaying = settings.isPlayingAnimation;
      const isAnyRunning = Object.values(actions).some(a => a?.isRunning());
      if (isPlaying || isAnyRunning) {
        accumulatorRef.current += Math.min(delta, 0.1);
        while (accumulatorRef.current >= frameTime) { mixer.update(frameTime); accumulatorRef.current -= frameTime; }
      } else if (accumulatorRef.current > 0) { mixer.update(accumulatorRef.current); accumulatorRef.current = 0; }
    }
    const target = settings.isExploded ? 1.0 : 0.0;
    const nextFactor = THREE.MathUtils.lerp(internalExplodeFactor, target, 0.05);
    if (Math.abs(nextFactor - internalExplodeFactor) > 0.0001) setInternalExplodeFactor(nextFactor);
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
    fbx.traverse((child) => {
      if (!(child as THREE.Mesh).isMesh) return;
      const mesh = child as THREE.Mesh;
      if (mesh.name.endsWith('_BackPass') || mesh.name.endsWith('_BackFacePass')) return;

      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];

      materials.forEach((mat) => {
        if (!(mat instanceof THREE.MeshStandardMaterial) || !mat.userData.isPBR) return;

        // ── 1. Resolve best TextureSet for this mesh/material ──────────────
        const set = resolveBestSet(mesh.name, mat.name, textureSets);

        // ── 2. Helper to get a cached texture ─────────────────────────────
        const tex = (url: string | undefined) => (url ? textureCache[url] : undefined);

        // ── 3. Base color / albedo ─────────────────────────────────────────
        // textureSets takes priority over legacy materialMappings
        const baseColorTex = tex(set?.baseColor) ?? tex(settings.materialMappings?.[mat.name]);
        if (baseColorTex) { mat.map = baseColorTex; mat.color.set(0xffffff); }
        else { mat.map = mat.userData.originalMap || null; mat.color.copy(mat.userData.originalColor || new THREE.Color(0xffffff)); }

        // ── 4. Normal ──────────────────────────────────────────────────────
        const normalTex = tex(set?.normal) ?? tex(settings.normalMappings?.[mat.name]);
        if (normalTex) { mat.normalMap = normalTex; mat.normalScale.set(1, 1); }

        // ── 5. Metalness ───────────────────────────────────────────────────
        const metalTex = tex(set?.metalness) ?? tex(settings.metalMappings?.[mat.name]);
        if (metalTex) mat.metalnessMap = metalTex;

        // ── 6. Roughness ───────────────────────────────────────────────────
        const roughTex = tex(set?.roughness) ?? tex(settings.roughMappings?.[mat.name]);
        if (roughTex) mat.roughnessMap = roughTex;

        // ── 7. Alpha ───────────────────────────────────────────────────────
        const alphaTex = tex(set?.alpha) ?? tex(settings.alphaMappings?.[mat.name]);
        if (alphaTex) mat.alphaMap = alphaTex;
        else mat.alphaMap = mat.userData.originalAlphaMap || null;

        // ── 8. Emissive ────────────────────────────────────────────────────
        const emissiveTex = tex(set?.emissive) ?? tex(settings.emissiveMappings?.[mat.name]);
        if (emissiveTex) { mat.emissiveMap = emissiveTex; mat.emissive.set(0xffffff); mat.emissiveIntensity = settings.emissiveIntensity || 1.0; }

        // ── 9. AO ──────────────────────────────────────────────────────────
        const aoTex = tex(set?.ao) ?? tex(settings.aoMappings?.[mat.name]);
        if (aoTex) { mat.aoMap = aoTex; mat.aoMapIntensity = 1.0; }

        // ── 10. Height / displacement ──────────────────────────────────────
        const heightTex = tex(set?.height) ?? tex(settings.heightMappings?.[mat.name]);
        if (heightTex) { mat.displacementMap = heightTex; mat.displacementScale = 0.1; }

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
          mat.depthWrite = settings.opacity > 0.92; // Keep depth for near-opaque
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
    if (onAnimationsDetectedRef.current) onAnimationsDetectedRef.current(fbx.animations && fbx.animations.length > 0);
  }, [fbx, names, meshes]);

  useEffect(() => {
    if (onMaterialsLoadedRef.current && materialNames.length > 0) {
      onMaterialsLoadedRef.current(materialNames);
    }
  }, [materialNames]);

  useEffect(() => {
    if (onMeshesLoadedRef.current && meshNames.length > 0) {
      onMeshesLoadedRef.current(meshNames);
    }
  }, [meshNames]);

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

  return (
    <group position={centeringOffset} scale={scaleFactor}>
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