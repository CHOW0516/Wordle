const test = require('node:test');
const assert = require('node:assert');
const { Room, scoreGuess, pointsForSolve, pickSabotage, HINTS_PER_MATCH } = require('../game');

test('scoreGuess marks correct, present and absent letters', () => {
  assert.deepStrictEqual(scoreGuess('smile', 'solve'), ['correct', 'absent', 'absent', 'present', 'correct']);
});

test('scoreGuess does not over-count repeated letters', () => {
  // LEMON has one E, already green, so the other Es in EERIE stay gray.
  assert.deepStrictEqual(scoreGuess('eerie', 'lemon'), ['absent', 'correct', 'absent', 'absent', 'absent']);
  // Two Ls guessed, one L in the secret in the wrong spot: only one yellow.
  assert.deepStrictEqual(scoreGuess('allot', 'lemon'), ['absent', 'present', 'absent', 'correct', 'absent']);
});

test('pointsForSolve gives more points for fewer guesses', () => {
  assert.strictEqual(pointsForSolve(1), 6);
  assert.strictEqual(pointsForSolve(6), 1);
});

test('pickSabotage gives strong sabotages for fast solves', () => {
  assert.ok(['lostRow', 'keyLock'].includes(pickSabotage(3, () => 0.99)));
  assert.ok(['fog', 'scramble', 'freeze'].includes(pickSabotage(4, () => 0)));
});

// A room with fake time, fake timers and a fixed word, so tests are predictable.
function makeRoom({ answerWords = ['solve'], random = () => 0 } = {}) {
  const sent = [];
  const clock = { time: 1000 };
  const timers = [];
  const room = new Room('ABCD', {
    answerWords,
    allowedWords: new Set(['solve', 'smile', 'crane', 'other', 'apple', 'zzzzz', 'lemon']),
    send: (playerId, message) => sent.push({ playerId, message }),
    now: () => clock.time,
    random,
    setTimer: (callback, delay) => { timers.push(callback); return timers.length; },
    clearTimer: () => {},
  });
  return { room, sent, clock, timers };
}

function startTwoPlayerRoom(options) {
  const setup = makeRoom(options);
  setup.room.addPlayer('ann', 'Ann');
  setup.room.addPlayer('bob', 'Bob');
  assert.strictEqual(setup.room.start('ann'), null);
  return setup;
}

test('players join, first player is host, room caps at 4 and rejects bad names', () => {
  const { room } = makeRoom();
  assert.strictEqual(room.addPlayer('p1', '  '), 'Please enter a name.');
  assert.strictEqual(room.addPlayer('p1', 'Ann'), null);
  assert.strictEqual(room.addPlayer('p2', 'ann'), 'That name is already used in this room.');
  room.addPlayer('p2', 'Bob');
  room.addPlayer('p3', 'Cat');
  room.addPlayer('p4', 'Dan');
  assert.strictEqual(room.addPlayer('p5', 'Eve'), 'That room is full (4 players max).');
  assert.strictEqual(room.hostId, 'p1');
});

test('only the host can start, and only with 2+ players', () => {
  const { room } = makeRoom();
  room.addPlayer('ann', 'Ann');
  assert.strictEqual(room.start('ann'), 'You need at least 2 players.');
  room.addPlayer('bob', 'Bob');
  assert.strictEqual(room.start('bob'), 'Only the host can start.');
  assert.strictEqual(room.start('ann'), null);
  assert.strictEqual(room.state, 'playing');
  assert.strictEqual(room.addPlayer('cat', 'Cat'), 'That match has already started.');
});

test('a guess is rejected if not 5 letters or not in the word list', () => {
  const { room } = startTwoPlayerRoom();
  assert.strictEqual(room.guess('ann', 'abc'), 'Guesses must be 5 letters.');
  assert.strictEqual(room.guess('ann', 'qqqqq'), 'Not in the word list.');
  assert.strictEqual(room.players.get('ann').guesses.length, 0);
});

test('solving scores points, earns a sabotage and gives a new word', () => {
  const { room, sent } = startTwoPlayerRoom({ answerWords: ['solve', 'crane'] });
  const ann = room.players.get('ann');
  const firstWord = ann.secretWord;
  room.guess('ann', firstWord);
  assert.strictEqual(ann.score, 6);
  assert.strictEqual(ann.solvedCount, 1);
  assert.strictEqual(ann.pendingSabotages.length, 1);
  assert.notStrictEqual(ann.secretWord, firstWord);
  assert.strictEqual(ann.guesses.length, 0);
  assert.ok(sent.some((entry) => entry.playerId === 'ann' && entry.message.type === 'reveal' && entry.message.solved));
});

test('6 wrong guesses reveal the word and give a new one with no points', () => {
  const { room } = startTwoPlayerRoom();
  const ann = room.players.get('ann');
  for (let count = 0; count < 6; count++) room.guess('ann', 'crane');
  assert.strictEqual(ann.score, 0);
  assert.strictEqual(ann.guesses.length, 0);
  assert.strictEqual(ann.pendingSabotages.length, 0);
});

test('sabotage needs a pending sabotage and a valid target', () => {
  const { room } = startTwoPlayerRoom();
  assert.strictEqual(room.sabotage('ann', 'bob'), 'You have no sabotage to send.');
  room.guess('ann', 'solve');
  assert.strictEqual(room.sabotage('ann', 'ann'), 'Pick another player.');
  assert.strictEqual(room.sabotage('ann', 'nobody'), 'Pick another player.');
  assert.strictEqual(room.sabotage('ann', 'bob'), null);
  assert.strictEqual(room.players.get('ann').pendingSabotages.length, 0);
});

test('freeze blocks guesses until it wears off', () => {
  const { room, clock } = startTwoPlayerRoom();
  room.players.get('ann').pendingSabotages.push('freeze');
  room.sabotage('ann', 'bob');
  assert.strictEqual(room.guess('bob', 'crane'), 'You are frozen!');
  clock.time += 5000;
  assert.strictEqual(room.guess('bob', 'crane'), null);
});

test('key lock blocks guesses with locked letters', () => {
  const { room, clock } = startTwoPlayerRoom();
  room.players.get('ann').pendingSabotages.push('keyLock');
  room.sabotage('ann', 'bob');
  const bob = room.players.get('bob');
  assert.strictEqual(bob.lockedLetters.length, 3);
  const wordWithLockedLetter = bob.lockedLetters[0].repeat(5);
  room.allowedWords.add(wordWithLockedLetter);
  assert.match(room.guess('bob', wordWithLockedLetter), /is locked/);
  clock.time += 15000;
  assert.strictEqual(room.guess('bob', wordWithLockedLetter), null);
});

test('lost row removes a guess but never ends the word instantly', () => {
  const { room } = startTwoPlayerRoom();
  const bob = room.players.get('bob');
  for (let count = 0; count < 5; count++) {
    room.players.get('ann').pendingSabotages.push('lostRow');
    room.sabotage('ann', 'bob');
  }
  assert.strictEqual(bob.maxGuesses, 1);
  room.players.get('ann').pendingSabotages.push('lostRow');
  room.sabotage('ann', 'bob');
  assert.strictEqual(bob.maxGuesses, 1);
  room.guess('bob', 'crane'); // uses the last row, so Bob gets a new word
  assert.strictEqual(bob.guesses.length, 0);
  assert.strictEqual(bob.maxGuesses, 6);
});

test('the match ends when the timer fires, and can be restarted', () => {
  const { room, timers } = startTwoPlayerRoom();
  room.guess('ann', 'solve');
  timers[0]();
  assert.strictEqual(room.state, 'finished');
  assert.strictEqual(room.guess('ann', 'solve'), 'The match is not running.');
  assert.strictEqual(room.start('ann'), null);
  assert.strictEqual(room.players.get('ann').score, 0);
});

test('when a player leaves mid-match, host moves on and match ends below 2 players', () => {
  const { room } = startTwoPlayerRoom();
  room.removePlayer('ann');
  assert.strictEqual(room.hostId, 'bob');
  assert.strictEqual(room.state, 'finished');
});

test('state messages never include other players\' secret words', () => {
  const { room, sent } = startTwoPlayerRoom();
  const stateMessages = sent.filter((entry) => entry.message.type === 'state');
  for (const entry of stateMessages) {
    assert.ok(!JSON.stringify(entry.message).includes('"solve"'));
  }
});

test('host picks the match length before the match, and the timer uses it', () => {
  const { room, clock } = makeRoom();
  room.addPlayer('ann', 'Ann');
  room.addPlayer('bob', 'Bob');
  assert.strictEqual(room.matchMinutes, 5);
  assert.strictEqual(room.setMatchLength('bob', 3), 'Only the host can change the match length.');
  assert.strictEqual(room.setMatchLength('ann', 7), 'Pick 3, 5 or 10 minutes.');
  assert.strictEqual(room.setMatchLength('ann', 10), null);
  room.start('ann');
  assert.strictEqual(room.endsAt, clock.time + 10 * 60 * 1000);
  assert.strictEqual(room.setMatchLength('ann', 3), 'You cannot change the length during a match.');
});

test('hints reveal unknown letters, cost a point, and run out after 3 per match', () => {
  const { room } = startTwoPlayerRoom();
  const ann = room.players.get('ann');
  room.guess('ann', 'smile'); // S and E are green for SOLVE
  for (let count = 0; count < HINTS_PER_MATCH; count++) {
    assert.strictEqual(room.hint('ann'), null);
  }
  assert.strictEqual(room.hint('ann'), 'You have no hints left.');
  assert.strictEqual(ann.score, -3);
  // Hints never repeat a spot and never pick a spot already green (0 and 4).
  assert.deepStrictEqual([...ann.hintPositions].sort(), [1, 2, 3]);
  // Hints carry across words, but revealed letters reset on a new word.
  room.guess('ann', 'solve');
  assert.strictEqual(ann.hintPositions.length, 0);
  assert.strictEqual(ann.hintsLeft, 0);
});

test('hint state message shows the letter, and hints reset on a new match', () => {
  const { room, sent, timers } = startTwoPlayerRoom();
  room.hint('ann');
  const lastState = sent.filter((entry) => entry.playerId === 'ann' && entry.message.type === 'state').pop();
  const [shownHint] = lastState.message.you.hints;
  assert.strictEqual(shownHint.letter, 'solve'[shownHint.position]);
  timers[0]();
  room.start('ann');
  assert.strictEqual(room.players.get('ann').hintsLeft, HINTS_PER_MATCH);
});

test('hints are blocked while frozen and when every letter is known', () => {
  const { room } = startTwoPlayerRoom();
  room.players.get('ann').pendingSabotages.push('freeze');
  room.sabotage('ann', 'bob');
  assert.strictEqual(room.hint('bob'), 'You are frozen!');
  const ann = room.players.get('ann');
  ann.guesses.push({ word: 'solve', result: Array(5).fill('correct') });
  assert.strictEqual(room.hint('ann'), 'You already know every letter.');
});

test('a dropped player keeps their seat and score, and is shown as offline', () => {
  const { room, sent } = startTwoPlayerRoom();
  room.guess('bob', 'solve');
  room.setConnected('bob', false);
  assert.strictEqual(room.state, 'playing');
  const lastState = sent.filter((entry) => entry.playerId === 'ann' && entry.message.type === 'state').pop();
  assert.strictEqual(lastState.message.players.find((player) => player.id === 'bob').connected, false);
  room.setConnected('bob', true);
  assert.strictEqual(room.players.get('bob').score, 6);
});
