# Word Rush

An online word race for 2 to 4 players. Everyone guesses their own secret 5‑letter word at the same time. Solving a word scores points and earns a sabotage you send to another player.

## Run it

Needs Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. One player clicks **Create a room** and shares the 4‑letter code. Others enter the code and click **Join room**. Players on other devices on the same Wi‑Fi can use `http://<your-computer-ip>:3000`.

Set `PORT` to use another port. Run tests with `npm test`.

## Rules

- Each player has their own secret word and 6 guesses. Green = right letter, right spot. Yellow = in the word, wrong spot.
- Solving scores `7 - guesses` points (6 for 1 guess, 1 for 6 guesses). You get a new word right away.
- Running out of guesses shows you the word and gives you a new one, with no points.
- Each solve earns one sabotage. You pick which player gets it. Solving in 3 guesses or fewer earns a strong one.
- Each player has 3 hints per match. A hint shows one unknown letter of the current word in its right spot and costs 1 point.
- The host picks a match length of 3, 5 (default) or 10 minutes. Most points wins. The host can press **Play again**.

- If your connection drops or you reload the page during a match, you get your seat back automatically. The server holds it for 60 seconds.

| Sabotage | Strength | Effect on the target |
|---|---|---|
| Lost row | Strong | One fewer guess on the current word (never removes the row they are about to use) |
| Key lock | Strong | 3 random letters can't be used for 15 seconds |
| Fog | Weak | Board and keyboard colors hidden for 10 seconds |
| Scramble | Weak | On‑screen keyboard shuffled for 15 seconds |
| Freeze | Weak | Can't type for 5 seconds |

## Files

- `server.js` – serves `public/` and runs the WebSocket game server (`ws` package).
- `game.js` – rules and room state, with no networking, so it is easy to test.
- `public/` – the browser client (plain HTML, CSS, JS).
- `words/answers.txt` – secret words (hand‑picked common words).
- `words/allowed.txt` – accepted guesses, the 5‑letter words from [dwyl/english-words](https://github.com/dwyl/english-words) (public domain) plus the answers.
- `test/game.test.js` – tests for the rules.
- `test/server.test.js` – starts the real server and tests reconnect and message limits.
