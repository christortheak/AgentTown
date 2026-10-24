// The town's layout and everything drawn on the canvas. All coordinates are
// world pixels; one tile is TILE pixels. Nothing here talks to the server.
export const TILE = 32;
export const COLS = 40;
export const ROWS = 26;

const GRASS = 0;
const PATH = 1;
const WATER = 2;

/** Deterministic 0..1 noise for a tile, so the town looks the same every visit. */
export const hash = (x, y, seed = 0) => {
  let h = Math.imul(x + 1013, 374761393) ^ Math.imul(y + 2029, 668265263) ^ Math.imul(seed + 7, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

export const BUILDINGS = [
  { id: 'records', name: 'Records Office', x: 4, y: 4, w: 7, h: 5, door: 7, roof: '#4f7fbf', wall: '#f6ead2', kind: 'office' },
  { id: 'townhall', name: 'Town Hall', x: 15, y: 2, w: 10, h: 7, door: 19, doorW: 2, roof: '#c8524a', wall: '#fbf1dc', kind: 'hall' },
  { id: 'home', name: 'Your house', x: 29, y: 4, w: 5, h: 5, door: 31, roof: '#e07a8a', wall: '#fff3e0', kind: 'house' },
  { id: 'bramble', name: 'Bramble Books', x: 3, y: 15, w: 5, h: 5, door: 5, roof: '#7a5aa6', wall: '#f3e7d3', kind: 'shop' },
  { id: 'kettle', name: 'Copper Kettle', x: 10, y: 15, w: 5, h: 5, door: 12, roof: '#d9822b', wall: '#fbeedb', kind: 'shop' },
  { id: 'maple', name: "Maple's", x: 29, y: 15, w: 5, h: 5, door: 31, roof: '#6aa35a', wall: '#fbf3df', kind: 'house' },
];

export const POND = { x: 22, y: 15, w: 5, h: 4 };
export const BOARD = { x: 17, y: 12 };
export const KEY_SPOT = { x: 25, y: 21 };
export const SPAWN = { x: 20 * TILE, y: 13.5 * TILE };
export const BURGLAR_START = { x: 37.5 * TILE, y: 10.5 * TILE };
const LAMPS = [[4, 12], [12, 12], [27, 12], [35, 12], [9, 20], [17, 20], [27, 20], [36, 20]];

export function buildTown() {
  const ground = Array.from({ length: ROWS }, () => new Array(COLS).fill(GRASS));
  const solid = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  const setPath = (x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ground[y][x] = PATH;
  };
  setPath(2, 10, 37, 11); // upper street
  setPath(2, 21, 37, 22); // lower street
  setPath(19, 9, 20, 22); // the lane between them

  for (let y = POND.y; y < POND.y + POND.h; y++) for (let x = POND.x; x < POND.x + POND.w; x++) {
    ground[y][x] = WATER;
    solid[y][x] = true;
  }
  const buildings = BUILDINGS.map((b) => {
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) solid[y][x] = true;
    const doorW = b.doorW ?? 1;
    for (let i = 0; i < doorW; i++) ground[b.y + b.h][b.door + i] = PATH;
    return { ...b, doorW, front: { x: (b.door + doorW / 2) * TILE, y: (b.y + b.h + 0.55) * TILE } };
  });
  const lamps = LAMPS.map(([x, y]) => {
    solid[y][x] = true;
    return { x, y };
  });
  solid[BOARD.y][BOARD.x] = true;

  // Trees: a border all round, and a scattering wherever they would not crowd a path.
  const trees = [];
  const near = (x, y, r, test) => {
    for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) {
      const xx = x + i;
      const yy = y + j;
      if (xx >= 0 && yy >= 0 && xx < COLS && yy < ROWS && test(xx, yy)) return true;
    }
    return false;
  };
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const border = x < 2 || y < 2 || x >= COLS - 2 || y >= ROWS - 2;
    if (border) {
      if (hash(x, y, 1) < 0.86) trees.push({ x, y, v: hash(x, y, 2) });
      solid[y][x] = true;
      continue;
    }
    if (ground[y][x] !== GRASS || solid[y][x]) continue;
    const crowded = near(x, y, 1, (a, b) => ground[b][a] !== GRASS || solid[b][a]) || Math.hypot(x - 20, y - 13) < 3.5;
    if (!crowded && hash(x, y, 3) < 0.2) {
      trees.push({ x, y, v: hash(x, y, 2) });
      solid[y][x] = true;
    }
  }
  const flowers = [];
  for (let y = 2; y < ROWS - 2; y++) for (let x = 2; x < COLS - 2; x++) {
    if (ground[y][x] === GRASS && !solid[y][x] && hash(x, y, 5) < 0.09) flowers.push({ x, y, v: hash(x, y, 6) });
  }
  return { ground, solid, buildings, lamps, trees, flowers };
}

/** Breadth-first path over walkable tiles, as tile centers in world pixels. */
export function findPath(town, from, to) {
  const key = (x, y) => y * COLS + x;
  const walkable = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS && !town.solid[y][x];
  if (!walkable(to.x, to.y)) return null;
  const prev = new Map([[key(from.x, from.y), null]]);
  const queue = [from];
  while (queue.length) {
    const c = queue.shift();
    if (c.x === to.x && c.y === to.y) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { x: c.x + dx, y: c.y + dy };
      if (walkable(n.x, n.y) && !prev.has(key(n.x, n.y))) {
        prev.set(key(n.x, n.y), c);
        queue.push(n);
      }
    }
  }
  if (!prev.has(key(to.x, to.y))) return null;
  const path = [];
  for (let c = to; c && !(c.x === from.x && c.y === from.y); c = prev.get(key(c.x, c.y))) path.unshift({ x: (c.x + 0.5) * TILE, y: (c.y + 0.6) * TILE });
  return path;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const OUTLINE = '#5a4636';
const C = {
  grass: ['#9fd46c', '#97cd65', '#a8da75'], tuft: '#7fb954',
  path: '#ecd9a8', pathEdge: '#d6bd86', pebble: '#d9c493',
  water: '#7cc8e8', waterEdge: '#bfe7f4', waterDeep: '#63b4da',
  canopyDark: '#3f8146', canopy: '#4f9a4f', canopyLight: '#68b55c', canopyShine: '#86cc72', trunk: '#8a5a3c',
};

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** The ground: grass, streets, the pond and flowers, drawn once into a cache. */
export function drawGround(ctx, town) {
  const { ground, flowers } = town;
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    ctx.fillStyle = C.grass[Math.floor(hash(x, y, 9) * 3)];
    ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    if (hash(x, y, 10) < 0.35) {
      ctx.strokeStyle = C.tuft;
      ctx.lineWidth = 1.5;
      const tx = x * TILE + 6 + hash(x, y, 11) * 18;
      const ty = y * TILE + 10 + hash(x, y, 12) * 14;
      ctx.beginPath();
      ctx.moveTo(tx - 3, ty - 4); ctx.lineTo(tx, ty); ctx.lineTo(tx + 3, ty - 4);
      ctx.stroke();
    }
  }
  const at = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS ? GRASS : ground[y][x]);
  for (const [kind, fill, edge] of [[PATH, C.path, C.pathEdge], [WATER, C.water, C.waterEdge]]) {
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      if (ground[y][x] !== kind) continue;
      const X = x * TILE;
      const Y = y * TILE;
      const n = at(x, y - 1) === kind; const s = at(x, y + 1) === kind; const w = at(x - 1, y) === kind; const e = at(x + 1, y) === kind;
      const r = 10;
      ctx.fillStyle = fill;
      roundRect(ctx, X, Y, TILE, TILE, [!n && !w ? r : 0, !n && !e ? r : 0, !s && !e ? r : 0, !s && !w ? r : 0]);
      ctx.fill();
      ctx.strokeStyle = edge;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (!n) { ctx.moveTo(X + (w ? 0 : r), Y + 1); ctx.lineTo(X + TILE - (e ? 0 : r), Y + 1); }
      if (!s) { ctx.moveTo(X + (w ? 0 : r), Y + TILE - 1); ctx.lineTo(X + TILE - (e ? 0 : r), Y + TILE - 1); }
      if (!w) { ctx.moveTo(X + 1, Y + (n ? 0 : r)); ctx.lineTo(X + 1, Y + TILE - (s ? 0 : r)); }
      if (!e) { ctx.moveTo(X + TILE - 1, Y + (n ? 0 : r)); ctx.lineTo(X + TILE - 1, Y + TILE - (s ? 0 : r)); }
      ctx.stroke();
      if (kind === PATH && hash(x, y, 13) < 0.5) {
        ctx.fillStyle = C.pebble;
        ctx.beginPath();
        ctx.ellipse(X + 6 + hash(x, y, 14) * 20, Y + 6 + hash(x, y, 15) * 20, 2.5, 1.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  // The pond deepens toward its middle.
  const px = POND.x * TILE;
  const py = POND.y * TILE;
  const deep = ctx.createRadialGradient(px + (POND.w * TILE) / 2, py + (POND.h * TILE) / 2, 4, px + (POND.w * TILE) / 2, py + (POND.h * TILE) / 2, (POND.w * TILE) / 2);
  deep.addColorStop(0, C.waterDeep);
  deep.addColorStop(1, 'rgba(99,180,218,0)');
  ctx.fillStyle = deep;
  roundRect(ctx, px + 6, py + 6, POND.w * TILE - 12, POND.h * TILE - 12, 18);
  ctx.fill();
  // Reeds and a lily pad.
  for (const [rx, ry] of [[px + 8, py + POND.h * TILE - 6], [px + 14, py + POND.h * TILE - 4], [px + POND.w * TILE - 10, py + 10]]) {
    ctx.strokeStyle = '#4f8f45';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 2, ry - 14); ctx.moveTo(rx + 3, ry); ctx.lineTo(rx + 4, ry - 11); ctx.stroke();
  }
  ctx.fillStyle = '#6fbf5e';
  ctx.beginPath(); ctx.arc(px + POND.w * TILE * 0.68, py + POND.h * TILE * 0.62, 7, 0.4, Math.PI * 2 - 0.1); ctx.lineTo(px + POND.w * TILE * 0.68, py + POND.h * TILE * 0.62); ctx.fill();
  ctx.fillStyle = '#ffb3c7';
  ctx.beginPath(); ctx.arc(px + POND.w * TILE * 0.68 - 2, py + POND.h * TILE * 0.62 - 2, 2.5, 0, Math.PI * 2); ctx.fill();
  const petals = ['#ffffff', '#ffd1e0', '#ffe27a', '#d9c9ff'];
  for (const f of flowers) {
    const cx = f.x * TILE + 8 + f.v * 16;
    const cy = f.y * TILE + 10 + hash(f.x, f.y, 7) * 12;
    ctx.fillStyle = petals[Math.floor(f.v * petals.length)];
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * 2.6, cy + Math.sin(a) * 2.6, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#f4b23c';
    ctx.beginPath();
    ctx.arc(cx, cy, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  // Maple's carrot patch.
  for (let i = 0; i < 6; i++) {
    const cx = 34.5 * TILE + (i % 3) * 10;
    const cy = 18 * TILE + Math.floor(i / 3) * 14;
    ctx.fillStyle = '#9a6b45';
    roundRect(ctx, cx - 5, cy - 2, 10, 8, 3); ctx.fill();
    ctx.fillStyle = '#5aa64a';
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx - 3, cy - 7); ctx.lineTo(cx + 3, cy - 7); ctx.fill();
  }
}

/** Ripples on the pond, redrawn every frame. */
export function drawWater(ctx, t) {
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    const x = (POND.x + 0.8 + hash(i, 1, 20) * (POND.w - 1.6)) * TILE;
    const y = (POND.y + 0.8 + hash(i, 2, 20) * (POND.h - 1.6)) * TILE;
    const p = (t * 0.5 + hash(i, 3, 20)) % 1;
    ctx.globalAlpha = 1 - p;
    ctx.beginPath();
    ctx.ellipse(x, y, 4 + p * 10, 2 + p * 4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

export function drawTree(ctx, tree, t) {
  const cx = (tree.x + 0.5) * TILE;
  const by = (tree.y + 1) * TILE - 3;
  const sway = Math.sin(t * 1.3 + tree.v * 9) * 0.8;
  ctx.fillStyle = 'rgba(40,70,30,0.22)';
  ctx.beginPath(); ctx.ellipse(cx, by, 14, 5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = C.trunk;
  roundRect(ctx, cx - 4, by - 15, 8, 14, 2); ctx.fill();
  const r = 12 + tree.v * 3;
  const blob = (x, y, rr, fill) => {
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.arc(cx + x + sway, by + y, rr, 0, Math.PI * 2); ctx.fill();
  };
  blob(0, -26, r + 2.5, C.canopyDark);
  blob(-7, -22, r * 0.78, C.canopy);
  blob(7, -22, r * 0.78, C.canopy);
  blob(0, -30, r * 0.85, C.canopyLight);
  blob(-4, -34, r * 0.4, C.canopyShine);
  if (tree.v > 0.62) {
    ctx.fillStyle = tree.v > 0.82 ? '#e8574a' : '#f29b38';
    for (const [x, y] of [[-6, -22], [6, -27], [1, -18]]) blob(x, y, 2.4, ctx.fillStyle);
  }
}

export function drawLamp(ctx, lamp, night) {
  const cx = (lamp.x + 0.5) * TILE;
  const by = (lamp.y + 1) * TILE - 6;
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath(); ctx.ellipse(cx, by, 6, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#4b4a55';
  ctx.fillRect(cx - 1.5, by - 30, 3, 30);
  roundRect(ctx, cx - 5, by - 4, 10, 4, 2); ctx.fill();
  ctx.fillStyle = night ? '#ffe28a' : '#fff6d6';
  ctx.strokeStyle = '#4b4a55';
  ctx.lineWidth = 2;
  roundRect(ctx, cx - 5, by - 40, 10, 11, 3); ctx.fill(); ctx.stroke();
}

export function drawBoard(ctx, t) {
  const cx = (BOARD.x + 0.5) * TILE;
  const by = (BOARD.y + 1) * TILE - 4;
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.beginPath(); ctx.ellipse(cx, by, 15, 4, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#8a5a3c';
  ctx.fillRect(cx - 12, by - 14, 3, 14);
  ctx.fillRect(cx + 9, by - 14, 3, 14);
  ctx.fillStyle = '#b77b4d';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  roundRect(ctx, cx - 16, by - 34, 32, 22, 3); ctx.fill(); ctx.stroke();
  const papers = ['#fffaf0', '#ffe7a8', '#d6ecff'];
  for (let i = 0; i < 3; i++) {
    ctx.fillStyle = papers[i];
    ctx.save();
    ctx.translate(cx - 9 + i * 9, by - 24);
    ctx.rotate((i - 1) * 0.08 + Math.sin(t * 2 + i) * 0.02);
    ctx.fillRect(-3.5, -6, 7, 10);
    ctx.restore();
  }
}

/** A building in three-quarter view: walls, windows, a door, a roof and its sign. */
export function drawBuilding(ctx, b, t, night) {
  const X = b.x * TILE;
  const Y = b.y * TILE;
  const W = b.w * TILE;
  const H = b.h * TILE;
  const wallTop = Y + H * 0.42;
  const ground = Y + H;
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;

  ctx.fillStyle = 'rgba(40,60,30,0.22)';
  roundRect(ctx, X - 2, ground - 8, W + 6, 14, 7); ctx.fill();

  // Walls and foundation.
  ctx.fillStyle = b.wall;
  roundRect(ctx, X + 3, wallTop, W - 6, ground - wallTop, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = 'rgba(120,90,60,0.25)';
  ctx.fillRect(X + 4, ground - 7, W - 8, 6);
  if (b.kind === 'house' || b.kind === 'shop') {
    ctx.strokeStyle = 'rgba(140,105,70,0.18)';
    ctx.lineWidth = 1;
    for (let y = wallTop + 8; y < ground - 8; y += 8) {
      ctx.beginPath(); ctx.moveTo(X + 5, y); ctx.lineTo(X + W - 5, y); ctx.stroke();
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = OUTLINE;
  }

  // Door.
  const doorX = b.door * TILE;
  const doorW = b.doorW * TILE;
  const dW = b.doorW > 1 ? doorW - 14 : 20;
  const dX = doorX + (doorW - dW) / 2;
  const dH = 30;
  ctx.fillStyle = b.kind === 'hall' ? '#7a4a30' : '#9a6440';
  ctx.beginPath();
  ctx.moveTo(dX, ground - 2);
  ctx.lineTo(dX, ground - dH + dW / 2);
  ctx.arc(dX + dW / 2, ground - dH + dW / 2, dW / 2, Math.PI, 0);
  ctx.lineTo(dX + dW, ground - 2);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  if (b.doorW > 1) {
    ctx.beginPath(); ctx.moveTo(dX + dW / 2, ground - dH + 2); ctx.lineTo(dX + dW / 2, ground - 2); ctx.stroke();
  }
  ctx.fillStyle = '#f4c95d';
  ctx.beginPath(); ctx.arc(dX + dW - 5, ground - 13, 1.8, 0, Math.PI * 2); ctx.fill();

  // Windows on either side of the door.
  const glass = night ? '#ffd877' : '#bfe4f5';
  const winY = wallTop + (ground - wallTop) * 0.3;
  const winH = 15;
  const winW = 17;
  const slots = [];
  const left = dX - X;
  const right = X + W - (dX + dW);
  for (let wx = X + 12; wx + winW <= dX - 8; wx += winW + 12) slots.push(wx);
  for (let wx = dX + dW + 10; wx + winW <= X + W - 10; wx += winW + 12) slots.push(wx);
  if (!slots.length && left > 30) slots.push(X + (left - winW) / 2);
  if (slots.length < 2 && right > 30) slots.push(dX + dW + (right - winW) / 2);
  for (const wx of slots) {
    ctx.fillStyle = glass;
    roundRect(ctx, wx, winY, winW, winH, 3); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#fffaf0';
    ctx.beginPath(); ctx.moveTo(wx + winW / 2, winY + 2); ctx.lineTo(wx + winW / 2, winY + winH - 2); ctx.moveTo(wx + 2, winY + winH / 2); ctx.lineTo(wx + winW - 2, winY + winH / 2); ctx.stroke();
    ctx.strokeStyle = OUTLINE;
    if (b.kind !== 'hall') {
      ctx.fillStyle = '#6aa64f';
      roundRect(ctx, wx - 2, winY + winH + 2, winW + 4, 5, 2); ctx.fill();
      ctx.fillStyle = ['#ff8fab', '#ffd166', '#ffffff'][Math.floor(hash(b.x, Math.round(wx), 4) * 3)];
      for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(wx + 3 + i * 6, winY + winH + 2, 2, 0, Math.PI * 2); ctx.fill(); }
    }
  }

  // Shop awning.
  if (b.kind === 'shop') {
    const aY = wallTop + 2;
    const stripes = 8;
    const sw = (W - 4) / stripes;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? '#fffaf0' : b.roof;
      ctx.beginPath();
      ctx.moveTo(X + 2 + i * sw, aY);
      ctx.lineTo(X + 2 + (i + 1) * sw, aY);
      ctx.lineTo(X + 2 + (i + 1) * sw, aY + 9);
      ctx.arc(X + 2 + (i + 0.5) * sw, aY + 9, sw / 2, 0, Math.PI);
      ctx.closePath();
      ctx.fill();
    }
    ctx.beginPath(); ctx.moveTo(X + 2, aY); ctx.lineTo(X + W - 2, aY); ctx.stroke();
  }

  // Roof.
  const roofBottom = wallTop + (b.kind === 'shop' ? 2 : 6);
  const over = 7;
  const roofTop = Y + (b.kind === 'hall' ? 14 : 8);
  ctx.fillStyle = b.roof;
  ctx.beginPath();
  ctx.moveTo(X - over, roofBottom);
  ctx.lineTo(X + 12, roofTop);
  ctx.lineTo(X + W - 12, roofTop);
  ctx.lineTo(X + W + over, roofBottom);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(0,0,0,0.13)';
  ctx.lineWidth = 2;
  for (let y = roofTop + 8; y < roofBottom; y += 8) {
    ctx.beginPath(); ctx.moveTo(X - over, y); ctx.lineTo(X + W + over, y); ctx.stroke();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(X, roofTop, W, 4);
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;

  if (b.kind === 'house') {
    const cx = X + W - 26;
    ctx.fillStyle = '#b5654a';
    ctx.fillRect(cx, roofTop - 12, 10, 18);
    ctx.strokeRect(cx, roofTop - 12, 10, 18);
    for (let i = 0; i < 3; i++) {
      const p = (t * 0.35 + i / 3) % 1;
      ctx.fillStyle = `rgba(255,255,255,${0.55 * (1 - p)})`;
      ctx.beginPath(); ctx.arc(cx + 5 + Math.sin(p * 6 + i) * 4, roofTop - 16 - p * 26, 3 + p * 5, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (b.kind === 'hall') {
    const cx = X + W / 2;
    ctx.fillStyle = '#fffaf0';
    ctx.beginPath(); ctx.arc(cx, roofTop + 24, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, roofTop + 24); ctx.lineTo(cx, roofTop + 17); ctx.moveTo(cx, roofTop + 24); ctx.lineTo(cx + 5, roofTop + 26); ctx.stroke();
    ctx.fillStyle = '#5a4636';
    ctx.fillRect(cx - 1, roofTop - 30, 2, 31);
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.moveTo(cx + 1, roofTop - 30);
    for (let i = 0; i <= 6; i++) ctx.lineTo(cx + 1 + i * 3.5, roofTop - 30 + Math.sin(t * 4 + i * 0.8) * 1.6 + (i === 0 ? 0 : 0));
    for (let i = 6; i >= 0; i--) ctx.lineTo(cx + 1 + i * 3.5, roofTop - 19 + Math.sin(t * 4 + i * 0.8) * 1.6);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#efe3c8';
    for (const px of [dX - 12, dX + dW + 6]) { ctx.fillRect(px, wallTop + 6, 6, ground - wallTop - 8); ctx.strokeRect(px, wallTop + 6, 6, ground - wallTop - 8); }
  }

  // Sign above the door.
  ctx.font = '700 9px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  const label = b.name;
  const tw = ctx.measureText(label).width + 12;
  const sx = dX + dW / 2 - tw / 2;
  const sy = ground - dH - 16;
  ctx.fillStyle = '#fff6df';
  roundRect(ctx, sx, sy, tw, 13, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#5a4636';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, dX + dW / 2, sy + 7);

  if (b.id === 'home') {
    const mx = X + W + 6;
    ctx.fillStyle = '#5a4636';
    ctx.fillRect(mx + 4, ground - 16, 3, 16);
    ctx.fillStyle = '#e07a8a';
    roundRect(ctx, mx - 2, ground - 26, 15, 11, 4); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '8px system-ui';
    ctx.fillText('♥', mx + 5.5, ground - 20);
  }
}

/** The key tag on the lower street. */
export function drawKey(ctx, t) {
  const cx = (KEY_SPOT.x + 0.5) * TILE;
  const cy = (KEY_SPOT.y + 0.5) * TILE;
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.beginPath(); ctx.ellipse(cx, cy + 6, 7, 2.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.save();
  ctx.translate(cx, cy + Math.sin(t * 3) * 1.5);
  ctx.strokeStyle = '#a77a1b';
  ctx.fillStyle = '#f2c94c';
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(-4, 0, 4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillRect(-1, -1.5, 10, 3); ctx.strokeRect(-1, -1.5, 10, 3);
  ctx.fillRect(6, 1.5, 2, 3);
  ctx.restore();
  const p = (t * 0.8) % 1;
  ctx.fillStyle = `rgba(255,255,255,${1 - p})`;
  const sx = cx + 8;
  const sy = cy - 10 - p * 6;
  ctx.beginPath();
  ctx.moveTo(sx, sy - 4); ctx.lineTo(sx + 1.2, sy - 1.2); ctx.lineTo(sx + 4, sy); ctx.lineTo(sx + 1.2, sy + 1.2);
  ctx.lineTo(sx, sy + 4); ctx.lineTo(sx - 1.2, sy + 1.2); ctx.lineTo(sx - 4, sy); ctx.lineTo(sx - 1.2, sy - 1.2);
  ctx.fill();
}

/**
 * An agent: a round little creature with an antenna. `look` sets its colors;
 * `badge` draws the ID card it presents; `mask` is for night visitors.
 */
export function drawAgent(ctx, a, t) {
  const look = a.look;
  const s = look.scale ?? 1;
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.scale(s, s);
  if (a.alpha !== undefined) ctx.globalAlpha = a.alpha;
  const walking = a.walking;
  const bob = walking ? Math.abs(Math.sin(a.phase)) * 2 : Math.sin(t * 2.2 + (a.seed ?? 0)) * 0.6;
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.ellipse(0, 0, 10, 3.5, 0, 0, Math.PI * 2); ctx.fill();

  const step = walking ? Math.sin(a.phase) * 2.5 : 0;
  ctx.fillStyle = look.feet ?? '#6b5444';
  ctx.beginPath(); ctx.ellipse(-5, -2 + Math.min(0, step), 4, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(5, -2 + Math.min(0, -step), 4, 3, 0, 0, Math.PI * 2); ctx.fill();

  const by = -15 - bob;
  ctx.fillStyle = look.body;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, by, 12, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (look.hood) {
    ctx.fillStyle = look.hood;
    ctx.beginPath(); ctx.moveTo(-12, by); ctx.quadraticCurveTo(0, by - 24, 12, by); ctx.quadraticCurveTo(0, by - 8, -12, by); ctx.fill(); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(0, by - 13); ctx.lineTo(0, by - 21); ctx.stroke();
    if (look.bulb) {
      ctx.fillStyle = look.bulb;
      ctx.shadowColor = look.bulb;
      ctx.shadowBlur = look.glow ? 8 : 0;
      ctx.beginPath(); ctx.arc(0, by - 23, 3.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  const fx = a.facing?.x ?? 0;
  const fy = a.facing?.y ?? 1;
  if (fy >= 0 || Math.abs(fx) > 0.3) {
    const ex = fx * 3.5;
    const ey = by - 2 + Math.max(0, fy) * 1.5;
    if (look.mask) {
      ctx.fillStyle = '#2b2233';
      roundRect(ctx, -11 + ex * 0.6, ey - 4, 22, 7, 3); ctx.fill();
    }
    ctx.fillStyle = look.eyes ?? '#3a2c2c';
    for (const dx of [-4.5, 4.5]) {
      ctx.beginPath(); ctx.ellipse(ex + dx, ey, 1.8, 2.6, 0, 0, Math.PI * 2); ctx.fill();
    }
    if (!look.mask && !look.hood) {
      ctx.fillStyle = 'rgba(255,140,150,0.45)';
      for (const dx of [-8, 8]) { ctx.beginPath(); ctx.ellipse(ex + dx, ey + 4, 2.6, 1.6, 0, 0, Math.PI * 2); ctx.fill(); }
    }
    if (look.badge === 'on') {
      ctx.fillStyle = look.badgeColor ?? '#ffe08a';
      roundRect(ctx, ex * 0.4 - 5, by + 4, 10, 7, 2); ctx.fill();
      ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = look.badgeMark ?? '#3f9b5c';
      ctx.fillRect(ex * 0.4 - 3, by + 6, 6, 1.6);
      ctx.fillRect(ex * 0.4 - 3, by + 8.5, 4, 1.2);
    }
  }
  ctx.restore();
  if (a.label) {
    ctx.font = '700 9px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(a.label).width + 10;
    const ly = a.y - 46 * s;
    ctx.fillStyle = 'rgba(255,250,240,0.92)';
    roundRect(ctx, a.x - w / 2, ly - 7, w, 13, 6); ctx.fill();
    ctx.fillStyle = '#5a4636';
    ctx.fillText(a.label, a.x, ly);
  }
}

/** A speech bubble above someone: an icon and an optional short line. */
export function drawBubble(ctx, x, y, text, tone, age) {
  const rise = Math.min(age, 0.3) * 20;
  ctx.font = '700 10px ui-rounded, "SF Pro Rounded", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = Math.max(24, ctx.measureText(text).width + 14);
  const by = y - 60 - rise;
  const colors = { ok: '#3f9b5c', bad: '#c8524a', warn: '#c98a1b', info: '#5a4636' };
  ctx.fillStyle = '#fffaf0';
  ctx.strokeStyle = colors[tone] ?? colors.info;
  ctx.lineWidth = 2;
  roundRect(ctx, x - w / 2, by - 10, w, 20, 10); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(x - 4, by + 10); ctx.lineTo(x, by + 15); ctx.lineTo(x + 4, by + 10); ctx.fill();
  ctx.fillStyle = colors[tone] ?? colors.info;
  ctx.fillText(text, x, by + 1);
}

/** Evening light: darken the town, then let windows and lamps glow. */
export function drawNight(ctx, town, amount, view) {
  if (amount <= 0) return;
  ctx.fillStyle = `rgba(20,24,64,${0.58 * amount})`;
  ctx.fillRect(view.x, view.y, view.w, view.h);
  ctx.globalCompositeOperation = 'lighter';
  const glow = (x, y, r, a) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,214,120,${a * amount})`);
    g.addColorStop(1, 'rgba(255,214,120,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };
  for (const l of town.lamps) glow((l.x + 0.5) * TILE, (l.y + 1) * TILE - 40, 46, 0.35);
  for (const b of town.buildings) glow((b.door + b.doorW / 2) * TILE, (b.y + b.h) * TILE - 18, 34, 0.25);
  ctx.globalCompositeOperation = 'source-over';
}
