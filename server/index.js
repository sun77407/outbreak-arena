const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../dist')));
app.use('/assets', express.static(path.join(__dirname, '../assets')));

// Simple health check for load balancers / uptime monitors
app.get('/healthz', (req, res) => res.status(200).send('ok'));

// Rooms map: roomCode -> { host: ws, peers: Set(ws) }
const rooms = new Map();
const MAX_PEERS_PER_ROOM = 5; // host + 5 peers = 6 max

function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  do {
    code = '';
    for (let i = 0; i < 5; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  } while (rooms.has(code)); // avoid rare collisions
  return code;
}

function safeSend(ws, payload) {
  if (ws && ws.readyState === ws.OPEN) {
    try { ws.send(JSON.stringify(payload)); } catch (e) { console.error('send failed', e); }
  }
}

function closeRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return;
  room.peers.forEach((p) => {
    safeSend(p, { type: 'host_disconnected' });
    try { p.close(); } catch { /* already closed */ }
  });
  rooms.delete(code);
  console.log(`Room ${code} closed (${reason})`);
}

wss.on('connection', (ws) => {
  ws.id = Math.random().toString(36).substr(2, 9);
  ws.isAlive = true;
  let currentRoom = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (message) => {
    let data;
    try {
      data = JSON.parse(message);
    } catch (e) {
      safeSend(ws, { type: 'error', message: 'Malformed message.' });
      return;
    }

    try {
      switch (data.type) {
        case 'create_room': {
          if (data.myId) ws.id = data.myId;
          const code = generateRoomCode();
          currentRoom = code;
          rooms.set(code, { host: ws, peers: new Set() });
          safeSend(ws, { type: 'room_created', code });
          console.log(`Room created: ${code}`);
          break;
        }

        case 'join_room': {
          if (data.myId) ws.id = data.myId;
          const room = rooms.get(String(data.code || '').toUpperCase());
          if (!room) {
            safeSend(ws, { type: 'error', message: 'Room not found.' });
            return;
          }
          if (room.peers.size >= MAX_PEERS_PER_ROOM) {
            safeSend(ws, { type: 'error', message: 'Room is full.' });
            return;
          }
          currentRoom = String(data.code).toUpperCase();
          room.peers.add(ws);

          safeSend(room.host, { type: 'peer_joined', peerId: ws.id });
          safeSend(ws, { type: 'room_joined', code: currentRoom, hostId: room.host.id });
          console.log(`Peer ${ws.id} joined room: ${currentRoom}`);
          break;
        }

        case 'signal': {
          const targetRoom = rooms.get(currentRoom);
          if (!targetRoom) return;

          if (ws === targetRoom.host) {
            const targetPeer = Array.from(targetRoom.peers).find((p) => p.id === data.targetId);
            if (targetPeer) {
              safeSend(targetPeer, { type: 'signal', senderId: ws.id, signalData: data.signalData });
            }
          } else {
            safeSend(targetRoom.host, { type: 'signal', senderId: ws.id, signalData: data.signalData });
          }
          break;
        }

        default:
          // Unknown message types are ignored rather than crashing the connection
          break;
      }
    } catch (e) {
      console.error('Error handling message', e);
      safeSend(ws, { type: 'error', message: 'Server error processing your request.' });
    }
  });

  ws.on('close', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    if (ws === room.host) {
      closeRoom(currentRoom, 'host disconnect');
    } else {
      room.peers.delete(ws);
      safeSend(room.host, { type: 'peer_disconnected', peerId: ws.id });
      console.log(`Peer ${ws.id} left room ${currentRoom}`);
    }
  });

  ws.on('error', (e) => console.error('WS error', e));
});

// Drop dead sockets (e.g. laptop lid closed, phone backgrounded) so rooms
// don't stay stuck waiting on a connection that will never come back.
const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  clearInterval(heartbeat);
  server.close(() => process.exit(0));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
});