
import React from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';

interface CameraHandlerProps {
  targetView: { pos: THREE.Vector3, lookAt: THREE.Vector3 } | null;
  controlsRef: any;
  activePartMesh?: THREE.Mesh | null;
}

const CameraHandler: React.FC<CameraHandlerProps> = ({ targetView, controlsRef, activePartMesh }) => {
  const { camera } = useThree();
  useFrame(() => {
    if (controlsRef.current) {
      let trackingSucceeded = false;
      
      // Fully validate that the mesh is valid, loaded, and not disposed/stale
      if (
        activePartMesh && 
        activePartMesh.isMesh && 
        activePartMesh.geometry && 
        activePartMesh.geometry.attributes && 
        activePartMesh.geometry.attributes.position &&
        activePartMesh.parent
      ) {
        try {
          // Calculate current world position of the mesh for dynamic tracking
          const box = new THREE.Box3();
          box.setFromObject(activePartMesh);
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
          
          trackingSucceeded = true;
        } catch (err) {
          console.warn("[CameraHandler] Failed to calculate dynamic tracking for activePartMesh:", err);
        }
      }

      // Fallback if no active part tracking is active or if tracking failed/mesh is stale
      if (!trackingSucceeded && targetView) {
        try {
          camera.position.lerp(targetView.pos, 0.02);
          controlsRef.current.target.lerp(targetView.lookAt, 0.02);
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

export default CameraHandler;
