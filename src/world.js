import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

const ARENA_HALF = 25;

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32.
// Must match the implementation in server/world-server.js exactly.
// ---------------------------------------------------------------------------
function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

function makePRNG(seed) {
  let s = typeof seed === 'string' ? hashSeed(seed) : seed >>> 0;
  return function () {
    s |= 0; s = s + 0x6d2b79f5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = []; // { type:'sphere', center:Vector3, radius } or { type:'box', cx,cz,hw,hd }
    this.safeZone = { center: new THREE.Vector3(0, 0, -15), radius: 3 };
    this.loader = new GLTFLoader();
    this.assets = {
      survivorModel: null,
      zombieModel: null,
      animations: [],
      cloneModel: (source) => SkeletonUtils.clone(source),
    };

    this.mapProps = [];   // { x, z, isWall?, w?, d? } for minimap
    this.safeZoneRing = null;
    this._clock = 0;

    this.powerups = new Map();
    this.traps = new Map();
    this.trapGeo = new THREE.PlaneGeometry(1.5, 1.5);
    this.trapMatSurvivor = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.4, depthWrite: false });
    this.trapMatZombie = new THREE.MeshBasicMaterial({ color: 0xef4444, transparent: true, opacity: 0.4, depthWrite: false });
  }

  /**
   * @param {function} onProgress  - loading progress callback
   * @param {string}   seed        - room code used to seed obstacle PRNG
   */
  async init(onProgress, seed = 'DEFAULT') {
    onProgress?.('Loading survivors & the infected...');
    await this.loadCharacters();

    onProgress?.('Building the arena...');
    await this.buildArena(seed);

    onProgress?.('Lighting the scene...');
    const ambientLight = new THREE.AmbientLight(0x4a3a6a, 2.2);
    this.scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffddaa, 2.8);
    dirLight.position.set(15, 25, 10);
    dirLight.castShadow = true;
    dirLight.shadow.mapSize.width = 2048;
    dirLight.shadow.mapSize.height = 2048;
    dirLight.shadow.camera.near = 0.5;
    dirLight.shadow.camera.far = 60;
    dirLight.shadow.camera.left = -25;
    dirLight.shadow.camera.right = 25;
    dirLight.shadow.camera.top = 25;
    dirLight.shadow.camera.bottom = -25;
    dirLight.shadow.bias = -0.0005;
    this.scene.add(dirLight);

    // Ground
    const groundGeo = new THREE.PlaneGeometry(60, 60);
    const groundMat = new THREE.MeshStandardMaterial({ color: 0x3d3a4e, roughness: 1.0, metalness: 0.0 });
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

    const pumpkinGltf = await this.loader.loadAsync('/assets/Models/GLB format/pumpkin.glb');
    this.assets.pumpkinModel = pumpkinGltf.scene;

    this.assets.animations = survivorGltf.animations;
  }

  async buildArena(seed) {
    const graveGltf = await this.loader.loadAsync('/assets/Models/GLB format/gravestone-cross.glb');
    const treeGltf = await this.loader.loadAsync('/assets/Models/GLB format/pine.glb');
    const fallTreeGltf = await this.loader.loadAsync('/assets/Models/GLB format/pine-fall.glb');
    const pumpkinGltf = this.assets.pumpkinModel;

    // Pass the seed so every client with the same room code gets the same layout
    this.scatterObstacles([graveGltf.scene, treeGltf.scene, fallTreeGltf.scene, pumpkinGltf], 90, seed);

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
      this.colliders.push({ type: 'box', cx, cz, hw: w / 2, hd: d / 2 });
      this.mapProps.push({ x: cx, z: cz, isWall: true, w, d });
    };

    // Must match MAZE_WALLS in server/world-server.js exactly
    buildWall(10,   10,  12, 1);
    buildWall(-10,  10,  12, 1);
    buildWall(10,  -10,   1, 12);
    buildWall(-10, -10,   1, 12);
    buildWall(0,    15,   8, 1);
    buildWall(0,   -15,   8, 1);
  }

  /**
   * Scatter obstacles using a seeded PRNG so every client with the same
   * seed produces the same layout. Algorithm and RNG calls must match
   * buildColliders() in server/world-server.js.
   */
  scatterObstacles(sources, count, seed) {
    const rng = makePRNG(seed);

    for (let i = 0; i < count; i++) {
      const srcIdx = Math.floor(rng() * sources.length);
      const source = sources[srcIdx];
      const model = SkeletonUtils.clone(source);

      const x = (rng() - 0.5) * 44;
      const z = (rng() - 0.5) * 44;
      const rotY = rng() * Math.PI * 2;
      const scaleJitter = 0.85 + rng() * 0.4;

      if (Math.abs(x) < 5 && Math.abs(z) < 5) continue;

      // Skip if it would overlap a maze wall (simple AABB vs point check)
      if (this._overlapsWall(x, z)) continue;

      model.position.set(x, 0, z);
      model.rotation.y = rotY;
      model.scale.setScalar(scaleJitter);

      model.traverse((c) => {
        if (c.isMesh) { c.castShadow = true; c.receiveShadow = true; }
      });

      this.scene.add(model);
      this.mapProps.push({ x, z });

      // Larger radius (0.5) so visual model and physics match — was 0.25 before
      this.colliders.push({
        type: 'sphere',
        center: new THREE.Vector3(x, 0, z),
        radius: 0.5 * scaleJitter,
      });
    }
  }

  /** Quick check: would placing an obstacle at (x,z) block a maze wall passage? */
  _overlapsWall(x, z) {
    const WALL_SAFE = 1.5;
    const walls = [
      { cx: 10, cz: 10, hw: 6, hd: 0.5 }, { cx: -10, cz: 10, hw: 6, hd: 0.5 },
      { cx: 10, cz: -10, hw: 0.5, hd: 6 }, { cx: -10, cz: -10, hw: 0.5, hd: 6 },
      { cx: 0, cz: 15, hw: 4, hd: 0.5 }, { cx: 0, cz: -15, hw: 4, hd: 0.5 },
    ];
    for (const w of walls) {
      if (Math.abs(x - w.cx) < w.hw + WALL_SAFE && Math.abs(z - w.cz) < w.hd + WALL_SAFE) return true;
    }
    return false;
  }

  buildBoundaryWalls() {
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

    buildSide('x', 1); buildSide('x', -1);
    buildSide('z', 1); buildSide('z', -1);
  }

  buildAmbientFog() {
    const count = 120;
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(count * 3);
    // Use simple deterministic layout for fog (aesthetic only, doesn't need seed)
    for (let i = 0; i < count; i++) {
      positions[i * 3]     = (Math.random() - 0.5) * 48;
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

    this.powerups.forEach(p => {
      p.rotation.y += dt * 3.0;
      p.position.y = Math.abs(Math.sin(this._clock * 4 + p.position.x)) * 1.5;
    });

    this.traps.forEach(t => {
      if (t.isEnemy) {
        t.mesh.rotation.y += dt * 3.0;
        t.mesh.position.y = Math.abs(Math.sin(this._clock * 4 + t.mesh.position.x)) * 1.5;
      }
    });

    if (this.particles) {
      for (let i = this.particles.length - 1; i >= 0; i--) {
        const p = this.particles[i];
        p.life -= dt * 2.0;
        if (p.mesh) {
          p.mesh.position.addScaledVector(p.vel, dt);
          p.vel.y -= dt * 15;
          p.mesh.scale.setScalar(Math.max(0, p.life));
        }
        if (p.light) p.light.intensity = p.life * 5;
        if (p.life <= 0) {
          if (p.mesh) this.scene.remove(p.mesh);
          if (p.light) this.scene.remove(p.light);
          this.particles.splice(i, 1);
        }
      }
    }
  }

  spawnPowerup(id, x, z) {
    if (this.powerups.has(id)) return;
    const mesh = SkeletonUtils.clone(this.assets.pumpkinModel);
    mesh.position.set(x, 0, z);
    const light = new THREE.PointLight(0xffa500, 2, 4);
    light.position.set(0, 0.5, 0);
    mesh.add(light);
    mesh.traverse((c) => {
      if (c.isMesh) {
        c.material = c.material.clone();
        c.material.emissive = new THREE.Color(0xffa500);
        c.material.emissiveIntensity = 0.6;
      }
    });
    this.scene.add(mesh);
    this.powerups.set(id, mesh);
  }

  removePowerup(id) {
    const mesh = this.powerups.get(id);
    if (mesh) { this.scene.remove(mesh); this.powerups.delete(id); }
  }

  spawnTrap(id, x, z, role, isEnemy) {
    if (this.traps.has(id)) return;
    let mesh;
    if (isEnemy) {
      mesh = SkeletonUtils.clone(this.assets.pumpkinModel);
      const light = new THREE.PointLight(0xffa500, 2, 4);
      light.position.set(0, 0.5, 0);
      mesh.add(light);
      mesh.traverse((c) => {
        if (c.isMesh) {
          c.material = c.material.clone();
          c.material.emissive = new THREE.Color(0xffa500);
          c.material.emissiveIntensity = 0.6;
        }
      });
      mesh.position.set(x, 0, z);
    } else {
      mesh = new THREE.Mesh(this.trapGeo, role === 'zombie' ? this.trapMatZombie : this.trapMatSurvivor);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(x, 0.05, z);
    }
    this.scene.add(mesh);
    this.traps.set(id, { mesh, role, x, z, isEnemy });
  }

  removeTrap(id) {
    const t = this.traps.get(id);
    if (t) {
      this.triggerTrapEffect(t.x, t.z, t.role);
      this.scene.remove(t.mesh);
      this.traps.delete(id);
    }
  }

  triggerTrapEffect(x, z, role) {
    const color = role === 'zombie' ? 0xa855f7 : 0xf59e0b;
    const geo = new THREE.IcosahedronGeometry(0.2, 0);
    const mat = new THREE.MeshBasicMaterial({ color });
    for (let i = 0; i < 15; i++) {
      const p = new THREE.Mesh(geo, mat);
      p.position.set(x, 0.5, z);
      const vel = new THREE.Vector3((Math.random() - 0.5) * 10, Math.random() * 8, (Math.random() - 0.5) * 10);
      this.scene.add(p);
      if (!this.particles) this.particles = [];
      this.particles.push({ mesh: p, vel, life: 1.0 });
    }
    const flash = new THREE.PointLight(color, 5, 8);
    flash.position.set(x, 1, z);
    this.scene.add(flash);
    this.particles.push({ light: flash, life: 1.0 });
  }

  checkCollision(pos, radius) {
    if (pos.x < -(ARENA_HALF - 1) || pos.x > (ARENA_HALF - 1) ||
        pos.z < -(ARENA_HALF - 1) || pos.z > (ARENA_HALF - 1)) return true;

    for (const c of this.colliders) {
      if (c.type === 'sphere' && c.center) {
        // Bug #17 fix: removed unreachable legacy else-if (was dead code)
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

  getMinimapData() {
    return { half: ARENA_HALF, props: this.mapProps };
  }
}