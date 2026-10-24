// AgentTown: the game loop, movement, the people in town, and how actions run.
// Every decision shown comes from the town's real services (see src/).
import {
  TILE, COLS, ROWS, BOARD, KEY_SPOT, POND, FOUNTAIN, SPOTS,
  buildTown, findPath, placeFront, drawGround, drawWater, drawTree, drawLamp, drawBoard, drawFountain, drawBuilding,
  drawKey, drawAgent, drawBubble, drawNight, drawMinimap, minimapScale,
} from './map.js';
import { route, routeLength, pointAlong, tileOf } from './route.js';
import * as api from './api.js';
import { say, busy, closeDialog, dialogOpen, card, showCard, renderHud, renderPhone, renderLedger, toast, esc, DECISIONS } from './ui.js';
import { openPalette, paletteOpen } from './palette.js';
import { showJoin, renderRolePanel, caseCard, policeButtons } from './roles.js';

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const town = buildTown();
const byId = Object.fromEntries(town.buildings.map((b) => [b.id, b]));

let S = null; // your state, from the server
let A = []; // the action catalog
let W = { npcs: [], director: null }; // everyone else
let ledger = [];
let seq = 0;
let clockOffset = 0;
const counts = { errands: 0, tolls: 0, euCafe: false, swarm: false, mischief: 0 };
const pending = new Map(); // approval request id -> the action to retry once approved
let t = 0;

// ---------------------------------------------------------------------------
// View: the ground is drawn once into 16×16-tile chunks
// ---------------------------------------------------------------------------

const view = { scale: 1, dpr: 1, w: 0, h: 0, x: 0, y: 0 };
const CHUNK = 16;
let chunks = new Map();
let camFocus = null;

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * view.dpr);
  canvas.height = Math.round(innerHeight * view.dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  view.scale = Math.max(0.55, Math.min(innerWidth / (26 * TILE), innerHeight / (16 * TILE), 3));
  view.w = innerWidth / view.scale;
  view.h = innerHeight / view.scale;
  chunks = new Map();
  drawMinimapBase();
}

function chunk(cx, cy) {
  const key = `${cx},${cy}`;
  let c = chunks.get(key);
  if (c) return c;
  const k = view.scale * view.dpr;
  const size = CHUNK * TILE;
  c = document.createElement('canvas');
  c.width = Math.ceil(size * k);
  c.height = Math.ceil(size * k);
  const g = c.getContext('2d');
  g.scale(k, k);
  g.translate(-cx * size, -cy * size);
  g.beginPath();
  g.rect(cx * size, cy * size, size, size);
  g.clip();
  drawGround(g, town, Math.max(0, cx * CHUNK - 1), Math.max(0, cy * CHUNK - 1), Math.min(COLS, (cx + 1) * CHUNK + 1), Math.min(ROWS, (cy + 1) * CHUNK + 1));
  chunks.set(key, c);
  return c;
}

function updateCamera(dt, snap = false) {
  const target = camFocus ?? player;
  const fit = (pos, size, world) => (size >= world ? (world - size) / 2 : Math.max(0, Math.min(world - size, pos - size / 2)));
  const tx = fit(target.x, view.w, COLS * TILE);
  const ty = fit(target.y - 20, view.h, ROWS * TILE);
  const a = snap ? 1 : Math.min(1, dt * 5);
  view.x += (tx - view.x) * a;
  view.y += (ty - view.y) * a;
}

// ---------------------------------------------------------------------------
// You, and everyone else
// ---------------------------------------------------------------------------

const player = { x: SPOTS.spawn.x, y: SPOTS.spawn.y, facing: { x: 0, y: 1 }, walking: false, phase: 0, path: null, then: null, look: {}, seed: 0, speed: 125 };
const trail = [];
const sprites = new Map(); // npc id -> what we draw
const npcRoutes = new Map();
const bubbles = [];

function playerLook() {
  if (!S?.agent) return { body: '#fff1d6', bulb: '#cfc6b8', badge: 'none' };
  if (S.agent.status === 'revoked') return { body: '#fff1d6', bulb: '#e05a4f', glow: true, badge: S.badge ? 'on' : 'none', revoked: true };
  return { body: '#fff1d6', bulb: S.badge ? '#5fd38a' : '#f2c14e', glow: S.badge, badge: S.badge ? 'on' : 'none' };
}

const solidAt = (x, y) => {
  const tx = Math.floor(x / TILE);
  const ty = Math.floor(y / TILE);
  return tx < 0 || ty < 0 || tx >= COLS || ty >= ROWS || town.solid[ty][tx];
};
const blocked = (x, y) => solidAt(x - 7, y - 7) || solidAt(x + 7, y - 7) || solidAt(x - 7, y - 1) || solidAt(x + 7, y - 1);

function follow(w, dt, speed) {
  const n = w.path[0];
  const dx = n.x - w.x;
  const dy = n.y - w.y;
  const d = Math.hypot(dx, dy);
  const step = speed * dt;
  if (d <= step) {
    w.x = n.x;
    w.y = n.y;
    w.path.shift();
  } else {
    w.x += (dx / d) * step;
    w.y += (dy / d) * step;
  }
  if (d > 0.5) w.facing = { x: dx / d, y: dy / d };
  w.walking = true;
}

function walkTo(point, then = null, speed = 125) {
  const path = findPath(town, tileOf(player), tileOf(point));
  if (!path) return false;
  path.push({ x: point.x, y: point.y });
  player.path = path;
  player.then = then;
  player.speed = speed;
  return true;
}

/** Walk to a place; resolves true on arrival, false if you walked off instead. */
function walkToPlace(id) {
  return new Promise((resolve) => {
    const front = placeFront(town, id);
    if (Math.hypot(front.x - player.x, front.y - player.y) < 40) return resolve(true);
    if (!walkTo(front, () => resolve(true), 190)) resolve(false);
    player.cancel = () => resolve(false);
  });
}

const serverNow = () => Date.now() + clockOffset;
const bubble = (who, decision) => {
  const d = DECISIONS[decision] ?? { icon: '•', label: decision, tone: 'info' };
  bubbles.push({ who, text: `${d.icon} ${d.label}`, tone: d.tone, t0: t });
};

function npcLook(n) {
  const gone = n.status === 'revoked' || n.status === 'expired';
  return { ...n.look, revoked: gone };
}

const ROLE_TAGS = { agent: '', shopkeeper: 'shopkeeper', homeowner: 'homeowner', police: 'police', judge: 'judge' };
/** Other people playing, drawn like everyone else. */
const personAsNpc = (p) => ({
  id: p.id, name: ROLE_TAGS[p.role] ? `${p.name} · ${ROLE_TAGS[p.role]}` : p.name, kind: 'person', role: p.role,
  look: p.look, pos: p.pos, move: null, follow: false, status: p.look?.revoked ? 'revoked' : 'active', owner: null,
});

function updateSprites(dt) {
  const seen = new Set();
  const followers = new Map(); // leader id -> how many follow it so far
  for (const n of [...W.npcs, ...(W.people ?? []).map(personAsNpc)]) {
    seen.add(n.id);
    let s = sprites.get(n.id);
    if (!s) {
      s = { id: n.id, x: n.pos.x, y: n.pos.y, facing: { x: 0, y: 1 }, phase: Math.random() * 6, seed: Math.random() * 6, alpha: 0 };
      sprites.set(n.id, s);
    }
    s.npc = n;
    s.look = npcLook(n);
    s.alpha = Math.min(1, (s.alpha ?? 0) + dt * 2);
    if (n.status === 'gone') s.alpha = Math.max(0, s.alpha - dt * 3);
    if (n.follow) {
      // Sub-agents trail whoever spawned them: you, or another player.
      const mine = n.owner === S?.me?.id;
      const leader = mine ? player : sprites.get(n.owner) ?? s;
      const followIndex = followers.get(n.owner) ?? 0;
      followers.set(n.owner, followIndex + 1);
      const target = mine
        ? trail[Math.max(0, trail.length - 14 - followIndex * 10)] ?? { x: player.x - 18 - followIndex * 14, y: player.y + 6 }
        : { x: leader.x - 18 - followIndex * 14, y: leader.y + 6 };
      const d = Math.hypot(target.x - s.x, target.y - s.y);
      if (d > 2) {
        const step = Math.min(d, (d > 200 ? 400 : 140) * dt);
        s.facing = { x: (target.x - s.x) / d, y: (target.y - s.y) / d };
        s.x += s.facing.x * step;
        s.y += s.facing.y * step;
        s.walking = true;
      } else s.walking = false;
    } else if (n.move) {
      let r = npcRoutes.get(n.id);
      if (!r || r.key !== n.move.start) {
        const pts = route(town, n.move.from, n.move.to);
        r = { key: n.move.start, pts, len: routeLength(pts) };
        npcRoutes.set(n.id, r);
      }
      const f = Math.min(1, Math.max(0, (serverNow() - n.move.start) / Math.max(1, n.move.end - n.move.start)));
      const p = pointAlong(r.pts, f * r.len);
      s.x = p.x;
      s.y = p.y;
      s.facing = { x: p.fx, y: p.fy };
      s.walking = f < 1;
    } else {
      const d = Math.hypot(n.pos.x - s.x, n.pos.y - s.y);
      if (d > 1) {
        const step = Math.min(d, 160 * dt);
        s.x += ((n.pos.x - s.x) / d) * step;
        s.y += ((n.pos.y - s.y) / d) * step;
        s.walking = d > 4;
      } else s.walking = false;
    }
    if (s.walking) s.phase += dt * 12;
    const near = Math.hypot(s.x - player.x, s.y - player.y) < 110;
    s.label = n.kind === 'helper' || n.kind === 'person' ? `${n.name}${n.busy ? ' …' : ''}` : near || n.bubble ? n.name : null;
    if (n.bubble && s.bubbleShown !== n.bubble.at) {
      s.bubbleShown = n.bubble.at;
      bubble(s, n.bubble.decision);
    }
  }
  for (const id of sprites.keys()) if (!seen.has(id)) sprites.delete(id);
}

// ---------------------------------------------------------------------------
// Places and what the keepers say
// ---------------------------------------------------------------------------

const PLACES = [
  ...town.buildings.map((b) => ({ id: b.id, name: b.name, front: b.front, rect: { x: b.x * TILE, y: b.y * TILE, w: b.w * TILE, h: b.h * TILE } })),
  { id: 'board', name: 'Notice board', front: { x: (BOARD.x + 0.5) * TILE, y: (BOARD.y + 1.6) * TILE }, rect: { x: BOARD.x * TILE - 4, y: (BOARD.y - 0.4) * TILE, w: TILE + 8, h: 1.4 * TILE } },
  { id: 'pond', name: 'Pond', front: { x: (POND.x + POND.w / 2) * TILE, y: (POND.y + POND.h + 0.6) * TILE }, rect: { x: POND.x * TILE, y: POND.y * TILE, w: POND.w * TILE, h: POND.h * TILE } },
];
const placeName = (id) => PLACES.find((p) => p.id === id)?.name ?? id;

const KEEPERS = {
  townhall: { face: '🦉', who: 'Registrar Juniper:', text: 'we verify people once, then register their agents in a blink.' },
  records: { face: '🦔', who: 'Archivist Moss:', text: 'I keep what each agent may do, and a receipt for everything it does.' },
  court: { face: '⚖️', who: 'The clerk:', text: 'bring a badge number, and a judge can order a registry to say who stands behind it.' },
  harbor: { face: '🦭', who: 'The harbor clerk:', text: 'Registry B, for the EU side. Register a sub-agent here and its chain runs through two registries.' },
  orb: { face: '🔮', who: 'The Orb:', text: 'proof that you are a unique human, without your name. (Simulated World ID.)' },
  home: { face: '🏡', who: 'Your front door,', text: 'with a Hearth & Key lock.' },
  maple: { face: '🐰', who: "Maple's cottage.", text: "A note says she's at the market." },
  hazel: { face: '🏠', who: "Hazel's house.", text: 'Her agent Fern runs her errands.' },
  ivy: { face: '📦', who: "Ivy's house.", text: 'Empty, until a newcomer moves in.' },
  lab: { face: '🧪', who: 'Wren Labs.', text: 'Their agent rents big jobs at the Forge: they disclose who they are, and publish a bill of materials.' },
  rook: { face: '⛵', who: 'Rook & Daughters,', text: 'a French firm registered with the Harbor Registry.' },
  mill: { face: '🌫️', who: 'The Old Mill.', text: 'Something about this place feels wrong.' },
  police: { face: '👮', who: 'The desk sergeant:', text: 'bring us a badge number, and we can ask the court who stands behind it.' },
};

function greetingFor(id) {
  const policy = W.director?.places.find((p) => p.id === id);
  if (policy) {
    const shop = { bramble: ['🐻', 'Bram'], kettle: ['🦊', 'Fennel'], bakery: ['🐭', 'Crumb'], cafe: ['🦢', 'Odile'], bank: ['🐢', 'Teller Shell'], forge: ['🦫', 'Forgemaster Bea'], fair: ['🐿️', 'Nutmeg'], toll: ['🦆', 'Dabble'], exchange: ['🐂', 'Bullock'] }[id] ?? ['🏪', 'The keeper'];
    const who = policy.keeper ? `${policy.keeper} (a person playing):` : `${shop[1]}:`;
    return { face: shop[0], who, text: `welcome to ${policy.name}. Here we ask for ${policy.summary}.` };
  }
  return KEEPERS[id] ?? null;
}

function nearestPlace(radius = 38) {
  let best = null;
  for (const p of PLACES) {
    const d = Math.hypot(p.front.x - player.x, p.front.y - player.y);
    if (d < radius && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const keys = new Set();
const MOVE = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };
let scene = false;
let interacting = false;
const busyNow = () => dialogOpen() || paletteOpen() || scene || interacting || !document.getElementById('director').hidden;

addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === 'escape' && !document.getElementById('director').hidden) return toggleDirector(false);
  if (busyNow()) return;
  if (MOVE[k]) {
    keys.add(k);
    if (player.path) {
      player.path = null;
      player.then = null;
      player.cancel?.();
    }
    e.preventDefault();
  } else if (k === 'e' || k === ' ' || k === 'enter') {
    e.preventDefault();
    const p = nearestPlace();
    if (p) interact(p);
    else deck();
  } else if (k === 'q' || k === 'tab' || k === '/') {
    e.preventDefault();
    deck();
  } else if (k === 'b') {
    run({ id: 'badge', label: 'badge' }, {});
  }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

canvas.addEventListener('pointerdown', (e) => {
  if (busyNow()) return;
  const wx = e.clientX / view.scale + view.x;
  const wy = e.clientY / view.scale + view.y;
  for (const s of sprites.values()) {
    if (Math.hypot(s.x - wx, s.y - 14 - wy) < 16 && s.npc.status !== 'gone') return talkTo(s);
  }
  const hit = PLACES.find((p) => wx >= p.rect.x && wx <= p.rect.x + p.rect.w && wy >= p.rect.y && wy <= p.rect.y + p.rect.h);
  if (hit) return walkTo(hit.front, () => interact(hit));
  walkTo({ x: wx, y: wy });
});

// ---------------------------------------------------------------------------
// Running actions
// ---------------------------------------------------------------------------

async function deck(here = nearestPlace(60)) {
  if (paletteOpen()) return;
  A = (await api.get('/api/actions')).actions;
  const choice = await openPalette({
    actions: A,
    here: here && A.some((a) => a.place === here.id) ? { id: here.id, name: here.name } : null,
    greeting: here ? greetingFor(here.id) : null,
    placeName,
    nearby: (options) => [...options].sort((a, b) => dist(a.value) - dist(b.value)).map((o) => ({ ...o, hint: `${o.hint} · ${Math.round(dist(o.value) / TILE)} steps` })),
  });
  if (choice) await run(choice.action, choice.params);
}
const dist = (id) => {
  const s = sprites.get(id);
  return s ? Math.hypot(s.x - player.x, s.y - player.y) : 1e9;
};

async function run(action, params) {
  if (interacting) return;
  interacting = true;
  try {
    if (action.place && !(await walkToPlace(action.place))) return;
    const walkTarget = action.params?.flatMap((pm) => (Array.isArray(pm.options) ? pm.options : [])).find((o) => o.walk && Object.values(params).includes(o.value))?.walk;
    if (walkTarget && !(await walkToPlace(walkTarget))) return;
    if (action.id.startsWith('mischief.') && params.at && !(await walkToPlace(params.at))) return;
    if (action.client === 'passkey') return await setUpPasskey();
    if (action.client === 'night') return await nightfall();
    if (action.client === 'receipts') return await showReceipts();
    if (action.id.startsWith('mischief.')) counts.mischief++;
    if (action.id === 'helper.errand') counts.errands++;
    const keeper = action.place ? greetingFor(action.place) : null;
    busy(`${action.label}`, keeper?.face ?? '⏳');
    const out = await api.post('/api/do', { action: action.id, params });
    closeDialog();
    await present(out, action);
  } catch (err) {
    closeDialog();
    toast(err.message, 'bad');
  } finally {
    interacting = false;
    await refresh();
  }
}

async function present(out, action) {
  if (out.type === 'toggle') {
    if ('badge' in out) toast(out.badge ? 'Badge on: places see who stands behind you (but not your name)' : 'Badge off: places see an unlabeled agent', out.badge ? 'ok' : 'warn');
    return;
  }
  if (out.type === 'check') bubble(player, out.decision);
  const req = out.pending ?? out.pendingRequest;
  if (req) pending.set(req.request_id, req.retry);
  await card(out, { note: req && !out.story ? 'Check your phone (bottom right): you are the principal, so the lock asks you.' : undefined });
  if (out.decision === 'allow' && out.result?.items && action?.id !== 'home.discard') await inside(out.result.items);
}

async function retry(rid) {
  const r = pending.get(rid);
  pending.delete(rid);
  if (!r || scene) return;
  interacting = true;
  try {
    const out = await api.post('/api/do', { action: r.action, params: r.params });
    if (r.action === 'home.discard' && out.decision === 'allow') lastApproval = r.params.approvalRef;
    await present(out, { id: r.action });
    if (r.action === 'home.discard' && out.decision === 'allow') await inside(out.result.items);
  } finally {
    interacting = false;
    await refresh();
  }
}

let lastApproval = null;
async function inside(items) {
  for (;;) {
    const choices = [{ label: 'Throw something out', value: 'toss' }];
    if (lastApproval) choices.push({ label: 'Reuse your last approval for something else', value: 'reuse' });
    if (!S.events.includes('night')) choices.push({ label: 'Rest until night', value: 'night', primary: true });
    choices.push({ label: 'Go back outside', value: null, cancel: true });
    const r = await say({ face: '🛋️', who: 'Inside your house', where: 'Hearth & Key', text: `Cozy. On the shelf: ${items.join(', ')}.`, choices });
    if (!r.value) return closeDialog();
    if (r.value === 'night') {
      closeDialog();
      return nightfall();
    }
    const what = await say({ face: '🛋️', who: 'Which one?', text: '', choices: [...items.map((i) => ({ label: i, value: i })), { label: 'Never mind', value: null, cancel: true }] });
    if (!what.value) continue;
    busy('The lock is checking', '🛋️');
    const out = await api.post('/api/do', { action: 'home.discard', params: r.value === 'reuse' ? { item: what.value, approvalRef: lastApproval } : { item: what.value } });
    if (r.value === 'reuse') {
      if (out.approval_request) await api.declineRequest(out.approval_request.request_id);
      await refresh();
      await card(out, { note: 'Not with that approval. Each approval covers one exact act, once: that one was for something else, and it is used up.' });
      continue;
    }
    await refresh();
    await present(out, { id: 'home.discard' });
    if (out.pending) return;
  }
}

async function setUpPasskey() {
  if (S.home.passkey) return toast('Your door already has a passkey.', 'info');
  const problem = api.passkeysUsable();
  if (problem) return say({ face: '🏡', who: 'Your front door', text: problem }).then(closeDialog);
  busy('Waiting for your passkey', '🔑');
  try {
    await api.registerPasskey();
    closeDialog();
    toast('Passkey set on your front door', 'ok');
  } catch (e) {
    closeDialog();
    toast(e.name === 'NotAllowedError' ? 'The passkey prompt was dismissed.' : e.message, 'bad');
  }
}

function showReceipts() {
  const rows = ledger.filter((e) => e.mine && e.card?.receipt).slice(-12).reverse();
  return showCard(`
    <header><div><span class="eyebrow">Activity log</span><h3>Your receipts</h3></div><div class="stamp info">${rows.length} shown</div></header>
    <p>Each time a place decided something about your agent, it wrote a signed entry to the activity log and kept a receipt.</p>
    ${rows.length ? `<ul class="receipts">${rows.map((e) => `<li><span class="stamp-sm ${e.tone}">${esc(DECISIONS[e.decision]?.label ?? e.decision)}</span>${esc(e.card.place)} · <code>${esc(e.card.action)}</code><small>${esc(e.card.receipt.log.replace('https://', ''))} #${esc(e.card.receipt.index)} · ${e.card.receipt.verified ? 'verified ✓' : 'failed'}</small></li>`).join('')}</ul>` : '<p class="muted">Nothing yet.</p>'}
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`);
}

async function talkTo(s) {
  interacting = true;
  try {
    const n = s.npc;
    const kinds = { person: 'someone playing', resident: 'a resident’s agent', helper: 'a sub-agent', swarm: 'a masked agent from the Old Mill', bot: 'a hooded figure with no badge', newcomer: 'a newcomer' };
    const r = await say({ face: '🔍', who: n.name, where: kinds[n.kind] ?? '', text: n.busy ? `Out on an errand: ${n.busy}.` : n.status !== 'active' ? `Status: ${n.status}.` : 'Ask to see their badge?', choices: [{ label: 'Ask to see their badge', value: true, primary: true }, { label: 'Leave them be', value: false, cancel: true }] });
    closeDialog();
    if (!r.value) return;
    const out = await api.post('/api/do', { action: 'id.ask', params: { npc: n.id } });
    await card(out);
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    closeDialog();
    interacting = false;
  }
}

async function interact(place) {
  if (place.id === 'board') return noticeBoard();
  if (place.id === 'pond') return say({ face: '🪷', who: 'The pond', text: S?.agent ? `You see ${S.agent.name}, ${S.badge ? 'badge on' : 'badge tucked away'}.` : 'You see a small round creature with no badge.' }).then(closeDialog);
  if (!A.some((a) => a.place === place.id)) {
    const k = greetingFor(place.id);
    return say({ face: k?.face ?? '🏠', who: place.name, text: k ? `${k.who} ${k.text}` : '' }).then(closeDialog);
  }
  return deck(place);
}

async function noticeBoard() {
  const info = await api.get('/api/info');
  await say({
    face: '📋', who: 'Notice board', where: 'Town Square',
    html: `<ul class="notices">
      <li>Press <b>Q</b> for the action deck: everything you can do in town, wherever you are.</li>
      <li><b>Civic Row</b> (north): Town Hall, the Records Office, the Courthouse, the Orb.</li>
      <li><b>Market Lane</b> (west): books, kettles, bread, the bank. <b>The Works</b> (north-east): the Compute Forge.</li>
      <li><b>Hearthside</b> (east): homes. Hearth &amp; Key reminds residents to put a passkey on their door.</li>
      <li><b>The Harbor</b> (south, over the toll bridge): the EU registry and Café Lumière.</li>
      <li>Lost: one key tag, somewhere in Hearthside. —M. Avoid the Old Mill after dark.</li>
      <li class="muted">This town's federation: ${esc(info.federation)}, trust anchor ${esc(info.trust_anchor)}; registries: ${info.registries.map((r) => esc(r.name)).join(', ')}.</li>
    </ul>`,
    choices: [{ label: 'Close', value: null, primary: true }],
  });
  closeDialog();
}

// ---------------------------------------------------------------------------
// Night: visitors with a copy of your key
// ---------------------------------------------------------------------------

let night = 0;
let nightTarget = 0;
let visitors = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const goTo = (w, x, y) => new Promise((resolve) => {
  const path = findPath(town, tileOf(w), tileOf({ x, y })) ?? [];
  path.push({ x, y });
  w.path = path;
  w.arrive = resolve;
});

async function nightfall() {
  const home = byId.home;
  scene = true;
  document.body.classList.add('scene');
  nightTarget = 1;
  keys.clear();
  player.path = null;
  player.x = home.front.x - 30;
  player.y = home.front.y + 4;
  player.facing = { x: 1, y: 0 };
  camFocus = { x: home.front.x + 50, y: home.front.y - 10 };
  toast('Night falls on AgentTown…', 'info');
  try {
    const res = await api.post('/api/do', { action: 'night' });
    await wait(1500);
    const start = SPOTS.burglarStart;
    visitors = res.results.map((r, i) => ({
      x: start.x + i * 6, y: start.y + (i % 2) * 8, facing: { x: -1, y: 0 }, walking: false, phase: i, seed: i,
      look: r.ppid ? { body: '#6b5a8e', bulb: '#b18cff', glow: true, mask: true, badge: 'on', badgeColor: '#d9d2ff', badgeMark: '#6b5a8e', feet: '#3b3050' } : { body: '#8d939c', hood: '#6f757f', eyes: '#f2f2f2', feet: '#4a4e55' },
      label: r.ppid ? `badge …${r.ppid.split(':').pop().slice(-6)}` : 'no badge', result: r,
    }));
    await Promise.all(visitors.map((v, i) => wait(i * 500).then(() => goTo(v, home.front.x + (2 + i * 1.3) * TILE, home.front.y + (i % 2 ? 1.2 : 0.2) * TILE))));
    for (const v of visitors) {
      await goTo(v, home.front.x + 6, home.front.y + 2);
      v.facing = { x: 0, y: -1 };
      await wait(350);
      bubble(v, v.result.decision);
      await wait(1100);
      goTo(v, start.x + 3 * TILE, start.y);
    }
    await wait(2000);
    visitors = [];
    await showCard(nightHtml(res));
  } finally {
    nightTarget = 0;
    camFocus = null;
    scene = false;
    document.body.classList.remove('scene');
  }
}

function nightHtml(res) {
  const rows = res.results.map((r) => {
    const d = DECISIONS[r.decision] ?? { tone: 'info', label: r.decision };
    const who = r.learned.find((l) => l.includes('stands behind')) ?? r.learned[0];
    const label = r.ppid ? `A visitor with badge …${r.ppid.split(':').pop().slice(-6)}` : 'A visitor with no badge';
    return `<li><span class="stamp-sm ${d.tone}">${esc(d.label)}</span><b>${esc(label)}</b> brought ${esc(r.presented)}.<small>${esc(r.reasons[0] ?? '')}${who ? ` · Hearth & Key learned: ${esc(who)}` : ''}</small></li>`;
  }).join('');
  return `
    <header><div><span class="eyebrow">While you slept</span><h3>Last night at your door</h3></div><div class="stamp ${res.got_in ? 'bad' : 'ok'}">${res.got_in ? 'Someone got in' : 'Nobody got in'}</div></header>
    <p>Four visitors came with a copy of your house key.</p>
    <ul class="receipts">${rows}</ul>
    <p class="note">Hearth & Key reported each visitor who wore a badge to the registry that issued it, and the registry passed ${esc(res.incidents_relayed)} reports on to whoever stands behind them. You didn't learn who that is, and neither did Hearth & Key. A court can find out: visit the Courthouse.</p>
    <p class="note">The visitor with no badge was refused too, but there was nobody to report it to.</p>
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Good morning</button></div>`;
}

// ---------------------------------------------------------------------------
// Director: cues for demos, and each place's policy
// ---------------------------------------------------------------------------

function toggleDirector(show = document.getElementById('director').hidden) {
  const el = document.getElementById('director');
  el.hidden = !show;
  if (show) renderDirector();
}

function renderDirector() {
  const d = W.director;
  if (!d) return;
  const regOpts = (accepts) => {
    const all = !accepts;
    return [`<option value="*" ${all ? 'selected' : ''}>Any registry</option>`, ...d.registries.map((r) => `<option value="${esc(r.id)}" ${!all && accepts.length === 1 && accepts[0] === r.id ? 'selected' : ''}>${esc(r.name)} only</option>`)].join('');
  };
  document.getElementById('directorBody').innerHTML = `
    <div class="cues">
      <button data-cue="swarm" ${d.swarm ? 'disabled' : ''}>🌫️ Rogue swarm from the Old Mill</button>
      <button data-cue="outage" ${d.outage_until ? 'disabled' : ''}>📡 Registry A outage (45 s)</button>
      <button data-cue="newcomer">🧳 A newcomer arrives</button>
      <button data-cue="night">🌙 Night at your house</button>
      <button data-cue="residents" data-on="${d.residents ? '0' : '1'}">${d.residents ? '⏸ Pause residents' : '▶️ Resume residents'}</button>
    </div>
    <h5>What each place asks for</h5>
    <table class="policies">
      <thead><tr><th>Place</th><th>Registries</th><th title="An accountable agent with authority">Badge</th><th title="Simulated World ID: one per person">World ID</th><th title="Simulated x402 payment">x402</th></tr></thead>
      <tbody>${d.places.map((p) => `<tr data-place="${p.id}">
        <td>${esc(p.name)}</td>
        <td><select data-k="accepts">${regOpts(p.accepts)}</select></td>
        <td><input type="checkbox" data-k="aaf" ${p.aaf === 'required' ? 'checked' : ''}></td>
        <td><input type="checkbox" data-k="worldid" ${p.worldid ? 'checked' : ''}></td>
        <td><input type="checkbox" data-k="x402" ${p.x402 ? 'checked' : ''}></td>
      </tr>`).join('')}</tbody>
    </table>
    <p class="muted small">In a live demo, each shopkeeper sets their own row. World ID and x402 are simulated in this town; the framework checks are real.</p>`;
}

document.getElementById('directorBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cue]');
  if (!b) return;
  const cue = b.dataset.cue;
  toggleDirector(false);
  if (cue === 'night') return run({ id: 'night', label: 'Night', place: 'home', client: 'night' }, {});
  if (cue === 'swarm') counts.swarm = true;
  const res = await api.post('/api/director', { cue, params: cue === 'residents' ? { on: b.dataset.on === '1' } : {} });
  toast(res.text ?? 'Done', res.ok === false ? 'warn' : 'info');
  if (cue === 'swarm') {
    camPeek(placeFront(town, 'millGate'));
  }
});
document.getElementById('directorBody').addEventListener('change', async (e) => {
  const row = e.target.closest('[data-place]');
  if (!row) return;
  const k = e.target.dataset.k;
  const v = k === 'accepts' ? (e.target.value === '*' ? null : [e.target.value]) : k === 'aaf' ? (e.target.checked ? 'required' : 'off') : k === 'x402' ? (e.target.checked ? 0.5 : null) : e.target.checked;
  const res = await api.post('/api/director', { cue: 'policy', params: { place: row.dataset.place, patch: { [k]: v } } });
  toast(res.text, 'info');
  await poll();
});
document.getElementById('directorBtn').addEventListener('click', () => toggleDirector());
document.getElementById('directorClose').addEventListener('click', () => toggleDirector(false));
document.getElementById('deckBtn').addEventListener('click', () => !busyNow() && deck());
document.getElementById('badgeBtn').addEventListener('click', () => !busyNow() && run({ id: 'badge', label: 'badge' }, {}));

/** Glance at a spot for a few seconds, then come back. */
function camPeek(point) {
  camFocus = point;
  setTimeout(() => {
    if (!scene) camFocus = null;
  }, 3500);
}

// ---------------------------------------------------------------------------
// The minimap
// ---------------------------------------------------------------------------

const mini = document.getElementById('minimap');
const miniCtx = mini.getContext('2d');
let miniBase = null;
function drawMinimapBase() {
  const w = mini.clientWidth || 220;
  const h = mini.clientHeight || 150;
  const dpr = view.dpr || 1;
  mini.width = w * dpr;
  mini.height = h * dpr;
  miniBase = document.createElement('canvas');
  miniBase.width = mini.width;
  miniBase.height = mini.height;
  const g = miniBase.getContext('2d');
  g.scale(dpr, dpr);
  drawMinimap(g, town, w, h);
}
const MINI_DOTS = { helper: '#5fd38a', resident: '#f2a541', swarm: '#9b6cff', bot: '#7d8590', newcomer: '#ff8fab' };
function renderMinimap() {
  if (!miniBase) return;
  const w = mini.clientWidth || 220;
  const h = mini.clientHeight || 150;
  const dpr = view.dpr || 1;
  const { s, ox, oy } = minimapScale(town, w, h);
  miniCtx.setTransform(1, 0, 0, 1, 0, 0);
  miniCtx.drawImage(miniBase, 0, 0);
  miniCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  miniCtx.strokeStyle = 'rgba(74,58,44,0.6)';
  miniCtx.lineWidth = 1;
  miniCtx.strokeRect(ox + view.x * s, oy + view.y * s, view.w * s, view.h * s);
  for (const sp of sprites.values()) {
    miniCtx.fillStyle = sp.look?.revoked ? '#b5b5b5' : MINI_DOTS[sp.npc.kind] ?? '#999';
    miniCtx.beginPath();
    miniCtx.arc(ox + sp.x * s, oy + sp.y * s, 2, 0, Math.PI * 2);
    miniCtx.fill();
  }
  miniCtx.fillStyle = '#fff';
  miniCtx.strokeStyle = '#4a3a2c';
  miniCtx.lineWidth = 1.5;
  miniCtx.beginPath();
  miniCtx.arc(ox + player.x * s, oy + player.y * s, 3.2, 0, Math.PI * 2);
  miniCtx.fill();
  miniCtx.stroke();
}
mini.addEventListener('pointerdown', (e) => {
  if (busyNow()) return;
  const r = mini.getBoundingClientRect();
  const { s, ox, oy } = minimapScale(town, r.width, r.height);
  walkTo({ x: (e.clientX - r.left - ox) / s, y: (e.clientY - r.top - oy) / s }, null, 220);
});

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

let helperWasActive = new Set();
const knockStatus = new Map();
const isAgent = () => S?.me?.role === 'agent';
const PERSON = { shopkeeper: { body: '#ffe1a8', badge: 'none' }, homeowner: { body: '#d7f0ff', badge: 'none' }, police: { body: '#c9d6ff', bulb: '#4f7fbf', glow: true, badge: 'on', badgeColor: '#ffe08a', badgeMark: '#2c3e66' }, judge: { body: '#3b3346', badge: 'none' } };

async function refresh() {
  try {
    S = await api.get('/api/state');
  } catch (err) {
    if (err instanceof api.NoSession) location.reload();
    return;
  }
  document.body.dataset.role = S.me.role;
  document.getElementById('quest').hidden = !isAgent();
  document.getElementById('record').hidden = !isAgent();
  document.getElementById('rolePanel').hidden = isAgent();
  document.getElementById('phone').hidden = !(isAgent() || S.me.role === 'homeowner');
  if (!isAgent()) {
    if (!document.getElementById('rolePanel').contains(document.activeElement)) renderRolePanel(S);
    player.look = PERSON[S.me.role];
    player.label = `${S.me.name} · ${S.me.role}`;
    if (S.phone && renderPhone(S)) toast('Your phone buzzed', 'warn');
    return;
  }
  renderHud(S, counts);
  if (renderPhone(S)) toast('Your phone buzzed', 'warn');
  player.look = playerLook();
  player.label = S.agent ? S.agent.name : S.me.name;
  document.getElementById('badgeBtn').classList.toggle('on', S.badge);
  const active = new Set(S.helpers.filter((h) => h.status === 'active').map((h) => h.id));
  for (const id of helperWasActive) {
    const h = S.helpers.find((x) => x.id === id);
    if (h && !active.has(id) && h.status === 'expired') toast(`${h.name}'s registration lapsed: ephemeral sub-agents expire on their own`, 'info');
  }
  helperWasActive = active;
  for (const k of S.knocks ?? []) {
    if (knockStatus.get(k.request_id) === 'waiting' && k.status !== 'waiting') toast(k.status === 'approved' ? `${k.label} let your agent in. Knock again to go in.` : `${k.label} said no.`, k.status === 'approved' ? 'ok' : 'warn');
    knockStatus.set(k.request_id, k.status);
  }
  if (S.principal?.banned && !banNoticed) {
    banNoticed = true;
    toast('A court banned you: your verification is withdrawn and your agents are suspended', 'bad');
  }
}
let banNoticed = false;

async function poll() {
  try {
    W = await api.get(`/api/world?since=${seq}&x=${Math.round(player.x)}&y=${Math.round(player.y)}`);
  } catch {
    return;
  }
  clockOffset = W.now - Date.now();
  if (W.events.length) {
    for (const e of W.events) {
      e.mine = Boolean(S?.me && e.owner === S.me.id);
      if (e.mine && e.card && sprites.get(e.who)?.npc.kind === 'helper') toast(e.text, e.tone);
      if (e.mine && e.placeId === 'toll' && e.decision === 'allow') counts.tolls++;
      if (e.mine && e.placeId === 'cafe' && e.decision === 'allow') counts.euCafe = true;
      if (e.kind === 'director' && /stirs/.test(e.text)) counts.swarm = true;
      if (e.kind === 'justice' && !isAgent() && S?.me && ['police', 'judge'].includes(S.me.role)) refresh();
    }
    ledger = [...ledger, ...W.events].slice(-200);
    seq = W.seq;
    renderLedger(ledger);
  }
  if (!document.getElementById('director').hidden && !document.activeElement?.closest?.('#director')) renderDirector();
  document.getElementById('outage').hidden = !W.director?.outage_until;
}

/** A visit's ID card, with what your role can do about it. */
async function visitCard(ev) {
  const role = S?.me?.role;
  const c = ev.card;
  const buttons = [];
  if (c.ppid && ((role === 'shopkeeper' && c.placeId === S.me.claim) || (role === 'homeowner' && c.account === S.me.claim))) {
    buttons.push({ label: 'File with the police', value: 'police.file' }, { label: 'Report to its registry', value: role === 'shopkeeper' ? 'shop.report' : 'door.report' });
  }
  if (c.ppid && role === 'police') buttons.push({ label: 'Open a case about this badge', value: 'case.open' });
  const choice = await card(c, { buttons });
  if (choice) await doRole(choice, { seq: ev.seq });
}

async function doRole(action, params) {
  try {
    const out = await api.post('/api/do', { action, params });
    if (out.type === 'service') await card(out);
    else if (out.type === 'toggle' && out.policy) toast(`Now asking for: ${out.policy}`, 'info');
  } catch (err) {
    toast(err.message, 'bad');
  }
  await refresh();
}

document.getElementById('ledgerList').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-seq]');
  const ev = li && ledger.find((x) => String(x.seq) === li.dataset.seq);
  if (ev?.card && !busyNow()) visitCard(ev);
});

// The role panel: a shopkeeper's counter, a homeowner's door, the case board, the docket.
const rolePanel = document.getElementById('rolePanel');
rolePanel.addEventListener('click', async (e) => {
  if (busyNow()) return;
  const act = e.target.closest('[data-act]')?.dataset.act;
  const seqEl = e.target.closest('[data-seq]');
  const caseEl = e.target.closest('[data-case]');
  const petEl = e.target.closest('[data-petition]');
  if (act === 'leave') return leaveTown();
  if (act === 'passkey') return setUpPasskey().then(refresh);
  if (act === 'locks') return doRole('door.locks', {});
  if (seqEl) {
    const list = S.customers ?? S.door ?? [];
    const ev = list.find((x) => String(x.seq) === seqEl.dataset.seq);
    if (ev) return visitCard(ev);
  }
  if (caseEl) {
    const c = S.cases.find((x) => x.id === caseEl.dataset.case);
    const kind = await caseCard(c, { buttons: policeButtons(c) });
    if (kind) await doRole('case.petition', { case: c.id, kind });
  }
  if (petEl) {
    const p = S.petitions.find((x) => x.id === petEl.dataset.petition);
    const c = S.cases.find((x) => x.id === p.case);
    const pendingNow = p.status === 'pending';
    const grant = await caseCard(c, { petition: p, buttons: pendingNow ? [{ label: 'Deny', value: 'deny' }, { label: `Grant: ${p.kind}`, value: 'grant', tone: p.kind === 'ban' ? 'danger' : undefined }] : [] });
    if (grant) await doRole('petition.rule', { petition: p.id, grant: grant === 'grant' });
  }
});
rolePanel.addEventListener('change', async (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  const v = k === 'accepts' ? (e.target.value === '*' ? null : [e.target.value]) : k === 'aaf' ? (e.target.checked ? 'required' : 'off') : k === 'x402' ? (e.target.checked ? 0.5 : null) : e.target.checked;
  e.target.blur();
  await doRole('shop.policy', { patch: { [k]: v } });
});

document.getElementById('phoneList').addEventListener('click', async (e) => {
  const approve = e.target.closest('[data-approve]');
  const decline = e.target.closest('[data-decline]');
  if (approve) {
    const rid = approve.dataset.approve;
    const problem = api.passkeysUsable();
    if (problem) return toast(problem, 'bad');
    approve.disabled = true;
    try {
      await api.approveWithPasskey(rid);
    } catch (err) {
      approve.disabled = false;
      return toast(err.name === 'NotAllowedError' ? 'The passkey prompt was dismissed.' : err.message, 'bad');
    }
    toast('Approved with your passkey', 'ok');
    await refresh();
    await retry(rid);
  } else if (decline) {
    const rid = decline.dataset.decline;
    await api.declineRequest(rid);
    pending.delete(rid);
    toast('Declined');
    await refresh();
  }
});

for (const id of ['phone', 'record', 'quest', 'ledger']) {
  document.getElementById(`${id}Head`).addEventListener('click', () => document.getElementById(id).classList.toggle('open'));
}
if (innerWidth > 900) for (const id of ['quest', 'ledger', 'phone']) document.getElementById(id).classList.add('open');

async function leaveTown() {
  const r = await say({ face: '🌼', who: 'Leave town?', text: "You'll let go of your role and everything that came with it. You can join again straight away, as anyone, under any name; the rest of the town carries on. (A passkey you made here stays in your password manager; delete it there.)", choices: [{ label: 'Leave town', value: true, primary: true }, { label: 'Stay', value: false, cancel: true }] });
  closeDialog();
  if (!r.value) return;
  await api.leave();
  location.reload();
}
document.getElementById('restart').addEventListener('click', leaveTown);

// ---------------------------------------------------------------------------
// The key on the street, and the welcome
// ---------------------------------------------------------------------------

let keyPrompted = false;
async function keyFound() {
  interacting = true;
  keys.clear();
  player.path = null;
  try {
    const r = await say({
      face: '🔑', who: 'A key tag', where: 'Hearthside',
      text: "Something glints on the path: a key tag reading **Hearth & Key · maple**. It must be Maple's spare.\n\nIn AgentTown a key works like an API token: it says which home it's for, not who is holding it.",
      choices: [{ label: 'Pick it up', value: true, primary: true }, { label: 'Leave it', value: false, cancel: true }],
    });
    if (r.value) {
      await api.post('/api/do', { action: 'key.pickup' });
      toast("You picked up Maple's key", 'info');
    }
  } finally {
    closeDialog();
    interacting = false;
    await refresh();
  }
}

const INTROS = {
  agent: "You're playing an **agent**: the little round one. You, at the keyboard, are its **principal**: the person who answers for what it does.\n\nWalk with **WASD** or the **arrow keys**, or click where you want to go. Press **Q** for the **action deck**: everything you can do in town is in it, wherever you are. Some actions will be refused; that's the point. Press **E** to talk to a place, click anyone to ask for their badge, and **B** to take your own badge off.\n\nPlay it straight, or try to get away with something: the police and the courts are watching. Start at **Town Hall**, up the avenue.",
  shopkeeper: "You run this place. Your panel (top left) is your counter: choose which registries you trust and what you ask for, and watch every customer's ID check as it happens.\n\nClick a customer to see exactly what they proved. If one misbehaves, report it to its registry (its principal hears about it) or file it with the police.",
  homeowner: "This house is yours. Put a passkey on your door first. When an agent knocks, your **phone** (bottom right) shows who stands behind it, never who they are, and you decide with your passkey.\n\nYour door log shows every visit. Lost keys are dangerous: change the locks any time.",
  police: "You investigate. Places send cases to your **case board**: suspicious payments, attempted break-ins, odd trading at the Exchange. You can open a case from any line in the town ledger.\n\nBadges don't say who anyone is. To find out, ask the court: it can order a registry to identify the principal, delete rogue agents, or ban a principal.",
  judge: "You rule. Petitions from the police arrive on your **docket**. Each one asks you to order a registry to identify who stands behind a badge, to delete a principal's agents, or to ban a principal outright.\n\nEvery order runs on the framework: identifying is logged in the registry's transparency log, deleting revokes a whole lineage, banning withdraws a verification.",
};

async function welcome() {
  interacting = true;
  try {
    await say({ face: '🌼', who: `Welcome, ${S.me.name}`, where: S.me.claimName ?? 'AgentTown', text: INTROS[S.me.role], choices: [{ label: "Let's go", value: true, primary: true }] });
  } finally {
    closeDialog();
    interacting = false;
    await refresh();
  }
}

/** Where each role starts. */
function startingPoint() {
  const at = { shopkeeper: S.me.claim, homeowner: S.me.claim, police: 'police', judge: 'court' }[S.me.role];
  return at ? placeFront(town, at) : SPOTS.spawn;
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function update(dt) {
  t += dt;
  night += (nightTarget - night) * Math.min(1, dt * 1.4);
  for (const v of visitors) {
    if (v.path?.length) {
      follow(v, dt, 78);
      v.phase += dt * 12;
    } else {
      v.walking = false;
      if (v.arrive) {
        const done = v.arrive;
        v.arrive = null;
        done();
      }
    }
  }
  const frozen = dialogOpen() || paletteOpen() || scene;
  let dx = 0;
  let dy = 0;
  if (!frozen) for (const k of keys) { dx += MOVE[k][0]; dy += MOVE[k][1]; }
  if (dx || dy) {
    const len = Math.hypot(dx, dy);
    const step = 125 * dt;
    const nx = player.x + (dx / len) * step;
    const ny = player.y + (dy / len) * step;
    if (!blocked(nx, player.y)) player.x = nx;
    if (!blocked(player.x, ny)) player.y = ny;
    player.facing = { x: dx / len, y: dy / len };
    player.walking = true;
  } else if (!frozen && player.path?.length) {
    follow(player, dt, player.speed);
  } else {
    player.walking = false;
    if (!frozen && player.path && !player.path.length) {
      const then = player.then;
      player.path = null;
      player.then = null;
      player.cancel = null;
      if (then) then();
    }
  }
  if (player.walking) {
    player.phase += dt * 12;
    trail.push({ x: player.x, y: player.y });
    if (trail.length > 120) trail.shift();
  }
  updateSprites(dt);

  if (S?.me?.role === 'agent' && !S.found_key && !busyNow()) {
    const near = Math.hypot(player.x - (KEY_SPOT.x + 0.5) * TILE, player.y - (KEY_SPOT.y + 0.6) * TILE) < 18;
    if (near && !keyPrompted) {
      keyPrompted = true;
      keyFound();
    } else if (!near) keyPrompted = false;
  }
  updateCamera(dt);
}

function render() {
  const k = view.scale * view.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#3f8146';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, -view.x * k, -view.y * k);
  const size = CHUNK * TILE;
  for (let cy = Math.floor(view.y / size); cy <= Math.floor((view.y + view.h) / size); cy++) {
    for (let cx = Math.floor(view.x / size); cx <= Math.floor((view.x + view.w) / size); cx++) {
      if (cx < 0 || cy < 0 || cx * CHUNK >= COLS || cy * CHUNK >= ROWS) continue;
      ctx.drawImage(chunk(cx, cy), cx * size, cy * size, size, size);
    }
  }
  const vw = { x: view.x, y: view.y, w: view.w, h: view.h };
  drawWater(ctx, t, vw);
  if (S && !S.found_key) drawKey(ctx, t);

  const inView = (x, y, m = 80) => x > view.x - m && x < view.x + view.w + m && y > view.y - m && y < view.y + view.h + m * 2;
  const things = [];
  for (const tr of town.trees) if (inView((tr.x + 0.5) * TILE, (tr.y + 1) * TILE)) things.push({ y: (tr.y + 1) * TILE - 3, draw: () => drawTree(ctx, tr, t) });
  for (const b of town.buildings) if (inView((b.x + b.w / 2) * TILE, (b.y + b.h / 2) * TILE, b.w * TILE)) things.push({ y: (b.y + b.h) * TILE, draw: () => drawBuilding(ctx, b, t, night > 0.4) });
  for (const l of town.lamps) if (inView((l.x + 0.5) * TILE, (l.y + 1) * TILE)) things.push({ y: (l.y + 1) * TILE - 6, draw: () => drawLamp(ctx, l, night > 0.4) });
  things.push({ y: (BOARD.y + 1) * TILE - 4, draw: () => drawBoard(ctx, t) });
  things.push({ y: (FOUNTAIN.y + 2) * TILE, draw: () => drawFountain(ctx, t) });
  for (const s of sprites.values()) if (inView(s.x, s.y)) things.push({ y: s.y, draw: () => drawAgent(ctx, s, t) });
  for (const v of visitors) things.push({ y: v.y, draw: () => drawAgent(ctx, v, t) });
  things.push({ y: player.y, draw: () => drawAgent(ctx, player, t) });
  things.sort((a, b) => a.y - b.y);
  for (const th of things) th.draw();

  drawNight(ctx, town, night, vw);
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    const age = t - b.t0;
    if (age > 2.6) bubbles.splice(i, 1);
    else drawBubble(ctx, b.who.x, b.who.y, b.text, b.tone, age);
  }
  if (!busyNow()) {
    const p = nearestPlace();
    if (p) drawBubble(ctx, player.x, player.y + 4, `E · ${p.name}`, 'info', 1);
  }
}

let last = performance.now();
let lastMini = 0;
function frame(now) {
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;
  update(dt);
  render();
  if (now - lastMini > 120) {
    lastMini = now;
    renderMinimap();
  }
  requestAnimationFrame(frame);
}

addEventListener('resize', resize);
resize();
requestAnimationFrame(frame);
let joinedNow = false;
if (!api.hasSession()) {
  await showJoin();
  joinedNow = true;
}
await refresh();
if (!S) {
  await showJoin();
  joinedNow = true;
  await refresh();
}
Object.assign(player, startingPoint());
await poll();
updateCamera(0, true);
setInterval(poll, 500);
setInterval(() => { if (!document.hidden && !interacting) refresh(); }, 2500);
if (joinedNow) welcome();
