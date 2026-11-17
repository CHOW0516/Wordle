// HTTP server for the browser files + WebSocket server for the game.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

function readWordList(fileName) {
  return fs
    .readFileSync(path.join(__dirname, 'words', fileName), 'utf8')
    .split('\n')
    .map((line) => line.trim().toLowerCase())
    .filter((line) => /^[a-z]{5}$/.test(line));
}

const answerWords = readWordList('answers.txt');
const allowedWords = new Set([...readWordList('allowed.txt'), ...answerWords]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const httpServer = http.createServer((request, response) => {
  const urlPath = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const filePath = path.join(PUBLIC_DIR, urlPath === '/' ? 'index.html' : urlPath);

  // Block paths like /../server.js
  if (!filePath.startsWith(PUBLIC_DIR + path.sep)) {
    response.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (error, contents) => {
    if (error) {
      response.writeHead(404).end('Not found');
      return;
    }
    const contentType = CONTENT_TYPES[path.extname(filePath)] || 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': contentType }).end(contents);
  });
});

const rooms = new Map(); // code -> Room
const sockets = new Map(); // playerId -> WebSocket

function send(playerId, message) {
  const socket = sockets.get(playerId);
  if (socket && socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}

function createRoomCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no I or O, to avoid confusion with 1 and 0
  let code;
  do {
    code = Array.from({ length: 4 }, () => letters[crypto.randomInt(letters.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = createRoomCode();
  const room = new Room(code, {
    answerWords,
    allowedWords,
    send,
    onEmpty: () => rooms.delete(code),
  });
  rooms.set(code, room);
  return room;
}

// A dropped player can come back within this time and keep their score and board.
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 60000;
const MAX_MESSAGE_BYTES = 1024;
const MAX_MESSAGES_PER_SECOND = 20;

const sessions = new Map(); // secret token -> { playerId, room, removeTimer }

const webSocketServer = new WebSocketServer({ server: httpServer, maxPayload: MAX_MESSAGE_BYTES });

webSocketServer.on('connection', (socket) => {
  let playerId = null;
  let token = null;
  let room = null;
  let messagesThisSecond = 0;
  let currentSecond = 0;

  const reply = (message) => socket.send(JSON.stringify(message));
  const replyError = (error) => {
    if (error) reply({ type: 'error', message: error });
  };

  function join(message) {
    let targetRoom;
    if (message.code) {
      targetRoom = rooms.get(String(message.code).trim().toUpperCase());
      if (!targetRoom) return replyError('No room with that code.');
    } else {
      targetRoom = createRoom();
    }
    const newPlayerId = crypto.randomUUID();
    sockets.set(newPlayerId, socket);
    const error = targetRoom.addPlayer(newPlayerId, message.name);
    if (error) {
      sockets.delete(newPlayerId);
      if (targetRoom.players.size === 0) rooms.delete(targetRoom.code);
      return replyError(error);
    }
    playerId = newPlayerId;
    room = targetRoom;
    token = crypto.randomUUID();
    sessions.set(token, { playerId, room, removeTimer: null });
    reply({ type: 'joined', token });
  }

  function rejoin(message) {
    const session = sessions.get(String(message.token));
    if (!session || !session.room.players.has(session.playerId)) {
      return reply({ type: 'rejoinFailed' });
    }
    clearTimeout(session.removeTimer);
    session.removeTimer = null;

    // If the old connection is still open (e.g. same tab reloaded fast), this one replaces it.
    const oldSocket = sockets.get(session.playerId);
    sockets.set(session.playerId, socket);
    if (oldSocket && oldSocket !== socket) oldSocket.close();

    playerId = session.playerId;
    room = session.room;
    token = String(message.token);
    reply({ type: 'joined', token });
    room.setConnected(playerId, true);
    room.broadcastState();
  }

  socket.on('message', (rawMessage) => {
    const second = Math.floor(Date.now() / 1000);
    if (second !== currentSecond) {
      currentSecond = second;
      messagesThisSecond = 0;
    }
    if (++messagesThisSecond > MAX_MESSAGES_PER_SECOND) return;

    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'join' || message.type === 'rejoin') {
      if (room) return replyError('You are already in a room.');
      return message.type === 'join' ? join(message) : rejoin(message);
    }

    if (!room) return replyError('Join a room first.');
    if (message.type === 'start') replyError(room.start(playerId));
    else if (message.type === 'guess') replyError(room.guess(playerId, message.word));
    else if (message.type === 'hint') replyError(room.hint(playerId));
    else if (message.type === 'matchLength') replyError(room.setMatchLength(playerId, message.minutes));
    else if (message.type === 'sabotage') replyError(room.sabotage(playerId, message.targetId));
  });

  // Without this, a bad frame (e.g. one over the size limit) would crash the whole server.
  socket.on('error', () => socket.terminate());

  socket.on('close', () => {
    // Ignore sockets that never joined, or that were replaced by a newer connection.
    if (!room || sockets.get(playerId) !== socket) return;
    sockets.delete(playerId);

    const leaveRoom = () => {
      sessions.delete(token);
      room.removePlayer(playerId);
    };
    if (room.state === 'playing') {
      room.setConnected(playerId, false);
      sessions.get(token).removeTimer = setTimeout(leaveRoom, RECONNECT_GRACE_MS);
    } else {
      leaveRoom();
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`Word Rush running at http://localhost:${PORT}`);
});
