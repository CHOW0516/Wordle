// Browser side of Word Rush. Talks to server.js over a WebSocket.

const MAX_GUESSES = 6;
const WORD_LENGTH = 5;
const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
const HIT_FLASH_MS = 700;

// name: shown in messages. icon: shown on boards. text: shown to the player who is hit.
const SABOTAGES = {
  fog: { name: 'Fog', icon: '🌫️', text: 'Colors hidden' },
  keyLock: { name: 'Key lock', icon: '🔒', text: 'Letters locked' },
  scramble: { name: 'Scramble', icon: '🔀', text: 'Keyboard shuffled' },
  freeze: { name: 'Freeze', icon: '❄️', text: 'Cannot type' },
  amnesia: { name: 'Amnesia', icon: '💭', text: 'Old letters hidden' },
  invisibleInk: { name: 'Invisible ink', icon: '👻', text: 'Typed letters hidden' },
  lostRow: { name: 'Lost row', icon: '🧱', text: 'You lost one guess row.' },
  steal: { name: 'Steal', icon: '💰', text: 'They took 2 of your points.' },
  wordSwap: { name: 'Word swap', icon: '🔄', text: 'Your word was replaced.' },
  hintThief: { name: 'Hint thief', icon: '🕵️', text: 'They took a hint from you.' },
};

const elements = {};
for (const id of [
  'join-screen', 'lobby-screen', 'game-screen', 'name-input', 'code-input', 'create-button',
  'join-button', 'room-code', 'lobby-title', 'lobby-players', 'start-button', 'waiting-text',
  'game-room-code', 'timer', 'my-score', 'opponents', 'attack-banner', 'my-effects', 'board',
  'keyboard', 'toast', 'event-log', 'length-buttons', 'hint-tiles', 'hint-button',
]) {
  elements[id] = document.getElementById(id);
}

let socket = null;
let roomState = null; // last 'state' message from the server
let serverTimeOffset = 0; // server clock minus browser clock
let currentInput = '';
const hitFlashUntil = {}; // player id -> browser time until which their board flashes

function serverNow() {
  return Date.now() + serverTimeOffset;
}

// The sabotage on this player right now, or undefined. The server decides what is active.
function myEffect(sabotage) {
  return roomState.you.effects.find((effect) => effect.sabotage === sabotage && serverNow() < effect.until);
}

function secondsLeft(until) {
  return Math.max(0, Math.ceil((until - serverNow()) / 1000));
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
    if (message.state === 'playing' && previousState !== 'playing') currentInput = '';
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
      const sabotage = SABOTAGES[message.sabotage];
      showToast(`Solved! +${message.points} points. You earned ${sabotage.icon} ${sabotage.name}.`);
    } else {
      showToast(`The word was ${message.word.toUpperCase()}.`, 3000);
    }
  } else if (message.type === 'attack') {
    showAttack(message);
  }
}

// Flash the board of whoever got hit. If it is this player, also say what happened.
function showAttack(attack) {
  hitFlashUntil[attack.targetId] = Date.now() + HIT_FLASH_MS;
  if (roomState && attack.targetId === roomState.you.id) {
    const sabotage = SABOTAGES[attack.sabotage];
    if (attack.sabotage === 'wordSwap') currentInput = '';
    showToast(`${sabotage.icon} ${attack.fromName} hit you with ${sabotage.name}! ${sabotage.text}`, 3000);
  }
}

// ---------- Input ----------

function pressKey(key, fromRealKeyboard = false) {
  if (!roomState || roomState.state !== 'playing') return;
  if (myEffect('freeze')) return;

  if (key === 'enter') {
    if (currentInput.length < WORD_LENGTH) return showToast('Not enough letters.');
    sendMessage({ type: 'guess', word: currentInput });
    currentInput = '';
  } else if (key === 'backspace') {
    currentInput = currentInput.slice(0, -1);
  } else if (/^[a-z]$/.test(key) && currentInput.length < WORD_LENGTH) {
    // Scramble would do nothing to a real keyboard, so letters must be tapped on screen.
    if (fromRealKeyboard && myEffect('scramble')) return showToast('Scrambled! Use the on-screen keys.');
    const keyLock = myEffect('keyLock');
    if (keyLock && keyLock.letters.includes(key)) return showToast(`${key.toUpperCase()} is locked!`);
    currentInput += key;
  }
  renderBoard();
}

document.addEventListener('keydown', (event) => {
  if (event.target.tagName === 'INPUT' || event.ctrlKey || event.metaKey || event.altKey) return;
  const key = event.key.toLowerCase();
  if (key === 'enter' || key === 'backspace' || /^[a-z]$/.test(key)) {
    event.preventDefault();
    pressKey(key, true);
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
  const me = roomState.players.find((player) => player.id === roomState.you.id);
  elements['game-room-code'].textContent = roomState.code;
  elements['my-score'].textContent = `You: ${me.score} pts`;
  document.body.classList.toggle('frozen', Boolean(myEffect('freeze')));
  renderOpponents();
  renderAttackBanner();
  renderMyEffects();
  renderHints();
  renderBoard();
  renderKeyboard();
  renderTimer();
}

function makeEffectChip(effect) {
  const chip = document.createElement('span');
  chip.className = 'effect-chip';
  chip.append(SABOTAGES[effect.sabotage].icon, ' ');
  const countdown = document.createElement('span');
  countdown.dataset.until = effect.until; // the clock tick keeps this number fresh
  countdown.textContent = secondsLeft(effect.until);
  chip.append(countdown);
  return chip;
}

// One small live board per opponent. Tap it to send your sabotage.
function renderOpponents() {
  const canAttack = roomState.you.pendingSabotages.length > 0;
  const topScore = Math.max(...roomState.players.map((player) => player.score));
  const opponents = roomState.players.filter((player) => player.id !== roomState.you.id);

  elements.opponents.replaceChildren(
    ...opponents.map((opponent) => {
      const card = document.createElement('button');
      card.className = 'opponent';
      card.disabled = !canAttack;
      if (canAttack) card.classList.add('targetable');
      if (!opponent.connected) card.classList.add('offline');
      if (Date.now() < (hitFlashUntil[opponent.id] || 0)) card.classList.add('hit');
      card.addEventListener('click', () => sendMessage({ type: 'sabotage', targetId: opponent.id }));

      const name = document.createElement('div');
      name.className = 'opponent-name';
      name.textContent = (opponent.score === topScore && topScore > 0 ? '👑 ' : '') + opponent.name;

      const score = document.createElement('div');
      score.className = 'opponent-score';
      score.textContent = opponent.connected ? `${opponent.score} pts` : 'offline';

      const miniBoard = document.createElement('div');
      miniBoard.className = 'mini-board';
      for (let rowIndex = 0; rowIndex < MAX_GUESSES; rowIndex++) {
        for (let letterIndex = 0; letterIndex < WORD_LENGTH; letterIndex++) {
          const tile = document.createElement('div');
          tile.className = 'mini-tile';
          if (opponent.board[rowIndex]) tile.classList.add(opponent.board[rowIndex][letterIndex]);
          else if (rowIndex >= opponent.maxGuesses) tile.classList.add('lost');
          miniBoard.appendChild(tile);
        }
      }

      const effects = document.createElement('div');
      effects.className = 'opponent-effects';
      effects.replaceChildren(...opponent.effects.map(makeEffectChip));

      card.append(name, score, miniBoard, effects);
      return card;
    })
  );
}

function renderAttackBanner() {
  const pending = roomState.you.pendingSabotages;
  elements['attack-banner'].hidden = pending.length === 0;
  if (pending.length === 0) return;
  const sabotage = SABOTAGES[pending[0]];
  let text = `${sabotage.icon} ${sabotage.name} ready`;
  if (pending.length > 1) text += ` (+${pending.length - 1} more)`;
  elements['attack-banner'].textContent = `${text}. Tap an opponent's board to attack!`;
}

function renderMyEffects() {
  const active = roomState.you.effects.filter((effect) => serverNow() < effect.until);
  elements['my-effects'].replaceChildren(
    ...active.map((effect) => {
      const chip = makeEffectChip(effect);
      chip.append(`s ${SABOTAGES[effect.sabotage].text}`);
      return chip;
    })
  );
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
  const inkHidden = Boolean(myEffect('invisibleInk'));
  const rows = [];

  for (let rowIndex = 0; rowIndex < MAX_GUESSES; rowIndex++) {
    const row = document.createElement('div');
    row.className = 'row';
    if (rowIndex >= maxGuesses) row.classList.add('lost');

    const guess = guesses[rowIndex];
    const isInputRow = rowIndex === guesses.length;
    for (let letterIndex = 0; letterIndex < WORD_LENGTH; letterIndex++) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      if (guess) {
        // The server sends no word during Amnesia and no result during Fog.
        tile.textContent = guess.word ? guess.word[letterIndex] : '?';
        tile.classList.add(guess.result ? guess.result[letterIndex] : 'fogged');
      } else if (isInputRow && currentInput[letterIndex]) {
        tile.textContent = inkHidden ? '•' : currentInput[letterIndex];
        tile.classList.add('filled');
      }
      row.appendChild(tile);
    }
    rows.push(row);
  }
  elements.board.classList.toggle('hit', Date.now() < (hitFlashUntil[roomState.you.id] || 0));
  elements.board.replaceChildren(...rows);
}

// Best known status for each letter, used to color the keyboard.
function letterStatuses() {
  const priority = { absent: 1, present: 2, correct: 3 };
  const statuses = {};
  for (const guess of roomState.you.guesses) {
    if (!guess.word || !guess.result) continue; // hidden by Amnesia or Fog
    [...guess.word].forEach((letter, index) => {
      const status = guess.result[index];
      if (!statuses[letter] || priority[status] > priority[statuses[letter]]) statuses[letter] = status;
    });
  }
  return statuses;
}

function renderKeyboard() {
  const statuses = letterStatuses();
  const scramble = myEffect('scramble');
  let rows = KEYBOARD_ROWS;
  if (scramble) {
    const letters = scramble.letters.join('');
    rows = [letters.slice(0, 10), letters.slice(10, 19), letters.slice(19)];
  }
  const keyLock = myEffect('keyLock');
  const lockedLetters = keyLock ? keyLock.letters : [];

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

function renderTimer() {
  if (!roomState || !roomState.endsAt) return;
  const remainingMs = Math.max(0, roomState.endsAt - serverNow());
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  elements.timer.textContent = `${minutes}:${seconds}`;
}

// Keep the clock and the sabotage countdowns moving, and redraw when one of my sabotages ends.
let lastEffectSignature = '';
setInterval(() => {
  if (!roomState || roomState.state !== 'playing') return;
  renderTimer();
  for (const countdown of document.querySelectorAll('[data-until]')) {
    countdown.textContent = secondsLeft(Number(countdown.dataset.until));
  }
  const signature = roomState.you.effects.map((effect) => serverNow() < effect.until).join();
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
