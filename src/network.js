/**
 * network.js — Pure WebSocket client.
 * WebRTC removed. The server is now the authoritative simulation;
 * this module only handles the WS connection and message routing.
 *
 * Public API intentionally kept compatible with the old version
 * (same callback names) so main.js changes are minimal.
 */
import geckos from '@geckos.io/client';

export class NetworkManager {
  constructor() {
    this.channel = null;
    this.roomCode = null;
    this.myId = Math.random().toString(36).substr(2, 9);
    this.myName = 'Survivor';
    this.playerNames = new Map();
    this.playerNames.set(this.myId, this.myName);

    // These exist only for API compatibility with main.js checks
    this.isHost = false;   // no longer meaningful — all players are equal peers
    this.hostId = null;

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 6;
    this._manualClose = false;
    this._inputSeq = 0;

    this.ping = 0;          // ms RTT to server

    // Callbacks
    this.onRoomCreated = null;
    this.onRoomJoined = null;
    this.onPeerJoined = null;
    this.onPeerLeft = null;
    this.onLobbySync = null;
    this.onError = null;
    this.onHostDisconnected = null;   // kept for compat — fires when server forcibly closes room
    this.onGameStarted = null;
    this.onGameEnded = null;
    this.onSnapshot = null;           // replaces onPeerData — called with each server snapshot
    this.onServerEvent = null;        // reliable game events: infect, powerup_spawned, etc.
    this.onChatMessage = null;
    this.onSignalingStatus = null;
    this.onPingUpdate = null;

    this.connectServer();

    // Client-initiated ping for UI
    this._pingInterval = setInterval(() => {
      if (this.channel) {
        this._lastPingSent = performance.now();
        this._send({ type: 'client_ping' });
      }
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------
  connectServer() {
    let port = window.location.port ? parseInt(window.location.port) : (window.location.protocol === 'https:' ? 443 : 80);
    if (port === 5173) {
      port = 3000; // Map Vite dev server to Node backend
    }
    const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
    if (this.onSignalingStatus) this.onSignalingStatus(this.reconnectAttempts ? 'reconnecting' : 'connecting');

    this.channel = geckos({ 
      url: `${protocol}//${window.location.hostname}`, 
      port: port || (protocol === 'https:' ? 443 : 80)
    });

    this.channel.onConnect((error) => {
      if (error) {
        console.error(error.message);
        if (!this._manualClose) this._tryReconnect();
        return;
      }
      this.reconnectAttempts = 0;
      if (this.onSignalingStatus) this.onSignalingStatus('connected');
      console.log('Connected to game server via Geckos WebRTC');

      this.channel.on('msg', (data) => {
        if (typeof data === 'string') {
          try { data = JSON.parse(data); } catch { return; }
        }
        this._handleMessage(data);
      });
    });

    this.channel.onDisconnect(() => {
      console.log('Disconnected from game server');
      if (this._manualClose) return;
      this._tryReconnect();
    });
  }

  _tryReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.onSignalingStatus) this.onSignalingStatus('failed');
      if (this.onError) this.onError('Lost connection to the server.');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(4000, 300 * Math.pow(2, this.reconnectAttempts));
    if (this.onSignalingStatus) this.onSignalingStatus('reconnecting');
    setTimeout(() => this.connectServer(), delay);
  }

  // ---------------------------------------------------------------------------
  // Message routing
  // ---------------------------------------------------------------------------
  _handleMessage(data) {
    switch (data.type) {

      case 'room_created':
        this.roomCode = data.code;
        // Bug #2 fix: server now assigns canonical IDs — update and clean up old local entry
        if (data.yourId && data.yourId !== this.myId) {
          this.playerNames.delete(this.myId);
          this.myId = data.yourId;
        }
        this.isHost = true;   // first player in room — can start the game
        this.playerNames.set(this.myId, this.myName);
        if (this.onRoomCreated) this.onRoomCreated(this.roomCode);
        break;

      case 'room_joined':
        this.roomCode = data.code;
        // Bug #2 fix: server now assigns canonical IDs — update and clean up old local entry
        if (data.yourId && data.yourId !== this.myId) {
          this.playerNames.delete(this.myId);
          this.myId = data.yourId;
        }
        this.isHost = false;
        // Populate names from existing players
        (data.players || []).forEach(p => this.playerNames.set(p.id, p.name));
        this.playerNames.set(this.myId, this.myName);
        if (this.onRoomJoined) this.onRoomJoined(this.roomCode);
        if (this.onLobbySync) this.onLobbySync();
        break;

      case 'peer_joined':
        this.playerNames.set(data.id, data.name || `Player ${data.id.slice(0, 4)}`);
        // Bug #9 fix: forward role so main.js can spawn with the correct model
        if (this.onPeerJoined) this.onPeerJoined(data.id, data.role || 'survivor');
        if (this.onLobbySync) this.onLobbySync();
        break;

      case 'peer_left':
        this.playerNames.delete(data.id);
        if (this.onPeerLeft) this.onPeerLeft(data.id);
        if (this.onLobbySync) this.onLobbySync();
        break;

      case 'host_promoted':
        // Server promoted us to host after the previous host left
        this.isHost = true;
        if (this.onSignalingStatus) this.onSignalingStatus('connected');
        // Notify main.js so it can show the start button
        if (this.onRoomCreated) this.onRoomCreated(this.roomCode);
        break;

      case 'host_disconnected':
        if (this.onHostDisconnected) this.onHostDisconnected();
        break;

      case 'game_start':
        if (this.onGameStarted) this.onGameStarted(data.initialState, false);
        break;

      case 'start_spinner':
        if (this.onGameStarted) this.onGameStarted(data.initialState, true);
        break;

      case 'snapshot':
        if (this.onSnapshot) this.onSnapshot(data);
        break;

      case 'all_ready':
        if (this.onAllReady) this.onAllReady(data);
        break;

      // Reliable game events — route through onServerEvent
      case 'infect_event':
      case 'role_changed':
      case 'powerup_spawned':
      case 'powerup_claimed':
      case 'use_powerup':
      case 'trap_trigger':
      case 'player_spawn':
        if (this.onServerEvent) this.onServerEvent(data);
        break;

      case 'game_end':
        if (this.onGameEnded) this.onGameEnded(data.result);
        break;

      case 'chat':
        if (this.onChatMessage) this.onChatMessage(data.senderId, data);
        break;

      case 'ping':
        // Server pings us; we pong back immediately so server can track our RTT
        this._send({ type: 'pong', t: data.t });
        break;

      case 'client_pong':
        if (this._lastPingSent) {
          this.ping = Math.round(performance.now() - this._lastPingSent);
          if (this.onPingUpdate) this.onPingUpdate(null, this.ping);
        }
        break;

      case 'error':
        if (this.onError) this.onError(data.message);
        break;

      default: break;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal send helper
  // ---------------------------------------------------------------------------
  _send(data) {
    if (this.channel) {
      try { this.channel.emit('msg', data); } catch { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------
  createRoom() {
    this._send({ type: 'create_room', myId: this.myId, myName: this.myName });
  }

  joinRoom(code) {
    this._send({ type: 'join_room', code, myId: this.myId, myName: this.myName });
  }

  /**
   * Send player input to server (replaces sendData / position broadcast).
   * Called every frame (throttled by game.js to ~30Hz).
   */
  sendInputBatch(inputs) {
    this._send({ type: 'input_batch', inputs });
  }

  /**
   * Send reliable event to server (powerup use, etc.).
   * Kept for API compatibility; all traffic now goes over the same WS.
   */
  sendReliable(data) {
    this._send(data);
  }

  sendChat(text) {
    const safeText = String(text).slice(0, 140);
    this._send({ type: 'chat', text: safeText });
    // Echo locally
    if (this.onChatMessage) {
      this.onChatMessage(this.myId, { senderId: this.myId, senderName: this.myName, text: safeText, t: Date.now() });
    }
  }

  startGame(roundTime = 180) {
    // Any player in the lobby can start (server will forward to all).
    // The first player (isHost flag) is the only one who sees the button.
    this._send({ type: 'start_game', roundTime, useSpinner: true });
  }

  getMyPing() {
    return this.ping || null;
  }

  close() {
    this._manualClose = true;
    if (this.channel) this.channel.close();
  }

  // ---------------------------------------------------------------------------
  // Kept for API compatibility — no-ops in the new architecture
  // ---------------------------------------------------------------------------
  sendData() { /* inputs now sent via sendInput */ }
  broadcast() { /* server handles broadcasting */ }
  sendToPeer() { /* no peers, server handles distribution */ }
  removePeer() { /* no peers */ }
  cleanup() { /* no peer connections to clean up */ }
}