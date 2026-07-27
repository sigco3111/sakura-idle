import * as THREE from 'three';
// TEMPORARY smoke-test scene — deleted once the real world modules land.
export default {
  name: 'smoke',
  order: 50,
  async setup(ctx) {
    const g = new THREE.Group();
    ctx.scene.background = new THREE.Color(0x8fb7e8);
    const hemi = new THREE.HemisphereLight(0xbfd9ff, 0x4a3b46, 1.2);
    const sun = new THREE.DirectionalLight(0xfff0e0, 3.0);
    sun.position.set(12, 18, 8); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    g.add(hemi, sun);
    const ground = new THREE.Mesh(
      new THREE.CircleGeometry(60, 64).rotateX(-Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0x5c7a4a, roughness: 0.9 }));
    ground.receiveShadow = true;
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.9, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0x6b4f3f, roughness: 0.8 }));
    trunk.position.y = 4; trunk.castShadow = true;
    const canopy = new THREE.Mesh(
      new THREE.IcosahedronGeometry(4.5, 2),
      new THREE.MeshStandardMaterial({ color: 0xffb7d5, roughness: 0.7 }));
    canopy.position.y = 9.5; canopy.castShadow = true;
    g.add(ground, trunk, canopy);
    return { object3D: g, update(dt, t) { canopy.rotation.y = t * 0.05; } };
  },
};
