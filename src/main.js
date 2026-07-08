import { NetworkManager } from './network.js';
import { Game } from './game.js';
import { Menu3D } from './menu3d.js';

// DOM Elements
const screenLobby = document.getElementById('lobby-screen');
const screenGame = document.getElementById('game-hud');
const mainMenu = document.getElementById('main-menu');
const roomWaiting = document.getElementById('room-waiting');
const inputRoomCode = document.getElementById('input-room-code');
const roomCodeDisplay = document.getElementById('room-code-display');
const btnCreateRoom = document.getElementById('btn-create-room');
const btnJoinRoom = document.getElementById('btn-join-room');
const btnStartMatch = document.getElementById('btn-start-match');
const hostControls = document.getElementById('host-controls');
const peerStatus = document.getElementById('peer-status');
const playerCountEl = document.getElementById('player-count');
const playersUl = document.getElementById('players-ul');
const gameOverModal = document.getElementById('game-over-modal');
const btnBackLobby = document.getElementById('btn-back-lobby');
const btnMute = document.getElementById('btn-mute');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const connStatusEl = document.getElementById('conn-status');
const toastContainer = document.getElementById('toast-container');
const btnCopyCode = document.getElementById('btn-copy-code');

// State
let network = null;
let game = null;
let menu3d = null;
let isHost = false;
let starting = false;
let hostRoundTime = 180;

function showToast(message, kind = 'info') {
  if (!toastContainer) { console.log(message); return; }
  const el = document.createElement('div');
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 3500);
}

function setLoading(visible, text) {
  if (!loadingOverlay) return;
  loadingOverlay.classList.toggle('hidden', !visible);
  if (text && loadingText) loadingText.textContent = text;
}

function init() {
  network = new NetworkManager();
  menu3d = new Menu3D('game-container');

  network.onSignalingStatus = (status) => {
    if (!connStatusEl) return;
    connStatusEl.className = `conn-status conn-${status}`;
    connStatusEl.textContent = {
      connecting: 'Connecting…',
      connected: 'Connected',
      reconnecting: 'Reconnecting…',
      failed: 'Connection failed',
    }[status] || '';
  };

  network.onRoomCreated = (code) => {
    isHost = true;
    showWaitingRoom(code);
    hostControls.classList.remove('hidden');
    peerStatus.classList.add('hidden');
    btnStartMatch.classList.remove('hidden');
    updatePlayerList();
  };

  network.onRoomJoined = (code) => {
    isHost = false;
    showWaitingRoom(code);
    hostControls.classList.add('hidden');
    peerStatus.classList.remove('hidden');
    btnStartMatch.classList.add('hidden');
    updatePlayerList();
  };

  network.onPeerJoined = (peerId) => {
    updatePlayerList();
    showToast('A survivor joined the lobby.');
    if (isHost && network.reliableChannels.size >= 1) {
      btnStartMatch.classList.remove('disabled');
      btnStartMatch.disabled = false;
      btnStartMatch.textContent = 'Start Match';
    }

    if (isHost && game && game.isRunning) {
      const syncState = {
        players: Array.from(game.players.keys()),
        zombies: Array.from(game.players.values()).filter(p => p.role === 'zombie').map(p => p.id),
        startTime: game.startTime
      };
      network.sendToPeer(peerId, { type: 'game_start', initialState: syncState });

      if (!game.players.has(peerId)) {
        game.spawnPlayer(peerId, 'survivor');
        network.broadcast({ type: 'player_spawn', id: peerId, role: 'survivor' }, peerId, true);
      }
    }
  };

  network.onLobbySync = () => {
    updatePlayerList();
  };

  network.onPeerLeft = () => {
    updatePlayerList();
    showToast('A player disconnected.', 'warn');
    if (isHost && network.reliableChannels.size < 1) {
      btnStartMatch.classList.add('disabled');
      btnStartMatch.disabled = true;
      btnStartMatch.textContent = 'Start Match (Need 2+)';
    }
  };

  network.onError = (msg) => {
    showToast(msg, 'error');
    if (!game) showMainMenu();
  };

  network.onHostDisconnected = () => {
    showToast('Host disconnected.', 'error');
    if (game) { game.stop(); game = null; }
    showMainMenu();
  };

  network.onGameStarted = (initialState, useSpinner) => {
    if (useSpinner) {
      showSpinner(initialState);
    } else {
      startGame(initialState);
    }
  };

  function showSpinner(initialState) {
    const spinnerModal = document.getElementById('spinner-modal');
    const spinnerName = document.getElementById('spinner-name');
    
    screenLobby.classList.remove('active');
    screenLobby.classList.add('hidden');
    screenGame.classList.remove('hidden'); // UNHIDE GAME SCREEN SO IT DOESN'T LOOK PITCH BLACK!
    spinnerModal.classList.remove('hidden');
    spinnerName.classList.remove('highlight');
    
    const players = initialState.players;
    const zombieId = initialState.zombies[0];
    
    let cycles = 0;
    const interval = setInterval(() => {
      cycles++;
      const randId = players[Math.floor(Math.random() * players.length)];
      let dName = network.playerNames.get(randId) || `Player ${randId.slice(0, 4)}`;
      if (randId === network.myId) dName = 'You';
      spinnerName.textContent = dName;
      
      if (cycles >= 30) {
        clearInterval(interval);
        let zName = network.playerNames.get(zombieId) || `Player ${zombieId.slice(0, 4)}`;
        if (zombieId === network.myId) zName = 'You';
        spinnerName.textContent = zName;
        spinnerName.classList.add('highlight');
        
        setTimeout(() => {
          spinnerModal.classList.add('hidden');
          startGame(initialState);
        }, 1500);
      }
    }, 100);
  }

  network.onGameEnded = (result) => {
    if (game) {
      game.handleGameOver(result);
      gameOverModal.classList.remove('hidden');
      document.getElementById('game-over-title').textContent = result === 'zombies' ? 'ZOMBIES WIN' : 'SURVIVORS WIN';
      document.getElementById('game-over-desc').textContent = result === 'zombies' ? 'All survivors were infected.' : 'The survivors escaped!';
    }
  };

  // UI Listeners
  btnCreateRoom.addEventListener('click', () => {
    isHost = true;
    network.myName = document.getElementById('input-name').value.trim() || 'Survivor';
    network.playerNames.set(network.myId, network.myName);
    setLoading(true, 'Creating room…');
    network.createRoom();
  });

  btnJoinRoom.addEventListener('click', () => {
    const code = inputRoomCode.value.trim().toUpperCase();
    if (!code) return showToast('Please enter a room code');
    isHost = false;
    network.myName = document.getElementById('input-name').value.trim() || 'Survivor';
    network.playerNames.set(network.myId, network.myName);
    setLoading(true, 'Joining room…');
    network.joinRoom(code);
  });

  inputRoomCode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') btnJoinRoom.click();
  });
  inputRoomCode.addEventListener('input', () => {
    inputRoomCode.value = inputRoomCode.value.toUpperCase().slice(0, 5);
  });

  btnStartMatch.addEventListener('click', () => {
    if (!isHost || network.reliableChannels.size < 1) return;
    network.startGame(hostRoundTime);
  });

  const roundTimerInput = document.getElementById('round-timer-input');
  const roundTimerVal = document.getElementById('round-timer-val');
  if (roundTimerInput) {
    roundTimerInput.addEventListener('input', (e) => {
      hostRoundTime = parseInt(e.target.value);
      const m = Math.floor(hostRoundTime / 60);
      const s = hostRoundTime % 60;
      roundTimerVal.textContent = `${m}:${s.toString().padStart(2, '0')}`;
    });
  }

  btnBackLobby.addEventListener('click', () => {
    gameOverModal.classList.add('hidden');
    if (game) { game.stop(); game = null; }
    starting = false;
    showWaitingRoom(network.roomCode);
  });

  btnMute?.addEventListener('click', () => {
    if (game) game.toggleMute();
  });

  btnCopyCode?.addEventListener('click', async () => {
    if (!network.roomCode) return;
    try {
      await navigator.clipboard.writeText(network.roomCode);
      showToast('Room code copied.');
    } catch {
      showToast('Could not copy — copy it manually.', 'error');
    }
  });

  window.addEventListener('beforeunload', () => { network?.close(); });
}

function showMainMenu() {
  setLoading(false);
  mainMenu.classList.remove('hidden');
  roomWaiting.classList.add('hidden');
  screenLobby.classList.remove('hidden');
  screenLobby.classList.add('active');
  screenGame.classList.add('hidden');
  if (!menu3d) menu3d = new Menu3D('game-container');
}

function showWaitingRoom(code) {
  setLoading(false);
  mainMenu.classList.add('hidden');
  roomWaiting.classList.remove('hidden');
  screenLobby.classList.remove('hidden');
  screenLobby.classList.add('active');
  roomCodeDisplay.textContent = `Room: ${code}`;
}

function updatePlayerList() {
  playersUl.innerHTML = '';

  const addLi = (id, name, isHostLi) => {
    const li = document.createElement('li');
    if (id === network.myId) name += ' (You)';
    li.textContent = name;
    playersUl.appendChild(li);
  };

  const hostName = network.playerNames.get(isHost ? network.myId : network.hostId) || 'Host';
  addLi(isHost ? network.myId : network.hostId, hostName, true);

  if (isHost) {
    network.reliableChannels.forEach((_, id) => {
      const name = network.playerNames.get(id) || `Peer ${id.slice(0, 4)}`;
      addLi(id, name, false);
    });
    playerCountEl.textContent = network.reliableChannels.size + 1;
  } else {
    network.playerNames.forEach((name, id) => {
      if (id !== network.hostId) addLi(id, name, false);
    });
    playerCountEl.textContent = network.playerNames.size || 1;
  }
}

async function startGame(initialState) {
  if (menu3d) { menu3d.destroy(); menu3d = null; }
  screenLobby.classList.remove('active');
  screenLobby.classList.add('hidden');
  screenGame.classList.remove('hidden');

  game = new Game(network, isHost);

  setLoading(true, 'Loading world…');
  try {
    await game.start(initialState, (text) => setLoading(true, text));
  } catch (e) {
    console.error(e);
    showToast('Failed to load the arena. Check your connection and try again.', 'error');
    setLoading(false);
    showMainMenu();
    return;
  }
  setLoading(false);
  starting = false;
}

window.addEventListener('DOMContentLoaded', init);