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

const webSocketServer = new WebSocketServer({ server: httpServer });

webSocketServer.on('connection', (socket) => {
  const playerId = crypto.randomUUID();
  sockets.set(playerId, socket);
  let room = null;

  const replyError = (error) => {
    if (error) send(playerId, { type: 'error', message: error });
  };

  socket.on('message', (rawMessage) => {
    let message;
    try {
      message = JSON.parse(rawMessage);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'join') {
      if (room) return replyError('You are already in a room.');
      let targetRoom;
      if (message.code) {
        targetRoom = rooms.get(String(message.code).trim().toUpperCase());
        if (!targetRoom) return replyError('No room with that code.');
      } else {
        targetRoom = createRoom();
      }
      const error = targetRoom.addPlayer(playerId, message.name);
      if (error) {
        if (targetRoom.players.size === 0) rooms.delete(targetRoom.code);
        return replyError(error);
      }
      room = targetRoom;
      return;
    }

    if (!room) return replyError('Join a room first.');
    if (message.type === 'start') replyError(room.start(playerId));
    else if (message.type === 'guess') replyError(room.guess(playerId, message.word));
    else if (message.type === 'sabotage') replyError(room.sabotage(playerId, message.targetId));
  });

  socket.on('close', () => {
    sockets.delete(playerId);
    if (room) room.removePlayer(playerId);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Word Rush running at http://localhost:${PORT}`);
});
