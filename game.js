// Game rules and room state. No networking here, so it is easy to test.

const MAX_PLAYERS = 4;
const MIN_PLAYERS = 2;
const MAX_GUESSES = 6;
const MATCH_LENGTH_CHOICES_MINUTES = [3, 5, 10];
const DEFAULT_MATCH_MINUTES = 5;
const HINTS_PER_MATCH = 3;
const HINT_COST_POINTS = 1;

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('');

// Solving in 1-3 guesses earns a strong sabotage, 4+ earns a weak one.
const STRONG_SABOTAGES = ['lostRow', 'keyLock'];
const WEAK_SABOTAGES = ['fog', 'scramble', 'freeze'];

const SABOTAGE_DURATION_MS = {
  fog: 10000,
  keyLock: 15000,
  scramble: 15000,
  freeze: 5000,
  lostRow: 0,
};

const SABOTAGE_NAMES = {
  fog: 'Fog',
  keyLock: 'Key lock',
  scramble: 'Scramble',
  freeze: 'Freeze',
  lostRow: 'Lost row',
};

// Returns one of 'correct' | 'present' | 'absent' for each letter.
// Handles repeated letters: a letter is only marked as many times as it appears in the secret.
function scoreGuess(guess, secret) {
  const result = Array(guess.length).fill('absent');
  const unusedSecretLetters = {};

  for (let index = 0; index < secret.length; index++) {
    if (guess[index] === secret[index]) {
      result[index] = 'correct';
    } else {
      unusedSecretLetters[secret[index]] = (unusedSecretLetters[secret[index]] || 0) + 1;
    }
  }

  for (let index = 0; index < guess.length; index++) {
    const letter = guess[index];
    if (result[index] !== 'correct' && unusedSecretLetters[letter] > 0) {
      result[index] = 'present';
      unusedSecretLetters[letter]--;
    }
  }

  return result;
}

// Fewer guesses = more points. 1 guess = 6 points, 6 guesses = 1 point.
function pointsForSolve(guessCount) {
  return 7 - guessCount;
}

function pickRandom(list, random) {
  return list[Math.floor(random() * list.length)];
}

function pickSabotage(guessCount, random) {
  return pickRandom(guessCount <= 3 ? STRONG_SABOTAGES : WEAK_SABOTAGES, random);
}

function shuffle(list, random) {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const swapIndex = Math.floor(random() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

class Room {
  // options: answerWords (array), allowedWords (Set), send(playerId, message),
  //          onEmpty(), now(), random(), setTimer(fn, ms), clearTimer(handle)
  constructor(code, options) {
    this.code = code;
    this.answerWords = options.answerWords;
    this.allowedWords = options.allowedWords;
    this.send = options.send;
    this.onEmpty = options.onEmpty || (() => {});
    this.now = options.now || Date.now;
    this.random = options.random || Math.random;
    this.setTimer = options.setTimer || setTimeout;
    this.clearTimer = options.clearTimer || clearTimeout;

    this.players = new Map(); // keeps join order
    this.hostId = null;
    this.state = 'lobby'; // 'lobby' | 'playing' | 'finished'
    this.endsAt = null;
    this.matchTimer = null;
    this.matchMinutes = DEFAULT_MATCH_MINUTES;
  }

  addPlayer(playerId, rawName) {
    const name = String(rawName || '').trim().slice(0, 12);
    if (!name) return 'Please enter a name.';
    if (this.state === 'playing') return 'That match has already started.';
    if (this.players.size >= MAX_PLAYERS) return 'That room is full (4 players max).';
    const nameTaken = [...this.players.values()].some(
      (player) => player.name.toLowerCase() === name.toLowerCase()
    );
    if (nameTaken) return 'That name is already used in this room.';

    this.players.set(playerId, {
      id: playerId,
      name,
      score: 0,
      solvedCount: 0,
      secretWord: null,
      usedWords: new Set(),
      guesses: [],
      maxGuesses: MAX_GUESSES,
      hintsLeft: HINTS_PER_MATCH,
      hintPositions: [],
      pendingSabotages: [],
      frozenUntil: 0,
      lockedLetters: [],
      lockedUntil: 0,
    });
    if (!this.hostId) this.hostId = playerId;
    this.broadcastEvent(`${name} joined.`);
    this.broadcastState();
    return null;
  }

  removePlayer(playerId) {
    const player = this.players.get(playerId);
    if (!player) return;
    this.players.delete(playerId);

    if (this.players.size === 0) {
      this.clearTimer(this.matchTimer);
      this.onEmpty();
      return;
    }
    if (this.hostId === playerId) this.hostId = this.players.keys().next().value;

    this.broadcastEvent(`${player.name} left.`);
    if (this.state === 'playing' && this.players.size < MIN_PLAYERS) {
      this.finish('Not enough players left.');
      return;
    }
    this.broadcastState();
  }

  start(playerId) {
    if (playerId !== this.hostId) return 'Only the host can start.';
    if (this.state === 'playing') return 'The match is already running.';
    if (this.players.size < MIN_PLAYERS) return 'You need at least 2 players.';

    for (const player of this.players.values()) {
      player.score = 0;
      player.solvedCount = 0;
      player.hintsLeft = HINTS_PER_MATCH;
      player.usedWords = new Set();
      player.pendingSabotages = [];
      player.frozenUntil = 0;
      player.lockedLetters = [];
      player.lockedUntil = 0;
      this.giveNewWord(player);
    }
    this.state = 'playing';
    const matchLengthMs = this.matchMinutes * 60 * 1000;
    this.endsAt = this.now() + matchLengthMs;
    this.matchTimer = this.setTimer(() => this.finish('Time is up!'), matchLengthMs);
    this.broadcastEvent('The match has started. Go!');
    this.broadcastState();
    return null;
  }

  setMatchLength(playerId, minutes) {
    if (playerId !== this.hostId) return 'Only the host can change the match length.';
    if (this.state === 'playing') return 'You cannot change the length during a match.';
    if (!MATCH_LENGTH_CHOICES_MINUTES.includes(minutes)) return 'Pick 3, 5 or 10 minutes.';
    this.matchMinutes = minutes;
    this.broadcastState();
    return null;
  }

  finish(reason) {
    this.clearTimer(this.matchTimer);
    this.matchTimer = null;
    this.state = 'finished';
    this.endsAt = null;
    for (const player of this.players.values()) {
      if (player.secretWord) {
        this.send(player.id, { type: 'reveal', word: player.secretWord, solved: false });
      }
      player.secretWord = null;
      player.pendingSabotages = [];
    }
    this.broadcastEvent(reason);
    this.broadcastState();
  }

  giveNewWord(player) {
    let choices = this.answerWords.filter((word) => !player.usedWords.has(word));
    if (choices.length === 0) {
      player.usedWords.clear();
      choices = this.answerWords;
    }
    player.secretWord = pickRandom(choices, this.random);
    player.usedWords.add(player.secretWord);
    player.guesses = [];
    player.maxGuesses = MAX_GUESSES;
    player.hintPositions = [];
  }

  guess(playerId, rawWord) {
    const player = this.players.get(playerId);
    if (!player) return 'You are not in this room.';
    if (this.state !== 'playing') return 'The match is not running.';

    const word = String(rawWord || '').toLowerCase();
    if (!/^[a-z]{5}$/.test(word)) return 'Guesses must be 5 letters.';
    if (this.now() < player.frozenUntil) return 'You are frozen!';
    if (this.now() < player.lockedUntil) {
      const lockedLetter = [...word].find((letter) => player.lockedLetters.includes(letter));
      if (lockedLetter) return `The letter ${lockedLetter.toUpperCase()} is locked.`;
    }
    if (!this.allowedWords.has(word)) return 'Not in the word list.';

    const result = scoreGuess(word, player.secretWord);
    player.guesses.push({ word, result });

    if (word === player.secretWord) {
      const guessCount = player.guesses.length;
      const points = pointsForSolve(guessCount);
      const sabotage = pickSabotage(guessCount, this.random);
      player.score += points;
      player.solvedCount++;
      player.pendingSabotages.push(sabotage);
      this.send(player.id, { type: 'reveal', word, solved: true, points, sabotage });
      this.broadcastEvent(`${player.name} solved a word in ${guessCount} and earned ${SABOTAGE_NAMES[sabotage]}.`);
      this.giveNewWord(player);
    } else if (player.guesses.length >= player.maxGuesses) {
      this.send(player.id, { type: 'reveal', word: player.secretWord, solved: false });
      this.giveNewWord(player);
    }

    this.broadcastState();
    return null;
  }

  // Reveals one letter of the current word in its spot. Costs a point.
  hint(playerId) {
    const player = this.players.get(playerId);
    if (!player) return 'You are not in this room.';
    if (this.state !== 'playing') return 'The match is not running.';
    if (player.hintsLeft === 0) return 'You have no hints left.';
    if (this.now() < player.frozenUntil) return 'You are frozen!';

    // Skip spots the player already has green, or already got as a hint.
    const unknownPositions = [0, 1, 2, 3, 4].filter(
      (position) =>
        !player.hintPositions.includes(position) &&
        !player.guesses.some((guess) => guess.result[position] === 'correct')
    );
    if (unknownPositions.length === 0) return 'You already know every letter.';

    player.hintPositions.push(pickRandom(unknownPositions, this.random));
    player.hintsLeft--;
    player.score -= HINT_COST_POINTS;
    this.broadcastState();
    return null;
  }

  // The solver spends their oldest earned sabotage on one target.
  sabotage(playerId, targetId) {
    const attacker = this.players.get(playerId);
    const target = this.players.get(targetId);
    if (!attacker) return 'You are not in this room.';
    if (this.state !== 'playing') return 'The match is not running.';
    if (attacker.pendingSabotages.length === 0) return 'You have no sabotage to send.';
    if (!target || targetId === playerId) return 'Pick another player.';

    const sabotage = attacker.pendingSabotages.shift();
    const durationMs = SABOTAGE_DURATION_MS[sabotage];
    const effect = { type: 'effect', sabotage, durationMs, from: attacker.name };

    if (sabotage === 'freeze') {
      target.frozenUntil = this.now() + durationMs;
    } else if (sabotage === 'keyLock') {
      target.lockedLetters = shuffle(ALPHABET, this.random).slice(0, 3);
      target.lockedUntil = this.now() + durationMs;
      effect.letters = target.lockedLetters;
    } else if (sabotage === 'scramble') {
      effect.letters = shuffle(ALPHABET, this.random);
    } else if (sabotage === 'lostRow') {
      // Never take away the row the target is about to use, so this cannot end their word instantly.
      target.maxGuesses = Math.max(target.maxGuesses - 1, target.guesses.length + 1);
    }

    this.send(target.id, effect);
    this.broadcastEvent(`${attacker.name} hit ${target.name} with ${SABOTAGE_NAMES[sabotage]}!`);
    this.broadcastState();
    return null;
  }

  broadcastEvent(text) {
    for (const player of this.players.values()) {
      this.send(player.id, { type: 'event', text });
    }
  }

  // Each player gets the shared scoreboard plus their own private board.
  broadcastState() {
    const scoreboard = [...this.players.values()].map((player) => ({
      id: player.id,
      name: player.name,
      score: player.score,
      solvedCount: player.solvedCount,
      guessCount: player.guesses.length,
      maxGuesses: player.maxGuesses,
    }));

    for (const player of this.players.values()) {
      this.send(player.id, {
        type: 'state',
        code: this.code,
        state: this.state,
        hostId: this.hostId,
        matchMinutes: this.matchMinutes,
        matchLengthChoices: MATCH_LENGTH_CHOICES_MINUTES,
        endsAt: this.endsAt,
        serverNow: this.now(),
        players: scoreboard,
        you: {
          id: player.id,
          guesses: this.state === 'playing' ? player.guesses : [],
          maxGuesses: player.maxGuesses,
          hintsLeft: player.hintsLeft,
          hints: this.state === 'playing'
            ? player.hintPositions.map((position) => ({ position, letter: player.secretWord[position] }))
            : [],
          pendingSabotages: player.pendingSabotages,
        },
      });
    }
  }
}

module.exports = {
  Room,
  scoreGuess,
  pointsForSolve,
  pickSabotage,
  MAX_PLAYERS,
  MAX_GUESSES,
  HINTS_PER_MATCH,
  SABOTAGE_DURATION_MS,
};
