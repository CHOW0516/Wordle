// Browser side of Word Rush. Talks to server.js over a WebSocket.

const MAX_GUESSES = 6;
const WORD_LENGTH = 5;
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const SABOTAGE_NAMES = {
  fog: 'Fog',
  keyLock: 'Key lock',
  scramble: 'Scramble',
  freeze: 'Freeze',
  lostRow: 'Lost row',
};
const SABOTAGE_MESSAGES = {
  fog: 'Fog! Your colors are hidden.',
  keyLock: 'Key lock! Some letters are blocked.',
  scramble: 'Scramble! Your keyboard is shuffled.',
  freeze: 'Freeze! You cannot type.',
  lostRow: 'Lost row! You have one guess less.',
};

const elements = {};
for (const id of [
  'join-screen', 'lobby-screen', 'game-screen', 'name-input', 'code-input', 'create-button',
  'join-button', 'room-code', 'lobby-title', 'lobby-players', 'start-button', 'waiting-text',
  'game-room-code', 'timer', 'effect-banner', 'board', 'sabotage-panel', 'sabotage-name',
  'target-buttons', 'keyboard', 'scoreboard', 'toast', 'event-log', 'length-buttons', 'hint-tiles',
  'hint-button',
]) {
  elements[id] = document.getElementById(id);
}

let socket = null;
let roomState = null; // last 'state' message from the server
let serverTimeOffset = 0; // server clock minus browser clock
let currentInput = '';

// Active sabotages on this player. Each has an end time in browser time.
const activeEffects = {
  fogUntil: 0,
  freezeUntil: 0,
  lockedLetters: [],
  lockedUntil: 0,
  scrambledLetters: null,
  scrambleUntil: 0,
};

function isActive(untilTime) {
  return Date.now() < untilTime;
}

// ---------- Connection ----------

const SESSION_KEY = 'wordRushSession';
const RECONNECT_RETRY_MS = 2000;
const RECONNECT_GIVE_UP_MS = 60000;
let reconnectStartedAt = null; // when the connection dropped, or null if connected

// The token lets this tab take its seat back after a drop or a page reload.
// sessionStorage is per tab, so two tabs in one browser can be two players.
function savedToken() {
  try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; }
}
function saveToken(token) {
  try {
    if (token) sessionStorage.setItem(SESSION_KEY, token);
    else sessionStorage.removeItem(SESSION_KEY);
  } catch { /* storage blocked: reconnect after reload will not work, the game still does */ }
}

function connect(onOpen) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${location.host}`);
  socket.addEventListener('open', onOpen);
  socket.addEventListener('message', (event) => handleMessage(JSON.parse(event.data)));
  socket.addEventListener('close', () => {
    socket = null;
    if (!savedToken()) return showToast('Could not reach the server. Please try again.', 4000);
    if (reconnectStartedAt === null) reconnectStartedAt = Date.now();
    if (Date.now() - reconnectStartedAt > RECONNECT_GIVE_UP_MS) return leaveToJoinScreen('Connection lost.');
    showToast('Connection lost. Reconnecting...', RECONNECT_RETRY_MS + 1000);
    setTimeout(tryRejoin, RECONNECT_RETRY_MS);
  });
}

function tryRejoin() {
  const token = savedToken();
  if (token && !socket) connect(() => sendMessage({ type: 'rejoin', token }));
}

function leaveToJoinScreen(text) {
  saveToken(null);
  reconnectStartedAt = null;
  roomState = null;
  elements['join-screen'].hidden = false;
  elements['lobby-screen'].hidden = true;
  elements['game-screen'].hidden = true;
  showToast(text, 4000);
}

function sendMessage(message) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function joinRoom(code) {
  const name = elements['name-input'].value.trim();
  if (!name) return showToast('Please enter a name.');
  const message = { type: 'join', name, code };
  if (socket) sendMessage(message);
  else connect(() => sendMessage(message));
}

function handleMessage(message) {
  if (message.type === 'state') {
    const previousState = roomState && roomState.state;
    roomState = message;
    serverTimeOffset = message.serverNow - Date.now();
    if (message.state === 'playing' && previousState !== 'playing') resetForNewMatch();
    render();
  } else if (message.type === 'joined') {
    saveToken(message.token);
    if (reconnectStartedAt !== null) showToast('Reconnected!');
    reconnectStartedAt = null;
  } else if (message.type === 'rejoinFailed') {
    leaveToJoinScreen('Your seat in that room is gone.');
  } else if (message.type === 'error') {
    showToast(message.message);
  } else if (message.type === 'event') {
    addEvent(message.text);
  } else if (message.type === 'reveal') {
    currentInput = '';
    if (message.solved) {
      showToast(`Solved! +${message.points} points. You earned ${SABOTAGE_NAMES[message.sabotage]}.`);
    } else {
      showToast(`The word was ${message.word.toUpperCase()}.`, 3000);
    }
  } else if (message.type === 'effect') {
    applyEffect(message);
  }
}

function resetForNewMatch() {
  currentInput = '';
  activeEffects.fogUntil = 0;
  activeEffects.freezeUntil = 0;
  activeEffects.lockedUntil = 0;
  activeEffects.scrambleUntil = 0;
}

function applyEffect(effect) {
  const until = Date.now() + effect.durationMs;
  if (effect.sabotage === 'fog') activeEffects.fogUntil = until;
  if (effect.sabotage === 'freeze') activeEffects.freezeUntil = until;
  if (effect.sabotage === 'keyLock') {
    activeEffects.lockedLetters = effect.letters;
    activeEffects.lockedUntil = until;
  }
  if (effect.sabotage === 'scramble') {
    activeEffects.scrambledLetters = effect.letters;
    activeEffects.scrambleUntil = until;
  }
  showToast(`${effect.from} hit you with ${SABOTAGE_NAMES[effect.sabotage]}!`);
  render();
}

// ---------- Input ----------

function pressKey(key) {
  if (!roomState || roomState.state !== 'playing') return;
  if (isActive(activeEffects.freezeUntil)) return;

  if (key === 'enter') {
    if (currentInput.length < WORD_LENGTH) return showToast('Not enough letters.');
    sendMessage({ type: 'guess', word: currentInput });
    currentInput = '';
  } else if (key === 'backspace') {
    currentInput = currentInput.slice(0, -1);
  } else if (/^[a-z]$/.test(key) && currentInput.length < WORD_LENGTH) {
    if (isActive(activeEffects.lockedUntil) && activeEffects.lockedLetters.includes(key)) {
      return showToast(`${key.toUpperCase()} is locked!`);
    }
    currentInput += key;
  }
  renderBoard();
}

document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT' || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'enter' || key === 'backspace' || /^[a-z]$/.test(key)) {
    event.preventDefault();
    pressKey(key);
  }
});

elements['create-button'].addEventListener('click', () => joinRoom(null));
elements['join-button'].addEventListener('click', () => {
  const code = elements['code-input'].value.trim().toUpperCase();
  if (code.length !== 4) return showToast('Room codes have 4 letters.');
  joinRoom(code);
});
elements['start-button'].addEventListener('click', () => sendMessage({ type: 'start' }));
elements['hint-button'].addEventListener('click', () => sendMessage({ type: 'hint' }));

// ---------- Rendering ----------

function render() {
  if (!roomState) return;
  const playing = roomState.state === 'playing';
  elements['join-screen'].hidden = true;
  elements['lobby-screen'].hidden = playing;
  elements['game-screen'].hidden = !playing;
  if (playing) renderGame();
  else renderLobby();
}

function renderLobby() {
  const isHost = roomState.hostId === roomState.you.id;
  const finished = roomState.state === 'finished';
  elements['room-code'].textContent = roomState.code;
  elements['lobby-title'].textContent = finished ? 'Final scores' : 'Players';

  const players = [...roomState.players];
  if (finished) players.sort((first, second) => second.score - first.score);
  elements['lobby-players'].replaceChildren(
    ...players.map((player) => {
      const item = document.createElement('li');
      let text = player.name;
      if (finished) text += ` — ${player.score} points (${player.solvedCount} solved)`;
      if (player.id === roomState.hostId) text += ' (host)';
      if (player.id === roomState.you.id) text += ' (you)';
      item.textContent = text;
      return item;
    })
  );

  elements['length-buttons'].replaceChildren(
    ...roomState.matchLengthChoices.map((minutes) => {
      const button = document.createElement('button');
      button.textContent = `${minutes} min`;
      button.disabled = !isHost;
      if (minutes === roomState.matchMinutes) button.classList.add('selected');
      button.addEventListener('click', () => sendMessage({ type: 'matchLength', minutes }));
      return button;
    })
  );

  elements['start-button'].hidden = !isHost;
  elements['start-button'].textContent = finished ? 'Play again' : 'Start match';
  elements['start-button'].disabled = players.length < 2;
  if (players.length < 2) elements['waiting-text'].textContent = 'Waiting for at least 2 players...';
  else if (!isHost) elements['waiting-text'].textContent = 'Waiting for the host to start...';
  else elements['waiting-text'].textContent = '';
}

function renderGame() {
  elements['game-room-code'].textContent = roomState.code;
  document.body.classList.toggle('frozen', isActive(activeEffects.freezeUntil));
  renderEffectBanner();
  renderHints();
  renderBoard();
  renderKeyboard();
  renderSabotagePanel();
  renderScoreboard();
  renderTimer();
}

function renderEffectBanner() {
  const messages = [];
  if (isActive(activeEffects.freezeUntil)) messages.push(SABOTAGE_MESSAGES.freeze);
  if (isActive(activeEffects.fogUntil)) messages.push(SABOTAGE_MESSAGES.fog);
  if (isActive(activeEffects.lockedUntil)) messages.push(SABOTAGE_MESSAGES.keyLock);
  if (isActive(activeEffects.scrambleUntil)) messages.push(SABOTAGE_MESSAGES.scramble);
  elements['effect-banner'].hidden = messages.length === 0;
  elements['effect-banner'].textContent = messages.join(' ');
}

function renderHints() {
  const { hints, hintsLeft } = roomState.you;
  const tiles = [];
  for (let position = 0; position < WORD_LENGTH; position++) {
    const tile = document.createElement('div');
    tile.className = 'hint-tile';
    const hint = hints.find((entry) => entry.position === position);
    if (hint) {
      tile.textContent = hint.letter;
      tile.classList.add('revealed');
    }
    tiles.push(tile);
  }
  elements['hint-tiles'].replaceChildren(...tiles);
  elements['hint-button'].textContent = `Hint (${hintsLeft} left, -1 pt)`;
  elements['hint-button'].disabled = hintsLeft === 0;
}

function renderBoard() {
  if (!roomState || roomState.state !== 'playing') return;
  const { guesses, maxGuesses } = roomState.you;
  const fogged = isActive(activeEffects.fogUntil);
  const rows = [];

  for (let rowIndex = 0; rowIndex < MAX_GUESSES; rowIndex++) {
    const row = document.createElement('div');
    row.className = 'row';
    if (rowIndex >= maxGuesses) row.classList.add('lost');

    const guess = guesses[rowIndex];
    const letters = guess ? guess.word : rowIndex === guesses.length ? currentInput : '';
    for (let letterIndex = 0; letterIndex < WORD_LENGTH; letterIndex++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.textContent = letters[letterIndex] || '';
      if (guess) tile.classList.add(fogged ? 'fogged' : guess.result[letterIndex]);
      else if (letters[letterIndex]) tile.classList.add('filled');
      row.appendChild(tile);
    }
    rows.push(row);
  }
  elements.board.replaceChildren(...rows);
}

// Best known status for each letter, used to color the keyboard.
function letterStatuses() {
  const priority = { absent: 1, present: 2, correct: 3 };
  const statuses = {};
  for (const guess of roomState.you.guesses) {
    [...guess.word].forEach((letter, index) => {
      const status = guess.result[index];
      if (!statuses[letter] || priority[status] > priority[statuses[letter]]) statuses[letter] = status;
    });
  }
  return statuses;
}

function renderKeyboard() {
  const statuses = isActive(activeEffects.fogUntil) ? {} : letterStatuses();
  let rows = KEYBOARD_ROWS;
  if (isActive(activeEffects.scrambleUntil)) {
    const letters = activeEffects.scrambledLetters.join('');
    rows = [letters.slice(0, 10), letters.slice(10, 19), letters.slice(19)];
  }
  const lockedLetters = isActive(activeEffects.lockedUntil) ? activeEffects.lockedLetters : [];

  const rowElements = rows.map((rowLetters, rowIndex) => {
    const row = document.createElement('div');
    row.className = 'key-row';
    if (rowIndex === rows.length - 1) row.appendChild(makeKey('enter', 'Enter'));
    for (const letter of rowLetters) {
      const key = makeKey(letter, letter);
      if (statuses[letter]) key.classList.add(statuses[letter]);
      if (lockedLetters.includes(letter)) key.classList.add('locked');
      row.appendChild(key);
    }
    if (rowIndex === rows.length - 1) row.appendChild(makeKey('backspace', '⌫'));
    return row;
  });
  elements.keyboard.replaceChildren(...rowElements);
}

function makeKey(key, label) {
  const button = document.createElement('button');
  button.className = 'key';
  if (key.length > 1) button.classList.add('wide');
  button.textContent = label;
  button.addEventListener('click', () => pressKey(key));
  return button;
}

function renderSabotagePanel() {
  const pending = roomState.you.pendingSabotages;
  const targets = roomState.players.filter((player) => player.id !== roomState.you.id);
  elements['sabotage-panel'].hidden = pending.length === 0;
  if (pending.length === 0) return;

  let label = SABOTAGE_NAMES[pending[0]];
  if (pending.length > 1) label += ` (+${pending.length - 1} more saved)`;
  elements['sabotage-name'].textContent = label;
  elements['target-buttons'].replaceChildren(
    ...targets.map((target) => {
      const button = document.createElement('button');
      button.textContent = target.name;
      button.addEventListener('click', () => sendMessage({ type: 'sabotage', targetId: target.id }));
      return button;
    })
  );
}

function renderScoreboard() {
  const players = [...roomState.players].sort((first, second) => second.score - first.score);
  elements.scoreboard.replaceChildren(
    ...players.map((player) => {
      const item = document.createElement('li');
      if (player.id === roomState.you.id) item.classList.add('you');
      const name = document.createElement('span');
      name.textContent = player.connected ? player.name : `${player.name} (offline)`;
      const details = document.createElement('span');
      details.textContent = `${player.score} pts · guess ${player.guessCount}/${player.maxGuesses}`;
      item.append(name, details);
      return item;
    })
  );
}

function renderTimer() {
  if (!roomState || !roomState.endsAt) return;
  const remainingMs = Math.max(0, roomState.endsAt - (Date.now() + serverTimeOffset));
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  elements.timer.textContent = `${minutes}:${seconds}`;
}

// Update the clock, and redraw when a sabotage wears off.
let lastEffectSignature = '';
setInterval(() => {
  if (!roomState || roomState.state !== 'playing') return;
  renderTimer();
  const signature = [
    activeEffects.fogUntil, activeEffects.freezeUntil, activeEffects.lockedUntil, activeEffects.scrambleUntil,
  ].map(isActive).join();
  if (signature !== lastEffectSignature) {
    lastEffectSignature = signature;
    renderGame();
  }
}, 250);

// ---------- Messages ----------

let toastTimer = null;
function showToast(text, durationMs = 2000) {
  elements.toast.textContent = text;
  elements.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { elements.toast.hidden = true; }, durationMs);
}

function addEvent(text) {
  const item = document.createElement('li');
  item.textContent = text;
  elements['event-log'].prepend(item);
  while (elements['event-log'].children.length > 8) elements['event-log'].lastChild.remove();
}

// After a page reload, take the old seat back if there is one.
tryRejoin();
