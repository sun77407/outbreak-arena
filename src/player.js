import * as THREE from 'three';

// Remote players are rendered slightly in the past and interpolated between
// real snapshots instead of always chasing the newest one. This trades a
// small fixed delay (~100ms) for eliminating the jitter/rubber-banding you'd
// otherwise see under normal internet jitter or packet loss.
const INTERP_DELAY_MS = 100;

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

    // Snapshot buffer for remote interpolation: [{ t, pos, rot, anim }]
    this.snapshots = [];
    this.targetPos = new THREE.Vector3();
    this.targetRot = 0;

    this.isDead = false;
    this.isExtracted = false;
    this.actionCooldown = 0;
    this._footstepTimer = 0;

    // Optional hooks wired up by Game for audio/particles — kept decoupled
    // so Player has no direct dependency on the audio engine.
    this.onFootstep = null;
    this.onAttack = null;

    this.nameTagSprite = null;

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
      // Graceful fallback if an animation clip name is missing from the model
      // instead of silently doing nothing (previous behavior).
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

  updateLocal(dt, input, world) {
    if (this.isDead || this.isExtracted) {
      this.mixer?.update(dt);
      return { pos: this.group.position, rot: this.group.rotation.y, anim: this.currentAction, state: this.role, t: Date.now() };
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
        // Slide along whichever axis is still clear
        const posX = this.group.position.clone(); posX.x += step.x;
        const posZ = this.group.position.clone(); posZ.z += step.z;
        if (!world.checkCollision(posX, 0.5)) this.group.position.copy(posX);
        else if (!world.checkCollision(posZ, 0.5)) this.group.position.copy(posZ);
      }

      animToPlay = 'sprint';

      // Footstep cadence tied to speed, not framerate
      this._footstepTimer -= dt;
      if (this._footstepTimer <= 0) {
        this.onFootstep?.(this);
        this._footstepTimer = this.role === 'zombie' ? 0.32 : 0.28;
      }
    } else {
      this._footstepTimer = 0;
    }

    if (input.isActionPressed() && this.actionCooldown <= 0) {
      if (this.role === 'zombie') {
        animToPlay = 'attack-melee-right';
        this.actionCooldown = 1.0;
        this.onAttack?.(this);
        world.attemptInfect(this);
      }
    }

    if (this.actionCooldown > 0 && this.currentAction === 'attack-melee-right') {
      animToPlay = this.currentAction;
    }

    this.playAnimation(animToPlay, animToPlay !== 'attack-melee-right');
    this.mixer?.update(dt);

    return {
      pos: this.group.position,
      rot: this.group.rotation.y,
      anim: this.currentAction,
      state: this.role,
      t: Date.now(),
    };
  }

  // Push an authoritative snapshot into the interpolation buffer instead of
  // snapping targetPos directly — smooths out uneven packet arrival.
  applyNetworkState(state) {
    if (state.state !== this.role && !this.isDead) {
      if (state.state === 'zombie') this.infect();
    }

    this.snapshots.push({
      t: state.t || Date.now(),
      pos: new THREE.Vector3(state.pos.x, state.pos.y, state.pos.z),
      rot: state.rot,
      anim: state.anim,
    });
    // Keep buffer bounded
    if (this.snapshots.length > 20) this.snapshots.shift();
  }

  updateRemote(dt) {
    const renderTime = Date.now() - INTERP_DELAY_MS;

    // Find the two snapshots surrounding renderTime
    while (this.snapshots.length > 2 && this.snapshots[1].t <= renderTime) {
      this.snapshots.shift();
    }

    if (this.snapshots.length >= 2) {
      const a = this.snapshots[0];
      const b = this.snapshots[1];
      const span = b.t - a.t || 1;
      const alpha = Math.max(0, Math.min(1, (renderTime - a.t) / span));

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
      // Not enough history yet — fall back to a gentle lerp toward the one point we have
      this.group.position.lerp(this.snapshots[0].pos, 10 * dt);
    }

    if (this.mixer) this.mixer.update(dt);
  }

  destroy() {
    this.scene.remove(this.group);
  }
}