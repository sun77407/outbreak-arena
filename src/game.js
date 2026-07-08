import * as THREE from 'three';
import { Player } from './player.js';
import { World } from './world.js';
import { InputManager } from './input.js';
import { AudioManager } from './audio.js';

const ROUND_MS = 3 * 60 * 1000;

export class Game {
  constructor(network, isHost) {
    this.network = network;
    this.isHost = isHost;

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
    this.cameraOffset = new THREE.Vector3(0, 15, 12);

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

    this.isRunning = false;
    this.isPaused = false;
    this.roundEndTime = 0;
    this._lastCountdownBeep = -1;
    this.spectateIndex = 0;

    this.network.onPeerData = this.handleFastData.bind(this);
    this.network.onReliableData = this.handleReliableData.bind(this);
    this.network.onChatMessage = this.handleChatMessage.bind(this);
    this.network.onPingUpdate = () => this.updatePingHUD();

    this.input.onPause = () => this.togglePause();
    this.input.onMuteToggle = () => this.toggleMute();
    this.input.onChatFocus = () => this.chatInputEl?.focus();

    window.addEventListener('resize', this.onWindowResize.bind(this));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.isRunning) this.setPaused(true, true);
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
  }

  async start(initialState, onProgress) {
    await this.world.init(onProgress);
    this.world.setGameRef(this);

    this.startTime = initialState.startTime;

    initialState.players.forEach((id, index) => {
      const angle = (index / initialState.players.length) * Math.PI * 2;
      const role = initialState.zombies.includes(id) ? 'zombie' : 'survivor';
      const pos = new THREE.Vector3(Math.cos(angle) * 3, 0, Math.sin(angle) * 3);
      this.spawnPlayer(id, role, pos);
    });

    this.pushKillFeed(initialState.zombies.includes(this.localPlayerId)
      ? "You're Patient Zero. Find survivors before time runs out."
      : 'Someone among you has already turned...');

    this.updateHUD();
    this.updateActionButtons();

    this.roundEndTime = initialState.startTime + ROUND_MS + 2000;

    this.isRunning = true;
    this.isPaused = false;
    this.renderer.setAnimationLoop(this.animate.bind(this));

    window.addEventListener('wheel', (e) => {
      if (!this.isRunning) return;
      const zoomSpeed = 0.05;
      this.cameraOffset.y += e.deltaY * zoomSpeed;
      this.cameraOffset.z += e.deltaY * zoomSpeed * 0.8;
      
      this.cameraOffset.y = Math.max(8, Math.min(30, this.cameraOffset.y));
      this.cameraOffset.z = Math.max(6, Math.min(24, this.cameraOffset.z));
    });

    if (this.isHost) {
      this.syncInterval = setInterval(() => this.checkWinConditions(), 1000);
    }
  }

  spawnPlayer(id, role, position = null) {
    const dName = this.network.playerNames.get(id) || `Player ${id.slice(0, 4)}`;
    const player = new Player(id, role, this.scene, this.world.assets, id === this.localPlayerId ? 'You' : dName);
    if (position) {
      player.group.position.copy(position);
    } else {
      const angle = Math.random() * Math.PI * 2;
      player.group.position.set(Math.cos(angle) * 3, 0, Math.sin(angle) * 3);
    }

    if (id === this.localPlayerId) {
      player.onFootstep = () => this.audio.footstep();
      player.onAttack = () => this.audio.attackSwing();
    }

    this.players.set(id, player);
    return player;
  }

  stop() {
    this.isRunning = false;
    this.renderer.setAnimationLoop(null);
    if (this.syncInterval) clearInterval(this.syncInterval);
    this.audio.stopAll();
    this.players.forEach((p) => p.destroy());
    this.players.clear();
    this.container.innerHTML = '';
  }

  togglePause() {
    this.setPaused(!this.isPaused);
  }

  setPaused(paused, silent = false) {
    if (!this.isRunning) return;
    this.isPaused = paused;
    if (paused) {
      this.renderer.setAnimationLoop(null);
      if (!silent) this.pushKillFeed('Paused — press Esc to resume');
    } else {
      this.clock.getDelta(); // discard the accumulated gap so dt doesn't spike
      this.renderer.setAnimationLoop(this.animate.bind(this));
    }
  }

  toggleMute() {
    const muted = this.audio.toggleMute();
    const btn = document.getElementById('btn-mute');
    if (btn) btn.textContent = muted ? '🔇' : '🔊';
  }

  // ---- Networking ----

  handleFastData(senderId, data) {
    if (data.type === 'state_update') {
      const peerId = data.peerId || senderId;
      const player = this.players.get(peerId);
      if (player && peerId !== this.localPlayerId) {
        player.applyNetworkState(data.state);
      }
    }
  }

  handleReliableData(senderId, data) {
    if (data.type === 'infect_event') {
      const targetPlayer = this.players.get(data.targetId);
      if (targetPlayer && targetPlayer.role === 'survivor' && !targetPlayer.isDead) {
        targetPlayer.infect(); // Updates to zombie immediately
        this.audio.infectHit();
        if (data.targetId === this.localPlayerId) {
          this.audio.becomeZombie();
          this.flashVignette();
        }
        this.pushKillFeed(`${this.nameFor(data.targetId)} was infected!`);
        this.updateActionButtons(); // Update right away so they can infect
        this.updateHUD();
      }
    } else if (data.type === 'player_spawn') {
      if (!this.players.has(data.id)) {
        this.spawnPlayer(data.id, data.role);
        this.pushKillFeed(`${this.nameFor(data.id)} joined late!`);
        this.updateHUD();
      }
    }
  }

  handleChatMessage(senderId, msg) {
    if (!this.chatLogEl) return;
    const div = document.createElement('div');
    div.className = 'chat-line';
    const isMe = senderId === this.localPlayerId;
    div.innerHTML = `<span class="chat-name">${isMe ? 'You' : this.nameFor(senderId)}:</span> ${this.escapeHtml(msg.text)}`;
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
    return p ? p.displayName : `Player ${id.slice(0, 4)}`;
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
  }

  updatePingHUD() {
    if (!this.pingEl) return;
    const ms = this.network.getMyPing();
    this.pingEl.textContent = ms === null ? '--' : `${ms}ms`;
    this.pingEl.className = ms === null ? '' : ms < 80 ? 'ping-good' : ms < 160 ? 'ping-ok' : 'ping-bad';
  }

  updateHUD() {
    let s = 0;
    let z = 0;
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
    const localPlayer = this.players.get(this.localPlayerId);
    if (!this.spectatorBannerEl) return;
    const spectating = localPlayer && (localPlayer.isExtracted || (localPlayer.isDead && localPlayer.role !== 'zombie'));
    this.spectatorBannerEl.classList.toggle('hidden', !spectating);
  }

  drawMinimap() {
    if (!this.minimapCtx) return;
    const ctx = this.minimapCtx;
    const size = this.minimapCanvas.width;
    const data = this.world.getMinimapData();
    const scale = size / (data.half * 2);
    const toMap = (x, z) => [size / 2 + x * scale, size / 2 + z * scale];

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
    ctx.fill();

    // Props
    ctx.fillStyle = 'rgba(148, 163, 184, 0.5)';
    data.props.forEach((p) => {
      const [px, pz] = toMap(p.x, p.z);
      ctx.beginPath();
      ctx.arc(px, pz, 1.6, 0, Math.PI * 2);
      ctx.fill();
    });

    // Players
    this.players.forEach((p, id) => {
      if (p.isExtracted || (p.isDead && p.role !== 'zombie' && id !== this.localPlayerId)) return;
      const [px, pz] = toMap(p.group.position.x, p.group.position.z);
      ctx.fillStyle = id === this.localPlayerId ? '#f8fafc' : p.role === 'zombie' ? '#ef4444' : '#10b981';
      ctx.beginPath();
      ctx.arc(px, pz, id === this.localPlayerId ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    });

    // Border
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.stroke();
  }

  updateProximityHeartbeat() {
    const localPlayer = this.players.get(this.localPlayerId);
    if (!localPlayer || localPlayer.role !== 'survivor' || localPlayer.isDead || localPlayer.isExtracted) {
      this.audio.setHeartbeatIntensity(0);
      return;
    }
    let nearestDist = Infinity;
    this.players.forEach((p) => {
      if (p.role === 'zombie') {
        const d = p.group.position.distanceTo(localPlayer.group.position);
        if (d < nearestDist) nearestDist = d;
      }
    });
    const threshold = 12;
    const intensity = nearestDist >= threshold ? 0 : 1 - nearestDist / threshold;
    this.audio.setHeartbeatIntensity(intensity);
  }

  checkWinConditions() {
    if (!this.isRunning || !this.isHost) return;

    const counts = this.updateHUD();
    const now = Date.now();
    const remain = Math.max(0, this.roundEndTime - now);

    if (counts.survivors === 0) {
      this.network.broadcast({ type: 'game_end', result: 'zombies' }, null, true);
      this.handleGameOver('zombies');
    } else if (remain <= 0 && counts.survivors > 0) {
      this.network.broadcast({ type: 'game_end', result: 'survivors' }, null, true);
      this.handleGameOver('survivors');
    }
  }

  handleGameOver(result) {
    this.isRunning = false;
    this.audio.gameEnd(result === 'survivors' ? this.players.get(this.localPlayerId)?.role !== 'zombie' : this.players.get(this.localPlayerId)?.role === 'zombie');
  }

  // ---- Loop ----

  animate() {
    if (!this.isRunning || this.isPaused) return;

    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.world.update(dt);

    const localPlayer = this.players.get(this.localPlayerId);
    const spectating = localPlayer && (localPlayer.isExtracted || (localPlayer.role !== 'zombie' && localPlayer.isDead));

    if (localPlayer && !spectating) {
      const state = localPlayer.updateLocal(dt, this.input, this.world);

      if (!this.lastSend || performance.now() - this.lastSend > 33) {
        this.network.sendData({ type: 'state_update', state });
        this.lastSend = performance.now();
      }

      const targetCamPos = localPlayer.group.position.clone().add(this.cameraOffset);
      this.camera.position.lerp(targetCamPos, 5 * dt);
      this.camera.lookAt(localPlayer.group.position);
    } else if (spectating) {
      // Simple free-roam spectator camera following a living player, cycling with Space
      const alive = Array.from(this.players.values()).filter(p => !p.isDead && !p.isExtracted);
      if (alive.length) {
        if (this.input.isActionPressed() && !this._spectateLock) {
          this.spectateIndex = (this.spectateIndex + 1) % alive.length;
          this._spectateLock = true;
        } else if (!this.input.isActionPressed()) {
          this._spectateLock = false;
        }
        const target = alive[this.spectateIndex % alive.length];
        const targetCamPos = target.group.position.clone().add(this.cameraOffset);
        this.camera.position.lerp(targetCamPos, 3 * dt);
        this.camera.lookAt(target.group.position);
      }
    }

    this.players.forEach((p, id) => {
      if (id !== this.localPlayerId) p.updateRemote(dt);
    });

    this.updateProximityHeartbeat();
    this.drawMinimap();

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