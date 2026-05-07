
import React from 'react';
import { ThreeElements } from '@react-three/fiber';
import * as THREE from 'three';

declare global {
  namespace React {
    namespace JSX {
      interface IntrinsicElements extends ThreeElements {}
    }
  }
}

export interface ColorVariant {
  name: string;
  mappings: Record<string, string>; // Base colors
  normalMappings?: Record<string, string>;
  metalMappings?: Record<string, string>;
  roughMappings?: Record<string, string>;
  alphaMappings?: Record<string, string>;
  emissiveMappings?: Record<string, string>;
  aoMappings?: Record<string, string>;
  heightMappings?: Record<string, string>;
  specularMappings?: Record<string, string>;
}

export interface MaterialSettings {
  opacity: number;
  metalness: number;
  roughness: number;
  emissiveIntensity: number;
  color: string;
  transparent: boolean;
  materialMappings: Record<string, string>;
  normalMappings: Record<string, string>;
  metalMappings: Record<string, string>;
  roughMappings: Record<string, string>;
  alphaMappings: Record<string, string>;
  emissiveMappings: Record<string, string>;
  aoMappings: Record<string, string>;
  heightMappings: Record<string, string>;
  specularMappings: Record<string, string>;
  textureMappings?: Record<string, Record<string, string>>; // Added for dynamic mapping
  hoveredMaterial: string | null;
  metalnessUrl?: string | null;
  roughnessUrl?: string | null;
  transparencyUrl?: string | null;
  shadowUrl?: string | null;
  eyesUrl?: string | null;
  isExploded: boolean;
  explodeFactor: number;
  isPlayingAnimation: boolean;
  animationDirection: 'forward' | 'backward';
  colorVariants: ColorVariant[];
  activeVariant: string | null;
  targetPartId?: string | null;
}

export interface MaterialMetadata {
  name: string;
  meshName?: string;
}

export interface TextureSet {
  /** Unique id for this bundle (used internally). */
  id: string;
  /**
   * Glob-style patterns that are matched against mesh.name / material.name.
   * If omitted the bundle is considered a "fallback" and applied to every
   * mesh that has no other match.
   */
  targets?: string[];
  // individual map URLs
  baseColor?: string;
  normal?: string;
  metalness?: string;
  roughness?: string;
  alpha?: string;
  emissive?: string;
  ao?: string;
  height?: string;
}

export interface SceneModelInstance {
  id: string;
  name: string;
  url: string;
  settings: MaterialSettings;
  detectedMaterials: string[]; // Changed from MaterialMetadata[]
  detectedMeshes: string[]; // Added to store all individual mesh names
  position: [number, number, number];
  hasAnimations?: boolean;
  isAutoMapped?: boolean;
  textureSets?: TextureSet[]; // Added for dynamic PBR texture sets
}

export interface ModelMetadata {
  name: string;
  size: string;
  triangleCount: number;
  materials: string[];
}

export interface ModelPart {
  id: string;
  modelName: string;
  partName: string;
  partKey: string;
  description: string;
  linkTo?: string;
}
