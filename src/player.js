import * as THREE from 'three';

// Remote players are rendered INTERP_DELAY_TICKS behind the latest
// server tick to smooth over packet-arrival jitter.
// At 20Hz (50ms/tick) this is 100ms — same as before but now tick-based.
const INTERP_DELAY_TICKS = 2;

export class Player {
  constructor(id, role, scene, assets, displayName = null) {
    this.id = id;
    this.role = role;
    this.scene = scene;
    this.assets = assets;
    this.displayName = displayName || `Player ${id.slice(0, 4)}`;

    this.group = new THREE.Group();
    this.scene.add(this.group);

    this.model = null;
    this.mixer = null;
    this.actions = {};
    this.currentAction = '';

    this.speed = this.role === 'zombie' ? 5.5 : 5.0;

    // Snapshot buffer for remote interpolation: [{ tick, pos, rot, anim, powerups }]
    // Sorted by tick ascending. New snapshots are insert-sorted; stale ones dropped.
    this.snapshots = [];
    this._lastAppliedTick = -1;

    this.targetPos = new THREE.Vector3();
    this.targetRot = 0;

    this.isDead = false;
    this.isExtracted = false;
    this.actionCooldown = 0;
    this._footstepTimer = 0;

    this.onFootstep = null;
    this.onAttack = null;

    this.nameTagSprite = null;

    // Visual Effects
    this.shieldGeo = new THREE.TorusGeometry(1.2, 0.1, 8, 24);
    this.shieldMatSurvivor = new THREE.MeshBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.0, depthWrite: false });
    this.shieldMatZombie = new THREE.MeshBasicMaterial({ color: 0xa855f7, transparent: true, opacity: 0.0, depthWrite: false });
    this.shieldMesh = new THREE.Mesh(this.shieldGeo, this.shieldMatSurvivor);
    this.shieldMesh.rotation.x = Math.PI / 2;
    this.shieldMesh.position.y = 1.0;
    this.group.add(this.shieldMesh);

    this.trailGeo = new THREE.PlaneGeometry(0.1, 1.0);
    this.trailMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthWrite: false });
    this.trails = [];

    this.activePowerups = { speed: false, shield: false, aura: false };

    this.setModel(this.role);
    this.buildNameTag();
  }

  buildNameTag() {
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    const draw = (text, color) => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 32px Outfit, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(0, 8, canvas.width, 40);
      ctx.fillStyle = color;
      ctx.fillText(text, canvas.width / 2, 38);
    };
    draw(this.displayName, this.role === 'zombie' ? '#ef4444' : '#10b981');

    const texture = new THREE.CanvasTexture(canvas);
    const mat = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(mat);
    sprite.scale.set(1.6, 0.4, 1);
    sprite.position.y = 2.3;
    this.group.add(sprite);
    this.nameTagSprite = { sprite, canvas, ctx, draw };
  }

  updateNameTagColor() {
    if (!this.nameTagSprite) return;
    this.nameTagSprite.draw(this.displayName, this.role === 'zombie' ? '#ef4444' : '#10b981');
    this.nameTagSprite.sprite.material.map.needsUpdate = true;
  }

  setModel(role) {
    if (this.model) this.group.remove(this.model);
    this.role = role;
    this.speed = this.role === 'zombie' ? 5.5 : 5.0;
    const sourceModel = role === 'survivor' ? this.assets.survivorModel : this.assets.zombieModel;
    this.model = this.assets.cloneModel(sourceModel);
    this.model.traverse((child) => {
      if (child.isMesh) { child.castShadow = true; child.receiveShadow = true; }
    });
    this.group.add(this.model);
    this.mixer = new THREE.AnimationMixer(this.model);
    this.actions = {};
    this.assets.animations.forEach((clip) => {
      this.actions[clip.name] = this.mixer.clipAction(clip);
    });
    this.playAnimation('idle');
    this.updateNameTagColor();
  }

  playAnimation(name, loop = true) {
    if (this.currentAction === name) return;
    let action = this.actions[name];
    if (!action) {
      action = this.actions['idle'];
      name = 'idle';
      if (!action) return;
    }
    const prev = this.actions[this.currentAction];
    if (prev) prev.fadeOut(0.2);
    action.reset();
    action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce);
    action.clampWhenFinished = !loop;
    action.fadeIn(0.2);
    action.play();
    this.currentAction = name;
  }

  infect() {
    this.isDead = true;
    this.playAnimation('die', false);
    setTimeout(() => {
      this.setModel('zombie');
      this.isDead = false;
      this.playAnimation('idle');
    }, 2000);
  }

  // ---- Local player update (client-side prediction) ----
  // Returns { move, action } for sending to server as input message.
  updateLocal(dt, input, world, activePowerups = null) {
    if (activePowerups) {
      this.activePowerups.speed = activePowerups.speed > 0;
      this.activePowerups.shield = activePowerups.shield > 0;
      this.activePowerups.aura = activePowerups.aura > 0;
    }

    this.updateVisualEffects(dt);

    if (this.isDead || this.isExtracted) {
      this.mixer?.update(dt);
      return { move: { x: 0, y: 0 }, action: false };
    }

    if (this.actionCooldown > 0) this.actionCooldown -= dt;

    let animToPlay = 'idle';
    const move = input.getMovement();

    if (move.x !== 0 || move.y !== 0) {
      const moveVec = new THREE.Vector3(move.x, 0, move.y).normalize();
      const targetAngle = Math.atan2(moveVec.x, moveVec.z);
      let diff = targetAngle - this.group.rotation.y;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      this.group.rotation.y += diff * 10 * dt;

      const step = moveVec.multiplyScalar(this.speed * dt);
      const newPos = this.group.position.clone().add(step);

      if (!world.checkCollision(newPos, 0.5)) {
        this.group.position.copy(newPos);
      } else {
        const posX = this.group.position.clone(); posX.x += step.x;
        const posZ = this.group.position.clone(); posZ.z += step.z;
        if (!world.checkCollision(posX, 0.5)) this.group.position.copy(posX);
        else if (!world.checkCollision(posZ, 0.5)) this.group.position.copy(posZ);
      }

      animToPlay = 'sprint';
      this._footstepTimer -= dt;
      if (this._footstepTimer <= 0) {
        this.onFootstep?.(this);
        this._footstepTimer = this.role === 'zombie' ? 0.32 : 0.28;
      }
    } else {
      this._footstepTimer = 0;
    }

    const action = input.isActionPressed();
    if (action && this.actionCooldown <= 0 && this.role === 'zombie') {
      animToPlay = 'attack-melee-right';
      this.actionCooldown = 1.0;
      this.onAttack?.(this);
      // NOTE: Server decides the actual hit — we just play the animation and send input
    }

    if (this.actionCooldown > 0 && this.currentAction === 'attack-melee-right') {
      animToPlay = this.currentAction;
    }

    this.playAnimation(animToPlay, animToPlay !== 'attack-melee-right');
    this.mixer?.update(dt);

    return { move, action };
  }

  // ---- Server reconciliation (called when a snapshot arrives for the local player) ----
  // serverPos is the authoritative position the server recorded for us at serverTick.
  reconcile(serverPos, serverTick) {
    const dx = serverPos.x - this.group.position.x;
    const dz = serverPos.z - this.group.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    
    // If we're within 1.5 meters of the server's last known position, trust our local 
    // predicted movement. This prevents rubber-banding ("jamming") since the server 
    // snapshot is always in the past due to RTT.
    if (dist < 1.5) return;

    // Lerp-correct rather than snap to avoid rubber-banding flicker
    const alpha = Math.min(1, dist * 0.4); // stronger correction the further we are
    this.group.position.x += (serverPos.x - this.group.position.x) * alpha;
    this.group.position.z += (serverPos.z - this.group.position.z) * alpha;
  }

  // ---- Remote player snapshot ingestion ----
  // Insert-sorted by tick so out-of-order UDP packets don't corrupt the buffer.
  applyNetworkState(state) {
    // Role change triggers infect animation
    if (state.role !== this.role && !this.isDead) {
      if (state.role === 'zombie') this.infect();
    }

    // Drop stale snapshots (older than our current render position)
    if (state.tick <= this._lastAppliedTick - INTERP_DELAY_TICKS) return;

    const entry = {
      tick: state.tick,
      pos: new THREE.Vector3(state.x, 0, state.z),
      rot: state.rotY,
      anim: state.anim,
      powerups: state.powerups,
    };

    // Insert-sort ascending by tick
    let inserted = false;
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i].tick <= entry.tick) {
        this.snapshots.splice(i + 1, 0, entry);
        inserted = true;
        break;
      }
    }
    if (!inserted) this.snapshots.unshift(entry);

    // Keep buffer bounded — drop very old entries
    while (this.snapshots.length > 20) this.snapshots.shift();
  }

  // ---- Remote player interpolation (tick-based, no Date.now()) ----
  updateRemote(dt, currentServerTick) {
    // The tick we want to render: server's current tick minus delay
    const renderTick = currentServerTick - INTERP_DELAY_TICKS;

    // Drop snapshots that are now behind the render window
    while (this.snapshots.length > 2 && this.snapshots[1].tick <= renderTick) {
      this._lastAppliedTick = this.snapshots[0].tick;
      this.snapshots.shift();
    }

    if (this.snapshots.length >= 2) {
      const a = this.snapshots[0];
      const b = this.snapshots[1];
      const span = (b.tick - a.tick) || 1;
      const alpha = Math.max(0, Math.min(1, (renderTick - a.tick) / span));

      this.targetPos.lerpVectors(a.pos, b.pos, alpha);

      let diff = b.rot - a.rot;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      this.targetRot = a.rot + diff * alpha;

      if (!this.isDead && b.anim) {
        this.playAnimation(b.anim, b.anim !== 'attack-melee-right' && b.anim !== 'die');
      }

      this.group.position.copy(this.targetPos);
      this.group.rotation.y = this.targetRot;

    } else if (this.snapshots.length === 1) {
      this.group.position.lerp(this.snapshots[0].pos, 10 * dt);
    }

    this.mixer?.update(dt);

    // Apply powerup visuals from latest snapshot
    if (this.snapshots.length >= 1) {
      const latest = this.snapshots[this.snapshots.length - 1];
      if (latest.powerups) {
        this.activePowerups.speed = !!latest.powerups.speed;
        this.activePowerups.shield = !!latest.powerups.shield;
        this.activePowerups.aura = !!latest.powerups.aura;
      }
    }

    this.updateVisualEffects(dt);
  }

  updateVisualEffects(dt) {
    if (this.activePowerups.shield || this.activePowerups.aura) {
      this.shieldMesh.material = this.role === 'zombie' ? this.shieldMatZombie : this.shieldMatSurvivor;
      this.shieldMesh.material.opacity = 0.6 + Math.sin(Date.now() * 0.005) * 0.2;
      this.shieldMesh.rotation.z += dt * 2;
    } else {
      this.shieldMesh.material.opacity = 0;
    }

    if (this.activePowerups.speed && (Math.abs(this.group.position.x - this.targetPos.x) > 0.1 || this.mixer)) {
      if (Math.random() < 0.4) {
        const trail = new THREE.Mesh(this.trailGeo, this.trailMat.clone());
        trail.position.copy(this.group.position);
        trail.position.y = 0.1;
        trail.rotation.x = -Math.PI / 2;
        trail.rotation.z = this.group.rotation.y + (Math.random() - 0.5) * 0.5;
        this.scene.add(trail);
        this.trails.push({ mesh: trail, life: 1.0 });
      }
    }

    for (let i = this.trails.length - 1; i >= 0; i--) {
      const t = this.trails[i];
      t.life -= dt * 3.0;
      t.mesh.material.opacity = t.life * 0.5;
      if (t.life <= 0) {
        this.scene.remove(t.mesh);
        this.trails.splice(i, 1);
      }
    }
  }

  destroy() {
    this.scene.remove(this.group);
  }
}