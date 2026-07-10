import * as THREE from 'three';
import { Player } from './player.js';
import { World } from './world.js';
import { InputManager } from './input.js';
import { AudioManager } from './audio.js';

export class Game {
  constructor(network) {
    this.network = network;

    this.container = document.getElementById('game-container');
    this.timerEl = document.getElementById('round-timer');
    this.countSurvivorEl = document.getElementById('count-survivor');
    this.countZombieEl = document.getElementById('count-zombie');
    this.pingEl = document.getElementById('ping-value');
    this.minimapCanvas = document.getElementById('minimap-canvas');
    this.minimapCtx = this.minimapCanvas ? this.minimapCanvas.getContext('2d') : null;
    this.killFeedEl = document.getElementById('kill-feed');
    this.chatLogEl = document.getElementById('chat-log');
    this.chatInputEl = document.getElementById('chat-input');
    this.spectatorBannerEl = document.getElementById('spectator-banner');
    this.vignetteEl = document.getElementById('damage-vignette');

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0f172a);
    this.scene.fog = new THREE.FogExp2(0x0f172a, 0.04);

    this.camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
    this.cameraYaw = Math.PI; // Face "forward"
    const savedCam = localStorage.getItem('cameraHeight');
    this.setCameraPOV(savedCam ? parseFloat(savedCam) : 6.0);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.container.appendChild(this.renderer.domElement);

    this.clock = new THREE.Clock();
    this.input = new InputManager();
    this.world = new World(this.scene);
    this.audio = new AudioManager();

    this.players = new Map();
    this.localPlayerId = this.network.myId;

    // Client-side inventory (server confirms grants, client holds count)
    this.inventory = { speed: 0, shield: 0, trap: 0 };
    this.activePowerups = { speed: 0, shield: 0, aura: 0 };

    this.isRunning = false;
    this.isPaused = false;
    this.roundEndTime = 0;
    this._lastCountdownBeep = -1;
    this.spectateIndex = 0;
    // Ghost-clone guard: prevent handleSnapshot from auto-spawning players
    // before world assets have finished loading (see game.start())
    this._gameInitialized = false;

    // Server tick tracking for interpolation
    this.serverTick = 0;
    this._predictedTick = 0;
    this._lastInputSend = 0;
    this._debugOverlay = false;
    this._lastAdaptiveUpdate = 0;

    // Network callbacks
    this.network.onSnapshot = this.handleSnapshot.bind(this);
    this.network.onServerEvent = this.handleServerEvent.bind(this);
    this.network.onChatMessage = this.handleChatMessage.bind(this);
    this.network.onPingUpdate = () => this.updatePingHUD();

    // Input callbacks
    this.input.onPause = () => this.togglePause();
    this.input.onMuteToggle = () => this.toggleMute();
    this.input.onChatFocus = () => this.chatInputEl?.focus();
    this.input.onPowerup1 = () => this.usePowerup('speed');
    this.input.onPowerup2 = () => this.usePowerup('shield');
    this.input.onPowerup3 = () => this.usePowerup('trap');

    window.addEventListener('resize', this.onWindowResize.bind(this));

    // Auto-pause on tab hide, auto-resume on tab show
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.isRunning) {
        this.setPaused(true, true);
      } else if (!document.hidden && this.isPaused && this.isRunning) {
        this.setPaused(false);
      }
    });

    this.chatInputEl?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.chatInputEl.value.trim()) {
        this.network.sendChat(this.chatInputEl.value.trim());
        this.chatInputEl.value = '';
        this.chatInputEl.blur();
      } else if (e.key === 'Escape') {
        this.chatInputEl.blur();
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === '`') {
        this._debugOverlay = !this._debugOverlay;
        const el = document.getElementById('debug-overlay');
        if (el) el.style.display = this._debugOverlay ? 'block' : 'none';
      }
    });

    // Pointer Lock for Mouse Look
    this.renderer.domElement.addEventListener('click', () => {
      if (this.isRunning && !this.isPaused) {
        this.renderer.domElement.requestPointerLock();
      }
    });

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.renderer.domElement) {
        this.cameraYaw -= e.movementX * 0.002;
        // Pitch is locked for shoulder-level view
      }
    });

    document.getElementById('slot-speed')?.addEventListener('pointerdown', () => this.usePowerup('speed'));
    document.getElementById('slot-shield')?.addEventListener('pointerdown', () => this.usePowerup('shield'));
    document.getElementById('slot-trap')?.addEventListener('pointerdown', () => this.usePowerup('trap'));
    document.getElementById('btn-pause')?.addEventListener('click', () => this.togglePause());
  }

  setCameraPOV(distance) {
    this.cameraDistance = distance;
    this.cameraPitch = (Math.PI / 16) + (distance - 5) * 0.02;
  }

  // ---- Start / Stop ----

  async start(initialState, onProgress) {
    const seed = initialState.seed || initialState.code || 'DEFAULT';
    await this.world.init(onProgress, seed);
    
    this.network.onAllReady = (data) => this.completeStart(initialState, data);
    
    const banner = document.createElement('div');
    banner.id = 'wait-ready-banner';
    banner.className = 'spectator-banner';
    banner.textContent = 'Waiting for other players to load...';
    const uiLayer = document.getElementById('ui-layer');
    if (uiLayer) uiLayer.appendChild(banner);
    
    this.network._send({ type: 'player_ready' });
  }

  completeStart(initialState, readyData) {
    const banner = document.getElementById('wait-ready-banner');
    if (banner) banner.remove();

    this.startTime = readyData.startTime;
    this.roundEndTime = readyData.roundEndTime;

    // Spawn all players
    const positions = initialState.positions || [];
    initialState.players.forEach((id, index) => {
      const role = initialState.zombies.includes(id) ? 'zombie' : 'survivor';
      const posData = positions.find(p => p.id === id);
      const pos = posData
        ? new THREE.Vector3(posData.x, 0, posData.z)
        : new THREE.Vector3(Math.cos((index / initialState.players.length) * Math.PI * 2) * 3, 0,
                            Math.sin((index / initialState.players.length) * Math.PI * 2) * 3);
      this.spawnPlayer(id, role, pos, initialState.playerNames);
    });

    this.pushKillFeed(initialState.zombies.includes(this.localPlayerId)
      ? "You're Patient Zero. Find survivors before time runs out."
      : 'Someone among you has already turned...');

    this.updateHUD();
    this.updateActionButtons();

    // Mark init complete BEFORE starting the render loop so that
    // handleSnapshot can now safely auto-spawn late-joining players.
    this._gameInitialized = true;
    this.isRunning = true;
    this.isPaused = false;
    this.renderer.setAnimationLoop(this.animate.bind(this));
  }

  spawnPlayer(id, role, position = null, playerNames = null) {
    // Ghost-clone guard: if a player was auto-spawned from an early snapshot
    // (before world assets finished loading), their orphaned 3D group is still
    // in the scene. Destroy it before creating the real instance.
    const existing = this.players.get(id);
    if (existing) {
      existing.destroy();
      this.players.delete(id);
    }

    // Resolve display name: from initialState.playerNames array, or network map
    let dName = this.network.playerNames.get(id) || `Player ${id.slice(0, 4)}`;
    if (playerNames) {
      const entry = playerNames.find(p => p.id === id);
      if (entry) dName = entry.name;
    }
    const label = id === this.localPlayerId ? 'You' : dName;
    const player = new Player(id, role, this.scene, this.world.assets, label);
    if (position) player.group.position.copy(position);

    if (id === this.localPlayerId) {
      player.onFootstep = () => this.audio.footstep();
      player.onAttack = () => this.audio.attackSwing();
    }

    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    const player = this.players.get(id);
    if (player) {
      player.destroy();
      this.players.delete(id);
    }
    this.updateHUD();
  }

  applyZoom(dir, amount) {}
  setupPinchZoom() {}

  stop() {
    this.isRunning = false;
    this.renderer.setAnimationLoop(null);
    this.audio.stopAll();
    this.players.forEach((p) => p.destroy());
    this.players.clear();
    
    if (document.pointerLockElement === this.renderer.domElement) {
      document.exitPointerLock();
    }
    
    this.container.innerHTML = '';
  }

  togglePause() { this.setPaused(!this.isPaused); }

  setPaused(paused, silent = false) {
    if (!this.isRunning) return;
    this.isPaused = paused;
    const btn = document.getElementById('btn-pause');
    if (paused) {
      this.renderer.setAnimationLoop(null);
      if (btn) btn.textContent = '▶';
      if (!silent) this.pushKillFeed('Paused — press Esc or ▶ to resume');
    } else {
      this.clock.getDelta(); // discard accumulated gap so dt doesn't spike
      this.renderer.setAnimationLoop(this.animate.bind(this));
      if (btn) btn.textContent = '⏸';
    }
  }

  toggleMute() {
    const muted = this.audio.toggleMute();
    const btn = document.getElementById('btn-mute');
    if (btn) btn.textContent = muted ? '🔇' : '🔊';
  }

  // ---- Networking ----

  /**
   * Server sends a snapshot every 50ms containing all player positions.
   * We feed remote players into the interpolation buffer and reconcile
   * the local player's predicted position against the authoritative one.
   */
  handleSnapshot(data) {
    this.serverTick = data.tick;

    for (const state of data.players) {
      let player = this.players.get(state.id);

      // Auto-spawn guard: only spawn players mid-game AFTER initial loading is complete.
      // During the async world.init() window, snapshots arrive but world.assets are not
      // ready yet — spawning now would create broken orphan objects that become ghost clones.
      if (!player) {
        if (!this._gameInitialized) continue;   // loading still in progress — skip
        if (state.id === this.localPlayerId) continue;
        player = this.spawnPlayer(state.id, state.role || 'survivor', null, null);
        if (state.x !== undefined) player.group.position.set(state.x, 0, state.z);
      }

      if (state.id === this.localPlayerId) {
        // Reconcile local prediction with server position
        player.reconcile({ x: state.x, z: state.z }, state.seq, this.world.flatColliders);
        this._predictedTick = this.serverTick;
        // Update role if server says we changed
        if (state.role !== player.role && !player.isDead) {
          if (state.role === 'zombie') player.infect();
        }
        // Update local powerup visuals from server truth
        if (state.powerups) {
          player.activePowerups.speed = !!state.powerups.speed;
          player.activePowerups.shield = !!state.powerups.shield;
          player.activePowerups.aura = !!state.powerups.aura;
        }
      } else {
        // Remote player — feed into interpolation buffer
        player.applyNetworkState(state);
      }
    }
  }

  /**
   * Reliable server events (infect, powerup, trap, etc.)
   */
  handleServerEvent(data) {
    switch (data.type) {
      case 'infect_event': {
        const target = this.players.get(data.targetId);
        if (target && target.role === 'survivor' && !target.isDead) {
          target.infect();
          this.audio.infectHit();
          if (data.targetId === this.localPlayerId) {
            this.audio.becomeZombie();
            this.flashVignette();
          }
          this.pushKillFeed(`${this.nameFor(data.targetId)} was infected!`);
          this.updateActionButtons();
          this.updateHUD();
        }
        break;
      }

      case 'role_changed': {
        const p = this.players.get(data.playerId);
        if (p && p.role !== data.role) {
          // Bug #7 fix: always call setModel() to switch the 3D character mesh.
          // Previously this only ran when p.isDead, missing cases where the infect()
          // 2s timeout already finished but model was never switched server-side.
          if (data.role === 'zombie') {
            if (p.isDead) {
              // infect() timeout is still in progress — just sync the role property;
              // the setTimeout inside infect() will call setModel() when it fires.
              p.role = 'zombie';
            } else {
              // infect() timeout already completed — force model switch now.
              p.setModel('zombie');
              p.playAnimation('idle');
            }
          } else {
            p.role = data.role;
          }
          this.updateHUD();
        }
        break;
      }

      case 'player_spawn': {
        if (!this.players.has(data.id)) {
          this.spawnPlayer(data.id, data.role || 'survivor', null, data.playerNames);
          this.pushKillFeed(`${this.nameFor(data.id)} joined late!`);
          this.updateHUD();
        }
        break;
      }

      case 'powerup_spawned': {
        this.world.spawnPowerup(data.id, data.x, data.z);
        break;
      }

      case 'powerup_claimed': {
        this.world.removePowerup(data.id);
        if (data.claimerId === this.localPlayerId && data.granted) {
          this.inventory[data.granted] = (this.inventory[data.granted] || 0) + 1;
          this.updatePowerupUI();
          this.audio.infectHit();
          this.showPowerupAnimation(data.granted);
        }
        break;
      }

      case 'use_powerup': {
        this.pushKillFeed(`${this.nameFor(data.senderId)} used ${data.powerup}!`);
        if (data.powerup === 'trap' && data.trapId) {
          const localRole = this.players.get(this.localPlayerId)?.role;
          const isEnemy = localRole !== data.role;
          this.world.spawnTrap(data.trapId, data.x, data.z, data.role, isEnemy);
        }
        // Apply local powerup timers if this is for us (server already set them)
        if (data.senderId === this.localPlayerId) {
          if (data.powerup === 'speed') this.activePowerups.speed = 5.0;
          else if (data.powerup === 'shield') {
            const local = this.players.get(this.localPlayerId);
            if (local?.role === 'zombie') this.activePowerups.aura = 10.0;
            else this.activePowerups.shield = 8.0;
          }
        }
        break;
      }

      case 'trap_trigger': {
        this.world.removeTrap(data.trapId);
        if (data.targetId === this.localPlayerId) {
          const local = this.players.get(this.localPlayerId);
          if (local) {
            this.pushKillFeed('You hit a trap!');
            local.actionCooldown = 3.0;
            local.playAnimation('die', false);
          }
        }
        break;
      }

      default: break;
    }
  }

  handleChatMessage(senderId, msg) {
    if (!this.chatLogEl) return;
    const div = document.createElement('div');
    div.className = 'chat-line';
    const isMe = senderId === this.localPlayerId;
    const name = msg.senderName || (isMe ? 'You' : this.nameFor(senderId));
    div.innerHTML = `<span class="chat-name">${isMe ? 'You' : name}:</span> ${this.escapeHtml(msg.text)}`;
    this.chatLogEl.appendChild(div);
    this.chatLogEl.scrollTop = this.chatLogEl.scrollHeight;
    while (this.chatLogEl.children.length > 30) this.chatLogEl.removeChild(this.chatLogEl.firstChild);
  }

  escapeHtml(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  nameFor(id) {
    const p = this.players.get(id);
    if (p) return p.displayName;
    return this.network.playerNames.get(id) || `Player ${id.slice(0, 4)}`;
  }

  pushKillFeed(text) {
    if (!this.killFeedEl) return;
    const div = document.createElement('div');
    div.className = 'kill-feed-item';
    div.textContent = text;
    this.killFeedEl.prepend(div);
    setTimeout(() => div.classList.add('fade-out'), 4000);
    setTimeout(() => div.remove(), 4600);
    while (this.killFeedEl.children.length > 6) this.killFeedEl.removeChild(this.killFeedEl.lastChild);
  }

  flashVignette() {
    if (!this.vignetteEl) return;
    this.vignetteEl.classList.add('active');
    setTimeout(() => this.vignetteEl.classList.remove('active'), 900);
  }

  // ---- HUD ----

  updateActionButtons() {
    const local = this.players.get(this.localPlayerId);
    const btnAction = document.getElementById('btn-action');
    if (!btnAction) return;

    if (!local || local.isDead || local.isExtracted) {
      btnAction.classList.add('hidden');
      return;
    }

    if (local.role === 'zombie') {
      btnAction.classList.remove('hidden');
      btnAction.textContent = 'INFECT';
      btnAction.className = 'btn-circular zombie-action';
    } else {
      btnAction.classList.add('hidden');
    }

    this.updatePowerupUI();
  }

  updatePowerupUI() {
    const sSlot = document.getElementById('slot-speed');
    const shSlot = document.getElementById('slot-shield');
    const tSlot = document.getElementById('slot-trap');

    if (sSlot) {
      sSlot.classList.toggle('hidden', this.inventory.speed === 0);
      document.getElementById('count-speed').textContent = this.inventory.speed;
    }
    if (shSlot) {
      shSlot.classList.toggle('hidden', this.inventory.shield === 0);
      document.getElementById('count-shield').textContent = this.inventory.shield;
      const localRole = this.players.get(this.localPlayerId)?.role;
      shSlot.querySelector('.p-icon').textContent = localRole === 'zombie' ? '🦠' : '🛡️';
    }
    if (tSlot) {
      tSlot.classList.toggle('hidden', this.inventory.trap === 0);
      document.getElementById('count-trap').textContent = this.inventory.trap;
    }
  }

  showPowerupAnimation(type) {
    const ann = document.getElementById('powerup-announcement');
    const fly = document.getElementById('powerup-fly');
    if (!ann || !fly) return;
    const names = { speed: 'Speed Boost!', shield: 'Shield!', trap: 'Trap!' };
    ann.textContent = names[type];
    ann.classList.remove('show');
    void ann.offsetWidth;
    ann.classList.add('show');
    const slotMap = { speed: 'slot-speed', shield: 'slot-shield', trap: 'slot-trap' };
    const slotEl = document.getElementById(slotMap[type]);
    if (slotEl) {
      const rect = slotEl.getBoundingClientRect();
      fly.style.setProperty('--target-x', `${rect.left + rect.width / 2}px`);
      fly.style.setProperty('--target-y', `${rect.top + rect.height / 2}px`);
      fly.classList.remove('hidden');
      fly.style.animation = 'none';
      void fly.offsetWidth;
      fly.style.animation = 'flyToSlot 0.8s cubic-bezier(0.5, 0, 0.75, 0) forwards';
      setTimeout(() => fly.classList.add('hidden'), 800);
    }
  }

  usePowerup(type) {
    if (this.inventory[type] <= 0) return;
    this.inventory[type]--;
    this.updatePowerupUI();

    const localPlayer = this.players.get(this.localPlayerId);
    if (!localPlayer) return;

    let trapId = null;
    if (type === 'trap') {
      // Bug #16 fix: use full mantissa of random string for sufficient entropy
      trapId = 'trap_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 7);
      // Optimistic: spawn trap visually immediately on own client
      this.world.spawnTrap(trapId, localPlayer.group.position.x, localPlayer.group.position.z, localPlayer.role, false);
    }

    // Tell server — server applies the effect and broadcasts to everyone
    this.network.sendReliable({
      type: 'use_powerup',
      powerup: type,
      role: localPlayer.role,
      x: localPlayer.group.position.x,
      z: localPlayer.group.position.z,
      trapId,
    });
  }

  updatePingHUD() {
    if (!this.pingEl) return;
    const ms = this.network.getMyPing();
    this.pingEl.textContent = ms === null ? '--' : `${ms}ms`;
    this.pingEl.className = ms === null ? '' : ms < 80 ? 'ping-good' : ms < 160 ? 'ping-ok' : 'ping-bad';
  }

  updateHUD() {
    let s = 0, z = 0;
    this.players.forEach((p) => {
      if (p.role === 'survivor' && !p.isDead && !p.isExtracted) s++;
      if (p.role === 'zombie') z++;
    });
    if (this.countSurvivorEl) this.countSurvivorEl.textContent = s;
    if (this.countZombieEl) this.countZombieEl.textContent = z;
    this.updateSpectatorBanner();
    return { survivors: s, zombies: z };
  }

  updateSpectatorBanner() {
    const local = this.players.get(this.localPlayerId);
    if (!this.spectatorBannerEl) return;
    // Bug #22 fix: show banner whenever local player is dead (including the 2s infect
    // transition where isDead=true but role may already be 'zombie') or extracted.
    const spectating = local && (local.isExtracted || local.isDead);
    this.spectatorBannerEl.classList.toggle('hidden', !spectating);
  }

  // ---- Minimap — player-centered, top-right, with facing arrow ----
  drawMinimap() {
    if (!this.minimapCtx) return;
    const ctx = this.minimapCtx;
    const size = this.minimapCanvas.width;   // 200
    const VIEW_HALF = 14;                    // world units visible from center
    const scale = size / (VIEW_HALF * 2);

    const localPlayer = this.players.get(this.localPlayerId);
    const cx = localPlayer ? localPlayer.group.position.x : 0;
    const cz = localPlayer ? localPlayer.group.position.z : 0;
    const facing = localPlayer ? localPlayer.group.rotation.y : 0;

    // World → canvas coords (centered on local player)
    const toMap = (wx, wz) => [
      size / 2 + (wx - cx) * scale,
      size / 2 + (wz - cz) * scale,
    ];

    ctx.clearRect(0, 0, size, size);

    // Background
    ctx.fillStyle = 'rgba(10, 15, 30, 0.75)';
    ctx.beginPath();
    ctx.roundRect(0, 0, size, size, 14);
    ctx.fill();

    // Draw maze walls as line segments
    const data = this.world.getMinimapData();
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.6)';
    ctx.lineWidth = 2;
    data.props.forEach((p) => {
      if (!p.isWall) return;
      const hw = (p.w || 1) / 2;
      const hd = (p.d || 1) / 2;
      const [ax, az] = toMap(p.x - hw, p.z - hd);
      const [bx, bz] = toMap(p.x + hw, p.z + hd);
      ctx.fillStyle = 'rgba(100, 116, 139, 0.7)';
      ctx.fillRect(ax, az, bx - ax, bz - az);
    });

    // Draw obstacles (only those within the view window)
    ctx.fillStyle = 'rgba(100, 116, 139, 0.35)';
    data.props.forEach((p) => {
      if (p.isWall) return;
      if (Math.abs(p.x - cx) > VIEW_HALF + 2 || Math.abs(p.z - cz) > VIEW_HALF + 2) return;
      const [px, pz] = toMap(p.x, p.z);
      ctx.beginPath();
      ctx.arc(px, pz, 2, 0, Math.PI * 2);
      ctx.fill();
    });

    // Arena boundary indicator (subtle lines at edge)
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.3)';
    ctx.lineWidth = 1;
    const ARENA_HALF = 25;
    // Draw the boundary walls if they're in view
    [[-ARENA_HALF, -ARENA_HALF, ARENA_HALF, -ARENA_HALF],
     [ARENA_HALF, -ARENA_HALF, ARENA_HALF, ARENA_HALF],
     [ARENA_HALF, ARENA_HALF, -ARENA_HALF, ARENA_HALF],
     [-ARENA_HALF, ARENA_HALF, -ARENA_HALF, -ARENA_HALF]].forEach(([x1, z1, x2, z2]) => {
      const [ax, ay] = toMap(x1, z1);
      const [bx, by] = toMap(x2, z2);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    });

    // Draw players
    this.players.forEach((p, id) => {
      // During the 2s infect transform, keep dead players visible on minimap
      if (p.isExtracted) return;
      const [px, pz] = toMap(p.group.position.x, p.group.position.z);
      // Skip if outside view
      if (px < -10 || px > size + 10 || pz < -10 || pz > size + 10) return;

      if (id === this.localPlayerId) {
        // "You" — white dot with facing arrow
        ctx.fillStyle = '#f8fafc';
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, 5, 0, Math.PI * 2);
        ctx.fill();

        // Facing arrow
        ctx.save();
        ctx.translate(size / 2, size / 2);
        ctx.rotate(facing);
        ctx.fillStyle = '#f8fafc';
        ctx.beginPath();
        ctx.moveTo(0, -10);
        ctx.lineTo(4, -4);
        ctx.lineTo(-4, -4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      } else {
        const color = p.role === 'zombie' ? '#ef4444' : '#10b981';
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, pz, 4, 0, Math.PI * 2);
        ctx.fill();

        // Pulse ring for nearby zombies
        if (p.role === 'zombie') {
          const dist = Math.hypot(p.group.position.x - cx, p.group.position.z - cz);
          if (dist < 12) {
            ctx.strokeStyle = `rgba(239, 68, 68, ${0.6 * (1 - dist / 12)})`;
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            ctx.arc(px, pz, 7, 0, Math.PI * 2);
            ctx.stroke();
          }
        }
      }
    });

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.roundRect(0.75, 0.75, size - 1.5, size - 1.5, 13);
    ctx.stroke();
  }

  updateProximityHeartbeat() {
    const local = this.players.get(this.localPlayerId);
    if (!local || local.role !== 'survivor' || local.isDead || local.isExtracted) {
      this.audio.setHeartbeatIntensity(0);
      return;
    }
    let nearestDist = Infinity;
    this.players.forEach((p) => {
      if (p.role === 'zombie') {
        const d = p.group.position.distanceTo(local.group.position);
        if (d < nearestDist) nearestDist = d;
      }
    });
    const threshold = 12;
    this.audio.setHeartbeatIntensity(nearestDist >= threshold ? 0 : 1 - nearestDist / threshold);
  }

  handleGameOver(result) {
    this.isRunning = false;
    // Stop the render loop immediately — don't leave it ticking as a no-op
    this.renderer.setAnimationLoop(null);
    this.audio.gameEnd(result === 'survivors'
      ? this.players.get(this.localPlayerId)?.role !== 'zombie'
      : this.players.get(this.localPlayerId)?.role === 'zombie');
  }

  // ---- Main loop ----

  animate() {
    if (!this.isRunning || this.isPaused) return;

    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.world.update(dt);

    const localPlayer = this.players.get(this.localPlayerId);
    const spectating = localPlayer && (localPlayer.isExtracted || (localPlayer.role !== 'zombie' && localPlayer.isDead));

    if (localPlayer && !spectating) {
      // Apply speed powerup to local player's speed
      const baseSpeed = localPlayer.role === 'zombie' ? 5.5 : 5.0;
      localPlayer.speed = this.activePowerups.speed > 0 ? baseSpeed * 1.5 : baseSpeed;

      // Cooldown UI progress
      const speedPct = this.activePowerups.speed > 0 ? (this.activePowerups.speed / 5.0) * 100 : 0;
      const shieldMax = localPlayer.role === 'zombie' ? 10.0 : 8.0;
      const shieldVal = localPlayer.role === 'zombie' ? this.activePowerups.aura : this.activePowerups.shield;
      const shieldPct = shieldVal > 0 ? (shieldVal / shieldMax) * 100 : 0;
      document.getElementById('slot-speed')?.style.setProperty('--cooldown-pct', `${100 - speedPct}%`);
      document.getElementById('slot-shield')?.style.setProperty('--cooldown-pct', `${100 - shieldPct}%`);

      this.network._inputSeq++;
      const currentSeq = this.network._inputSeq;
      // Update local player with client-side prediction
      const { move, action } = localPlayer.updateLocal(
        dt, this.input, this.world, this.activePowerups, this.world.flatColliders, currentSeq, this.cameraYaw
      );

      // Queue input for batching
      if (!this._pendingInputs) this._pendingInputs = [];
      this._pendingInputs.push({ seq: currentSeq, move, action, dt });

      // Send input to server at ~30Hz
      if (performance.now() - this._lastInputSend > 33) {
        this.network.sendInputBatch(this._pendingInputs);
        this._pendingInputs = [];
        this._lastInputSend = performance.now();
      }

      // Decrement local powerup timers (server is authoritative, but we run timers
      // locally for smooth UI; server snapshot will reconcile discrepancies)
      if (this.activePowerups.speed > 0) this.activePowerups.speed -= dt;
      if (this.activePowerups.shield > 0) this.activePowerups.shield -= dt;
      if (this.activePowerups.aura > 0) this.activePowerups.aura -= dt;

      // Camera follow (3rd person orbit with shoulder offset)
      const offset = new THREE.Vector3(
        Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch) * this.cameraDistance,
        Math.sin(this.cameraPitch) * this.cameraDistance,
        Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch) * this.cameraDistance
      );
      // Shoulder offset: push right relative to yaw
      const rightVec = new THREE.Vector3(Math.cos(this.cameraYaw), 0, -Math.sin(this.cameraYaw));
      offset.add(rightVec.multiplyScalar(1.2));
      
      const targetCamPos = localPlayer.group.position.clone().add(offset);
      // Smoothly move camera
      this.camera.position.lerp(targetCamPos, 15 * dt);
      
      const lookAtTarget = localPlayer.group.position.clone().add(new THREE.Vector3(0, 1.2, 0));
      this.camera.lookAt(lookAtTarget);

    } else if (spectating) {
      const alive = Array.from(this.players.values()).filter(p => !p.isDead && !p.isExtracted);
      if (alive.length) {
        if (this.input.isActionPressed() && !this._spectateLock) {
          this.spectateIndex = (this.spectateIndex + 1) % alive.length;
          this._spectateLock = true;
        } else if (!this.input.isActionPressed()) {
          this._spectateLock = false;
        }
        const target = alive[this.spectateIndex % alive.length];
        
        const offset = new THREE.Vector3(
          Math.sin(this.cameraYaw) * Math.cos(this.cameraPitch) * this.cameraDistance,
          Math.sin(this.cameraPitch) * this.cameraDistance,
          Math.cos(this.cameraYaw) * Math.cos(this.cameraPitch) * this.cameraDistance
        );
        const rightVec = new THREE.Vector3(Math.cos(this.cameraYaw), 0, -Math.sin(this.cameraYaw));
        offset.add(rightVec.multiplyScalar(1.2));
        
        const targetCamPos = target.group.position.clone().add(offset);
        this.camera.position.lerp(targetCamPos, 10 * dt);
        const lookAtTarget = target.group.position.clone().add(new THREE.Vector3(0, 1.2, 0));
        this.camera.lookAt(lookAtTarget);
      }
    }

    // Adaptive delay calculation once per second
    if (performance.now() - this._lastAdaptiveUpdate > 1000) {
      let maxJitter = 0;
      this.players.forEach((p, id) => {
        if (id !== this.localPlayerId) {
          const j = p.getJitter();
          if (j > maxJitter) maxJitter = j;
        }
      });
      const adaptiveDelay = Math.max(2, Math.min(8, Math.ceil((50 + 1.5 * maxJitter) / 50)));
      this.players.forEach((p, id) => {
        if (id !== this.localPlayerId) p.setInterpDelay(adaptiveDelay);
      });
      this._lastAdaptiveUpdate = performance.now();
    }

    // Update remote players using server tick
    this.players.forEach((p, id) => {
      if (id !== this.localPlayerId) p.updateRemote(dt, this.serverTick);
    });

    this.updateProximityHeartbeat();
    this.drawMinimap();

    // Debug Overlay Update
    if (this._debugOverlay) {
      const el = document.getElementById('debug-overlay');
      if (el) {
        let avgInterpBuf = 0;
        let remoteCount = 0;
        this.players.forEach((p, id) => {
          if (id !== this.localPlayerId) {
            avgInterpBuf += p.snapshots.length;
            remoteCount++;
          }
        });
        avgInterpBuf = remoteCount > 0 ? (avgInterpBuf / remoteCount).toFixed(1) : 0;
        
        el.innerHTML = `[NET DEBUG]<br>` +
          `RTT:          ${this.network.ping}ms<br>` +
          `Pred Δ:       ${localPlayer ? localPlayer._predictionError.toFixed(3) : 0}m<br>` +
          `Interp buf:   ${avgInterpBuf} snaps<br>` +
          `Server tick:  ${this.serverTick}<br>` +
          `Pred tick:    ${this._predictedTick}`;
      }
    }

    // Timer display
    const now = Date.now();
    const remain = Math.max(0, this.roundEndTime - now);
    const mins = Math.floor(remain / 60000);
    const secs = Math.floor((remain % 60000) / 1000);
    if (this.timerEl) this.timerEl.textContent = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;

    if (remain <= 10000) {
      this.timerEl?.classList.add('warning');
      const secWhole = Math.ceil(remain / 1000);
      if (secWhole !== this._lastCountdownBeep && secWhole <= 10 && secWhole > 0) {
        this._lastCountdownBeep = secWhole;
        this.audio.countdownTick(secWhole <= 3);
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  onWindowResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}