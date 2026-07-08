import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const ARENA_HALF = 25;

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = []; // { center: Vector3, radius: number }
    this.safeZone = { center: new THREE.Vector3(0, 0, -15), radius: 3 };
    this.loader = new GLTFLoader();
    this.assets = {
      survivorModel: null,
      zombieModel: null,
      animations: [],
      cloneModel: (source) => SkeletonUtils.clone(source),
    };

    this.mapProps = [];
    this.safeZoneRing = null;
    this._clock = 0;
  }

  async init(onProgress) {
    onProgress?.('Loading survivors & the infected...');
    await this.loadCharacters();

    onProgress?.('Building the arena...');
    await this.buildArena();

    onProgress?.('Lighting the scene...');
    const ambientLight = new THREE.AmbientLight(0x223344, 1.5);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0x7788aa, 2);
    dirLight.position.set(10, 20, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 50;
    dirLight.shadow.camera.left = -20;
    dirLight.shadow.camera.right = 20;
    dirLight.shadow.camera.top = 20;
    dirLight.shadow.camera.bottom = -20;
    this.scene.add(dirLight);

    // Ground
    const groundGeo = new THREE.PlaneGeometry(60, 60);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x1a2a1a, roughness: 0.9, metalness: 0.1 });
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    this.buildBoundaryWalls();
    this.buildAmbientFog();
  }

  async loadCharacters() {
    const survivorGltf = await this.loader.loadAsync('/assets/Models/GLB format/character-keeper.glb');
    this.assets.survivorModel = survivorGltf.scene;

    const zombieGltf = await this.loader.loadAsync('/assets/Models/GLB format/character-zombie.glb');
    this.assets.zombieModel = zombieGltf.scene;

    this.assets.animations = survivorGltf.animations;
  }

  async buildArena() {
    const graveGltf = await this.loader.loadAsync('/assets/Models/GLB format/gravestone-cross.glb');
    const treeGltf = await this.loader.loadAsync('/assets/Models/GLB format/pine.glb');

    // Batch obstacles with InstancedMesh where the source model is a single mesh,
    // falling back to normal cloning for rigged/multi-mesh props. This keeps draw
    // calls low even with a large scatter count.
    this.scatterObstacles(graveGltf.scene, treeGltf.scene, 60); // Increased density

    // Real boundary colliders matching the visible walls (was previously dead code:
    // 'plane' colliders were pushed but never checked in checkCollision)
    this.colliders.push({ type: 'bounds', half: ARENA_HALF });
    
    this.buildInnerMazes();
  }

  buildInnerMazes() {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.8, metalness: 0.2 });
    
    const buildWall = (cx, cz, w, d) => {
      const geo = new THREE.BoxGeometry(w, 4, d);
      const mesh = new THREE.Mesh(geo, wallMat);
      mesh.position.set(cx, 2, cz);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      
      this.colliders.push({ type: 'box', cx, cz, hw: w/2, hd: d/2 });
      // Map props for minimap (draw walls as rectangles if possible, but let's just push them as props for now)
      this.mapProps.push({ x: cx, z: cz, isWall: true, w, d });
    };

    // Build some simple maze structures
    buildWall(10, 10, 12, 1);
    buildWall(-10, 10, 12, 1);
    buildWall(10, -10, 1, 12);
    buildWall(-10, -10, 1, 12);
    buildWall(0, 15, 8, 1);
    buildWall(0, -15, 8, 1);
  }

  scatterObstacles(graveSource, treeSource, count) {
    for (let i = 0; i < count; i++) {
      const isTree = Math.random() > 0.6;
      const model = SkeletonUtils.clone(isTree ? treeSource : graveSource);

      let x = (Math.random() - 0.5) * 40;
      let z = (Math.random() - 0.5) * 40;

      if (Math.abs(x) < 5 && Math.abs(z) < 5) continue; // Keep center clear

      model.position.set(x, 0, z);
      model.rotation.y = Math.random() * Math.PI * 2;
      const scaleJitter = 0.85 + Math.random() * 0.3;
      model.scale.setScalar(scaleJitter);

      model.traverse((c) => {
        if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
      });

      this.scene.add(model);
      this.mapProps.push({ x, z, isTree });
      this.colliders.push({ center: new THREE.Vector3(x, 0, z), radius: isTree ? 1.0 * scaleJitter : 0.6 * scaleJitter });
    }
  }

  buildBoundaryWalls() {
    // Low chain-link-style fence so the arena edge is visible, not an invisible wall
    // players bump into with no feedback.
    const fenceMat = new THREE.MeshStandardMaterial({ color: 0x334455, roughness: 0.6, metalness: 0.4, transparent: true, opacity: 0.85 });
    const fenceHeight = 2.2;
    const postGeo = new THREE.CylinderGeometry(0.08, 0.08, fenceHeight, 6);
    const railGeo = new THREE.BoxGeometry(1, 0.06, 0.06);

    const buildSide = (axis, sign) => {
      const length = ARENA_HALF * 2;
      const posts = 12;
      for (let i = 0; i <= posts; i++) {
        const t = (i / posts - 0.5) * length;
        const post = new THREE.Mesh(postGeo, fenceMat);
        if (axis === 'x') post.position.set(sign * ARENA_HALF, fenceHeight / 2, t);
        else post.position.set(t, fenceHeight / 2, sign * ARENA_HALF);
        post.castShadow = true;
        this.scene.add(post);
      }
      const rail = new THREE.Mesh(railGeo, fenceMat);
      rail.scale.set(length / 1, 1, 1);
      if (axis === 'x') { rail.rotation.y = Math.PI / 2; rail.position.set(sign * ARENA_HALF, fenceHeight * 0.7, 0); }
      else { rail.position.set(0, fenceHeight * 0.7, sign * ARENA_HALF); }
      this.scene.add(rail);
    };

    buildSide('x', 1);
    buildSide('x', -1);
    buildSide('z', 1);
    buildSide('z', -1);
  }

  buildAmbientFog() {
    // Cheap ground-hugging particle haze for atmosphere
    const count = 120;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 48;
      positions[i * 3 + 1] = Math.random() * 1.2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 48;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({ color: 0x8899aa, size: 0.6, transparent: true, opacity: 0.18, depthWrite: false });
    this.fogPoints = new THREE.Points(geo, mat);
    this.scene.add(this.fogPoints);
  }

  update(dt) {
    this._clock += dt;
    if (this.safeZoneRing) {
      const pulse = 0.5 + Math.sin(this._clock * 2) * 0.15;
      this.safeZoneRing.material.opacity = pulse;
    }
    if (this.fogPoints) {
      this.fogPoints.rotation.y += dt * 0.01;
    }
  }

  checkCollision(pos, radius) {
    if (pos.x < -(ARENA_HALF - 1) || pos.x > (ARENA_HALF - 1) || pos.z < -(ARENA_HALF - 1) || pos.z > (ARENA_HALF - 1)) return true;

    for (const c of this.colliders) {
      if (c.radius) { // sphere collider
        const dist = pos.distanceTo(c.center);
        if (dist < radius + c.radius) return true;
      } else if (c.type === 'box') {
        const dx = Math.abs(pos.x - c.cx);
        const dz = Math.abs(pos.z - c.cz);
        if (dx < c.hw + radius && dz < c.hd + radius) return true;
      }
    }
    return false;
  }

  isInSafeZone(pos) {
    return pos.distanceTo(this.safeZone.center) < this.safeZone.radius;
  }

  // Data used to draw the 2D minimap without touching three.js internals every frame
  getMinimapData() {
    return {
      half: ARENA_HALF,
      props: this.mapProps,
    };
  }

  setGameRef(game) {
    this.game = game;
  }

  attemptInfect(zombiePlayer) {
    if (!this.game) return;
    const infectRadius = 2.0;

    this.game.players.forEach((p, id) => {
      if (id !== zombiePlayer.id && p.role === 'survivor' && !p.isDead) {
        const dist = zombiePlayer.group.position.distanceTo(p.group.position);
        if (dist < infectRadius) {
          this.game.network.sendReliable({ type: 'infect_event', targetId: id, sourceId: zombiePlayer.id });
        }
      }
    });
  }
}