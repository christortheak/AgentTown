// The town's layout and everything drawn on the canvas. All coordinates are
// world pixels; one tile is TILE pixels. Nothing here touches the DOM at load
// time, so the server imports it too (to know how far apart places are).
export const TILE = 32;
export const COLS = 76;
export const ROWS = 52;

export const GRASS = 0;
export const PATH = 1;
export const WATER = 2;
export const PLAZA = 3;
export const BRIDGE = 4;
export const QUAY = 5;
export const DIRT = 6;
const EDGE = -1; // beyond the map: counts as "more of the same", so roads and the river run off the edge
const ROAD = new Set([PATH, PLAZA, BRIDGE, QUAY, DIRT]);

/** Deterministic 0..1 noise for a tile, so the town looks the same every visit. */
export const hash = (x, y, seed = 0) => {
  let h = Math.imul(x + 1013, 374761393) ^ Math.imul(y + 2029, 668265263) ^ Math.imul(seed + 7, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

const tilePx = (x, y) => ({ x: (x + 0.5) * TILE, y: (y + 0.6) * TILE });

export const BUILDINGS = [
  // Civic Row
  { id: 'records', name: 'Records Office', district: 'civic', x: 22, y: 6, w: 7, h: 5, door: 25, roof: '#4f7fbf', wall: '#f6ead2', kind: 'office' },
  { id: 'townhall', name: 'Town Hall', district: 'civic', x: 33, y: 4, w: 10, h: 7, door: 37, doorW: 2, roof: '#c8524a', wall: '#fbf1dc', kind: 'hall' },
  { id: 'court', name: 'Courthouse', district: 'civic', x: 47, y: 5, w: 8, h: 6, door: 50, doorW: 2, roof: '#ddd5c4', wall: '#f1ece0', kind: 'court' },
  { id: 'exchange', name: 'Thistle Exchange', district: 'civic', x: 3, y: 4, w: 8, h: 6, door: 6, doorW: 2, roof: '#3d5a80', wall: '#efe9dc', kind: 'bank' },
  { id: 'police', name: 'Police Station', district: 'civic', x: 13, y: 5, w: 6, h: 5, door: 15, roof: '#2c3e66', wall: '#e8edf5', kind: 'office' },
  // Market Lane
  { id: 'bramble', name: 'Bramble Books', district: 'market', x: 4, y: 18, w: 5, h: 5, door: 6, roof: '#7a5aa6', wall: '#f3e7d3', kind: 'shop' },
  { id: 'kettle', name: 'Copper Kettle', district: 'market', x: 10, y: 18, w: 5, h: 5, door: 12, roof: '#d9822b', wall: '#fbeedb', kind: 'shop' },
  { id: 'bank', name: 'First Ledger Bank', district: 'market', x: 16, y: 17, w: 7, h: 6, door: 19, roof: '#5c6b7a', wall: '#ebe4d6', kind: 'bank' },
  { id: 'bakery', name: 'Oakleaf Bakery', district: 'market', x: 24, y: 18, w: 5, h: 5, door: 26, roof: '#b5723f', wall: '#fff1dc', kind: 'shop' },
  // Hearthside
  { id: 'home', name: 'Your house', district: 'residential', x: 47, y: 18, w: 5, h: 5, door: 49, roof: '#e07a8a', wall: '#fff3e0', kind: 'house' },
  { id: 'maple', name: "Maple's", district: 'residential', x: 54, y: 18, w: 5, h: 5, door: 56, roof: '#6aa35a', wall: '#fbf3df', kind: 'house' },
  { id: 'hazel', name: "Hazel's", district: 'residential', x: 61, y: 18, w: 5, h: 5, door: 63, roof: '#e2a33d', wall: '#fff6e6', kind: 'house' },
  { id: 'ivy', name: "Ivy's", district: 'residential', x: 68, y: 18, w: 5, h: 5, door: 70, roof: '#4fa3a0', wall: '#f7f1e3', kind: 'house' },
  // The Works
  { id: 'forge', name: 'Compute Forge', district: 'works', x: 60, y: 5, w: 7, h: 6, door: 63, roof: '#5b4b4b', wall: '#b5654a', kind: 'forge' },
  { id: 'lab', name: 'Wren Labs', district: 'works', x: 68, y: 6, w: 5, h: 5, door: 70, roof: '#2f8f7a', wall: '#eef3ee', kind: 'office' },
  // The Harbor (EU)
  { id: 'harbor', name: 'Harbor Registry', district: 'harbor', x: 29, y: 41, w: 7, h: 6, door: 32, roof: '#2f5fb3', wall: '#f4f1e8', kind: 'harbor' },
  { id: 'cafe', name: 'Café Lumière', district: 'harbor', x: 40, y: 42, w: 6, h: 5, door: 42, roof: '#c45c48', wall: '#fbf0de', kind: 'cafe' },
  { id: 'rook', name: 'Rook & Daughters', district: 'harbor', x: 48, y: 42, w: 5, h: 5, door: 50, roof: '#8b6f4e', wall: '#f5ead6', kind: 'house' },
  // The Wilds
  { id: 'mill', name: 'The Old Mill', district: 'wilds', x: 4, y: 29, w: 6, h: 6, door: 6, roof: '#6d4f3a', wall: '#cfc6b5', kind: 'mill' },
  // Small structures
  { id: 'fair', name: 'Harvest Fair', district: 'square', x: 40, y: 26, w: 3, h: 2, door: 41, roof: '#d94f45', wall: '#fffaf0', kind: 'stall' },
  { id: 'toll', name: 'Bridge Toll', district: 'harbor', x: 39, y: 34, w: 2, h: 2, door: 39, doorW: 2, roof: '#2f5fb3', wall: '#f4efe4', kind: 'toll' },
  { id: 'orb', name: 'Orb Kiosk', district: 'civic', x: 30, y: 9, w: 2, h: 2, door: 30, doorW: 2, roof: '#c9d3dc', wall: '#eef2f6', kind: 'kiosk' },
];

export const DISTRICTS = [
  { id: 'square', name: 'Town Square', x: 38, y: 29.5 },
  { id: 'civic', name: 'Civic Row', x: 38, y: 2.6 },
  { id: 'market', name: 'Market Lane', x: 15, y: 15.6 },
  { id: 'residential', name: 'Hearthside', x: 59, y: 15.6 },
  { id: 'works', name: 'The Works', x: 66, y: 3.2 },
  { id: 'harbor', name: 'The Harbor (EU)', x: 40, y: 49.4 },
  { id: 'wilds', name: 'The Wilds', x: 10, y: 27 },
];

export const FOUNTAIN = { x: 37, y: 23 };
export const BOARD = { x: 34, y: 22 };
export const KEY_SPOT = { x: 60, y: 24 };
export const POND = { x: 50, y: 28, w: 6, h: 4 };

export const SPOTS = {
  spawn: { x: 38 * TILE, y: 26.6 * TILE },
  square: tilePx(42, 21),
  eastGate: tilePx(74, 24),
  millGate: tilePx(9, 35),
  bridge: { x: 38 * TILE, y: 38.6 * TILE },
  burglarStart: tilePx(58, 25),
  wildsEdge: tilePx(13, 28),
};
export const SPAWN = SPOTS.spawn;
export const BURGLAR_START = SPOTS.burglarStart;

const RIVER = { y: 37, h: 3 };
const BRIDGES = [20, 37]; // left column of each two-tile bridge
const WILDS = { x0: 2, y0: 26, x1: 19, y1: 36 };
const PARK = { x0: 46, y0: 26, x1: 72, y1: 35 };
const CARROTS = { x: 59, y: 20, w: 2, h: 2 };
const BOAT = { x: 26, y: 39 };
const LAMPS = [
  // along the main road
  [5, 26], [11, 26], [17, 26], [25, 26], [29, 26], [47, 26], [53, 26], [59, 26], [65, 26], [71, 26],
  // Civic Row
  [5, 14], [11, 14], [17, 14], [23, 14], [28, 14], [34, 14], [42, 14], [48, 14], [55, 14], [61, 14], [67, 14], [72, 14],
  // the square's corners
  [32, 20], [44, 20], [32, 28], [44, 28],
  // the harbor
  [23, 49], [28, 49], [34, 49], [43, 49], [47, 49], [54, 49],
];

export function buildTown() {
  const ground = Array.from({ length: ROWS }, () => new Array(COLS).fill(GRASS));
  const solid = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  const fill = (kind, x0, y0, x1, y1) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) ground[y][x] = kind;
  };

  // The river and its two bridges.
  fill(WATER, 0, RIVER.y, COLS - 1, RIVER.y + RIVER.h - 1);
  for (const bx of BRIDGES) fill(BRIDGE, bx, RIVER.y, bx + 1, RIVER.y + RIVER.h - 1);
  fill(WATER, POND.x, POND.y, POND.x + POND.w - 1, POND.y + POND.h - 1);

  // Roads.
  fill(PATH, 2, 24, COLS - 1, 25); // the main road, leaving by the east gate
  fill(PATH, 4, 12, 72, 13); // Civic Row, from the Exchange to the Works
  fill(PATH, 6, 10, 7, 11); // up to the Exchange
  fill(PATH, 15, 10, 15, 11); // up to the Police Station
  fill(PATH, 37, 11, 38, 19); // the avenue, north of the square
  fill(PATH, 30, 14, 30, 23); // lane to Market Lane
  fill(PATH, 45, 14, 45, 23); // lane to Hearthside
  fill(PATH, 37, 29, 38, RIVER.y - 1); // the avenue, south to the main bridge
  fill(PATH, 20, 26, 21, RIVER.y - 1); // the west lane to the old bridge
  fill(QUAY, 22, RIVER.y + RIVER.h, 58, RIVER.y + RIVER.h);
  fill(PATH, 20, RIVER.y + RIVER.h, 21, 46);
  fill(PATH, 37, RIVER.y + RIVER.h + 1, 38, 46);
  fill(PATH, 20, 47, 56, 48); // the harbor street
  fill(PLAZA, 32, 20, 44, 28); // Town Square
  fill(DIRT, 13, 26, 13, 35); // the mill track
  fill(DIRT, 6, 35, 19, 35);

  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) if (ground[y][x] === WATER) solid[y][x] = true;

  const buildings = BUILDINGS.map((b) => {
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) solid[y][x] = true;
    const doorW = b.doorW ?? 1;
    for (let i = 0; i < doorW; i++) {
      const fy = b.y + b.h;
      if (!ROAD.has(ground[fy][b.door + i])) ground[fy][b.door + i] = b.kind === 'mill' ? DIRT : PATH;
    }
    return { ...b, doorW, front: { x: (b.door + doorW / 2) * TILE, y: (b.y + b.h + 0.55) * TILE } };
  });
  for (let y = FOUNTAIN.y; y < FOUNTAIN.y + 2; y++) for (let x = FOUNTAIN.x; x < FOUNTAIN.x + 2; x++) solid[y][x] = true;
  solid[BOARD.y][BOARD.x] = true;
  const lamps = LAMPS.map(([x, y]) => {
    solid[y][x] = true;
    return { x, y };
  });

  // Trees: a border all round, a scattering wherever they would not crowd a
  // road or a door, and a thicket in the Wilds.
  const trees = [];
  const treeAt = new Uint8Array(COLS * ROWS);
  const inWilds = (x, y) => x >= WILDS.x0 && x <= WILDS.x1 && y >= WILDS.y0 && y <= WILDS.y1;
  const near = (x, y, test) => {
    for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
      const a = x + i;
      const b = y + j;
      if ((i || j) && a >= 0 && b >= 0 && a < COLS && b < ROWS && test(a, b)) return true;
    }
    return false;
  };
  const plant = (x, y) => {
    trees.push({ x, y, v: hash(x, y, 2) });
    treeAt[y * COLS + x] = 1;
    solid[y][x] = true;
  };
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const border = x < 2 || y < 2 || x >= COLS - 2 || y >= ROWS - 2;
    if (border) {
      if (ground[y][x] !== GRASS) continue;
      if (hash(x, y, 1) < 0.86) plant(x, y);
      solid[y][x] = true;
      continue;
    }
    if (ground[y][x] !== GRASS || solid[y][x]) continue;
    const wild = inWilds(x, y);
    // In the Wilds trees may crowd each other and the dirt track (never a road or a building).
    const crowded = near(x, y, (a, b) => (ground[b][a] !== GRASS && !(wild && ground[b][a] === DIRT)) || (solid[b][a] && !treeAt[b * COLS + a]) || (!wild && treeAt[b * COLS + a]))
      || Math.hypot(x - 38, y - 26) < 7;
    const park = x >= PARK.x0 && x <= PARK.x1 && y >= PARK.y0 && y <= PARK.y1;
    const chance = wild ? 0.62 : park ? 0.1 : 0.16;
    if (!crowded && hash(x, y, 3) < chance) plant(x, y);
  }

  const flowers = [];
  for (let y = 2; y < ROWS - 2; y++) for (let x = 2; x < COLS - 2; x++) {
    const park = x >= PARK.x0 && x <= PARK.x1 && y >= PARK.y0 && y <= PARK.y1;
    if (ground[y][x] === GRASS && !solid[y][x] && hash(x, y, 5) < (park ? 0.2 : inWilds(x, y) ? 0.04 : 0.08)) flowers.push({ x, y, v: hash(x, y, 6) });
  }

  const walk = new Uint8Array(COLS * ROWS);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) walk[y * COLS + x] = solid[y][x] ? 0 : 1;
  return { ground, solid, walk, buildings, lamps, trees, flowers };
}

export const isWalkable = (town, tx, ty) => tx >= 0 && ty >= 0 && tx < COLS && ty < ROWS && !town.solid[ty][tx];

let prevBuf = null;
let queueBuf = null;

/** Breadth-first path over walkable tiles, as tile centers in world pixels (deterministic). */
export function findPath(town, from, to) {
  if (!isWalkable(town, to.x, to.y)) return null;
  if (from.x < 0 || from.y < 0 || from.x >= COLS || from.y >= ROWS) return null;
  const n = COLS * ROWS;
  if (!prevBuf) {
    prevBuf = new Int32Array(n);
    queueBuf = new Int32Array(n);
  }
  const prev = prevBuf.fill(-1);
  const queue = queueBuf;
  const walk = town.walk ?? Uint8Array.from({ length: n }, (_, i) => (town.solid[Math.floor(i / COLS)][i % COLS] ? 0 : 1));
  const start = from.y * COLS + from.x;
  const goal = to.y * COLS + to.x;
  let head = 0;
  let tail = 0;
  queue[tail++] = start;
  prev[start] = start;
  while (head < tail) {
    const c = queue[head++];
    if (c === goal) break;
    const cx = c % COLS;
    const visit = (m) => {
      if (prev[m] === -1 && walk[m]) {
        prev[m] = c;
        queue[tail++] = m;
      }
    };
    if (cx + 1 < COLS) visit(c + 1);
    if (cx > 0) visit(c - 1);
    if (c + COLS < n) visit(c + COLS);
    if (c - COLS >= 0) visit(c - COLS);
  }
  if (prev[goal] === -1) return null;
  const path = [];
  for (let c = goal; c !== start; c = prev[c]) path.push({ x: ((c % COLS) + 0.5) * TILE, y: (Math.floor(c / COLS) + 0.6) * TILE });
  return path.reverse();
}

/** A building's front door, or one of the named SPOTS. */
export function placeFront(town, id) {
  return town.buildings.find((b) => b.id === id)?.front ?? SPOTS[id] ?? null;
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------

const OUTLINE = '#5a4636';
const C = {
  grass: ['#9fd46c', '#97cd65', '#a8da75'], tuft: '#7fb954',
  path: '#ecd9a8', pathEdge: '#d6bd86', pebble: '#d9c493',
  plaza: '#e9e0cf', plazaStone: ['#e4d9c5', '#ede5d6', '#e0d4bf'], plazaGrout: '#d4c7ae', plazaEdge: '#cdbf9f',
  dirt: '#d4b27c', dirtEdge: '#b8945c', dirtSpeck: '#bf9a62',
  quay: '#d3ccc0', quayLine: '#b9b1a3', quayEdge: '#9d9488',
  water: '#7cc8e8', waterEdge: '#bfe7f4', waterDeep: '#5fb0d8',
  deck: '#c99a63', deckLine: '#a87b47', rail: '#8a5a3c',
  canopyDark: '#3f8146', canopy: '#4f9a4f', canopyLight: '#68b55c', canopyShine: '#86cc72', trunk: '#8a5a3c',
};
const FONT = 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const inPond = (x, y) => x >= POND.x && x < POND.x + POND.w && y >= POND.y && y < POND.y + POND.h;
const intersects = (fx0, fy0, fx1, fy1, tx0, ty0, tx1, ty1) => fx0 < tx1 && fx1 > tx0 && fy0 < ty1 && fy1 > ty0;

/**
 * The ground for tiles [tx0, tx1) × [ty0, ty1): grass, roads, the river,
 * bridges, the square, flowers. Features wider than a tile are drawn whole
 * whenever they touch the range; the caller clips to its chunk.
 */
export function drawGround(ctx, town, tx0 = 0, ty0 = 0, tx1 = COLS, ty1 = ROWS) {
  const { ground } = town;
  tx0 = Math.max(0, tx0); ty0 = Math.max(0, ty0); tx1 = Math.min(COLS, tx1); ty1 = Math.min(ROWS, ty1);
  const at = (x, y) => (x < 0 || y < 0 || x >= COLS || y >= ROWS ? EDGE : ground[y][x]);

  for (let y = ty0; y < ty1; y++) for (let x = tx0; x < tx1; x++) {
    ctx.fillStyle = C.grass[Math.floor(hash(x, y, 9) * 3)];
    ctx.fillRect(x * TILE, y * TILE, TILE, TILE);
    if (ground[y][x] === GRASS && hash(x, y, 10) < 0.35) {
      ctx.strokeStyle = C.tuft;
      ctx.lineWidth = 1.5;
      const tx = x * TILE + 6 + hash(x, y, 11) * 18;
      const ty = y * TILE + 10 + hash(x, y, 12) * 14;
      ctx.beginPath();
      ctx.moveTo(tx - 3, ty - 4); ctx.lineTo(tx, ty); ctx.lineTo(tx + 3, ty - 4);
      ctx.stroke();
    }
  }

  for (let y = ty0; y < ty1; y++) for (let x = tx0; x < tx1; x++) {
    const kind = ground[y][x];
    if (kind === GRASS) continue;
    const X = x * TILE;
    const Y = y * TILE;
    const watery = (k) => k === WATER || k === BRIDGE || k === EDGE;
    const roady = (k) => ROAD.has(k) || k === EDGE;
    const same = kind === WATER ? watery : roady;
    const n = same(at(x, y - 1)); const s = same(at(x, y + 1)); const w = same(at(x - 1, y)); const e = same(at(x + 1, y));
    const r = 10;
    const shape = () => roundRect(ctx, X, Y, TILE, TILE, [!n && !w ? r : 0, !n && !e ? r : 0, !s && !e ? r : 0, !s && !w ? r : 0]);
    const edges = (color, width = 2) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      if (!n) { ctx.moveTo(X + (w ? 0 : r), Y + 1); ctx.lineTo(X + TILE - (e ? 0 : r), Y + 1); }
      if (!s) { ctx.moveTo(X + (w ? 0 : r), Y + TILE - 1); ctx.lineTo(X + TILE - (e ? 0 : r), Y + TILE - 1); }
      if (!w) { ctx.moveTo(X + 1, Y + (n ? 0 : r)); ctx.lineTo(X + 1, Y + TILE - (s ? 0 : r)); }
      if (!e) { ctx.moveTo(X + TILE - 1, Y + (n ? 0 : r)); ctx.lineTo(X + TILE - 1, Y + TILE - (s ? 0 : r)); }
      ctx.stroke();
    };
    const deepBand = () => {
      if (inPond(x, y)) return;
      const nw = watery(at(x, y - 1));
      const sw = watery(at(x, y + 1));
      if (!nw || !sw) return;
      const g = ctx.createLinearGradient(0, Y, 0, Y + TILE);
      g.addColorStop(0, C.water);
      g.addColorStop(0.5, C.waterDeep);
      g.addColorStop(1, C.water);
      ctx.fillStyle = g;
      ctx.fillRect(X, Y, TILE, TILE);
    };

    if (kind === WATER) {
      ctx.fillStyle = C.water;
      shape(); ctx.fill();
      deepBand();
      edges(C.waterEdge);
    } else if (kind === BRIDGE) {
      ctx.fillStyle = C.water;
      ctx.fillRect(X, Y, TILE, TILE);
      deepBand();
      const bw = at(x - 1, y) === BRIDGE;
      const be = at(x + 1, y) === BRIDGE;
      ctx.fillStyle = 'rgba(40,60,80,0.25)';
      ctx.fillRect(X + (bw ? 0 : 2), Y + 3, TILE - (bw ? 0 : 2) - (be ? 0 : 2), TILE);
      ctx.fillStyle = C.deck;
      ctx.fillRect(X + (bw ? 0 : 2), Y, TILE - (bw ? 0 : 2) - (be ? 0 : 2), TILE);
      ctx.strokeStyle = C.deckLine;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let py = Y + 3; py < Y + TILE; py += 6) { ctx.moveTo(X, py); ctx.lineTo(X + TILE, py); }
      ctx.stroke();
      ctx.fillStyle = C.rail;
      if (!bw) { ctx.fillRect(X, Y, 4, TILE); ctx.fillRect(X - 1, Y + 12, 6, 6); }
      if (!be) { ctx.fillRect(X + TILE - 4, Y, 4, TILE); ctx.fillRect(X + TILE - 5, Y + 12, 6, 6); }
    } else if (kind === PATH) {
      ctx.fillStyle = C.path;
      shape(); ctx.fill();
      edges(C.pathEdge);
      if (hash(x, y, 13) < 0.5) {
        ctx.fillStyle = C.pebble;
        ctx.beginPath();
        ctx.ellipse(X + 6 + hash(x, y, 14) * 20, Y + 6 + hash(x, y, 15) * 20, 2.5, 1.8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    } else if (kind === PLAZA) {
      ctx.fillStyle = C.plaza;
      shape(); ctx.fill();
      ctx.save();
      shape(); ctx.clip();
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        ctx.fillStyle = C.plazaStone[Math.floor(hash(x * 2 + i, y * 2 + j, 16) * 3)];
        ctx.fillRect(X + i * 16 + 1, Y + j * 16 + 1, 14, 14);
      }
      ctx.restore();
      edges(C.plazaEdge);
    } else if (kind === QUAY) {
      ctx.fillStyle = C.quay;
      ctx.fillRect(X, Y, TILE, TILE);
      ctx.strokeStyle = C.quayLine;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(X, Y + 16); ctx.lineTo(X + TILE, Y + 16);
      ctx.moveTo(X + (x % 2 ? 8 : 24), Y + 3); ctx.lineTo(X + (x % 2 ? 8 : 24), Y + 16);
      ctx.moveTo(X + (x % 2 ? 24 : 8), Y + 16); ctx.lineTo(X + (x % 2 ? 24 : 8), Y + TILE);
      ctx.stroke();
      if (watery(at(x, y - 1))) {
        ctx.fillStyle = C.quayEdge;
        ctx.fillRect(X, Y, TILE, 3);
      }
      if (x % 4 === 1 && watery(at(x, y - 1))) {
        ctx.fillStyle = '#6b5444';
        roundRect(ctx, X + 12, Y + 3, 8, 9, 3); ctx.fill();
      }
    } else if (kind === DIRT) {
      ctx.fillStyle = C.dirt;
      shape(); ctx.fill();
      edges(C.dirtEdge, 1.5);
      ctx.fillStyle = C.dirtSpeck;
      for (let i = 0; i < 3; i++) {
        ctx.beginPath();
        ctx.arc(X + 5 + hash(x, y, 30 + i) * 22, Y + 5 + hash(x, y, 40 + i) * 22, 1.4, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // The pond deepens toward its middle; reeds and a lily pad.
  if (intersects(POND.x - 1, POND.y - 1, POND.x + POND.w + 1, POND.y + POND.h + 1, tx0, ty0, tx1, ty1)) {
    const px = POND.x * TILE;
    const py = POND.y * TILE;
    const pw = POND.w * TILE;
    const ph = POND.h * TILE;
    const deep = ctx.createRadialGradient(px + pw / 2, py + ph / 2, 4, px + pw / 2, py + ph / 2, pw / 2);
    deep.addColorStop(0, C.waterDeep);
    deep.addColorStop(1, 'rgba(95,176,216,0)');
    ctx.fillStyle = deep;
    roundRect(ctx, px + 6, py + 6, pw - 12, ph - 12, 18);
    ctx.fill();
    ctx.strokeStyle = '#4f8f45';
    ctx.lineWidth = 2;
    for (const [rx, ry] of [[px + 8, py + ph - 6], [px + 14, py + ph - 4], [px + pw - 10, py + 10]]) {
      ctx.beginPath(); ctx.moveTo(rx, ry); ctx.lineTo(rx - 2, ry - 14); ctx.moveTo(rx + 3, ry); ctx.lineTo(rx + 4, ry - 11); ctx.stroke();
    }
    const lx = px + pw * 0.68;
    const ly = py + ph * 0.62;
    ctx.fillStyle = '#6fbf5e';
    ctx.beginPath(); ctx.arc(lx, ly, 7, 0.4, Math.PI * 2 - 0.1); ctx.lineTo(lx, ly); ctx.fill();
    ctx.fillStyle = '#ffb3c7';
    ctx.beginPath(); ctx.arc(lx - 2, ly - 2, 2.5, 0, Math.PI * 2); ctx.fill();
  }

  // A ring of darker paving round the fountain.
  const fcx = (FOUNTAIN.x + 1) * TILE;
  const fcy = (FOUNTAIN.y + 1) * TILE;
  if (intersects(FOUNTAIN.x - 3, FOUNTAIN.y - 3, FOUNTAIN.x + 5, FOUNTAIN.y + 5, tx0, ty0, tx1, ty1)) {
    ctx.strokeStyle = 'rgba(160,140,110,0.35)';
    ctx.lineWidth = 8;
    ctx.beginPath(); ctx.ellipse(fcx, fcy + 4, 70, 56, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(160,140,110,0.2)';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.ellipse(fcx, fcy + 4, 84, 68, 0, 0, Math.PI * 2); ctx.stroke();
  }

  // Maple's carrot patch.
  if (intersects(CARROTS.x, CARROTS.y, CARROTS.x + CARROTS.w, CARROTS.y + CARROTS.h, tx0, ty0, tx1, ty1)) {
    ctx.fillStyle = '#9a6b45';
    roundRect(ctx, CARROTS.x * TILE + 4, CARROTS.y * TILE + 6, CARROTS.w * TILE - 8, CARROTS.h * TILE - 10, 6); ctx.fill();
    for (let i = 0; i < 6; i++) {
      const cx = CARROTS.x * TILE + 14 + (i % 3) * 16;
      const cy = CARROTS.y * TILE + 22 + Math.floor(i / 3) * 20;
      ctx.fillStyle = '#e9823a';
      ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5aa64a';
      ctx.beginPath(); ctx.moveTo(cx, cy - 2); ctx.lineTo(cx - 4, cy - 10); ctx.lineTo(cx + 4, cy - 10); ctx.fill();
    }
  }

  // A rowboat tied up at the quay.
  if (intersects(BOAT.x, BOAT.y, BOAT.x + 2, BOAT.y + 1, tx0, ty0, tx1, ty1)) {
    const bx = BOAT.x * TILE + 4;
    const by = BOAT.y * TILE + 8;
    ctx.fillStyle = 'rgba(30,60,90,0.25)';
    ctx.beginPath(); ctx.ellipse(bx + 28, by + 14, 30, 6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a0643c';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bx, by + 2); ctx.lineTo(bx + 56, by + 2); ctx.quadraticCurveTo(bx + 52, by + 16, bx + 40, by + 16);
    ctx.lineTo(bx + 14, by + 16); ctx.quadraticCurveTo(bx + 2, by + 16, bx, by + 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#c98a5a';
    ctx.fillRect(bx + 18, by + 3, 4, 12); ctx.fillRect(bx + 34, by + 3, 4, 12);
    ctx.strokeStyle = '#8a7a5a';
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(bx + 28, by + 2); ctx.quadraticCurveTo(bx + 30, by - 4, bx + 34, by - 8); ctx.stroke();
  }

  const petals = ['#ffffff', '#ffd1e0', '#ffe27a', '#d9c9ff'];
  for (const f of town.flowers) {
    if (f.x < tx0 || f.x >= tx1 || f.y < ty0 || f.y >= ty1) continue;
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
}

/** Ripples on the pond and the river, and the river's slow drift, within view. */
export function drawWater(ctx, t, view) {
  const vis = (x, y, m = 40) => x > view.x - m && x < view.x + view.w + m && y > view.y - m && y < view.y + view.h + m;
  ctx.lineWidth = 1.5;
  for (let i = 0; i < 6; i++) {
    const x = (POND.x + 0.8 + hash(i, 1, 20) * (POND.w - 1.6)) * TILE;
    const y = (POND.y + 0.8 + hash(i, 2, 20) * (POND.h - 1.6)) * TILE;
    if (!vis(x, y)) continue;
    const p = (t * 0.5 + hash(i, 3, 20)) % 1;
    ctx.strokeStyle = `rgba(255,255,255,${0.55 * (1 - p)})`;
    ctx.beginPath();
    ctx.ellipse(x, y, 4 + p * 10, 2 + p * 4, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  const ry0 = RIVER.y * TILE;
  const ry1 = (RIVER.y + RIVER.h) * TILE;
  if (ry1 < view.y - 40 || ry0 > view.y + view.h + 40) return;
  const x0 = Math.max(0, Math.floor(view.x / TILE) - 1);
  const x1 = Math.min(COLS, Math.ceil((view.x + view.w) / TILE) + 1);
  const onBridge = (px) => BRIDGES.some((bx) => px > bx * TILE - 4 && px < (bx + 2) * TILE + 4);
  for (let x = x0; x < x1; x++) {
    for (let row = 0; row < RIVER.h; row++) {
      const h = hash(x, row, 21);
      if (h > 0.45) continue;
      const span = TILE * 3;
      const dx = (t * (14 + h * 10) + h * span) % span;
      const px = x * TILE + dx - TILE;
      const py = ry0 + row * TILE + 8 + hash(x, row, 22) * 16;
      if (onBridge(px) || onBridge(px + 14)) continue;
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * Math.sin((dx / span) * Math.PI)})`;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(px + 7, py - 2, px + 14, py);
      ctx.stroke();
    }
  }
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
    const fruit = tree.v > 0.82 ? '#e8574a' : '#f29b38';
    for (const [x, y] of [[-6, -22], [6, -27], [1, -18]]) blob(x, y, 2.4, fruit);
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

/** The fountain in Town Square: a stone basin, a little tower and its spray. Sort it by (FOUNTAIN.y + 2) * TILE. */
export function drawFountain(ctx, t) {
  const cx = (FOUNTAIN.x + 1) * TILE;
  const cy = (FOUNTAIN.y + 1) * TILE + 6;
  ctx.fillStyle = 'rgba(40,60,30,0.2)';
  ctx.beginPath(); ctx.ellipse(cx, cy + 22, 36, 9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  // Basin wall.
  ctx.fillStyle = '#cfc6b5';
  ctx.beginPath(); ctx.ellipse(cx, cy + 10, 32, 16, 0, 0, Math.PI); ctx.lineTo(cx - 32, cy); ctx.ellipse(cx, cy, 32, 16, 0, Math.PI, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#e4ddcd';
  ctx.beginPath(); ctx.ellipse(cx, cy, 32, 16, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // Water.
  ctx.fillStyle = '#7cc8e8';
  ctx.beginPath(); ctx.ellipse(cx, cy, 26, 11.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 2; i++) {
    const p = (t * 0.6 + i * 0.5) % 1;
    ctx.globalAlpha = 1 - p;
    ctx.beginPath(); ctx.ellipse(cx, cy + 1, 6 + p * 18, 3 + p * 7, 0, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Pillar and bowl.
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.fillStyle = '#d8d0bf';
  roundRect(ctx, cx - 5, cy - 26, 10, 26, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#e4ddcd';
  ctx.beginPath(); ctx.ellipse(cx, cy - 26, 13, 5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#9fd8ef';
  ctx.beginPath(); ctx.ellipse(cx, cy - 27, 9, 3, 0, 0, Math.PI * 2); ctx.fill();
  // Spray.
  for (let i = 0; i < 14; i++) {
    const side = i % 2 ? 1 : -1;
    const p = (t * 0.9 + i / 14) % 1;
    const spread = 6 + (i % 7) * 2.6;
    const x = cx + side * spread * p;
    const y = cy - 34 - 14 * Math.sin(p * Math.PI) + p * 28;
    ctx.fillStyle = `rgba(220,243,252,${0.9 - p * 0.6})`;
    ctx.beginPath(); ctx.arc(x, y, 1.8, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = 'rgba(230,248,255,0.95)';
  ctx.beginPath(); ctx.ellipse(cx, cy - 36 - Math.sin(t * 6) * 1.2, 2.5, 5, 0, 0, Math.PI * 2); ctx.fill();
}

/** A building in three-quarter view: walls, windows, a door, a roof and its sign. */
export function drawBuilding(ctx, b, t, night) {
  if (b.kind === 'mill') return drawMill(ctx, b, t, night);
  if (b.kind === 'stall') return drawStall(ctx, b, t);
  if (b.kind === 'toll') return drawToll(ctx, b, t, night);
  if (b.kind === 'kiosk') return drawKiosk(ctx, b, t);
  const X = b.x * TILE;
  const Y = b.y * TILE;
  const W = b.w * TILE;
  const H = b.h * TILE;
  const classical = b.kind === 'court' || b.kind === 'bank';
  const wallTop = Y + H * (classical ? 0.4 : 0.42);
  const ground = Y + H;
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;

  ctx.fillStyle = 'rgba(40,60,30,0.22)';
  roundRect(ctx, X - 2, ground - 8, W + 6, 14, 7); ctx.fill();

  // Walls and foundation.
  ctx.fillStyle = b.wall;
  roundRect(ctx, X + 3, wallTop, W - 6, ground - wallTop, 4); ctx.fill(); ctx.stroke();
  ctx.save();
  roundRect(ctx, X + 4, wallTop + 1, W - 8, ground - wallTop - 2, 3); ctx.clip();
  if (b.kind === 'house' || b.kind === 'shop' || b.kind === 'cafe') {
    ctx.strokeStyle = 'rgba(140,105,70,0.18)';
    ctx.lineWidth = 1;
    for (let y = wallTop + 8; y < ground - 8; y += 8) { ctx.beginPath(); ctx.moveTo(X + 5, y); ctx.lineTo(X + W - 5, y); ctx.stroke(); }
  } else if (b.kind === 'forge') {
    ctx.strokeStyle = 'rgba(90,40,25,0.35)';
    ctx.lineWidth = 1;
    let row = 0;
    for (let y = wallTop + 6; y < ground - 6; y += 6, row++) {
      ctx.beginPath(); ctx.moveTo(X + 4, y); ctx.lineTo(X + W - 4, y); ctx.stroke();
      for (let x = X + (row % 2 ? 6 : 12); x < X + W - 4; x += 12) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 6); ctx.stroke(); }
    }
  } else if (classical || b.kind === 'harbor') {
    ctx.strokeStyle = 'rgba(120,105,85,0.2)';
    ctx.lineWidth = 1;
    let row = 0;
    for (let y = wallTop + 10; y < ground - 6; y += 10, row++) {
      ctx.beginPath(); ctx.moveTo(X + 4, y); ctx.lineTo(X + W - 4, y); ctx.stroke();
      for (let x = X + (row % 2 ? 10 : 22); x < X + W - 4; x += 24) { ctx.beginPath(); ctx.moveTo(x, y - 10); ctx.lineTo(x, y); ctx.stroke(); }
    }
  }
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.fillStyle = 'rgba(120,90,60,0.25)';
  ctx.fillRect(X + 4, ground - 7, W - 8, 6);

  // Door.
  const doorX = b.door * TILE;
  const doorW = b.doorW * TILE;
  const dW = b.doorW > 1 ? doorW - 14 : 20;
  const dX = doorX + (doorW - dW) / 2;
  const dH = 30;
  if (classical || b.kind === 'hall') {
    ctx.fillStyle = '#e9e3d6';
    ctx.fillRect(dX - 12, ground - 6, dW + 24, 5);
    ctx.strokeRect(dX - 12, ground - 6, dW + 24, 5);
    ctx.fillRect(dX - 6, ground - 10, dW + 12, 4);
    ctx.strokeRect(dX - 6, ground - 10, dW + 12, 4);
  }
  const doorBase = classical || b.kind === 'hall' ? ground - 10 : ground - 2;
  ctx.fillStyle = b.kind === 'hall' || classical ? '#7a4a30' : b.kind === 'forge' ? '#4a3b36' : '#9a6440';
  ctx.beginPath();
  ctx.moveTo(dX, doorBase);
  ctx.lineTo(dX, ground - dH + dW / 2 - 4);
  ctx.arc(dX + dW / 2, ground - dH + dW / 2 - 4, dW / 2, Math.PI, 0);
  ctx.lineTo(dX + dW, doorBase);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  if (b.doorW > 1) {
    ctx.beginPath(); ctx.moveTo(dX + dW / 2, ground - dH - 2); ctx.lineTo(dX + dW / 2, doorBase); ctx.stroke();
  }
  ctx.fillStyle = '#f4c95d';
  ctx.beginPath(); ctx.arc(dX + dW - 5, doorBase - 11, 1.8, 0, Math.PI * 2); ctx.fill();

  // Windows on either side of the door (columns instead, at the courthouse).
  const winY = wallTop + (ground - wallTop) * 0.28;
  const winH = 15;
  const winW = 17;
  const slots = [];
  if (b.kind === 'court') {
    const cols = Math.floor((W - 20) / 26);
    for (let i = 0; i <= cols; i++) {
      const cx = X + 12 + i * ((W - 24) / cols);
      if (cx > dX - 8 && cx < dX + dW + 8) continue;
      ctx.fillStyle = '#fbf8f1';
      ctx.fillRect(cx - 4, wallTop + 6, 8, ground - wallTop - 16);
      ctx.strokeRect(cx - 4, wallTop + 6, 8, ground - wallTop - 16);
      ctx.fillStyle = 'rgba(120,105,85,0.18)';
      ctx.fillRect(cx + 1, wallTop + 7, 2, ground - wallTop - 18);
      ctx.fillStyle = '#e9e3d6';
      ctx.fillRect(cx - 6, wallTop + 4, 12, 4); ctx.strokeRect(cx - 6, wallTop + 4, 12, 4);
    }
  } else {
    const left = dX - X;
    const right = X + W - (dX + dW);
    const gap = b.kind === 'bank' ? 22 : 12;
    for (let wx = X + 12; wx + winW <= dX - gap; wx += winW + 12) slots.push(wx);
    for (let wx = dX + dW + gap; wx + winW <= X + W - 10; wx += winW + 12) slots.push(wx);
    if (!slots.length && left > 30) slots.push(X + (left - winW) / 2);
    if (slots.length < 2 && right > 30) slots.push(dX + dW + (right - winW) / 2);
  }
  const glass = b.kind === 'forge' ? (night ? '#ffc15e' : '#ffb45c') : night ? '#ffd877' : '#bfe4f5';
  slots.forEach((wx, i) => {
    ctx.fillStyle = glass;
    roundRect(ctx, wx, winY, winW, winH, 3); ctx.fill(); ctx.stroke();
    if (b.kind === 'forge') {
      for (let k = 0; k < 4; k++) {
        const on = Math.sin(t * (3 + k) + i * 1.7 + k) > 0;
        ctx.fillStyle = on ? (k % 2 ? '#7dffa8' : '#8fd2ff') : 'rgba(60,40,30,0.5)';
        ctx.fillRect(wx + 3 + k * 3.4, winY + 4 + (k % 2) * 5, 2, 2);
      }
    } else if (b.kind === 'bank') {
      ctx.strokeStyle = '#6b6b6b';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let k = 1; k < 4; k++) { ctx.moveTo(wx + (k * winW) / 4, winY + 1); ctx.lineTo(wx + (k * winW) / 4, winY + winH - 1); }
      ctx.stroke();
    } else {
      ctx.strokeStyle = '#fffaf0';
      ctx.beginPath(); ctx.moveTo(wx + winW / 2, winY + 2); ctx.lineTo(wx + winW / 2, winY + winH - 2); ctx.moveTo(wx + 2, winY + winH / 2); ctx.lineTo(wx + winW - 2, winY + winH / 2); ctx.stroke();
    }
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2;
    if (b.kind === 'house' || b.kind === 'shop' || b.kind === 'cafe') {
      ctx.fillStyle = '#6aa64f';
      roundRect(ctx, wx - 2, winY + winH + 2, winW + 4, 5, 2); ctx.fill();
      ctx.fillStyle = ['#ff8fab', '#ffd166', '#ffffff'][Math.floor(hash(b.x, Math.round(wx), 4) * 3)];
      for (let k = 0; k < 3; k++) { ctx.beginPath(); ctx.arc(wx + 3 + k * 6, winY + winH + 2, 2, 0, Math.PI * 2); ctx.fill(); }
    }
  });

  // Bank columns flanking the door.
  if (b.kind === 'bank') {
    for (const cx of [dX - 12, dX + dW + 12]) {
      ctx.fillStyle = '#fbf8f1';
      ctx.fillRect(cx - 4, wallTop + 4, 8, ground - wallTop - 14); ctx.strokeRect(cx - 4, wallTop + 4, 8, ground - wallTop - 14);
      ctx.fillStyle = '#e9e3d6';
      ctx.fillRect(cx - 6, wallTop + 2, 12, 4); ctx.strokeRect(cx - 6, wallTop + 2, 12, 4);
    }
  }

  // Awnings over shop and café fronts.
  if (b.kind === 'shop' || b.kind === 'cafe') {
    const aY = wallTop + 2;
    const stripes = 8;
    const sw = (W - 4) / stripes;
    const a = b.kind === 'cafe' ? '#d94f45' : b.roof;
    for (let i = 0; i < stripes; i++) {
      ctx.fillStyle = i % 2 ? '#fffaf0' : a;
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
  const roofBottom = wallTop + (b.kind === 'shop' || b.kind === 'cafe' ? 2 : 6);
  const over = 7;
  const roofTop = Y + (b.kind === 'hall' ? 14 : 8);
  if (classical) {
    // A frieze and a low pediment.
    const fy = wallTop - 10;
    ctx.fillStyle = b.kind === 'bank' ? '#d9d2c3' : '#ece6d8';
    ctx.fillRect(X - 2, fy, W + 4, 14); ctx.strokeRect(X - 2, fy, W + 4, 14);
    ctx.fillStyle = b.roof;
    ctx.beginPath();
    ctx.moveTo(X - over, fy);
    ctx.lineTo(X + W / 2, Y + (b.kind === 'court' ? 10 : 22));
    ctx.lineTo(X + W + over, fy);
    ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(90,70,54,0.35)';
    ctx.beginPath();
    ctx.moveTo(X + 14, fy - 4); ctx.lineTo(X + W / 2, Y + (b.kind === 'court' ? 18 : 28)); ctx.lineTo(X + W - 14, fy - 4); ctx.closePath(); ctx.stroke();
    ctx.strokeStyle = OUTLINE;
    if (b.kind === 'bank') {
      const cx = X + W / 2;
      const cy = (fy + Y + 22) / 2 + 6;
      ctx.fillStyle = '#f2c94c';
      ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#a77a1b';
      ctx.font = `800 10px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', cx, cy + 0.5);
    } else {
      // Scales of justice.
      const cx = X + W / 2;
      const cy = (fy + Y + 10) / 2 + 6;
      ctx.strokeStyle = '#8a6d3b';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(cx, cy - 7); ctx.lineTo(cx, cy + 6); ctx.moveTo(cx - 9, cy - 4); ctx.lineTo(cx + 9, cy - 4); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx - 9, cy, 3.5, 0, Math.PI); ctx.arc(cx + 9, cy, 3.5, 0, Math.PI); ctx.stroke();
      ctx.strokeStyle = OUTLINE;
      ctx.lineWidth = 2;
    }
  } else {
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
    for (let y = roofTop + 8; y < roofBottom; y += 8) { ctx.beginPath(); ctx.moveTo(X - over, y); ctx.lineTo(X + W + over, y); ctx.stroke(); }
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.fillRect(X, roofTop, W, 4);
    ctx.restore();
    ctx.lineWidth = 2;
    ctx.strokeStyle = OUTLINE;
  }

  if (b.kind === 'house') {
    const cx = X + W - 26;
    ctx.fillStyle = '#b5654a';
    ctx.fillRect(cx, roofTop - 12, 10, 18);
    ctx.strokeRect(cx, roofTop - 12, 10, 18);
    for (let i = 0; i < 3; i++) {
      const p = (t * 0.35 + i / 3 + b.x * 0.13) % 1;
      ctx.fillStyle = `rgba(255,255,255,${0.55 * (1 - p)})`;
      ctx.beginPath(); ctx.arc(cx + 5 + Math.sin(p * 6 + i) * 4, roofTop - 16 - p * 26, 3 + p * 5, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (b.kind === 'forge') {
    const cx = X + W - 30;
    const top = roofTop - 50;
    ctx.fillStyle = '#9c5039';
    ctx.fillRect(cx, top, 14, roofBottom - top - 8);
    ctx.strokeRect(cx, top, 14, roofBottom - top - 8);
    ctx.strokeStyle = 'rgba(70,30,20,0.35)';
    ctx.lineWidth = 1;
    for (let y = top + 6; y < roofBottom - 10; y += 6) { ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(cx + 14, y); ctx.stroke(); }
    ctx.lineWidth = 2;
    ctx.strokeStyle = OUTLINE;
    ctx.fillStyle = '#6e3a2a';
    ctx.fillRect(cx - 2, top - 4, 18, 5); ctx.strokeRect(cx - 2, top - 4, 18, 5);
    const glow = 0.55 + Math.sin(t * 3) * 0.2;
    ctx.fillStyle = `rgba(255,150,60,${glow})`;
    ctx.beginPath(); ctx.ellipse(cx + 7, top - 5, 6, 2.5, 0, 0, Math.PI * 2); ctx.fill();
    for (let i = 0; i < 4; i++) {
      const p = (t * 0.28 + i / 4) % 1;
      ctx.fillStyle = `rgba(110,100,100,${0.5 * (1 - p)})`;
      ctx.beginPath(); ctx.arc(cx + 7 + Math.sin(p * 5 + i) * 6 + p * 10, top - 10 - p * 44, 4 + p * 9, 0, Math.PI * 2); ctx.fill();
    }
  }
  if (b.kind === 'hall') {
    const cx = X + W / 2;
    ctx.fillStyle = '#fffaf0';
    ctx.beginPath(); ctx.arc(cx, roofTop + 24, 11, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(cx, roofTop + 24); ctx.lineTo(cx, roofTop + 17); ctx.moveTo(cx, roofTop + 24); ctx.lineTo(cx + 5, roofTop + 26); ctx.stroke();
    flag(ctx, cx, roofTop, t, '#ffd166');
    ctx.fillStyle = '#efe3c8';
    for (const px of [dX - 12, dX + dW + 6]) { ctx.fillRect(px, wallTop + 6, 6, ground - wallTop - 16); ctx.strokeRect(px, wallTop + 6, 6, ground - wallTop - 16); }
  }
  if (b.kind === 'harbor') flag(ctx, X + W / 2, roofTop, t, '#2f4fa8', true);
  if (b.kind === 'court') flag(ctx, X + W / 2, Y + 10, t, '#c8524a');

  // Sign above the door.
  ctx.font = `700 9px ${FONT}`;
  const label = b.name;
  const tw = ctx.measureText(label).width + 12;
  const sx = dX + dW / 2 - tw / 2;
  const sy = ground - dH - (classical || b.kind === 'hall' ? 20 : 16);
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
  if (b.kind === 'cafe') {
    for (const [tx, umbrella] of [[X + W - 22, '#d94f45'], [X + 18, '#3d6fb5']]) {
      const ty = ground + 8;
      if (Math.abs(tx - (dX + dW / 2)) < 26) continue;
      ctx.fillStyle = 'rgba(0,0,0,0.15)';
      ctx.beginPath(); ctx.ellipse(tx, ty + 6, 10, 3, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#6b5444';
      ctx.fillRect(tx - 1, ty - 14, 2, 20);
      ctx.fillStyle = umbrella;
      ctx.beginPath(); ctx.moveTo(tx - 13, ty - 12); ctx.quadraticCurveTo(tx, ty - 24, tx + 13, ty - 12); ctx.closePath(); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#fffaf0';
      ctx.beginPath(); ctx.ellipse(tx, ty, 8, 3, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = '#8a5a3c';
      for (const sx2 of [-11, 11]) { ctx.beginPath(); ctx.arc(tx + sx2, ty + 3, 2.6, 0, Math.PI * 2); ctx.fill(); }
    }
  }
}

function flag(ctx, cx, top, t, color, eu = false) {
  ctx.fillStyle = '#5a4636';
  ctx.fillRect(cx - 1, top - 30, 2, 31);
  ctx.fillStyle = color;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx + 1, top - 30);
  for (let i = 0; i <= 6; i++) ctx.lineTo(cx + 1 + i * 3.6, top - 30 + Math.sin(t * 4 + i * 0.8) * 1.6);
  for (let i = 6; i >= 0; i--) ctx.lineTo(cx + 1 + i * 3.6, top - 17 + Math.sin(t * 4 + i * 0.8) * 1.6);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  if (eu) {
    ctx.fillStyle = '#ffd84a';
    const fx = cx + 12;
    const fy = top - 23.5 + Math.sin(t * 4 + 2.4) * 1.6;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      ctx.beginPath(); ctx.arc(fx + Math.cos(a) * 4.2, fy + Math.sin(a) * 4.2, 0.9, 0, Math.PI * 2); ctx.fill();
    }
  }
}

/** A small sign board centered at (cx, cy). */
function smallSign(ctx, label, cx, cy, fill = '#fff6df') {
  ctx.font = `700 9px ${FONT}`;
  const tw = ctx.measureText(label).width + 12;
  ctx.fillStyle = fill;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  roundRect(ctx, cx - tw / 2, cy - 7, tw, 13, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#5a4636';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, cx, cy);
}

/** The Harvest Fair: a striped canopy, bunting and a table of pies. */
function drawStall(ctx, b, t) {
  const X = b.x * TILE;
  const Y = b.y * TILE;
  const W = b.w * TILE;
  const H = b.h * TILE;
  const ground = Y + H;
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.fillStyle = 'rgba(40,60,30,0.2)';
  roundRect(ctx, X - 2, ground - 8, W + 4, 12, 6); ctx.fill();
  // Posts.
  ctx.fillStyle = '#8a5a3c';
  for (const px of [X + 6, X + W - 10]) { ctx.fillRect(px, Y + 10, 4, H - 12); ctx.strokeRect(px, Y + 10, 4, H - 12); }
  // Table with a checked cloth and pies.
  ctx.fillStyle = '#b77b4d';
  roundRect(ctx, X + 4, ground - 26, W - 8, 22, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#fffaf0';
  ctx.fillRect(X + 4, ground - 28, W - 8, 8); ctx.strokeRect(X + 4, ground - 28, W - 8, 8);
  ctx.fillStyle = 'rgba(217,79,69,0.55)';
  for (let x = X + 6; x < X + W - 6; x += 8) ctx.fillRect(x, ground - 27, 4, 6);
  for (const [px, fill] of [[X + 22, '#e3a857'], [X + W / 2, '#c9563f'], [X + W - 22, '#e3a857']]) {
    ctx.fillStyle = fill;
    ctx.beginPath(); ctx.ellipse(px, ground - 30, 10, 4.5, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = 'rgba(120,70,30,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(px - 6, ground - 31); ctx.lineTo(px + 6, ground - 29); ctx.moveTo(px - 6, ground - 29); ctx.lineTo(px + 6, ground - 31); ctx.stroke();
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 2;
  }
  // Pumpkins by the table.
  for (const [px, r] of [[X - 4, 7], [X + W + 4, 6]]) {
    ctx.fillStyle = '#ef8a2e';
    ctx.beginPath(); ctx.ellipse(px, ground - 6, r, r * 0.8, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#5aa64a';
    ctx.fillRect(px - 1, ground - 6 - r * 0.8 - 4, 2, 4);
  }
  // Striped canopy.
  const cy = Y + 6;
  const stripes = 6;
  const sw = (W + 8) / stripes;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 ? '#fffaf0' : b.roof;
    ctx.beginPath();
    ctx.moveTo(X - 4 + i * sw, cy + 6);
    ctx.lineTo(X - 4 + i * sw + sw * 0.15, cy - 6);
    ctx.lineTo(X - 4 + (i + 1) * sw - sw * 0.15, cy - 6);
    ctx.lineTo(X - 4 + (i + 1) * sw, cy + 6);
    ctx.lineTo(X - 4 + (i + 1) * sw, cy + 14);
    ctx.arc(X - 4 + (i + 0.5) * sw, cy + 14, sw / 2, 0, Math.PI);
    ctx.closePath();
    ctx.fill();
  }
  ctx.beginPath(); ctx.moveTo(X - 4, cy + 6); ctx.lineTo(X + W + 4, cy + 6); ctx.stroke();
  // Bunting between the post tops.
  const colors = ['#ffd166', '#5aa65a', '#4f7fbf', '#e07a8a', '#ef8a2e'];
  ctx.strokeStyle = '#8a5a3c';
  ctx.lineWidth = 1;
  const y0 = Y + 28;
  ctx.beginPath(); ctx.moveTo(X + 8, y0); ctx.quadraticCurveTo(X + W / 2, y0 + 8, X + W - 8, y0); ctx.stroke();
  for (let i = 0; i < 7; i++) {
    const p = (i + 0.5) / 7;
    const fx = X + 8 + p * (W - 16);
    const fy = y0 + Math.sin(p * Math.PI) * 4 + Math.sin(t * 3 + i) * 0.6;
    ctx.fillStyle = colors[i % colors.length];
    ctx.beginPath(); ctx.moveTo(fx - 4, fy); ctx.lineTo(fx + 4, fy); ctx.lineTo(fx, fy + 7); ctx.closePath(); ctx.fill();
  }
  smallSign(ctx, b.name, X + W / 2, Y - 2);
}

/** The toll booth at the north end of the main bridge, its barrier arm raised. */
function drawToll(ctx, b, t, night) {
  const X = b.x * TILE;
  const Y = b.y * TILE;
  const W = b.w * TILE;
  const H = b.h * TILE;
  const ground = Y + H;
  const bx = X + 10;
  const bw = W - 20;
  const wallTop = Y + 24;
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.fillStyle = 'rgba(40,60,30,0.22)';
  roundRect(ctx, bx - 4, ground - 8, bw + 8, 12, 6); ctx.fill();
  ctx.fillStyle = b.wall;
  roundRect(ctx, bx, wallTop, bw, ground - wallTop - 2, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = night ? '#ffd877' : '#bfe4f5';
  roundRect(ctx, bx + 6, wallTop + 6, bw - 12, 12, 2); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#9a6440';
  ctx.fillRect(bx + bw / 2 - 5, ground - 16, 10, 14); ctx.strokeRect(bx + bw / 2 - 5, ground - 16, 10, 14);
  ctx.fillStyle = b.roof;
  ctx.beginPath(); ctx.moveTo(bx - 6, wallTop + 2); ctx.lineTo(bx + 4, Y + 8); ctx.lineTo(bx + bw - 4, Y + 8); ctx.lineTo(bx + bw + 6, wallTop + 2); ctx.closePath(); ctx.fill(); ctx.stroke();
  // Barrier arm on the road side (west), raised; decorative only.
  const px = bx - 2;
  const py = ground - 18;
  ctx.fillStyle = '#5a4636';
  ctx.fillRect(px - 3, py - 2, 6, 18);
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(-Math.PI / 2 + 0.35 + Math.sin(t * 0.8) * 0.02);
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = i % 2 ? '#fffaf0' : '#d94f45';
    ctx.fillRect(i * 7, -2.5, 7, 5);
  }
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(0, -2.5, 42, 5);
  ctx.restore();
  ctx.fillStyle = '#5a4636';
  ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();
  smallSign(ctx, b.name, X + W / 2, Y + 2);
}

/** A sleek little kiosk with a glowing silver orb on a pedestal. */
function drawKiosk(ctx, b, t) {
  const X = b.x * TILE;
  const Y = b.y * TILE;
  const W = b.w * TILE;
  const H = b.h * TILE;
  const ground = Y + H;
  const cx = X + W / 2;
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.fillStyle = 'rgba(40,60,30,0.2)';
  ctx.beginPath(); ctx.ellipse(cx, ground - 3, 28, 6, 0, 0, Math.PI * 2); ctx.fill();
  // Kiosk body with a screen.
  ctx.fillStyle = b.wall;
  roundRect(ctx, X + 4, ground - 30, W - 8, 28, 8); ctx.fill(); ctx.stroke();
  const pulse = 0.5 + Math.sin(t * 2.2) * 0.25;
  ctx.fillStyle = `rgba(110,210,235,${0.55 + pulse * 0.3})`;
  roundRect(ctx, X + 10, ground - 27, W - 20, 5, 2); ctx.fill();
  // Pedestal.
  ctx.fillStyle = '#d6dde4';
  ctx.beginPath(); ctx.moveTo(cx - 7, ground - 30); ctx.lineTo(cx - 4, ground - 46); ctx.lineTo(cx + 4, ground - 46); ctx.lineTo(cx + 7, ground - 30); ctx.closePath(); ctx.fill(); ctx.stroke();
  // The orb, with a soft halo.
  const oy = ground - 56 + Math.sin(t * 1.6) * 1.5;
  const halo = ctx.createRadialGradient(cx, oy, 4, cx, oy, 26);
  halo.addColorStop(0, `rgba(200,235,255,${0.45 + pulse * 0.3})`);
  halo.addColorStop(1, 'rgba(200,235,255,0)');
  ctx.fillStyle = halo;
  ctx.beginPath(); ctx.arc(cx, oy, 26, 0, Math.PI * 2); ctx.fill();
  const orb = ctx.createRadialGradient(cx - 4, oy - 4, 1, cx, oy, 11);
  orb.addColorStop(0, '#ffffff');
  orb.addColorStop(0.45, '#d9e1e8');
  orb.addColorStop(1, '#8e9aa6');
  ctx.fillStyle = orb;
  ctx.beginPath(); ctx.arc(cx, oy, 10, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  for (let i = 0; i < 3; i++) {
    const a = t * 1.4 + (i * Math.PI * 2) / 3;
    ctx.fillStyle = `rgba(255,255,255,${0.6 + 0.4 * Math.sin(t * 3 + i)})`;
    ctx.beginPath(); ctx.arc(cx + Math.cos(a) * 16, oy + Math.sin(a) * 6, 1.4, 0, Math.PI * 2); ctx.fill();
  }
  smallSign(ctx, b.name, cx, ground - 16, '#ffffff');
}

/** The Old Mill: a stone tower, a patched conical roof and slowly turning sails. */
function drawMill(ctx, b, t, night) {
  const X = b.x * TILE;
  const Y = b.y * TILE;
  const W = b.w * TILE;
  const H = b.h * TILE;
  const ground = Y + H;
  const cx = X + W / 2;
  const bw = W * 0.56;
  const tw = bw * 0.72;
  const towerTop = Y + H * 0.32;
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;
  ctx.fillStyle = 'rgba(40,60,30,0.25)';
  ctx.beginPath(); ctx.ellipse(cx, ground - 2, bw * 0.75, 10, 0, 0, Math.PI * 2); ctx.fill();

  // Tower.
  ctx.fillStyle = b.wall;
  ctx.beginPath();
  ctx.moveTo(cx - bw / 2, ground - 2);
  ctx.lineTo(cx - tw / 2, towerTop);
  ctx.lineTo(cx + tw / 2, towerTop);
  ctx.lineTo(cx + bw / 2, ground - 2);
  ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = 'rgba(110,95,75,0.3)';
  ctx.lineWidth = 1;
  let row = 0;
  for (let y = towerTop + 8; y < ground; y += 9, row++) {
    ctx.beginPath(); ctx.moveTo(cx - bw, y); ctx.lineTo(cx + bw, y); ctx.stroke();
    for (let x = cx - bw / 2 + (row % 2 ? 6 : 14); x < cx + bw / 2; x += 18) { ctx.beginPath(); ctx.moveTo(x, y - 9); ctx.lineTo(x, y); ctx.stroke(); }
  }
  ctx.fillStyle = 'rgba(96,140,70,0.55)';
  for (const [mx, my, r] of [[-0.35, 0.82, 7], [0.3, 0.9, 6], [-0.1, 0.5, 4]]) {
    ctx.beginPath(); ctx.arc(cx + mx * bw, towerTop + my * (ground - towerTop), r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = 'rgba(70,60,50,0.55)';
  ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.moveTo(cx + bw * 0.18, towerTop + 20); ctx.lineTo(cx + bw * 0.12, towerTop + 34); ctx.lineTo(cx + bw * 0.2, towerTop + 44); ctx.stroke();
  ctx.restore();
  ctx.lineWidth = 2;
  ctx.strokeStyle = OUTLINE;

  // Door and a boarded-up window.
  const dX = b.door * TILE + 6;
  const dW = 20;
  ctx.fillStyle = '#5e4232';
  ctx.beginPath();
  ctx.moveTo(dX, ground - 2); ctx.lineTo(dX, ground - 22); ctx.arc(dX + dW / 2, ground - 22, dW / 2, Math.PI, 0); ctx.lineTo(dX + dW, ground - 2); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#9a7650';
  ctx.save(); ctx.translate(dX + dW / 2, ground - 16); ctx.rotate(-0.25); ctx.fillRect(-13, -2.5, 26, 5); ctx.restore();
  const wx = cx + 6;
  const wy = towerTop + 26;
  ctx.fillStyle = night ? '#3a2e28' : '#2f3a40';
  roundRect(ctx, wx, wy, 14, 14, 3); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#a8865d';
  ctx.save(); ctx.translate(wx + 7, wy + 7); ctx.rotate(0.6); ctx.fillRect(-10, -2, 20, 4); ctx.rotate(-1.2); ctx.fillRect(-10, -2, 20, 4); ctx.restore();

  // Conical roof with a few missing shingles.
  const roofBase = towerTop + 4;
  const apex = Y - 4;
  ctx.fillStyle = b.roof;
  ctx.beginPath(); ctx.moveTo(cx - tw / 2 - 8, roofBase); ctx.lineTo(cx, apex); ctx.lineTo(cx + tw / 2 + 8, roofBase); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#3e2c20';
  for (const [sx, sy] of [[-8, 0.55], [6, 0.35], [10, 0.75]]) ctx.fillRect(cx + sx, apex + sy * (roofBase - apex), 5, 3);

  // Sails.
  const hubY = towerTop + 8;
  const angle = t * 0.35;
  ctx.save();
  ctx.translate(cx, hubY);
  for (let i = 0; i < 4; i++) {
    ctx.save();
    ctx.rotate(angle + (i * Math.PI) / 2);
    const len = i === 2 ? 40 : 62;
    ctx.strokeStyle = '#6b4f37';
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke();
    ctx.fillStyle = i === 2 ? 'rgba(240,230,210,0.5)' : 'rgba(245,238,222,0.85)';
    ctx.strokeStyle = OUTLINE;
    ctx.lineWidth = 1.5;
    ctx.fillRect(2, -len, 11, len - 14);
    ctx.strokeRect(2, -len, 11, len - 14);
    ctx.strokeStyle = 'rgba(90,70,54,0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let y = -len + 8; y < -14; y += 8) { ctx.moveTo(2, y); ctx.lineTo(13, y); }
    ctx.moveTo(7.5, -len); ctx.lineTo(7.5, -14);
    ctx.stroke();
    ctx.restore();
  }
  ctx.fillStyle = '#5a4636';
  ctx.beginPath(); ctx.arc(0, 0, 4.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // A leaning signpost.
  ctx.font = `700 9px ${FONT}`;
  const label = b.name;
  const tw2 = ctx.measureText(label).width + 12;
  const px = X + 14;
  ctx.fillStyle = '#7a5a3c';
  ctx.fillRect(px - 1, ground - 26, 3, 26);
  ctx.save();
  ctx.translate(px, ground - 30);
  ctx.rotate(-0.06);
  ctx.fillStyle = '#efe2c4';
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 2;
  roundRect(ctx, -tw2 / 2, -7, tw2, 13, 4); ctx.fill(); ctx.stroke();
  ctx.fillStyle = '#5a4636';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 0, 0);
  ctx.restore();
}

/** The key tag near Maple's. */
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
 * `badge` draws the ID card it presents; `mask` is for night visitors;
 * `revoked` greys it out with crossed-out eyes.
 */
export function drawAgent(ctx, a, t) {
  const look = a.look;
  const s = look.scale ?? 1;
  const revoked = Boolean(look.revoked);
  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.scale(s, s);
  if (a.alpha !== undefined) ctx.globalAlpha = a.alpha;
  const walking = a.walking && !revoked;
  const bob = walking ? Math.abs(Math.sin(a.phase)) * 2 : revoked ? 0 : Math.sin(t * 2.2 + (a.seed ?? 0)) * 0.6;
  ctx.fillStyle = 'rgba(0,0,0,0.2)';
  ctx.beginPath(); ctx.ellipse(0, 0, 10, 3.5, 0, 0, Math.PI * 2); ctx.fill();

  const step = walking ? Math.sin(a.phase) * 2.5 : 0;
  ctx.fillStyle = revoked ? '#8f8f8f' : look.feet ?? '#6b5444';
  ctx.beginPath(); ctx.ellipse(-5, -2 + Math.min(0, step), 4, 3, 0, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.ellipse(5, -2 + Math.min(0, -step), 4, 3, 0, 0, Math.PI * 2); ctx.fill();

  const by = -15 - bob;
  ctx.fillStyle = revoked ? '#cfcfcf' : look.body;
  ctx.strokeStyle = revoked ? '#7d7d7d' : OUTLINE;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.ellipse(0, by, 12, 13, 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  if (look.hood) {
    ctx.fillStyle = revoked ? '#b5b5b5' : look.hood;
    ctx.beginPath(); ctx.moveTo(-12, by); ctx.quadraticCurveTo(0, by - 24, 12, by); ctx.quadraticCurveTo(0, by - 8, -12, by); ctx.fill(); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.moveTo(0, by - 13); ctx.lineTo(0, by - 21); ctx.stroke();
    const bulb = revoked ? '#9a9a9a' : look.bulb;
    if (bulb) {
      ctx.fillStyle = bulb;
      ctx.shadowColor = bulb;
      ctx.shadowBlur = look.glow && !revoked ? 8 : 0;
      ctx.beginPath(); ctx.arc(0, by - 23, 3.6, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.shadowBlur = 0;
    }
  }

  const fx = a.facing?.x ?? 0;
  const fy = a.facing?.y ?? 1;
  if (fy >= 0 || Math.abs(fx) > 0.3) {
    const ex = fx * 3.5;
    const ey = by - 2 + Math.max(0, fy) * 1.5;
    if (look.mask && !revoked) {
      ctx.fillStyle = '#2b2233';
      roundRect(ctx, -11 + ex * 0.6, ey - 4, 22, 7, 3); ctx.fill();
    }
    if (revoked) {
      ctx.strokeStyle = '#5f5f5f';
      ctx.lineWidth = 1.6;
      for (const dx of [-4.5, 4.5]) {
        ctx.beginPath();
        ctx.moveTo(ex + dx - 2, ey - 2); ctx.lineTo(ex + dx + 2, ey + 2);
        ctx.moveTo(ex + dx + 2, ey - 2); ctx.lineTo(ex + dx - 2, ey + 2);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = look.eyes ?? '#3a2c2c';
      for (const dx of [-4.5, 4.5]) {
        ctx.beginPath(); ctx.ellipse(ex + dx, ey, 1.8, 2.6, 0, 0, Math.PI * 2); ctx.fill();
      }
    }
    if (!look.mask && !look.hood && !revoked) {
      ctx.fillStyle = 'rgba(255,140,150,0.45)';
      for (const dx of [-8, 8]) { ctx.beginPath(); ctx.ellipse(ex + dx, ey + 4, 2.6, 1.6, 0, 0, Math.PI * 2); ctx.fill(); }
    }
    if (look.badge === 'on') {
      ctx.strokeStyle = revoked ? '#7d7d7d' : OUTLINE;
      ctx.fillStyle = revoked ? '#e0e0e0' : look.badgeColor ?? '#ffe08a';
      roundRect(ctx, ex * 0.4 - 5, by + 4, 10, 7, 2); ctx.fill();
      ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = revoked ? '#9a9a9a' : look.badgeMark ?? '#3f9b5c';
      ctx.fillRect(ex * 0.4 - 3, by + 6, 6, 1.6);
      ctx.fillRect(ex * 0.4 - 3, by + 8.5, 4, 1.2);
    }
  }
  ctx.restore();
  if (a.label) {
    ctx.font = `700 9px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const w = ctx.measureText(a.label).width + 10;
    const ly = a.y - 46 * s;
    ctx.fillStyle = 'rgba(255,250,240,0.92)';
    roundRect(ctx, a.x - w / 2, ly - 7, w, 13, 6); ctx.fill();
    ctx.fillStyle = revoked ? '#8a8a8a' : '#5a4636';
    ctx.fillText(a.label, a.x, ly);
  }
}

/** A speech bubble above someone: an icon and an optional short line. */
export function drawBubble(ctx, x, y, text, tone, age) {
  const rise = Math.min(age, 0.3) * 20;
  ctx.font = `700 10px ${FONT}`;
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

/** Evening light: darken the view, then let windows, lamps and the forge glow (only what is in view). */
export function drawNight(ctx, town, amount, view) {
  if (amount <= 0) return;
  ctx.fillStyle = `rgba(20,24,64,${0.58 * amount})`;
  ctx.fillRect(view.x, view.y, view.w, view.h);
  ctx.globalCompositeOperation = 'lighter';
  const vis = (x, y, r) => x + r > view.x && x - r < view.x + view.w && y + r > view.y && y - r < view.y + view.h;
  const glow = (x, y, r, a, rgb = '255,214,120') => {
    if (!vis(x, y, r)) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a * amount})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
  };
  for (const l of town.lamps) glow((l.x + 0.5) * TILE, (l.y + 1) * TILE - 40, 46, 0.35);
  for (const b of town.buildings) {
    if (b.kind === 'mill') continue;
    glow((b.door + b.doorW / 2) * TILE, (b.y + b.h) * TILE - 18, 34, 0.25);
    if (b.kind === 'forge') glow((b.x + b.w) * TILE - 23, b.y * TILE - 50, 40, 0.45, '255,140,60');
    if (b.kind === 'kiosk') glow((b.x + b.w / 2) * TILE, (b.y + b.h) * TILE - 56, 36, 0.4, '190,230,255');
  }
  glow((FOUNTAIN.x + 1) * TILE, (FOUNTAIN.y + 1) * TILE, 40, 0.12, '180,220,255');
  ctx.globalCompositeOperation = 'source-over';
}

/** World px → minimap px: x * s + ox, y * s + oy. */
export function minimapScale(town, w, h) {
  const s = Math.min(w / (COLS * TILE), h / (ROWS * TILE));
  return { s, ox: (w - COLS * TILE * s) / 2, oy: (h - ROWS * TILE * s) / 2 };
}

const MINI = {
  [GRASS]: '#a6d877', [PATH]: '#ecd9a8', [WATER]: '#7cc8e8', [PLAZA]: '#efe7d8', [BRIDGE]: '#c99a63', [QUAY]: '#d3ccc0', [DIRT]: '#d4b27c',
};

/** The whole town at a glance, fitted to w × h. The caller draws the dots. */
export function drawMinimap(ctx, town, w, h) {
  const { s, ox, oy } = minimapScale(town, w, h);
  const ts = TILE * s;
  ctx.save();
  ctx.fillStyle = MINI[GRASS];
  ctx.fillRect(ox, oy, COLS * ts, ROWS * ts);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const k = town.ground[y][x];
    if (k === GRASS) continue;
    ctx.fillStyle = MINI[k];
    ctx.fillRect(ox + x * ts, oy + y * ts, ts + 0.5, ts + 0.5);
  }
  ctx.fillStyle = '#6fae5a';
  for (const tr of town.trees) {
    ctx.beginPath(); ctx.arc(ox + (tr.x + 0.5) * ts, oy + (tr.y + 0.5) * ts, ts * 0.55, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = '#cfc6b5';
  ctx.fillRect(ox + FOUNTAIN.x * ts, oy + FOUNTAIN.y * ts, ts * 2, ts * 2);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(90,70,54,0.7)';
  for (const b of town.buildings) {
    ctx.fillStyle = b.roof;
    roundRect(ctx, ox + b.x * ts, oy + b.y * ts, b.w * ts, b.h * ts, Math.max(1, ts * 0.8)); ctx.fill(); ctx.stroke();
  }
  const size = Math.max(7, Math.min(11, ts * 2.4));
  ctx.font = `800 ${size}px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  for (const d of DISTRICTS) {
    const x = ox + d.x * ts;
    const y = oy + d.y * ts;
    ctx.strokeStyle = 'rgba(255,250,240,0.9)';
    ctx.lineWidth = 3;
    ctx.strokeText(d.name, x, y);
    ctx.fillStyle = '#5a4636';
    ctx.fillText(d.name, x, y);
  }
  ctx.restore();
}
