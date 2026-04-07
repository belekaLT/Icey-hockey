# 🏒 Icey Hockey

A fully playable browser-based ice hockey game with **2-player local**, **vs Bot**, and **online multiplayer** modes — all in a single HTML file.

---

## 🎮 How to Play

### Single Player / 2-Player Local

Just open `index.html` in any modern browser — **no build step, no server required**.

```bash
# Double-click index.html, or serve it locally:
npx serve .
# → open http://localhost:3000
```

Pick a mode from the menu:
- **⚔ 2 Players (Local)** – both players on the same keyboard
- **🤖 vs Bot** – you (P1, blue) vs AI (P2, red)

---

## 🕹 Controls

| Action     | Player 1 (Blue / Left) | Player 2 (Red / Right) |
|------------|------------------------|------------------------|
| Move Up    | `W`                    | `↑` Arrow Up           |
| Move Down  | `S`                    | `↓` Arrow Down         |
| Move Left  | `A`                    | `← ` Arrow Left        |
| Move Right | `D`                    | `→` Arrow Right        |
| **Shoot**  | **`Space`**            | **`Enter`**            |

> Controls are also displayed in the HUD during gameplay.

---

## 🌐 Online Multiplayer

Multiplayer requires the Node.js WebSocket server.

### Prerequisites

- [Node.js](https://nodejs.org/) v14 or later

### 1. Start the server

```bash
cd server
npm install
npm start
# → Server listening on ws://localhost:3000
```

You can change the port via the `PORT` environment variable:

```bash
PORT=4000 npm start
```

### 2. Connect clients

1. Open `index.html` in **two** browser windows/tabs (or on two machines on the same network).
2. Click **🌐 Multiplayer** in the menu.
3. Enter the server URL (default `ws://localhost:3000`).
4. Click **Connect** in both windows — the game starts automatically when both players are connected.

> For two machines: replace `localhost` with the host machine's IP address (e.g. `ws://192.168.1.5:3000`).

---

## 🧊 Gameplay

- **3 periods** of 3 minutes each
- Score by getting the puck into the opponent's goal
- After a goal: 2-second celebration, then **faceoff** at center ice
- If tied after regulation → **overtime** (sudden death)
- Period/game-over overlays shown on the canvas

---

## 📁 Project Structure

```
index.html          ← Complete game client (HTML + CSS + JS, no dependencies)
server/
  server.js         ← Node.js WebSocket multiplayer server
  package.json      ← Server dependencies (ws)
README.md
```

---

## 🤖 Bot AI

The bot (vs Bot mode) uses a simple state machine:

- **Defend** – rushes to intercept puck when it's in the bot's half
- **Chase** – pursues the puck across the rink
- **Shoot** – fires toward your goal when close enough, with slight randomised aim error

---

## 🛠 Tech Stack

- **Client**: Vanilla HTML5 Canvas + JavaScript (zero dependencies)
- **Server**: Node.js + [`ws`](https://github.com/websockets/ws) WebSocket library
