import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export class Menu3D {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.scene = new THREE.Scene();

    // Bug #4 fix: use game background color to eliminate obvious grey whitespace
    this.scene.background = new THREE.Color(0x0f172a);

    // Bug #4 fix: reduce d from 10→6 to zoom in and fill more of the viewport
    const aspect = window.innerWidth / window.innerHeight;
    const d = 6;
    this.camera = new THREE.OrthographicCamera(-d * aspect, d * aspect, d, -d, 0.1, 1000);
    // Position set later after cluster offset is known

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.container.appendChild(this.renderer.domElement);

    // Soft, clean lighting matching the Kenney reference
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.7));

    const sun = new THREE.DirectionalLight(0xffffff, 0.9);
    sun.position.set(15, 25, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.width = 2048;
    sun.shadow.mapSize.height = 2048;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 100;
    sun.shadow.camera.left = -20;
    sun.shadow.camera.right = 20;
    sun.shadow.camera.top = 20;
    sun.shadow.camera.bottom = -20;
    this.scene.add(sun);

    const fill = new THREE.DirectionalLight(0xaabbff, 0.3);
    fill.position.set(-10, 10, -10);
    this.scene.add(fill);

    // Tiled checkerboard floor like the reference image
    this._buildFloor();

    // Bug #4 fix: cluster brought closer to view center so models fill the right half
    this.cluster = new THREE.Group();
    this.cluster.position.set(3, 0, 0);
    this.scene.add(this.cluster);

    // Camera: isometric angle — zoomed in to fill the right 50% of screen with content
    this.camera.position.set(18, 14, 18);
    this.camera.lookAt(3, 0, 3);

    this.mixers = [];
    this.loader = new GLTFLoader();

    this.active = true;
    this.clock = new THREE.Clock();

    this.onResize = this.handleResize.bind(this);
    window.addEventListener('resize', this.onResize);

    this._loadAssets();
    this._animate();
  }

  _buildFloor() {
    // Huge endless checkerboard floor
    const tileSize = 2;
    const count = 40; // Much larger so it fills the view
    const half = (count * tileSize) / 2;

    const matA = new THREE.MeshLambertMaterial({ color: 0x4a4a52 });
    const matB = new THREE.MeshLambertMaterial({ color: 0x383840 });
    const geo = new THREE.BoxGeometry(tileSize, 0.12, tileSize);

    for (let x = 0; x < count; x++) {
      for (let z = 0; z < count; z++) {
        const mesh = new THREE.Mesh(geo, (x + z) % 2 === 0 ? matA : matB);
        mesh.position.set(-half + x * tileSize + tileSize / 2, -0.06, -half + z * tileSize + tileSize / 2);
        mesh.receiveShadow = true;
        this.scene.add(mesh);
      }
    }
  }

  async _loadAssets() {
    const load = (path) => this.loader.loadAsync(`/assets/Models/GLB format/${path}`);

    try {
      // Load ONLY verified existing GLB files
      const [
        treeGltf, treeFallGltf, pineCrookedGltf,
        graveGltf, graveBevelGltf, graveCrossLargeGltf,
        cryptSmallGltf, cryptLargeGltf,
        ironFenceBorderGltf, ironFenceCurveGltf,
        pumpkinGltf, pumpkinCarvedGltf, coffinGltf,
        pillarGltf, lanternGltf,
        survivorGltf, zombieGltf, ghostGltf
      ] = await Promise.all([
        load('pine.glb'), load('pine-fall.glb'), load('pine-crooked.glb'),
        load('gravestone-cross.glb'), load('gravestone-bevel.glb'), load('gravestone-cross-large.glb'),
        load('crypt-small.glb'), load('crypt-large.glb'),
        load('iron-fence-border.glb'), load('iron-fence-curve.glb'),
        load('pumpkin.glb'), load('pumpkin-carved.glb'), load('coffin.glb'),
        load('pillar-large.glb'), load('lantern-candle.glb'),
        load('character-keeper.glb'), load('character-zombie.glb'), load('character-ghost.glb')
      ]);

      const add = (gltf, x, z, scale = 1, rotY = 0) => {
        const m = gltf.scene.clone();
        m.position.set(x, 0, z);
        m.scale.setScalar(scale);
        m.rotation.y = rotY;
        m.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
        this.cluster.add(m);
        return m;
      };

      // === CRYPTS (centerpiece structures) ===
      add(cryptLargeGltf, -5, -5, 1.4);
      add(cryptSmallGltf, 4, -4, 1.2, -Math.PI / 2);

      // === IRON FENCE perimeter ===
      for (let i = 0; i < 5; i++) add(ironFenceBorderGltf, -6 + i * 2.4, -8, 1.0, 0);
      add(ironFenceCurveGltf, -7, -7, 1.0, 0);
      add(ironFenceCurveGltf, 5, -7, 1.0, -Math.PI / 2);
      for (let i = 0; i < 3; i++) add(ironFenceBorderGltf, -8, -5 + i * 2.4, 1.0, Math.PI / 2);
      for (let i = 0; i < 3; i++) add(ironFenceBorderGltf, 6, -5 + i * 2.4, 1.0, Math.PI / 2);

      // === PINE TREES framing the scene ===
      add(treeGltf,       -7, -2, 1.7);
      add(treeGltf,       -8,  1, 2.1);
      add(treeFallGltf,    7, -1, 1.9, 0.3);
      add(treeFallGltf,    7,  3, 1.5);
      add(pineCrookedGltf,-6,  4, 1.6, -0.3);
      add(treeGltf,        3,  5, 1.4, 0.5);

      // === GRAVESTONES scattered naturally ===
      add(graveGltf,          -2, -3, 1.0,  0.1);
      add(graveGltf,           0, -5, 1.0, -0.2);
      add(graveBevelGltf,     -4,  0, 1.0,  0.3);
      add(graveBevelGltf,      2, -2, 1.0, -0.1);
      add(graveCrossLargeGltf,-1,  1, 1.0,  0.4);
      add(graveCrossLargeGltf, 3, -4, 1.0, -0.3);
      add(graveGltf,           1, -6, 0.9,  0.2);

      // === COFFINS ===
      add(coffinGltf, -3, 3, 1.0,  Math.PI / 4);
      add(coffinGltf,  4, 1, 1.0, -Math.PI / 6);

      // === PILLARS at fence corners ===
      add(pillarGltf, -7, -8, 1.0);
      add(pillarGltf,  5, -8, 1.0);

      // === LANTERNS on pillars ===
      add(lanternGltf, -7, -6, 1.0);
      add(lanternGltf,  5, -6, 1.0);

      // === PUMPKINS ===
      add(pumpkinGltf,      -3, -1,  0.9,  0.5);
      add(pumpkinCarvedGltf, 0,  0,  0.8, -0.3);
      add(pumpkinGltf,       4, -2,  0.7,  1.2);
      add(pumpkinCarvedGltf,-5,  2,  0.9,  0.8);
      add(pumpkinGltf,       2,  3,  0.75,-0.5);
      add(pumpkinCarvedGltf,-1, -4.5,0.7,  0.2);

      // === SURVIVOR character ===
      const survivor = survivorGltf.scene;
      survivor.position.set(-2, 0, 2);
      survivor.scale.setScalar(1.3);
      survivor.rotation.y = Math.PI / 3;
      survivor.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      this.cluster.add(survivor);
      const sMix = new THREE.AnimationMixer(survivor);
      const sAnim = survivorGltf.animations.find(a => /idle/i.test(a.name));
      if (sAnim) sMix.clipAction(sAnim).play();
      this.mixers.push(sMix);

      // === ZOMBIE character ===
      const zombie = zombieGltf.scene;
      zombie.position.set(2, 0, -1);
      zombie.scale.setScalar(1.3);
      zombie.rotation.y = -Math.PI / 4;
      zombie.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      this.cluster.add(zombie);
      const zMix = new THREE.AnimationMixer(zombie);
      const zAnim = zombieGltf.animations.find(a => /idle/i.test(a.name));
      if (zAnim) zMix.clipAction(zAnim).play();
      this.mixers.push(zMix);

      // === GHOST floating above ===
      const ghost = ghostGltf.scene;
      ghost.position.set(1, 1.8, 4);
      ghost.scale.setScalar(1.1);
      ghost.rotation.y = Math.PI;
      ghost.traverse(c => { if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; } });
      this.cluster.add(ghost);
      const gMix = new THREE.AnimationMixer(ghost);
      const gAnim = ghostGltf.animations.find(a => /idle|float/i.test(a.name));
      if (gAnim) gMix.clipAction(gAnim).play();
      this.mixers.push(gMix);

    } catch (e) {
      console.error('Menu3D asset load error:', e);
    }
  }

  handleResize() {
    const aspect = window.innerWidth / window.innerHeight;
    const d = 6;  // Bug #4 fix: keep in sync with constructor
    this.camera.left = -d * aspect;
    this.camera.right = d * aspect;
    this.camera.top = d;
    this.camera.bottom = -d;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  _animate() {
    if (!this.active) return;
    requestAnimationFrame(this._animate.bind(this));
    const dt = this.clock.getDelta();
    this.mixers.forEach(m => m.update(dt));
    // Very slow elegant rotation — full revolution in ~30 seconds
    this.cluster.rotation.y += dt * 0.21;
    this.renderer.render(this.scene, this.camera);
  }

  destroy() {
    this.active = false;
    window.removeEventListener('resize', this.onResize);
    if (this.renderer) {
      // Bug #14 fix: dispose all Three.js GPU resources to prevent memory leaks
      // (1600 floor tile geometries + materials + character textures)
      this.mixers.forEach(m => m.stopAllAction());
      this.scene.traverse((object) => {
        if (object.isMesh) {
          object.geometry.dispose();
          const mats = Array.isArray(object.material) ? object.material : [object.material];
          mats.forEach(m => { if (m) m.dispose(); });
        }
      });
      this.renderer.dispose();
      this.container.innerHTML = '';
    }
  }
}
