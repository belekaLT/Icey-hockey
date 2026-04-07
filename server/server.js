'use strict';

/**
 * Icey Hockey – WebSocket Multiplayer Server
 *
 * Run:  npm install && npm start
 *       PORT=3000 node server.js   (optional PORT env var)
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

const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT, 10) || 3000;

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

// ─── Game state ──────────────────────────────────────────────────────────────
let gameState = {
  p1:       makePlayer(250, CY),
  p2:       makePlayer(650, CY),
  puck:     makePuck(),
  score:    { p1: 0, p2: 0 },
  period:   1,
  time:     PERIOD_SECS,
  overtime: false,
  phase:    'waiting',           // waiting | playing | goal | periodEnd | gameOver
  lastGoalScorer: '',
};

// Phase timers
let goalTimer      = 0;
let periodEndTimer = 0;

// Latest inputs keyed by role (1 or 2)
const inputs = {
  1: { up: false, down: false, left: false, right: false, shoot: false },
  2: { up: false, down: false, left: false, right: false, shoot: false },
};

// Connected clients: [{ ws, role }]
let clients = [];

// ─── WebSocket server ────────────────────────────────────────────────────────
const wss = new WebSocket.Server({ port: PORT }, () => {
  console.log(`[Icey Hockey] Server listening on ws://localhost:${PORT}`);
});

wss.on('connection', ws => {
  if (clients.length >= 2) {
    console.log('[Icey Hockey] Room full – rejecting connection.');
    ws.close(1008, 'Room full');
    return;
  }

  const role = clients.length + 1;
  clients.push({ ws, role });
  console.log(`[Icey Hockey] Player ${role} connected. Total: ${clients.length}`);

  // Assign role
  safeSend(ws, { type: 'role', role });

  // Send current state immediately so the client knows it's waiting
  safeSend(ws, buildStateMsg());

  // Start game when second player joins
  if (clients.length === 2) {
    startGame();
  }

  ws.on('message', data => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'input') {
        inputs[role] = {
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
    clients = clients.filter(c => c.ws !== ws);
    console.log(`[Icey Hockey] Player ${role} disconnected. Remaining: ${clients.length}`);

    // Notify the remaining client
    clients.forEach(c => safeSend(c.ws, { type: 'playerLeft' }));

    // Reset everything so the next pair can play
    resetGame();
  });

  ws.on('error', err => {
    console.error(`[Icey Hockey] WS error (role ${role}):`, err.message);
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

function tryShoot(pl, targetX, targetY) {
  if (pl.shootCooldown > 0) return;
  const dx = gameState.puck.x - pl.x;
  const dy = gameState.puck.y - pl.y;
  if (Math.hypot(dx, dy) > P_R + PUCK_R + 15) return;

  const tdx = targetX - gameState.puck.x;
  const tdy = targetY - gameState.puck.y;
  const d   = Math.hypot(tdx, tdy);
  if (d > 0) {
    gameState.puck.vx = tdx / d * SHOOT_SPD;
    gameState.puck.vy = tdy / d * SHOOT_SPD;
  }
  pl.shootCooldown = SHOOT_CD;
}

function updatePuck() {
  const pk = gameState.puck;
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

function playerPuckCollision(pl) {
  const pk   = gameState.puck;
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

function checkGoal() {
  const pk = gameState.puck;
  // Left goal → P2 scores
  if (pk.x < GOAL_L_BACK && pk.y > GOAL_TOP && pk.y < GOAL_BOT) {
    gameState.score.p2++;
    gameState.lastGoalScorer = 'p2';
    gameState.phase = 'goal';
    goalTimer = GOAL_DISP;
    if (gameState.score.p2 >= SCORE_TO_WIN || gameState.overtime) {
      gameState.phase = 'goal'; // will go to gameOver after timer
    }
    return true;
  }
  // Right goal → P1 scores
  if (pk.x > GOAL_R_BACK && pk.y > GOAL_TOP && pk.y < GOAL_BOT) {
    gameState.score.p1++;
    gameState.lastGoalScorer = 'p1';
    gameState.phase = 'goal';
    goalTimer = GOAL_DISP;
    if (gameState.score.p1 >= SCORE_TO_WIN || gameState.overtime) {
      gameState.phase = 'goal'; // will go to gameOver after timer
    }
    return true;
  }
  return false;
}

// ─── Game flow ───────────────────────────────────────────────────────────────
function startGame() {
  console.log('[Icey Hockey] Game starting!');
  resetFaceoff();
  gameState.score    = { p1: 0, p2: 0 };
  gameState.period   = 1;
  gameState.time     = PERIOD_SECS;
  gameState.overtime = false;
  gameState.phase    = 'playing';
  goalTimer      = 0;
  periodEndTimer = 0;
}

function resetFaceoff() {
  gameState.p1   = makePlayer(250, CY);
  gameState.p2   = makePlayer(650, CY);
  gameState.puck = makePuck();
}

function endPeriod() {
  gameState.phase = 'periodEnd';
  periodEndTimer  = PERIOD_DISP;
}

// ─── Main game tick (30 fps) ──────────────────────────────────────────────────
function gameTick() {
  // Do nothing until both clients are connected
  if (clients.length < 2) return;
  if (gameState.phase === 'waiting') return;

  switch (gameState.phase) {

    case 'playing': {
      // Cooldowns
      if (gameState.p1.shootCooldown > 0) gameState.p1.shootCooldown -= DT;
      if (gameState.p2.shootCooldown > 0) gameState.p2.shootCooldown -= DT;

      // Player movement
      updatePlayer(gameState.p1, inputs[1]);
      updatePlayer(gameState.p2, inputs[2]);

      // Shooting – P1 aims at right goal, P2 aims at left goal
      if (inputs[1].shoot) tryShoot(gameState.p1, RX2, CY);
      if (inputs[2].shoot) tryShoot(gameState.p2, RX,  CY);

      // Puck physics
      updatePuck();

      // Collisions
      playerPuckCollision(gameState.p1);
      playerPuckCollision(gameState.p2);

      // Goal detection
      if (checkGoal()) break;

      // Period countdown
      gameState.time -= DT;
      if (gameState.time <= 0) {
        gameState.time = 0;
        endPeriod();
      }
      break;
    }

    case 'goal': {
      goalTimer -= DT;
      if (goalTimer <= 0) {
        const s = gameState.score;
        // First to SCORE_TO_WIN goals wins
        if (s.p1 >= SCORE_TO_WIN || s.p2 >= SCORE_TO_WIN || gameState.overtime) {
          gameState.phase = 'gameOver';
        } else {
          resetFaceoff();
          gameState.phase = 'playing';
        }
      }
      break;
    }

    case 'periodEnd': {
      periodEndTimer -= DT;
      if (periodEndTimer <= 0) {
        if (gameState.overtime) {
          // OT timed out with no goal
          gameState.phase = 'gameOver';
        } else if (gameState.period >= NUM_PERIODS) {
          if (gameState.score.p1 === gameState.score.p2) {
            // Tied after regulation → overtime
            gameState.overtime = true;
            gameState.period++;
            gameState.time = PERIOD_SECS;
            resetFaceoff();
            gameState.phase = 'playing';
            console.log('[Icey Hockey] Overtime!');
          } else {
            gameState.phase = 'gameOver';
          }
        } else {
          // Next period
          gameState.period++;
          gameState.time = PERIOD_SECS;
          resetFaceoff();
          gameState.phase = 'playing';
          console.log(`[Icey Hockey] Period ${gameState.period} starting.`);
        }
      }
      break;
    }

    case 'gameOver':
      // Keep broadcasting final state; no further updates needed
      break;
  }

  broadcast(buildStateMsg());
}

// ─── State serialisation ─────────────────────────────────────────────────────
function buildStateMsg() {
  const gs = gameState;
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

function broadcast(obj) {
  const json = JSON.stringify(obj);
  clients.forEach(c => {
    if (c.ws.readyState === WebSocket.OPEN) {
      try { c.ws.send(json); } catch (e) { /* ignore */ }
    }
  });
}

function resetGame() {
  gameState = {
    p1:       makePlayer(250, CY),
    p2:       makePlayer(650, CY),
    puck:     makePuck(),
    score:    { p1: 0, p2: 0 },
    period:   1,
    time:     PERIOD_SECS,
    overtime: false,
    phase:    'waiting',
    lastGoalScorer: '',
  };
  inputs[1] = { up: false, down: false, left: false, right: false, shoot: false };
  inputs[2] = { up: false, down: false, left: false, right: false, shoot: false };
  goalTimer      = 0;
  periodEndTimer = 0;
  console.log('[Icey Hockey] Game reset – waiting for players.');
}

// ─── Start tick loop ─────────────────────────────────────────────────────────
const tickInterval = setInterval(gameTick, 1000 / TICK_RATE);

// Graceful shutdown
process.on('SIGINT',  () => { clearInterval(tickInterval); wss.close(); process.exit(0); });
process.on('SIGTERM', () => { clearInterval(tickInterval); wss.close(); process.exit(0); });
