'use strict';

const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { geckos } = require('@geckos.io/server');
const path = require('path');
const { buildColliders, checkCollision, applyMove, makePRNG, ARENA_HALF } = require('./world-server');

const app = express();
const server = http.createServer(app);
const io = geckos({ cors: { origin: '*', allowEIO3: true } });
io.addServer(server);

app.use(express.static(path.join(__dirname, '../dist')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));
app.get('/healthz', (_req, res) => res.status(200).send('ok'));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MAX_PLAYERS = 6;
const TICK_MS = 16.666;        // ~60 Hz
const HISTORY_TICKS = 6;       // ~300 ms of position history for lag comp
const PLAYER_RADIUS = 0.5;
const INFECT_RADIUS = 2.2;
const AURA_INFECT_RADIUS = 4.0;
const POWERUP_COLLECT_RADIUS = 1.5;
const TRAP_TRIGGER_RADIUS = 1.0;

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function safeSend(ws, payload) {
  if (ws) {
    try { ws.emit('msg', payload); } catch (e) { /* ignore */ }
  }
}

function broadcast(clients, payload, excludeId = null) {
  for (const ws of clients) {
    if (ws.playerId !== excludeId) {
      try { ws.emit('msg', payload); } catch { /* ignore */ }
    }
  }
}

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  } while (rooms.has(code));
  return code;
}

// ---------------------------------------------------------------------------
// Room state
// ---------------------------------------------------------------------------
/**
 * Room shape:
 * {
 *   code: string,
 *   clients: Set<WebSocket>,           // all connected WS for this room
 *   players: Map<id, PlayerState>,
 *   colliders: array,                  // built from seed on game start
 *   seed: string,                      // = room code (deterministic layout)
 *   gameRunning: boolean,
 *   tick: number,
 *   roundEndTime: number,              // Date.now() + roundMs
 *   powerups: Map<id, {x,z}>,
 *   traps: Map<id, {x,z,role,ownerId}>,
 *   gameLoopTimer: NodeJS.Timer|null,
 *   powerupTimer: number,              // seconds until next powerup
 *   _powerupIdCounter: number,
 * }
 *
 * PlayerState shape:
 * {
 *   id: string,
 *   name: string,
 *   ws: WebSocket,
 *   x: number, z: number, rotY: number,
 *   role: 'survivor'|'zombie',
 *   isDead: boolean,
 *   isExtracted: boolean,
 *   activePowerups: { speed: number, shield: number, aura: number }, // seconds remaining
 *   speed: number,
 *   // Input state (latest buffered input from this client)
 *   inputMove: { x: number, y: number },
 *   inputAction: boolean,
 *   inputSeq: number,
 *   actionCooldown: number,            // seconds
 *   // Lag compensation: ring buffer of {tick, x, z}
 *   history: Array<{tick:number, x:number, z:number}>,
 *   // RTT tracking
 *   ping: number,                      // ms
 *   lastPingAt: number,
 * }
 */
const rooms = new Map();

// ---------------------------------------------------------------------------
// Player helper constructors
// ---------------------------------------------------------------------------
function makePlayer(id, name, ws, role = 'survivor') {
  return {
    id, name, ws, role,
    x: 0, z: 0, rotY: 0,
    isDead: false, isExtracted: false,
    activePowerups: { speed: 0, shield: 0, aura: 0 },
    speed: role === 'zombie' ? 5.5 : 5.0,
    inputMove: { x: 0, y: 0 },
    inputAction: false, inputSeq: 0,
    inputQueue: [],
    actionCooldown: 0,
    history: [],
    ping: 0, lastPingAt: 0,
  };
}

function recordHistory(player, tick) {
  player.history.push({ tick, x: player.x, z: player.z });
  if (player.history.length > HISTORY_TICKS + 2) player.history.shift();
}

/** Get rewound position for lag comp (ticks back from current tick). */
function getHistoricalPos(player, targetTick) {
  // Clamp to earliest known
  if (!player.history.length) return { x: player.x, z: player.z };
  let best = player.history[0];
  for (const h of player.history) {
    if (Math.abs(h.tick - targetTick) < Math.abs(best.tick - targetTick)) best = h;
  }
  return { x: best.x, z: best.z };
}

// ---------------------------------------------------------------------------
// Spawn positions — circle around origin, spread players out
// ---------------------------------------------------------------------------
function spawnPositions(count) {
  const positions = [];
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    positions.push({ x: Math.cos(angle) * 3, z: Math.sin(angle) * 3 });
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Game loop tick
// ---------------------------------------------------------------------------
function gameTick(room) {
  if (!room.gameRunning) return;

  const dt = TICK_MS / 1000;
  room.tick++;

  // --- 1. Apply inputs → move players ---
  for (const [, p] of room.players) {
    if (p.isDead || p.isExtracted) continue;
    // Process queued inputs
    if (p.inputQueue && p.inputQueue.length > 0) {
      p.inputQueue.sort((a, b) => a.seq - b.seq);
      for (const input of p.inputQueue) {
        if (input.seq <= p.inputSeq) continue;
        
        const idt = input.dt || TICK_MS / 1000;
        if (p.actionCooldown > 0) p.actionCooldown -= idt;
        
        const baseSpeed = p.role === 'zombie' ? 5.5 : 5.0;
        p.speed = p.activePowerups.speed > 0 ? baseSpeed * 1.5 : baseSpeed;
        
        const { x: mx, y: my } = input.move;
        if (mx !== 0 || my !== 0) {
          const len = Math.sqrt(mx * mx + my * my);
          const nx = mx / len, ny = my / len;
          const dx = nx * p.speed * idt;
          const dz = ny * p.speed * idt;
          const moved = applyMove(p.x, p.z, dx, dz, PLAYER_RADIUS, room.colliders);
          p.x = moved.x;
          p.z = moved.z;
          p.rotY = Math.atan2(nx, ny);
        }
        
        p.inputMove = input.move;
        p.inputAction = input.action;
        p.inputSeq = input.seq;
      }
      p.inputQueue = [];
    } else {
      if (p.actionCooldown > 0) p.actionCooldown -= TICK_MS / 1000;
    }

    // Record history for lag comp
    recordHistory(p, room.tick);

    // Decrement powerup timers
    if (p.activePowerups.speed > 0) p.activePowerups.speed -= dt;
    if (p.activePowerups.shield > 0) p.activePowerups.shield -= dt;
    if (p.activePowerups.aura > 0) {
      p.activePowerups.aura -= dt;
    }
  }

  // --- 2. Zombie action / aura infect ---
  for (const [, zombie] of room.players) {
    if (zombie.role !== 'zombie' || zombie.isDead) continue;

    // Aura infect (constant field while active)
    if (zombie.activePowerups.aura > 0) {
      tryInfect(room, zombie, AURA_INFECT_RADIUS, false /* not lag-comp, aura is continuous */);
    }

    // Button-press infect
    if (zombie.inputAction && zombie.actionCooldown <= 0) {
      zombie.actionCooldown = 1.0;
      // Lag-compensated infect
      const lagTicks = Math.round((zombie.ping * 0.5) / TICK_MS);
      const rewindTick = room.tick - lagTicks;
      tryInfectLagComp(room, zombie, INFECT_RADIUS, rewindTick);
    }
  }

  // --- 3. Powerup collection ---
  for (const [pid, p] of room.players) {
    if (p.isDead || p.isExtracted) continue;
    for (const [puid, pu] of room.powerups) {
      const dx = p.x - pu.x, dz = p.z - pu.z;
      if (dx * dx + dz * dz < POWERUP_COLLECT_RADIUS * POWERUP_COLLECT_RADIUS) {
        room.powerups.delete(puid);
        // Grant a random powerup to the collector
        const types = ['speed', 'shield', 'trap'];
        const granted = types[Math.floor(Math.random() * types.length)];
        broadcast(room.clients, { type: 'powerup_claimed', id: puid, claimerId: pid, granted });
        break;
      }
    }
  }

  // --- 4. Trap collision ---
  for (const [, p] of room.players) {
    if (p.isDead || p.isExtracted) continue;
    for (const [tid, trap] of room.traps) {
      if (trap.role === p.role) continue; // only enemy traps
      const dx = p.x - trap.x, dz = p.z - trap.z;
      if (dx * dx + dz * dz < TRAP_TRIGGER_RADIUS * TRAP_TRIGGER_RADIUS) {
        room.traps.delete(tid);
        broadcast(room.clients, { type: 'trap_trigger', trapId: tid, targetId: p.id });
      }
    }
  }

  // --- 5. Powerup spawn timer ---
  room.powerupTimer -= dt;
  if (room.powerupTimer <= 0) {
    const alivePlayers = [...room.players.values()].filter(p => !p.isDead && !p.isExtracted).length;
    const remain = Math.max(0, room.roundEndTime - Date.now());
    const rate = Math.max(3, 12 - alivePlayers * 1.5 - (remain < 60000 ? 3 : 0));
    room.powerupTimer = rate;

    const rng = makePRNG(room.seed + room.tick);
    const px = (rng() - 0.5) * 44;
    const pz = (rng() - 0.5) * 44;
    const puid = `pu_${room.tick}`;
    room.powerups.set(puid, { x: px, z: pz });
    broadcast(room.clients, { type: 'powerup_spawned', id: puid, x: px, z: pz });
  }

  // --- 6. Build and broadcast snapshot ---
  if (room.tick % 3 === 0) {
    const snapshot = {
      type: 'snapshot',
      tick: room.tick,
      serverTime: Date.now(),   // wall-clock for client jitter measurement + debug overlay
      players: [],
    };
    for (const [, p] of room.players) {
      snapshot.players.push({
        id: p.id,
        tick: room.tick,   // Bug #3 fix: per-player tick needed for client interpolation
        seq: p.inputSeq,   // echo last processed input seq so client can match prediction frames
        x: p.x, z: p.z, rotY: p.rotY,
        role: p.role,
        isDead: p.isDead,
        isExtracted: p.isExtracted,
        anim: resolveAnim(p),
        powerups: {
          speed: p.activePowerups.speed > 0,
          shield: p.activePowerups.shield > 0,
          aura: p.activePowerups.aura > 0,
        },
      });
    }
    broadcast(room.clients, snapshot);
  }

  // --- 7. Check win conditions ---
  const remain = room.roundEndTime - Date.now();
  const survivors = [...room.players.values()].filter(p => p.role === 'survivor' && !p.isDead && !p.isExtracted);
  const zombies = [...room.players.values()].filter(p => p.role === 'zombie');

  if (zombies.length > 0 && survivors.length === 0) {
    endGame(room, 'zombies');
  } else if (remain <= 0 && survivors.length > 0) {
    endGame(room, 'survivors');
  }
}

function resolveAnim(p) {
  if (p.isDead) return 'die';
  const moving = p.inputMove.x !== 0 || p.inputMove.y !== 0;
  if (p.actionCooldown > 0.7 && p.role === 'zombie') return 'attack-melee-right';
  return moving ? 'sprint' : 'idle';
}

// ---------------------------------------------------------------------------
// Infect helpers
// ---------------------------------------------------------------------------
function tryInfect(room, zombie, radius, _lagComp) {
  for (const [, survivor] of room.players) {
    if (survivor.role !== 'survivor' || survivor.isDead || survivor.isExtracted) continue;
    if (survivor.activePowerups.shield > 0) continue;
    const dx = zombie.x - survivor.x, dz = zombie.z - survivor.z;
    if (dx * dx + dz * dz < radius * radius) {
      infectPlayer(room, survivor, zombie.id);
    }
  }
}

function tryInfectLagComp(room, zombie, radius, rewindTick) {
  for (const [, survivor] of room.players) {
    if (survivor.role !== 'survivor' || survivor.isDead || survivor.isExtracted) continue;
    if (survivor.activePowerups.shield > 0) continue;
    const pos = getHistoricalPos(survivor, rewindTick);
    const dx = zombie.x - pos.x, dz = zombie.z - pos.z;
    if (dx * dx + dz * dz < radius * radius) {
      infectPlayer(room, survivor, zombie.id);
    }
  }
}

function infectPlayer(room, survivor, sourceId) {
  if (survivor.isDead) return; // avoid double-infect
  survivor.isDead = true;
  broadcast(room.clients, { type: 'infect_event', targetId: survivor.id, sourceId });

  // After 2s the player becomes a zombie
  setTimeout(() => {
    if (!room.gameRunning) return;
    const p = room.players.get(survivor.id);
    if (!p) return;
    p.role = 'zombie';
    p.isDead = false;
    p.speed = 5.5;
    p.activePowerups = { speed: 0, shield: 0, aura: 0 };
    broadcast(room.clients, { type: 'role_changed', playerId: p.id, role: 'zombie' });
  }, 2000);
}

// ---------------------------------------------------------------------------
// End game
// ---------------------------------------------------------------------------
function endGame(room, result) {
  if (!room.gameRunning) return;
  room.gameRunning = false;
  clearInterval(room.gameLoopTimer);
  room.gameLoopTimer = null;
  // Bug #5 fix: clear ping interval when game ends
  if (room.pingInterval) { clearInterval(room.pingInterval); room.pingInterval = null; }
  broadcast(room.clients, { type: 'game_end', result });
}

// ---------------------------------------------------------------------------
// Close / cleanup a room
// ---------------------------------------------------------------------------
function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.gameLoopTimer) clearInterval(room.gameLoopTimer);
  if (room.pingInterval) clearInterval(room.pingInterval);
  broadcast(room.clients, { type: 'host_disconnected' });
  rooms.delete(code);
  console.log(`Room ${code} closed (${reason})`);
}

// ---------------------------------------------------------------------------
// Connection handler
// ---------------------------------------------------------------------------
io.onConnection((ws) => {
  // Bug #2 fix: use cryptographically-secure server-generated ID (16 hex chars)
  ws.playerId = crypto.randomBytes(8).toString('hex');
  ws.roomCode = null;

  ws.on('msg', (raw) => {
    let data = raw;
    if (typeof raw === 'string') {
      try { data = JSON.parse(raw); } catch { return; }
    }

    try {
      switch (data.type) {

        // ---- Lobby ----
        case 'create_room': {
          // Bug #2 fix: server assigns the canonical ID, ignoring client suggestion
          const code = generateRoomCode();
          ws.roomCode = code;
          const room = {
            code,
            clients: new Set([ws]),
            players: new Map([[ws.playerId, makePlayer(ws.playerId, data.myName || 'Player', ws)]]),
            colliders: [],
            seed: code,
            gameRunning: false,
            tick: 0,
            roundEndTime: 0,
            powerups: new Map(),
            traps: new Map(),
            gameLoopTimer: null,
            pingInterval: null,   // Bug #5 fix: stored on room for proper cleanup
            powerupTimer: 5,
            _powerupIdCounter: 0,
            hostId: ws.playerId,  // Bug #19 fix: track who can start the game
          };
          rooms.set(code, room);
          safeSend(ws, { type: 'room_created', code, yourId: ws.playerId });
          console.log(`Room created: ${code} by ${ws.playerId}`);
          break;
        }

        case 'join_room': {
          // Bug #2 fix: server uses its own assigned ID, ignores client's suggestion
          const code = String(data.code || '').toUpperCase();
          const room = rooms.get(code);
          if (!room) { safeSend(ws, { type: 'error', message: 'Room not found.' }); return; }
          if (room.players.size >= MAX_PLAYERS) { safeSend(ws, { type: 'error', message: 'Room is full.' }); return; }

          ws.roomCode = code;
          room.clients.add(ws);

          const newPlayer = makePlayer(ws.playerId, data.myName || 'Player', ws);
          room.players.set(ws.playerId, newPlayer);

          // Tell the newcomer who's already here
          const existingPlayers = [...room.players.entries()]
            .filter(([id]) => id !== ws.playerId)
            .map(([id, p]) => ({ id, name: p.name }));

          safeSend(ws, { type: 'room_joined', code, yourId: ws.playerId, players: existingPlayers });

          // If game is already running, send them current state
          if (room.gameRunning) {
            const syncState = buildInitialState(room);
            safeSend(ws, { type: 'game_start', initialState: syncState });
          }

          // Bug #9 fix: include role so clients can spawn with the correct model
          broadcast(room.clients, { type: 'peer_joined', id: ws.playerId, name: newPlayer.name, role: newPlayer.role }, ws.playerId);
          console.log(`Player ${ws.playerId} joined room ${code}`);
          break;
        }

        case 'start_game': {
          const room = rooms.get(ws.roomCode);
          if (!room || room.gameRunning) return;
          // Bug #19 fix: only the host can start the game
          if (ws.playerId !== room.hostId) { safeSend(ws, { type: 'error', message: 'Only the host can start the game.' }); return; }
          if (room.players.size < 2) { safeSend(ws, { type: 'error', message: 'Need at least 2 players.' }); return; }

          startGame(room, data.roundTime || 180, data.useSpinner !== false);
          break;
        }

        // ---- Gameplay ----
        case 'player_ready': {
          const room = rooms.get(ws.roomCode);
          if (!room || !room.gameRunning) return;
          const p = room.players.get(ws.playerId);
          if (p) p.isReady = true;

          if (room.allPlayersReady) {
            safeSend(ws, { type: 'all_ready', startTime: room.roundEndTime - room._roundMs - 2000, roundEndTime: room.roundEndTime });
            return;
          }

          let allReady = true;
          for (const [, rp] of room.players) {
            if (!rp.isReady) { allReady = false; break; }
          }
          
          if (allReady && !room.allPlayersReady) {
            room.allPlayersReady = true;
            room.roundEndTime = Date.now() + room._roundMs + 2000;
            broadcast(room.clients, { type: 'all_ready', startTime: Date.now(), roundEndTime: room.roundEndTime });
            room.gameLoopTimer = setInterval(() => gameTick(room), TICK_MS);
          }
          break;
        }

        case 'input_batch': {
          const room = rooms.get(ws.roomCode);
          if (!room || !room.gameRunning) return;
          const p = room.players.get(ws.playerId);
          if (!p || p.isDead || p.isExtracted) return;
          if (data.inputs && Array.isArray(data.inputs)) {
            p.inputQueue.push(...data.inputs);
          }
          break;
        }

        case 'use_powerup': {
          const room = rooms.get(ws.roomCode);
          if (!room || !room.gameRunning) return;
          const p = room.players.get(ws.playerId);
          if (!p) return;
          handlePowerupUse(room, p, data.powerup, data.trapId, data.x, data.z);
          break;
        }

        case 'chat': {
          const room = rooms.get(ws.roomCode);
          if (!room) return;
          const p = room.players.get(ws.playerId);
          const safeText = String(data.text || '').slice(0, 140);
          broadcast(room.clients, { type: 'chat', senderId: ws.playerId, senderName: p?.name || 'Unknown', text: safeText, t: Date.now() });
          break;
        }

        case 'pong': {
          const room = rooms.get(ws.roomCode);
          if (!room) return;
          const p = room.players.get(ws.playerId);
          if (p && data.t) {
            p.ping = Math.round(Date.now() - data.t);
          }
          break;
        }

        case 'client_ping': {
          safeSend(ws, { type: 'client_pong' });
          break;
        }

        default: break;
      }
    } catch (e) {
      console.error('Error handling message:', e);
    }
  });

  ws.onDisconnect(() => {
    const room = rooms.get(ws.roomCode);
    if (!room) return;
    const wasHost = (ws.playerId === room.hostId);
    room.players.delete(ws.playerId);
    room.clients.delete(ws);
    broadcast(room.clients, { type: 'peer_left', id: ws.playerId });
    console.log(`Player ${ws.playerId} left room ${ws.roomCode}`);

    if (room.players.size === 0) {
      closeRoom(ws.roomCode, 'all players left');
    } else if (wasHost) {
      // Promote another player to host
      room.hostId = room.players.keys().next().value;
      const newHostPlayer = room.players.get(room.hostId);
      if (newHostPlayer) {
        safeSend(newHostPlayer.ws, { type: 'host_promoted', yourId: room.hostId });
        console.log(`Host promoted to ${room.hostId} in room ${ws.roomCode}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Start game
// ---------------------------------------------------------------------------
function buildInitialState(room) {
  return {
    seed: room.seed,
    roundTime: Math.max(0, Math.round((room.roundEndTime - Date.now()) / 1000)),
    startTime: room.roundEndTime - (room._roundMs || 180000),
    players: [...room.players.keys()],
    zombies: [...room.players.values()].filter(p => p.role === 'zombie').map(p => p.id),
    positions: [...room.players.values()].map(p => ({ id: p.id, x: p.x, z: p.z })),
    playerNames: [...room.players.values()].map(p => ({ id: p.id, name: p.name })),
  };
}

function startGame(room, roundTime, useSpinner) {
  const playerIds = [...room.players.keys()];
  const zombieIdx = Math.floor(Math.random() * playerIds.length);
  const zombieId = playerIds[zombieIdx];

  // Build collision geometry using room code as seed
  room.colliders = buildColliders(room.seed);

  // Assign roles and spawn positions
  const positions = spawnPositions(playerIds.length);
  playerIds.forEach((id, i) => {
    const p = room.players.get(id);
    p.role = id === zombieId ? 'zombie' : 'survivor';
    p.x = positions[i].x;
    p.z = positions[i].z;
    p.isDead = false;
    p.isExtracted = false;
    p.activePowerups = { speed: 0, shield: 0, aura: 0 };
    p.actionCooldown = 0;
    p.history = [];
    p.inputMove = { x: 0, y: 0 };
    p.inputAction = false;
  });

  room.allPlayersReady = false;
  room.gameRunning = true;
  room.tick = 0;
  room._roundMs = roundTime * 1000;
  room.powerups.clear();
  room.traps.clear();
  room.powerupTimer = 5;

  const initialState = buildInitialState(room);
  const msgType = useSpinner ? 'start_spinner' : 'game_start';
  broadcast(room.clients, { type: msgType, initialState });

  // Bug #5 fix: store ping interval on room so endGame() can clear it
  room.pingInterval = setInterval(() => {
    if (!room.gameRunning) { clearInterval(room.pingInterval); room.pingInterval = null; return; }
    broadcast(room.clients, { type: 'ping', t: Date.now() });
  }, 2000);

  // Delay starting game loop until all players send player_ready
  console.log(`Game started in room ${room.code}, zombie: ${zombieId}, seed: ${room.seed}`);
}

// ---------------------------------------------------------------------------
// Powerup use handler
// ---------------------------------------------------------------------------
function handlePowerupUse(room, player, powerupType, trapId, trapX, trapZ) {
  if (powerupType === 'speed') {
    player.activePowerups.speed = 5.0;
  } else if (powerupType === 'shield') {
    if (player.role === 'zombie') player.activePowerups.aura = 10.0;
    else player.activePowerups.shield = 8.0;
  } else if (powerupType === 'trap' && trapId) {
    const x = trapX || player.x;
    const z = trapZ || player.z;
    room.traps.set(trapId, { x, z, role: player.role, ownerId: player.id });
  }

  broadcast(room.clients, {
    type: 'use_powerup',
    senderId: player.id,
    powerup: powerupType,
    role: player.role,
    trapId: trapId || null,
    x: trapX || player.x,
    z: trapZ || player.z,
  });
}

process.on('SIGTERM', () => {
  server.close(() => process.exit(0));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`OutbreakArena server running on port ${PORT}`));