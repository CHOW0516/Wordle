// Starts the real server and talks to it over WebSockets.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 3999;
const GRACE_MS = 400;
let serverProcess;

test.before(async () => {
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT, RECONNECT_GRACE_MS: GRACE_MS },
  });
  await new Promise((resolve) => serverProcess.stdout.once('data', resolve));
});

test.after(() => serverProcess.kill());

// A test player: collects every message and can wait for one of a given type.
function openClient() {
  const socket = new WebSocket(`ws://localhost:${PORT}`);
  const messages = [];
  const waiters = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (waiter.matches(message)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  });
  return {
    socket,
    messages,
    opened: new Promise((resolve) => socket.once('open', resolve)),
    send: (message) => socket.send(JSON.stringify(message)),
    next: (matches) => new Promise((resolve) => waiters.push({ matches, resolve })),
    lastState: () => messages.filter((message) => message.type === 'state').pop(),
  };
}

const isType = (type) => (message) => message.type === type;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function startMatch() {
  const ann = openClient();
  await ann.opened;
  ann.send({ type: 'join', name: 'Ann' });
  const { token: annToken } = await ann.next(isType('joined'));
  const code = ann.lastState().code;

  const bob = openClient();
  await bob.opened;
  bob.send({ type: 'join', name: 'Bob', code });
  const { token: bobToken } = await bob.next(isType('joined'));

  ann.send({ type: 'start' });
  await bob.next((message) => message.type === 'state' && message.state === 'playing');
  return { ann, bob, annToken, bobToken, code };
}

test('a player who drops mid-match can rejoin with their token and keep their board', async () => {
  const { ann, bob, bobToken } = await startMatch();
  bob.send({ type: 'guess', word: 'crane' });
  await bob.next((message) => message.type === 'state' && message.you.guesses.length === 1);

  bob.socket.close();
  const offlineState = await ann.next(
    (message) => message.type === 'state' && message.players.some((player) => !player.connected)
  );
  assert.strictEqual(offlineState.state, 'playing');

  const bobAgain = openClient();
  await bobAgain.opened;
  bobAgain.send({ type: 'rejoin', token: bobToken });
  const state = await bobAgain.next(isType('state'));
  assert.strictEqual(state.state, 'playing');
  assert.strictEqual(state.you.guesses[0].word, 'crane');

  // Still in the room after the grace time has passed.
  await wait(GRACE_MS + 200);
  assert.strictEqual(ann.lastState().players.length, 2);
  ann.socket.close();
  bobAgain.socket.close();
});

test('a player who does not come back is removed after the grace time', async () => {
  const { ann, bob, bobToken } = await startMatch();
  bob.socket.close();
  await ann.next((message) => message.type === 'state' && message.state === 'finished');
  assert.strictEqual(ann.lastState().players.length, 1);

  const bobAgain = openClient();
  await bobAgain.opened;
  bobAgain.send({ type: 'rejoin', token: bobToken });
  await bobAgain.next(isType('rejoinFailed'));
  ann.socket.close();
  bobAgain.socket.close();
});

test('a wrong token is rejected', async () => {
  const stranger = openClient();
  await stranger.opened;
  stranger.send({ type: 'rejoin', token: 'not-a-real-token' });
  await stranger.next(isType('rejoinFailed'));
  stranger.socket.close();
});

test('oversized messages close the connection and spam is ignored', async () => {
  const big = openClient();
  await big.opened;
  const closed = new Promise((resolve) => big.socket.once('close', resolve));
  big.socket.send('x'.repeat(5000));
  await closed;

  const spammer = openClient();
  await spammer.opened;
  for (let count = 0; count < 100; count++) spammer.send({ type: 'guess', word: 'crane' });
  await wait(200);
  // Only the first 20 messages in a second get an answer.
  assert.strictEqual(spammer.messages.filter(isType('error')).length, 20);
  spammer.socket.close();
});
