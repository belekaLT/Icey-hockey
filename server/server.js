'use strict';

/**
 * Icey Hockey – HTTP + WebSocket Multiplayer Server
 *
 * Run:  npm install && npm start
 *       PORT=3000 node server.js   (optional PORT env var)
 *
 * Visit http://localhost:3000 to play in any browser.
 *
 * Room flow:
 *   1. Player 1 calls GET /create-room  → receives { code: 'ABC123' }
 *   2. Both players connect via WebSocket with ?code=ABC123
 *   3. Game starts when both players are in the room.
 *   4. The code is one-time use: once the room has 2 players, no one else may join.
 *      When either player disconnects the room is deleted.
 *
 * Protocol:
 *   Server → Client
 *     { type:'role',   role: 1|2 }
 *     { type:'state',  p1, p2, puck, score, period, time, overtime, phase, lastGoalScorer }
 *     { type:'playerLeft' }
 *
 *   Client → Server
 *     { type:'input', up, down, left, right, shoot }   (booleans)
 */

const http       = require('http');
const fs         = require('fs');
const pathModule = require('path');
const WebSocket  = require('ws');

const PORT       = parseInt(process.env.PORT, 10) || 3000;
const INDEX_FILE = pathModule.join(__dirname, '..', 'index.html');

// ─── HTTP server (serves the game client + room creation API) ────────────────
const httpServer = http.createServer((req, res) => {
  // Room creation endpoint
  if (req.method === 'GET' && req.url === '/create-room') {
    const room = createRoom();
    console.log(`[Icey Hockey] Room ${room.code} created via HTTP.`);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify({ code: room.code }));
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    fs.readFile(INDEX_FILE, (err, data) => {
      if (err) {
        console.error('[Icey Hockey] Failed to read index.html:', err);
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Internal Server Error: could not read game file');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

// ─── Physics constants (mirror of client) ───────────────────────────────────
const RX   = 50,  RY  = 50,  RW  = 800, RH  = 520;
const RX2  = RX + RW;   // 850
const RY2  = RY + RH;   // 570
const CX   = 450, CY  = 310;
const GOAL_H     = 120;
const GOAL_D     = 22;
const GOAL_TOP   = CY - GOAL_H / 2;      // 250
const GOAL_BOT   = CY + GOAL_H / 2;      // 370
const GOAL_L_BACK = RX  - GOAL_D;        // 28
const GOAL_R_BACK = RX2 + GOAL_D;        // 872
const P_R        = 22;
const PUCK_R     = 10;
const P_SPEED    = 260;
const SHOOT_SPD  = 520;
const PUCK_FRIC  = 0.985;
const ELASTICITY = 0.75;
const SHOOT_CD   = 0.5;
const TICK_RATE  = 30;                   // server fps
const DT         = 1 / TICK_RATE;       // fixed timestep
const PERIOD_SECS  = 180;
const NUM_PERIODS  = 3;
const GOAL_DISP    = 2.0;               // seconds to show GOAL state
const PERIOD_DISP  = 2.5;              // seconds to show periodEnd state
const SCORE_TO_WIN = 3;

// ─── State helpers ───────────────────────────────────────────────────────────
function makePlayer(x, y) {
  return { x, y, vx: 0, vy: 0, shootCooldown: 0 };
}

function makePuck() {
  return { x: CX, y: CY, vx: 0, vy: 0 };
}

function makeInitialGameState() {
  return {
    p1:       makePlayer(250, CY),
    p2:       makePlayer(650, CY),
    puck:     makePuck(),
    score:    { p1: 0, p2: 0 },
    period:   1,
    time:     PERIOD_SECS,
    overtime: false,
    phase:    'waiting',          // waiting | playing | goal | periodEnd | gameOver
    lastGoalScorer: '',
  };
}

// ─── Room management ─────────────────────────────────────────────────────────
// rooms: Map<code, room>
// room: { code, clients, gameState, inputs, goalTimer, periodEndTimer }
const rooms = new Map();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
// Note: I, O, 0, and 1 are intentionally excluded to avoid confusion
// between visually similar characters when sharing codes verbally.

function generateCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom() {
  const code = generateCode();
  const room = {
    code,
    clients: [],
    gameState: makeInitialGameState(),
    inputs: {
      1: { up: false, down: false, left: false, right: false, shoot: false },
      2: { up: false, down: false, left: false, right: false, shoot: false },
    },
    goalTimer:      0,
    periodEndTimer: 0,
  };
  rooms.set(code, room);
  return room;
}

function deleteRoom(room) {
  rooms.delete(room.code);
  console.log(`[Icey Hockey] Room ${room.code} deleted.`);
}

// ─── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ server: httpServer });

wss.on('connection', (ws, req) => {
  // Parse the room code from the WebSocket URL query string (?code=ABC123)
  const reqUrl = new URL(req.url, `http://localhost`);
  const code   = (reqUrl.searchParams.get('code') || '').toUpperCase();
  const room   = rooms.get(code);

  if (!room) {
    console.log(`[Icey Hockey] Rejected connection – unknown code "${code}".`);
    ws.close(1008, 'Invalid room code');
    return;
  }

  if (room.clients.length >= 2) {
    console.log(`[Icey Hockey] Rejected connection – room ${code} is full.`);
    ws.close(1008, 'Room full');
    return;
  }

  const role = room.clients.length + 1;
  room.clients.push({ ws, role });
  console.log(`[Icey Hockey] Player ${role} joined room ${code}. Total: ${room.clients.length}`);

  // Assign role
  safeSend(ws, { type: 'role', role });

  // Send current state immediately so the client knows it's waiting
  safeSend(ws, buildStateMsg(room));

  // Start game when second player joins
  if (room.clients.length === 2) {
    startGame(room);
  }

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') {
        room.inputs[role] = {
          up:    !!msg.up,
          down:  !!msg.down,
          left:  !!msg.left,
          right: !!msg.right,
          shoot: !!msg.shoot,
        };
      }
    } catch (e) { /* ignore malformed messages */ }
  });

  ws.on('close', () => {
    room.clients = room.clients.filter(c => c.ws !== ws);
    console.log(`[Icey Hockey] Player ${role} left room ${room.code}. Remaining: ${room.clients.length}`);

    // Notify remaining clients and close their connections before deleting the room
    room.clients.forEach(c => {
      safeSend(c.ws, { type: 'playerLeft' });
      if (c.ws.readyState === WebSocket.OPEN) {
        try { c.ws.close(); } catch (e) { /* ignore */ }
      }
    });
    room.clients = [];

    // Remove the room so the code cannot be reused
    deleteRoom(room);
  });

  ws.on('error', err => {
    console.error(`[Icey Hockey] WS error (room ${room.code}, role ${role}):`, err.message);
  });
});

// ─── Physics functions ───────────────────────────────────────────────────────
function updatePlayer(pl, input) {
  let ax = 0, ay = 0;
  if (input.up)    ay -= P_SPEED;
  if (input.down)  ay += P_SPEED;
  if (input.left)  ax -= P_SPEED;
  if (input.right) ax += P_SPEED;

  pl.vx = pl.vx * 0.75 + ax * 0.25;
  pl.vy = pl.vy * 0.75 + ay * 0.25;
  pl.x += pl.vx * DT;
  pl.y += pl.vy * DT;

  pl.x = Math.max(RX + P_R, Math.min(RX2 - P_R, pl.x));
  pl.y = Math.max(RY + P_R, Math.min(RY2 - P_R, pl.y));
}

function tryShoot(gs, pl, targetX, targetY) {
  if (pl.shootCooldown > 0) return;
  const dx = gs.puck.x - pl.x;
  const dy = gs.puck.y - pl.y;
  if (Math.hypot(dx, dy) > P_R + PUCK_R + 15) return;

  const tdx = targetX - gs.puck.x;
  const tdy = targetY - gs.puck.y;
  const d   = Math.hypot(tdx, tdy);
  if (d > 0) {
    gs.puck.vx = tdx / d * SHOOT_SPD;
    gs.puck.vy = tdy / d * SHOOT_SPD;
  }
  pl.shootCooldown = SHOOT_CD;
}

function updatePuck(gs) {
  const pk = gs.puck;
  pk.x += pk.vx * DT;
  pk.y += pk.vy * DT;

  // Friction
  const f = Math.pow(PUCK_FRIC, DT * 60);
  pk.vx *= f;
  pk.vy *= f;

  // Left wall – allow through goal opening
  if (pk.x - PUCK_R < RX) {
    if (pk.y > GOAL_TOP && pk.y < GOAL_BOT) {
      // pass-through
    } else {
      pk.x  = RX + PUCK_R;
      pk.vx = Math.abs(pk.vx) * ELASTICITY;
    }
  }
  // Right wall
  if (pk.x + PUCK_R > RX2) {
    if (pk.y > GOAL_TOP && pk.y < GOAL_BOT) {
      // pass-through
    } else {
      pk.x  = RX2 - PUCK_R;
      pk.vx = -Math.abs(pk.vx) * ELASTICITY;
    }
  }
  // Top / bottom
  if (pk.y - PUCK_R < RY)  { pk.y  = RY  + PUCK_R; pk.vy =  Math.abs(pk.vy) * ELASTICITY; }
  if (pk.y + PUCK_R > RY2) { pk.y  = RY2 - PUCK_R; pk.vy = -Math.abs(pk.vy) * ELASTICITY; }

  // Back of nets – only bounce if NOT in the goal opening (goals are detected by checkGoal)
  if (pk.x - PUCK_R < GOAL_L_BACK && !(pk.y > GOAL_TOP && pk.y < GOAL_BOT)) { pk.x  = GOAL_L_BACK + PUCK_R; pk.vx =  Math.abs(pk.vx) * ELASTICITY; }
  if (pk.x + PUCK_R > GOAL_R_BACK && !(pk.y > GOAL_TOP && pk.y < GOAL_BOT)) { pk.x  = GOAL_R_BACK - PUCK_R; pk.vx = -Math.abs(pk.vx) * ELASTICITY; }

  // Top/bottom edges inside goal cavities
  if (pk.x < RX && pk.x > GOAL_L_BACK) {
    if (pk.y - PUCK_R < GOAL_TOP) { pk.y = GOAL_TOP + PUCK_R; pk.vy =  Math.abs(pk.vy) * ELASTICITY; }
    if (pk.y + PUCK_R > GOAL_BOT) { pk.y = GOAL_BOT - PUCK_R; pk.vy = -Math.abs(pk.vy) * ELASTICITY; }
  }
  if (pk.x > RX2 && pk.x < GOAL_R_BACK) {
    if (pk.y - PUCK_R < GOAL_TOP) { pk.y = GOAL_TOP + PUCK_R; pk.vy =  Math.abs(pk.vy) * ELASTICITY; }
    if (pk.y + PUCK_R > GOAL_BOT) { pk.y = GOAL_BOT - PUCK_R; pk.vy = -Math.abs(pk.vy) * ELASTICITY; }
  }
}

function playerPuckCollision(gs, pl) {
  const pk   = gs.puck;
  const dx   = pk.x - pl.x;
  const dy   = pk.y - pl.y;
  const dist = Math.hypot(dx, dy);
  const minD = P_R + PUCK_R;

  if (dist < minD && dist > 0.001) {
    const nx = dx / dist;
    const ny = dy / dist;

    pk.x = pl.x + nx * (minD + 0.5);
    pk.y = pl.y + ny * (minD + 0.5);

    const rvx = pk.vx - pl.vx;
    const rvy = pk.vy - pl.vy;
    const dot = rvx * nx + rvy * ny;
    if (dot < 0) {
      pk.vx -= (1 + 0.8) * dot * nx;
      pk.vy -= (1 + 0.8) * dot * ny;
    }
    pk.vx += pl.vx * 0.22;
    pk.vy += pl.vy * 0.22;

    const spd = Math.hypot(pk.vx, pk.vy);
    if (spd > SHOOT_SPD * 1.15) {
      pk.vx = pk.vx / spd * SHOOT_SPD * 1.15;
      pk.vy = pk.vy / spd * SHOOT_SPD * 1.15;
    }
  }
}

function checkGoal(room) {
  const gs = room.gameState;
  const pk = gs.puck;
  // Left goal → P2 scores
  if (pk.x < GOAL_L_BACK && pk.y > GOAL_TOP && pk.y < GOAL_BOT) {
    gs.score.p2++;
    gs.lastGoalScorer = 'p2';
    gs.phase = 'goal';
    room.goalTimer = GOAL_DISP;
    if (gs.score.p2 >= SCORE_TO_WIN || gs.overtime) {
      gs.phase = 'goal'; // will go to gameOver after timer
    }
    return true;
  }
  // Right goal → P1 scores
  if (pk.x > GOAL_R_BACK && pk.y > GOAL_TOP && pk.y < GOAL_BOT) {
    gs.score.p1++;
    gs.lastGoalScorer = 'p1';
    gs.phase = 'goal';
    room.goalTimer = GOAL_DISP;
    if (gs.score.p1 >= SCORE_TO_WIN || gs.overtime) {
      gs.phase = 'goal'; // will go to gameOver after timer
    }
    return true;
  }
  return false;
}

// ─── Game flow ───────────────────────────────────────────────────────────────
function startGame(room) {
  console.log(`[Icey Hockey] Room ${room.code}: game starting!`);
  const gs = room.gameState;
  resetFaceoff(gs);
  gs.score    = { p1: 0, p2: 0 };
  gs.period   = 1;
  gs.time     = PERIOD_SECS;
  gs.overtime = false;
  gs.phase    = 'playing';
  room.goalTimer      = 0;
  room.periodEndTimer = 0;
}

function resetFaceoff(gs) {
  gs.p1   = makePlayer(250, CY);
  gs.p2   = makePlayer(650, CY);
  gs.puck = makePuck();
}

function endPeriod(room) {
  room.gameState.phase = 'periodEnd';
  room.periodEndTimer  = PERIOD_DISP;
}

// ─── Main game tick (30 fps) ──────────────────────────────────────────────────
function gameTick() {
  for (const room of rooms.values()) {
    tickRoom(room);
  }
}

function tickRoom(room) {
  const gs = room.gameState;

  // Do nothing until both clients are connected
  if (room.clients.length < 2) return;
  if (gs.phase === 'waiting') return;

  switch (gs.phase) {

    case 'playing': {
      // Cooldowns
      if (gs.p1.shootCooldown > 0) gs.p1.shootCooldown -= DT;
      if (gs.p2.shootCooldown > 0) gs.p2.shootCooldown -= DT;

      // Player movement
      updatePlayer(gs.p1, room.inputs[1]);
      updatePlayer(gs.p2, room.inputs[2]);

      // Shooting – P1 aims at right goal, P2 aims at left goal
      if (room.inputs[1].shoot) tryShoot(gs, gs.p1, RX2, CY);
      if (room.inputs[2].shoot) tryShoot(gs, gs.p2, RX,  CY);

      // Puck physics
      updatePuck(gs);

      // Collisions
      playerPuckCollision(gs, gs.p1);
      playerPuckCollision(gs, gs.p2);

      // Goal detection
      if (checkGoal(room)) break;

      // Period countdown
      gs.time -= DT;
      if (gs.time <= 0) {
        gs.time = 0;
        endPeriod(room);
      }
      break;
    }

    case 'goal': {
      room.goalTimer -= DT;
      if (room.goalTimer <= 0) {
        const s = gs.score;
        // First to SCORE_TO_WIN goals wins
        if (s.p1 >= SCORE_TO_WIN || s.p2 >= SCORE_TO_WIN || gs.overtime) {
          gs.phase = 'gameOver';
        } else {
          resetFaceoff(gs);
          gs.phase = 'playing';
        }
      }
      break;
    }

    case 'periodEnd': {
      room.periodEndTimer -= DT;
      if (room.periodEndTimer <= 0) {
        if (gs.overtime) {
          // OT timed out with no goal
          gs.phase = 'gameOver';
        } else if (gs.period >= NUM_PERIODS) {
          if (gs.score.p1 === gs.score.p2) {
            // Tied after regulation → overtime
            gs.overtime = true;
            gs.period++;
            gs.time = PERIOD_SECS;
            resetFaceoff(gs);
            gs.phase = 'playing';
            console.log(`[Icey Hockey] Room ${room.code}: Overtime!`);
          } else {
            gs.phase = 'gameOver';
          }
        } else {
          // Next period
          gs.period++;
          gs.time = PERIOD_SECS;
          resetFaceoff(gs);
          gs.phase = 'playing';
          console.log(`[Icey Hockey] Room ${room.code}: Period ${gs.period} starting.`);
        }
      }
      break;
    }

    case 'gameOver':
      // Keep broadcasting final state; no further updates needed
      break;
  }

  broadcastRoom(room, buildStateMsg(room));
}

// ─── State serialisation ─────────────────────────────────────────────────────
function buildStateMsg(room) {
  const gs = room.gameState;
  return {
    type:    'state',
    p1:      { x: round2(gs.p1.x),   y: round2(gs.p1.y)   },
    p2:      { x: round2(gs.p2.x),   y: round2(gs.p2.y)   },
    puck:    { x: round2(gs.puck.x),  y: round2(gs.puck.y),
               vx: round2(gs.puck.vx), vy: round2(gs.puck.vy) },
    score:   { p1: gs.score.p1, p2: gs.score.p2 },
    period:  gs.period,
    time:    round2(gs.time),
    overtime: gs.overtime,
    phase:   gs.phase,
    lastGoalScorer: gs.lastGoalScorer,
  };
}

function round2(n) { return Math.round(n * 100) / 100; }

// ─── Utilities ───────────────────────────────────────────────────────────────
function safeSend(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* ignore */ }
  }
}

function broadcastRoom(room, obj) {
  const json = JSON.stringify(obj);
  room.clients.forEach(c => {
    if (c.ws.readyState === WebSocket.OPEN) {
      try { c.ws.send(json); } catch (e) { /* ignore */ }
    }
  });
}

// ─── Start tick loop ─────────────────────────────────────────────────────────
const tickInterval = setInterval(gameTick, 1000 / TICK_RATE);

// ─── Start HTTP + WebSocket server ───────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`[Icey Hockey] Game available at  http://localhost:${PORT}`);
  console.log(`[Icey Hockey] WebSocket listening on ws://localhost:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT',  () => { clearInterval(tickInterval); httpServer.close(); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(tickInterval); httpServer.close(); process.exit(0); });
