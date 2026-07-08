export class NetworkManager {
  constructor() {
    this.ws = null;
    this.roomCode = null;
    this.myId = Math.random().toString(36).substr(2, 9);
    this.myName = 'Survivor';
    this.playerNames = new Map();
    this.playerNames.set(this.myId, this.myName);
    this.hostId = null;
    this.isHost = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 6;
    this._manualClose = false;

    // peers Map: peerId -> RTCPeerConnection
    this.peers = new Map();
    // Two channels per peer for a good latency/reliability tradeoff:
    //  - "fast": unreliable, unordered — position/rotation/anim ticks, dropped packets are fine
    //  - "reliable": ordered, retried — infect/extract/game_start/game_end/chat, must arrive
    this.fastChannels = new Map();
    this.reliableChannels = new Map();
    // Buffer ICE candidates that arrive before remote description is set
    this.pendingCandidates = new Map();

    this.ping = new Map(); // peerId -> ms RTT (for peers), or hostId->ms if I'm a peer
    this._pingTimers = new Map();

    this.onRoomCreated = null;
    this.onRoomJoined = null;
    this.onPeerJoined = null;
    this.onPeerLeft = null;
    this.onLobbySync = null;
    this.onError = null;
    this.onHostDisconnected = null;
    this.onGameStarted = null;
    this.onGameEnded = null;
    this.onPeerData = null;       // fast-channel gameplay data
    this.onReliableData = null;   // reliable-channel events (infect/extract/etc, forwarded by game.js)
    this.onChatMessage = null;
    this.onSignalingStatus = null; // ('connecting'|'connected'|'reconnecting'|'failed')
    this.onPingUpdate = null;      // (peerId, ms)

    this.connectSignaling();
  }

  connectSignaling() {
    let wsHost = window.location.host;
    if (window.location.hostname === 'localhost' && window.location.port !== '3000') {
      wsHost = 'localhost:3000';
    }
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    if (this.onSignalingStatus) this.onSignalingStatus(this.reconnectAttempts ? 'reconnecting' : 'connecting');

    this.ws = new WebSocket(`${protocol}//${wsHost}`);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      if (this.onSignalingStatus) this.onSignalingStatus('connected');
      console.log('Connected to signaling server');
    };

    this.ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      this.handleSignalingMessage(data);
    };

    this.ws.onclose = () => {
      console.log('Disconnected from signaling server');
      if (this._manualClose) return;
      // Only treat as fatal if we haven't already established a live game session via WebRTC.
      if (this.peers.size === 0) {
        this._tryReconnectSignaling();
      }
    };

    this.ws.onerror = () => { /* onclose will fire right after */ };
  }

  _tryReconnectSignaling() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      if (this.onSignalingStatus) this.onSignalingStatus('failed');
      if (this.onError) this.onError('Lost connection to the signaling server.');
      return;
    }
    this.reconnectAttempts++;
    const delay = Math.min(4000, 300 * Math.pow(2, this.reconnectAttempts));
    if (this.onSignalingStatus) this.onSignalingStatus('reconnecting');
    setTimeout(() => this.connectSignaling(), delay);
  }

  handleSignalingMessage(data) {
    switch (data.type) {
      case 'room_created':
        this.roomCode = data.code;
        this.isHost = true;
        this.hostId = this.myId;
        if (this.onRoomCreated) this.onRoomCreated(this.roomCode);
        break;

      case 'room_joined':
        this.roomCode = data.code;
        this.hostId = data.hostId;
        if (this.onRoomJoined) this.onRoomJoined(this.roomCode);
        this.initiatePeerConnection(this.hostId);
        break;

      case 'peer_joined':
        console.log('Peer joined:', data.peerId);
        break;

      case 'peer_disconnected':
        this.removePeer(data.peerId);
        if (this.onPeerLeft) this.onPeerLeft(data.peerId);
        break;

      case 'host_disconnected':
        this.cleanup();
        if (this.onHostDisconnected) this.onHostDisconnected();
        break;

      case 'signal':
        this.handleWebRTCSignal(data.senderId, data.signalData);
        break;

      case 'error':
        if (this.onError) this.onError(data.message);
        break;
    }
  }

  createRoom() { this.ws.send(JSON.stringify({ type: 'create_room', myId: this.myId })); }
  joinRoom(code) { this.ws.send(JSON.stringify({ type: 'join_room', code, myId: this.myId })); }

  // ---- WebRTC Host-Relay Logic ----

  createPeerConnection(targetId) {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        // Add a TURN server here for reliable connectivity behind restrictive NATs, e.g.:
        // { urls: 'turn:your-turn-host:3478', username: '...', credential: '...' }
      ],
      iceCandidatePoolSize: 4,
    });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.ws.send(JSON.stringify({
          type: 'signal',
          targetId,
          signalData: { type: 'ice', candidate: event.candidate }
        }));
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`Connection state with ${targetId}:`, pc.connectionState);
      if (pc.connectionState === 'failed') {
        // One ICE restart attempt before giving up on this peer
        pc.restartIce?.();
      }
      if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
        this.removePeer(targetId);
        if (this.onPeerLeft) this.onPeerLeft(targetId);
      }
    };

    this.peers.set(targetId, pc);
    return pc;
  }

  async initiatePeerConnection(hostId) {
    const pc = this.createPeerConnection(hostId);

    const fast = pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 });
    const reliable = pc.createDataChannel('reliable', { ordered: true });
    this.setupDataChannel(fast, hostId, false);
    this.setupDataChannel(reliable, hostId, true);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    this.ws.send(JSON.stringify({
      type: 'signal',
      targetId: hostId,
      signalData: { type: 'offer', sdp: offer }
    }));
  }

  async handleWebRTCSignal(senderId, signalData) {
    let pc = this.peers.get(senderId);

    if (signalData.type === 'offer') {
      if (!pc) {
        pc = this.createPeerConnection(senderId);
        pc.ondatachannel = (event) => {
          const isReliable = event.channel.label === 'reliable';
          this.setupDataChannel(event.channel, senderId, isReliable);
        };
      }
      await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
      await this._flushPendingCandidates(senderId, pc);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      this.ws.send(JSON.stringify({
        type: 'signal',
        targetId: senderId,
        signalData: { type: 'answer', sdp: answer }
      }));
    } else if (signalData.type === 'answer') {
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(signalData.sdp));
        await this._flushPendingCandidates(senderId, pc);
      }
    } else if (signalData.type === 'ice') {
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate)); }
        catch (e) { console.warn('ICE candidate error', e); }
      } else {
        // Remote description not set yet — buffer it
        if (!this.pendingCandidates.has(senderId)) this.pendingCandidates.set(senderId, []);
        this.pendingCandidates.get(senderId).push(signalData.candidate);
      }
    }
  }

  async _flushPendingCandidates(peerId, pc) {
    const list = this.pendingCandidates.get(peerId);
    if (!list) return;
    for (const c of list) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (e) { console.warn(e); }
    }
    this.pendingCandidates.delete(peerId);
  }

  setupDataChannel(dc, targetId, isReliable) {
    const store = isReliable ? this.reliableChannels : this.fastChannels;

    dc.onopen = () => {
      store.set(targetId, dc);
      console.log(`${isReliable ? 'Reliable' : 'Fast'} channel open with ${targetId}`);

      // Exchange names immediately
      if (isReliable) {
        dc.send(JSON.stringify({ type: 'hello', name: this.myName }));
      }

      // Only announce "peer joined" once both channels for that peer are open
      if (this.fastChannels.has(targetId) && this.reliableChannels.has(targetId)) {
        if (this.isHost && this.onPeerJoined) this.onPeerJoined(targetId);
        if (this.isHost) this._syncLobby();
        this._startPing(targetId);
      }
    };

    dc.onclose = () => { store.delete(targetId); };

    dc.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'ping') {
        this._sendRaw(targetId, isReliable, { type: 'pong', t: msg.t });
        return;
      }
      if (msg.type === 'pong') {
        const rtt = performance.now() - msg.t;
        this.ping.set(targetId, Math.round(rtt));
        if (this.onPingUpdate) this.onPingUpdate(targetId, Math.round(rtt));
        return;
      }
      if (msg.type === 'game_start') {
        if (this.onGameStarted) this.onGameStarted(msg.initialState, false);
        return;
      }
      if (msg.type === 'start_spinner') {
        if (this.onGameStarted) this.onGameStarted(msg.initialState, true);
        return;
      }
      if (msg.type === 'lobby_sync') {
        this.playerNames.clear();
        this.playerNames.set(this.myId, this.myName);
        msg.players.forEach(p => {
          this.playerNames.set(p.id, p.name);
        });
        if (this.onLobbySync) this.onLobbySync();
        return;
      }
      if (msg.type === 'hello') {
        this.playerNames.set(targetId, msg.name);
        if (this.isHost) this._syncLobby();
        return;
      }
      if (msg.type === 'game_end') {
        if (this.onGameEnded) this.onGameEnded(msg.result);
        return;
      }
      if (msg.type === 'chat') {
        if (this.onChatMessage) this.onChatMessage(targetId, msg);
        if (this.isHost) this.broadcast(msg, targetId, true);
        return;
      }

      if (isReliable) {
        if (this.onReliableData) this.onReliableData(targetId, msg);
        if (this.isHost) this.broadcast(msg, targetId, true);
      } else {
        if (this.onPeerData) this.onPeerData(targetId, msg);
        if (this.isHost && msg.type === 'state_update') {
          msg.peerId = targetId;
          this.broadcast(msg, targetId, false);
        }
      }
    };
  }

  _startPing(peerId) {
    if (this._pingTimers.has(peerId)) clearInterval(this._pingTimers.get(peerId));
    const timer = setInterval(() => {
      this._sendRaw(peerId, true, { type: 'ping', t: performance.now() });
    }, 2000);
    this._pingTimers.set(peerId, timer);
    this._sendRaw(peerId, true, { type: 'ping', t: performance.now() });
  }

  _sendRaw(peerId, reliable, data) {
    const dc = (reliable ? this.reliableChannels : this.fastChannels).get(peerId);
    if (dc && dc.readyState === 'open') dc.send(JSON.stringify(data));
  }

  _syncLobby() {
    if (!this.isHost) return;
    const players = Array.from(this.playerNames.entries()).filter(([id]) => 
      id === this.myId || this.reliableChannels.has(id)
    ).map(([id, name]) => ({ id, name }));
    
    this.broadcast({ type: 'lobby_sync', players }, null, true);
  }

  removePeer(peerId) {
    const fdc = this.fastChannels.get(peerId); if (fdc) fdc.close();
    const rdc = this.reliableChannels.get(peerId); if (rdc) rdc.close();
    this.fastChannels.delete(peerId);
    this.reliableChannels.delete(peerId);

    const pc = this.peers.get(peerId);
    if (pc) pc.close();
    this.peers.delete(peerId);

    if (this._pingTimers.has(peerId)) { clearInterval(this._pingTimers.get(peerId)); this._pingTimers.delete(peerId); }
    this.ping.delete(peerId);
    if (this.isHost) this._syncLobby();
  }

  cleanup() {
    for (const [id] of this.peers) this.removePeer(id);
  }

  close() {
    this._manualClose = true;
    this.cleanup();
    if (this.ws) this.ws.close();
  }

  // Fast (unreliable) send — position/rotation/anim ticks
  sendData(data) {
    if (this.isHost) {
      this.broadcast(data, null, false);
    } else {
      this._sendRaw(this.hostId, false, data);
    }
  }

  // Reliable send — must-arrive events (infect, extract, chat, etc.)
  sendReliable(data) {
    if (this.isHost) {
      this.broadcast(data, null, true);
    } else {
      this._sendRaw(this.hostId, true, data);
    }
  }

  // Send to a specific peer (useful for late-join sync)
  sendToPeer(peerId, data, reliable = true) {
    this._sendRaw(peerId, reliable, data);
  }

  sendChat(text) {
    const msg = { type: 'chat', senderId: this.myId, text: String(text).slice(0, 140), t: Date.now() };
    if (this.isHost) {
      this.broadcast(msg, null, true);
      if (this.onChatMessage) this.onChatMessage(this.myId, msg);
    } else {
      this._sendRaw(this.hostId, true, msg);
      if (this.onChatMessage) this.onChatMessage(this.myId, msg);
    }
  }

  // Host only: send to all peers (optionally exclude one)
  broadcast(data, excludeId = null, reliable = false) {
    if (!this.isHost) return;
    const store = reliable ? this.reliableChannels : this.fastChannels;
    const msgStr = JSON.stringify(data);
    for (const [id, dc] of store) {
      if (id !== excludeId && dc.readyState === 'open') dc.send(msgStr);
    }
  }

  getMyPing() {
    // As a peer, my relevant ping is to the host
    if (!this.isHost) return this.ping.get(this.hostId) ?? null;
    // As host, report the worst peer ping (bottleneck for the match)
    let worst = null;
    for (const v of this.ping.values()) { if (worst === null || v > worst) worst = v; }
    return worst;
  }

  // Host starts the game
  startGame() {
    if (!this.isHost) return;
    const playerIds = [this.myId, ...Array.from(this.reliableChannels.keys())];
    const initialZombieIndex = Math.floor(Math.random() * playerIds.length);
    const initialZombieId = playerIds[initialZombieIndex];

    const initialState = {
      players: playerIds,
      zombies: [initialZombieId],
      startTime: Date.now()
    };

    this.broadcast({ type: 'start_spinner', initialState }, null, true);
    if (this.onGameStarted) this.onGameStarted(initialState, true);
  }
}