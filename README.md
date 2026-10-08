# Bridge with friends
# Check out my app at - https://bridge-game-wml9.onrender.com/

A small online bridge table. Up to four friends join a table by link, bid, and play.
Bots can fill empty seats so you can test alone.

## Run it on your computer

    npm install
    npm start

Open http://localhost:3000, open a table, then add three bots from the "Add bot" buttons,
sit in the fourth seat, and press "Deal the cards". Bots always pass, so to get a contract
to play, bid yourself and the bots will pass behind you.

To try it with real multiple players on one machine, open the invite link in a second
browser profile or a private window (each browser has its own player ID).

    npm test      # plays 300 random hands and checks the scoring rules

## Put it on Render

1. Create a GitHub repository and push this folder to it.
2. In Render choose New > Web Service and pick the repository.
3. Settings: Runtime Node, Build command `npm install`, Start command `npm start`,
   Instance type Free. (Or choose New > Blueprint and Render reads `render.yaml`.)
4. When the deploy finishes, open your `https://....onrender.com` address, open a table
   and send the invite link to friends.

Things to know about Render's free plan:
- The service sleeps after about 15 minutes without traffic and takes up to a minute to wake.
  Open the link yourself a minute before your friends arrive.
- Games live in memory. If the service restarts or redeploys, running tables disappear.
- Keep it to a single instance. Tables are not shared between instances.

## How it works

- `game.js` is the rules engine (dealing, bidding, follow-suit, tricks, dummy, rubber scoring). No network code.
- `server.js` handles tables, seats, bots and Socket.IO. The server is the only authority:
  clients send a bid or a card, and the server checks it.
- `viewFor()` in `game.js` decides what each player may see. You get your own hand and the
  dummy once it goes down. Other hands are never sent to your browser until the hand ends.
- Avatars are a fixed set of emoji chosen on the entry screen (click your own avatar at the table to change it). Bots use a robot.
- Your browser stores a random player ID so a refresh or dropped connection returns you to
  your seat.

## Not built yet

- Honors bonuses (100 or 150 for holding four or five top trumps), and duplicate scoring.
- Ending an unfinished rubber, which would add the 300 and 100 bonuses for a game or part score.
- Smarter bots. They pass in the auction and play random legal cards.
- Chat, undo and claim, spectators, a replay of the last trick.
