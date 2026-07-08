// Lightweight synthesized SFX/ambience engine — zero external audio files,
// so there's nothing extra to host or for the game to fail-fetch on a slow connection.
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.muted = localStorage.getItem('oa_muted') === '1';
    this.heartbeatTimer = null;
    this.heartbeatRate = 0;
    this._unlocked = false;

    // Unlock on first user gesture (required by browser autoplay policies)
    const unlock = () => {
      if (this._unlocked) return;
      this._unlocked = true;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.7;
      this.master.connect(this.ctx.destination);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  setMuted(muted) {
    this.muted = muted;
    localStorage.setItem('oa_muted', muted ? '1' : '0');
    if (this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.7, this.ctx.currentTime, 0.05);
    }
  }

  toggleMute() {
    this.setMuted(!this.muted);
    return this.muted;
  }

  _tone(freq, duration, type = 'sine', gain = 0.3, glideTo = null) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(1, glideTo), t0 + duration);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
    osc.connect(g).connect(this.master);
    osc.start(t0);
    osc.stop(t0 + duration + 0.02);
  }

  _noise(duration, gain = 0.2, filterFreq = 1200) {
    if (!this.ctx) return;
    const bufferSize = this.ctx.sampleRate * duration;
    const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(gain, this.ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
    src.connect(filter).connect(g).connect(this.master);
    src.start();
  }

  footstep() { this._noise(0.08, 0.06, 400); }
  uiClick() { this._tone(520, 0.06, 'square', 0.15); }
  roomReady() { this._tone(660, 0.12, 'sine', 0.2); setTimeout(() => this._tone(880, 0.15, 'sine', 0.2), 100); }
  infectHit() { this._tone(90, 0.35, 'sawtooth', 0.35, 40); this._noise(0.2, 0.2, 300); }
  becomeZombie() { this._tone(160, 0.6, 'sawtooth', 0.3, 50); }
  extractChime() { [523, 659, 784].forEach((f, i) => setTimeout(() => this._tone(f, 0.3, 'sine', 0.2), i * 90)); }
  gameEnd(win) {
    if (win) [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => this._tone(f, 0.35, 'triangle', 0.25), i * 130));
    else [300, 250, 190, 120].forEach((f, i) => setTimeout(() => this._tone(f, 0.4, 'sawtooth', 0.25), i * 150));
  }
  countdownTick(urgent) { this._tone(urgent ? 880 : 440, 0.1, 'square', 0.2); }
  attackSwing() { this._noise(0.15, 0.25, 900); }

  // Proximity heartbeat for survivors when a zombie is near — classic horror-game tension cue
  setHeartbeatIntensity(intensity) {
    // intensity: 0 (off) to 1 (max/close)
    if (intensity <= 0.02) {
      if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
      return;
    }
    const interval = 900 - intensity * 600; // faster beat when closer
    if (this.heartbeatRate === interval) return;
    this.heartbeatRate = interval;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      this._tone(55, 0.12, 'sine', 0.12 + intensity * 0.15);
    }, interval);
  }

  stopAll() {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }
}