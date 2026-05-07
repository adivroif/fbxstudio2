
import React from 'react';
import { Grid, MeshReflectorMaterial } from '@react-three/drei';
import * as THREE from 'three';

const Room: React.FC = () => {
  return (
    <group>
      {/* Floor with reflection */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -18, 0]} receiveShadow>
        <planeGeometry args={[200, 200]} />
        <MeshReflectorMaterial
          blur={[300, 100]}
          resolution={1024}
          mixBlur={1}
          mixStrength={40}
          roughness={1}
          depthScale={1.2}
          minDepthThreshold={0.4}
          maxDepthThreshold={1.4}
          color="#fdfbf7"
          metalness={0.5}
          mirror={0}
        />
      </mesh>

      {/* Grid for scale reference */}
      <Grid
        position={[0, -17.9, 0]}
        args={[200, 200]}
        cellSize={5}
        cellThickness={0.5}
        cellColor="#6366f1"
        sectionSize={25}
        sectionThickness={1}
        sectionColor="#6366f1"
        fadeDistance={100}
        fadeStrength={1}
        infiniteGrid
      />

      {/* Soft back wall */}
      <mesh position={[0, 80, -100]}>
        <planeGeometry args={[300, 200]} />
        <meshStandardMaterial color="#f5f2ed" roughness={1} />
      </mesh>

      {/* Side walls */}
      <mesh position={[-150, 80, 0]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[300, 200]} />
        <meshStandardMaterial color="#f0ede8" roughness={1} />
      </mesh>
      
      <mesh position={[150, 80, 0]} rotation={[0, -Math.PI / 2, 0]}>
        <planeGeometry args={[300, 200]} />
        <meshStandardMaterial color="#f0ede8" roughness={1} />
      </mesh>
    </group>
  );
};

export default Room;
