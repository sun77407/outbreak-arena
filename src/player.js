import * as THREE from 'three';
import { predictTick } from './predict.js';
import { BASE_SPEED_SURV, BASE_SPEED_ZOMBIE, POWERUP_SPEED_MULT, TICK_MS } from './constants.js';

// Default interpolation delay for remote players.
// The Game increases this adaptively based on measured arrival jitter.
const DEFAULT_INTERP_DELAY_TICKS = 4;  // 200ms at 20Hz
const MAX_EXTRAPOLATE_TICKS = 3;        // dead-reckoning cap when buffer empties
const MAX_INPUT_BUFFER = 120;           // ~4s at 30Hz — covers any realistic RTT

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

    this.speed = this.role === 'zombie' ? BASE_SPEED_ZOMBIE : BASE_SPEED_SURV;

    // Snapshot buffer for remote interpolation: [{ tick, pos, rot, anim, powerups }]
    // Sorted by tick ascending. New snapshots are insert-sorted; stale ones dropped.
    this.snapshots = [];
    this._lastAppliedTick = -1;
    this._interpDelayTicks = DEFAULT_INTERP_DELAY_TICKS;

    // Arrival jitter tracking (ring buffer of 10 inter-arrival deltas in ms)
    this._arrivalTimes = [];
    this._lastArrivalTime = null;

    this.targetPos = new THREE.Vector3();
    this.targetRot = 0;

    this.isDead = false;
    this.isExtracted = false;
    this.actionCooldown = 0;
    this.jumpCooldown = 0;
    this.slideCooldown = 0;
    this.isJumping = false;
    this.isSliding = false;
    this.jumpTimer = 0;
    this.slideTimer = 0;
    this.kartYaw = Math.PI; // default facing direction
    this._footstepTimer = 0;

    this.onFootstep = null;
    this.onAttack = null;

    this.nameTagSprite = null;

    // --- Client-side prediction state (local player only) ---
    // Input history buffer: [{ seq, move, action, dt, speedAtTime }]
    // Used to replay inputs after server reconciliation.
    this._inputBuffer = [];
    // Last reconciliation error (metres) — exposed for debug overlay.
    this._predictionError = 0;
    // Smooth correction vector applied over ~10 frames after small drift.
    this._correction = new THREE.Vector3();

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
  /**
   * Update local player every frame.
   *
   * NOW USES predictTick() — identical collision math to the server — so the
   * input buffer can be replayed after reconciliation without diverging.
   *
   * @param {number}   dt              frame delta (seconds)
   * @param {object}   input           Input manager
   * @param {object}   world           World instance (used only for checkCollision
   *                                    on the Three.js side for the HUD overlay;
   *                                    prediction uses world.flatColliders)
   * @param {object}   activePowerups  local copy of powerup timers { speed, shield, aura }
   * @param {Array}    flatColliders   world.flatColliders — flat format for predict.js
   * @param {number}   seq             current input sequence number (from network)
   * @returns {{ move, action }}
   */
  updateLocal(dt, input, world, activePowerups, flatColliders, seq, cameraYaw = Math.PI, cameraMode = 'kart') {
    if (activePowerups) {
      this.activePowerups.speed  = activePowerups.speed  > 0;
      this.activePowerups.shield = activePowerups.shield > 0;
      this.activePowerups.aura   = activePowerups.aura   > 0;
    }

    this.updateVisualEffects(dt);

    // Apply any pending smooth correction (from small reconciliation drifts)
    if (this._correction.lengthSq() > 0.0001) {
      const step = this._correction.clone().multiplyScalar(Math.min(1, 10 * dt));
      this.group.position.add(step);
      this._correction.sub(step);
    }

    if (this.isDead || this.isExtracted) {
      this.mixer?.update(dt);
      return { move: { x: 0, y: 0 }, action: false };
    }

    if (this.actionCooldown > 0) this.actionCooldown -= dt;

    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    if (this.slideCooldown > 0) this.slideCooldown -= dt;

    if (input.jumpPressed && this.jumpCooldown <= 0 && !this.isJumping) {
      this.isJumping = true;
      this.jumpTimer = 0.8;
      this.jumpCooldown = 3.0;
    }
    
    if (input.slidePressed && this.slideCooldown <= 0 && !this.isSliding) {
      this.isSliding = true;
      this.slideTimer = 1.0;
      this.slideCooldown = 3.0;
    }

    let animToPlay = 'idle';
    const rawMove = input.getMovement();
    const move = { x: 0, y: 0 };

    if (this.isJumping) {
      this.jumpTimer -= dt;
      if (this.jumpTimer <= 0) {
        this.isJumping = false;
        this.group.position.y = 0;
      } else {
        this.group.position.y = Math.sin(Math.PI * (0.8 - this.jumpTimer) / 0.8) * 1.5;
        animToPlay = 'jump';
      }
    } else {
      this.group.position.y = 0;
    }

    if (this.isSliding) {
      this.slideTimer -= dt;
      if (this.slideTimer <= 0) {
        this.isSliding = false;
      } else {
        if (!this.isJumping) animToPlay = 'crouch';
      }
    }

    if (cameraMode === 'kart') {
      // Kart Steering
      if (rawMove.x !== 0) {
        this.kartYaw -= rawMove.x * 4.0 * dt;
      }

      // Align character visual to kartYaw
      let yawDiff = this.kartYaw - this.group.rotation.y;
      while (yawDiff < -Math.PI) yawDiff += Math.PI * 2;
      while (yawDiff > Math.PI)  yawDiff -= Math.PI * 2;
      this.group.rotation.y += yawDiff * 15 * dt;

      if (rawMove.y !== 0) {
        const speedMultiplier = -rawMove.y; // W is +1, S is -1
        move.x = Math.sin(this.kartYaw) * speedMultiplier;
        move.y = Math.cos(this.kartYaw) * speedMultiplier;
      }
    } else {
      // Manual Controls (Strafe relative to cameraYaw)
      if (rawMove.x !== 0 || rawMove.y !== 0) {
        const sin = Math.sin(cameraYaw);
        const cos = Math.cos(cameraYaw);
        move.x = rawMove.x * cos + rawMove.y * sin;
        move.y = -rawMove.x * sin + rawMove.y * cos;
        
        const len = Math.sqrt(move.x * move.x + move.y * move.y);
        if (len > 1) {
          move.x /= len;
          move.y /= len;
        }
      }
    }

    if (move.x !== 0 || move.y !== 0) {
      // Speed mirrors server gameTick() exactly
      const baseSpeed = this.role === 'zombie' ? BASE_SPEED_ZOMBIE : BASE_SPEED_SURV;
      const speed = activePowerups?.speed > 0 ? baseSpeed * POWERUP_SPEED_MULT : baseSpeed;

      // Use predictTick() — same applyMoveFlat math as the server — instead of
      // the old Three.js-based movement so prediction stays in sync.
      const result = predictTick(
        this.group.position.x,
        this.group.position.z,
        move, speed, dt, flatColliders
      );
      this.group.position.x = result.x;
      this.group.position.z = result.z;
      
      if (cameraMode === 'manual' && result.rotY !== null) {
        // Smooth rotation (same slerp as before)
        let diff = result.rotY - this.group.rotation.y;
        while (diff < -Math.PI) diff += Math.PI * 2;
        while (diff > Math.PI)  diff -= Math.PI * 2;
        this.group.rotation.y += diff * 10 * dt;
        this.kartYaw = this.group.rotation.y; // keep kartYaw synced for mode switching
      }

      if (!this.isJumping && !this.isSliding) {
        animToPlay = 'sprint';
      }
      this._footstepTimer -= dt;
      if (this._footstepTimer <= 0) {
        this.onFootstep?.(this);
        this._footstepTimer = this.role === 'zombie' ? 0.32 : 0.28;
      }
    } else {
      this._footstepTimer = 0;
    }

    // Store this frame's input in the history buffer for reconciliation replay.
    if (flatColliders && seq !== undefined) {
      const baseSpeed = this.role === 'zombie' ? BASE_SPEED_ZOMBIE : BASE_SPEED_SURV;
      this._inputBuffer.push({
        seq,
        move: { x: move.x, y: move.y },
        action: input.isActionPressed(),
        dt,
        speed: activePowerups?.speed > 0 ? baseSpeed * POWERUP_SPEED_MULT : baseSpeed,
      });
      if (this._inputBuffer.length > MAX_INPUT_BUFFER) this._inputBuffer.shift();
    }

    const action = input.isActionPressed();
    if (action && this.actionCooldown <= 0 && this.role === 'zombie') {
      animToPlay = 'attack-melee-right';
      this.actionCooldown = 1.0;
      this.onAttack?.(this);
    }

    if (this.actionCooldown > 0 && this.currentAction === 'attack-melee-right') {
      animToPlay = this.currentAction;
    }

    this.playAnimation(animToPlay, animToPlay !== 'attack-melee-right');
    this.mixer?.update(dt);

    return { move, action };
  }

  /**
   * Server reconciliation — called in handleSnapshot() for the local player.
   *
   * Three-threshold strategy:
   *   < 0.05m  → floating-point noise, ignore
   *   < 0.5m   → small drift — apply smooth correction over ~10 frames (no replay needed)
   *   ≥ 0.5m   → hard mismatch — snap to server pos, replay buffered inputs
   *
   * @param {{ x, z }} serverPos   authoritative position from snapshot
   * @param {number}   confirmedSeq  last input seq the server processed (state.seq)
   * @param {Array}    flatColliders world.flatColliders for replaying inputs
   */
  reconcile(serverPos, confirmedSeq, flatColliders) {
    const dx = serverPos.x - this.group.position.x;
    const dz = serverPos.z - this.group.position.z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    this._predictionError = dist; // expose for debug overlay

    if (dist < 0.05) return; // floating-point noise — skip

    if (dist < 0.5) {
      // Small drift: accumulate into smooth correction vector instead of snapping.
      // _correction is applied gradually in updateLocal() each frame.
      this._correction.x += dx;
      this._correction.z += dz;
      return;
    }

    // Hard mismatch: snap to server authoritative position
    this.group.position.x = serverPos.x;
    this.group.position.z = serverPos.z;
    this._correction.set(0, 0, 0);

    // Replay all unacknowledged inputs (those after confirmedSeq)
    if (flatColliders && confirmedSeq !== undefined) {
      // Discard inputs the server has already processed
      const startIdx = this._inputBuffer.findIndex(e => e.seq > confirmedSeq);
      if (startIdx === -1) return; // nothing to replay

      let rx = serverPos.x;
      let rz = serverPos.z;
      for (let i = startIdx; i < this._inputBuffer.length; i++) {
        const entry = this._inputBuffer[i];
        const result = predictTick(rx, rz, entry.move, entry.speed, entry.dt, flatColliders);
        rx = result.x;
        rz = result.z;
      }
      this.group.position.x = rx;
      this.group.position.z = rz;
    }
  }

  /** Allow Game to tune interp delay based on measured network jitter. */
  setInterpDelay(ticks) {
    this._interpDelayTicks = Math.max(2, Math.min(8, Math.round(ticks)));
  }

  /** Returns rolling jitter stddev in ms (for adaptive interp delay). */
  getJitter() {
    if (this._arrivalTimes.length < 2) return 0;
    const mean = this._arrivalTimes.reduce((a, b) => a + b, 0) / this._arrivalTimes.length;
    const variance = this._arrivalTimes.reduce((a, b) => a + (b - mean) ** 2, 0) / this._arrivalTimes.length;
    return Math.sqrt(variance);
  }

  // ---- Remote player snapshot ingestion ----
  // Insert-sorted by tick; tracks arrival jitter for adaptive interp delay.
  applyNetworkState(state) {
    // Track arrival intervals for jitter measurement
    const now = performance.now();
    if (this._lastArrivalTime !== null) {
      const interval = now - this._lastArrivalTime;
      this._arrivalTimes.push(interval);
      if (this._arrivalTimes.length > 10) this._arrivalTimes.shift();
    }
    this._lastArrivalTime = now;

    // Role change triggers infect animation
    if (state.role !== this.role && !this.isDead) {
      if (state.role === 'zombie') this.infect();
    }

    // Drop stale snapshots (older than our current render position)
    if (state.tick <= this._lastAppliedTick - this._interpDelayTicks) return;

    const entry = {
      tick: state.tick,
      pos: new THREE.Vector3(state.x, 0, state.z),
      rot: state.rotY,
      anim: state.anim,
      powerups: state.powerups,
    };

    if (this.snapshots.length > 0) {
      const prevEntry = this.snapshots[this.snapshots.length - 1];
      const tickDelta = entry.tick - prevEntry.tick;
      if (tickDelta > 0) {
        const dtSeconds = tickDelta * (TICK_MS / 1000);
        entry.vel = new THREE.Vector3(
          (entry.pos.x - prevEntry.pos.x) / dtSeconds,
          0,
          (entry.pos.z - prevEntry.pos.z) / dtSeconds
        );
      }
    }

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
    // The tick we want to render: server's current tick minus adaptive delay
    const renderTick = currentServerTick - this._interpDelayTicks;

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
      while (diff > Math.PI)  diff -= Math.PI * 2;
      this.targetRot = a.rot + diff * alpha;

      if (!this.isDead && b.anim) {
        this.playAnimation(b.anim, b.anim !== 'attack-melee-right' && b.anim !== 'die');
      }

      this.group.position.copy(this.targetPos);
      this.group.rotation.y = this.targetRot;

    } else if (this.snapshots.length === 1) {
      // Dead-reckoning: extrapolate from the last known state using estimated velocity.
      // This smooths over brief buffer starvation instead of freezing the character.
      const snap = this.snapshots[0];
      const ticksAhead = Math.min(currentServerTick - snap.tick, MAX_EXTRAPOLATE_TICKS);
      if (ticksAhead > 0 && snap.vel) {
        // vel was stored when there were 2 snapshots to diff
        const t = ticksAhead * (TICK_MS / 1000);
        this.group.position.set(
          snap.pos.x + snap.vel.x * t,
          snap.pos.y,
          snap.pos.z + snap.vel.z * t
        );
      } else {
        this.group.position.lerp(snap.pos, 10 * dt);
      }
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