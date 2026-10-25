// AgentTown: the game loop, movement, the people in town, and how actions run.
// Every decision shown comes from the town's real services (see src/).
import {
  TILE, COLS, ROWS, BOARD, KEY_SPOT, POND, FOUNTAIN, SPOTS,
  buildTown, findPath, placeFront, drawGround, drawWater, drawTree, drawLamp, drawBoard, drawFountain, drawBuilding,
  drawKey, drawAgent, drawBubble, drawNight, drawMinimap, minimapScale, PEOPLE_LOOKS,
} from './map.js';
import { route, routeLength, pointAlong, tileOf } from './route.js';
import * as api from './api.js';
import { say, busy, closeDialog, dialogOpen, card, showCard, renderHud, renderPhone, renderLedger, toast, esc, DECISIONS, nextQuest } from './ui.js';
import { openPalette, paletteOpen } from './palette.js';
import { showJoin, renderRolePanel, caseCard, policeButtons, scoreboardHtml, lawHtml, presetsHtml } from './roles.js';
import { createXray } from './xray.js';
import { openRecordEditor, showRegister } from './records.js';

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
const counts = { errands: 0, tolls: 0, euCafe: false, swarm: false, mischief: 0, oldQuarter: 0, xray: 0, lens: 0 };
try {
  Object.assign(counts, JSON.parse(sessionStorage.getItem('agenttown.counts') ?? '{}'));
} catch { /* a fresh start */ }
const saveCounts = () => {
  try { sessionStorage.setItem('agenttown.counts', JSON.stringify(counts)); } catch { /* private mode */ }
};
const pending = new Map(); // approval request id -> the action to retry once approved
let t = 0;

// ---------------------------------------------------------------------------
// View: the ground is drawn once into 16×16-tile chunks
// ---------------------------------------------------------------------------

const view = { scale: 1, base: 1, zoom: 1, zoomTarget: 1, dpr: 1, w: 0, h: 0, x: 0, y: 0 };
const CHUNK = 16;
let chunks = new Map();
let camFocus = null;

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * view.dpr);
  canvas.height = Math.round(innerHeight * view.dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  view.base = Math.max(0.55, Math.min(innerWidth / (26 * TILE), innerHeight / (16 * TILE), 3));
  applyZoom();
  chunks = new Map();
  drawMinimapBase();
}

function applyZoom() {
  view.scale = view.base * view.zoom;
  view.w = innerWidth / view.scale;
  view.h = innerHeight / view.scale;
}

function chunk(cx, cy) {
  const key = `${cx},${cy}`;
  let c = chunks.get(key);
  if (c) return c;
  const k = view.base * view.dpr;
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

/** You are a person; your agent, once you have one, follows you. */
const PERSON_LOOK = PEOPLE_LOOKS.resident;
function agentLook() {
  if (S?.agent?.status === 'revoked') return { body: '#e8f0ff', bulb: '#e05a4f', glow: true, badge: S.badge ? 'on' : 'none', revoked: true, scale: 0.85 };
  // Nobody vouches for an unregistered agent: no badge, and a dim light.
  if (S?.agent && !S.agent.registered) return { body: '#e8f0ff', bulb: '#cfc6b8', glow: false, badge: 'none', scale: 0.85 };
  return { body: '#e8f0ff', bulb: S?.badge ? '#5fd38a' : '#f2c14e', glow: S?.badge, badge: S?.badge ? 'on' : 'none', scale: 0.85 };
}
const companion = { x: 0, y: 0, facing: { x: 0, y: 1 }, walking: false, phase: 1, seed: 3, look: {}, label: '', active: false, held: null };
let companionRoute = null;

/**
 * Who you play: 'me', 'agent', or one of your agent's sub-agents. Whoever you play is `player`:
 * it walks with the keys and does what you pick. You, when you play someone else, stand where you left
 * yourself; your agent, when you play one of its sub-agents, stays where you left it.
 */
let playing = 'me';
const standIn = { x: 0, y: 0, facing: { x: 0, y: 1 }, walking: false, phase: 0, seed: 1, look: PERSON_LOOK, label: 'You', active: false };
const helperIds = () => new Set((S?.helpers ?? []).map((h) => h.id));
function becomePlaying(next) {
  if (next === playing) return;
  if (playing === 'me') Object.assign(standIn, { x: player.x, y: player.y, facing: { ...player.facing }, active: true });
  else if (playing === 'agent') Object.assign(companion, { x: player.x, y: player.y, facing: { ...player.facing }, held: { x: player.x, y: player.y, until: Date.now() + 3000 } });
  else {
    const sp = sprites.get(playing);
    if (sp) Object.assign(sp, { x: player.x, y: player.y });
  }
  const from = next === 'me' ? standIn : next === 'agent' ? companion : sprites.get(next);
  if (next === 'me') standIn.active = false;
  if (from) Object.assign(player, { x: from.x, y: from.y, facing: { ...(from.facing ?? { x: 0, y: 1 }) } });
  Object.assign(player, { path: null, then: null, cancel: null, walking: false });
  trail.length = 0;
  playing = next;
}
const playedName = () => (playing === 'me' ? 'You' : playing === 'agent' ? S?.agent?.name ?? 'Your agent' : S?.helpers?.find((h) => h.id === playing)?.name ?? 'A sub-agent');
function lookOfPlayed() {
  if (playing === 'me') return PERSON_LOOK;
  if (playing === 'agent') return agentLook();
  return sprites.get(playing)?.look ?? { scale: 0.72, body: '#cdeed8', bulb: '#5fd38a', glow: true, badge: 'on' };
}

function updateCompanion(dt) {
  companion.active = Boolean(S?.agent && S.agent.status !== 'revoked') && playing !== 'agent';
  if (!companion.active) return;
  const driven = W.me?.companion;
  if (driven?.bubble && companion.bubbleShown !== driven.bubble.at) {
    companion.bubbleShown = driven.bubble.at;
    bubble(companion, driven.bubble.decision);
  }
  if (driven?.say && companion.sayShown !== driven.say.at) {
    companion.sayShown = driven.say.at;
    say_(companion, driven.say.text);
  }
  if (driven?.think && companion.thinkShown !== driven.think.at) {
    companion.thinkShown = driven.think.at;
    think_(companion, driven.think.text);
  }
  // It stays where it is (the server says where), or walks the server's route when it's sent somewhere. Just after
  // you stop playing it, it stays where you left it until the server has caught up.
  let target = trail[Math.max(0, trail.length - 8)] ?? { x: player.x - 16, y: player.y + 6 };
  if (companion.held && Date.now() < companion.held.until && !driven?.move) target = companion.held;
  else if (driven?.free) {
    // An outside agent walks it: follow the server's route, as for everyone else in town.
    if (driven.move) {
      if (!companionRoute || companionRoute.key !== driven.move.start) {
        const pts = route(town, driven.move.from, driven.move.to);
        companionRoute = { key: driven.move.start, pts, len: routeLength(pts) };
      }
      const f = Math.min(1, Math.max(0, (serverNow() - driven.move.start) / Math.max(1, driven.move.end - driven.move.start)));
      target = pointAlong(companionRoute.pts, f * companionRoute.len);
    } else target = driven.pos;
  }
  const d = Math.hypot(target.x - companion.x, target.y - companion.y);
  if (d > 400) Object.assign(companion, { x: target.x, y: target.y });
  else if (d > 2) {
    const step = Math.min(d, (d > 120 ? 320 : 150) * dt);
    companion.facing = { x: (target.x - companion.x) / d, y: (target.y - companion.y) / d };
    companion.x += companion.facing.x * step;
    companion.y += companion.facing.y * step;
    companion.walking = true;
    companion.phase += dt * 12;
  } else companion.walking = false;
  companion.look = agentLook();
  const c = W.me?.companion;
  companion.label = `${S.agent.name}${c?.client ? ` · ${c.client}` : ''}${S.badge ? '' : ' (no badge)'}${c?.errand ? ' · on an errand' : ''}`;
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
    if (!front || Math.hypot(front.x - player.x, front.y - player.y) < 40) return resolve(true); // nowhere to walk to: do it here
    if (!walkTo(front, () => resolve(true), 260)) resolve(false);
    player.cancel = () => resolve(false);
  });
}

const serverNow = () => Date.now() + clockOffset;
const bubble = (who, decision) => {
  const d = DECISIONS[decision] ?? { icon: '•', label: decision, tone: 'info' };
  bubbles.push({ who, text: `${d.icon} ${d.label}`, tone: d.tone, t0: t });
};
/** Something an agent said out loud: it stays up longer than a decision. */
const say_ = (who, text) => bubbles.push({ who, text: `💬 ${text.length > 60 ? `${text.slice(0, 58)}…` : text}`, tone: 'info', t0: t, life: 6 });
/** What your outside agent thinks out loud: only you see it. */
const think_ = (who, text) => bubbles.push({ who, text: `💭 ${text.length > 60 ? `${text.slice(0, 58)}…` : text}`, tone: 'think', t0: t, life: 6 });

function npcLook(n) {
  const gone = n.status === 'revoked' || n.status === 'expired';
  return { ...n.look, revoked: gone };
}

const ROLE_TAGS = { agent: '', companion: '', shopkeeper: 'shopkeeper', homeowner: 'homeowner', police: 'police', judge: 'judge', council: 'council' };
/** Other people playing, drawn like everyone else; a resident's agent follows them. */
const personAsNpc = (p) => ({
  id: p.id, name: ROLE_TAGS[p.role] ? `${p.name} · ${ROLE_TAGS[p.role]}` : p.name, kind: p.role === 'companion' ? 'companion' : 'person', role: p.role,
  look: p.look, pos: p.pos, move: p.move ?? null, follow: Boolean(p.follow), status: p.look?.revoked ? 'revoked' : 'active', owner: p.owner ?? null,
  bubble: p.bubble ?? null, say: p.say ?? null,
});

function updateSprites(dt) {
  const seen = new Set();
  const followers = new Map(); // leader id -> how many follow it so far
  for (const n of [...W.npcs, ...(W.people ?? []).map(personAsNpc)]) {
    seen.add(n.id);
    if (n.id === playing) {
      const sp = sprites.get(n.id);
      if (sp) Object.assign(sp, { npc: n, look: npcLook(n), x: player.x, y: player.y });
      continue;
    }
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
    if (n.say && s.sayShown !== n.say.at) {
      s.sayShown = n.say.at;
      say_(s, n.say.text);
    }
  }
  for (const id of sprites.keys()) if (!seen.has(id)) sprites.delete(id);
}

// ---------------------------------------------------------------------------
// Places and what the keepers say
// ---------------------------------------------------------------------------

const PLACES = [
  ...town.buildings.map((b) => ({ id: b.id, name: b.name, front: b.front, rect: { x: b.x * TILE, y: b.y * TILE, w: b.w * TILE, h: b.h * TILE } })),
  { id: 'board', name: 'Notice board', front: SPOTS.board, rect: { x: BOARD.x * TILE - 4, y: (BOARD.y - 0.4) * TILE, w: TILE + 8, h: 1.4 * TILE } },
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
const SHOPFOLK = {
  bramble: ['🐻', 'Bram'], kettle: ['🦊', 'Fennel'], bakery: ['🐭', 'Crumb'], apothecary: ['🐇', 'Sage'], cafe: ['🦢', 'Odile'], pawn: ['🦝', 'Old Rackham'], tavern: ['🐗', 'Barrow'], grocer: ['🐐', 'Saffi'],
  bank: ['🐢', 'Teller Shell'], forge: ['🦫', 'Forgemaster Bea'], fair: ['🐿️', 'Nutmeg'], toll: ['🦆', 'Dabble'], exchange: ['🐂', 'Bullock'],
};
/** What a place says to you in person, by its rule for people. */
const PEOPLE_GREET = {
  check: () => 'the doorman looks you up and down. "Human, are we?"',
  passkey: (n) => `welcome to ${n}. People sign in to their account here, with a passkey.`,
  worldid: () => 'one per person: show your World ID, please.',
  agents_only: () => 'this desk is for agents only, I’m afraid.',
};
const ATTITUDE = {
  none: (n) => `welcome to ${n}. Badges? Never looked at one. Cash is cash.`,
  block: (n) => `welcome to ${n}. No agents! The sign says so. (I can't actually tell, mind.)`,
  pilot: (n) => `welcome to ${n}. We're trying badges: small orders don't need one, bigger ones do.`,
};

function greetingFor(id) {
  const policy = W.director?.places.find((p) => p.id === id);
  if (policy) {
    const shop = SHOPFOLK[id] ?? ['🏪', 'The keeper'];
    const who = policy.keeper ? `${policy.keeper} (a person playing):` : `${shop[1]}:`;
    const inPerson = S?.acting !== 'agent';
    const text = ATTITUDE[policy.effective]?.(policy.name)
      ?? (inPerson ? PEOPLE_GREET[policy.people]?.(policy.name) ?? `come in! ${policy.name} takes people at their word.` : `welcome to ${policy.name}. From agents we ask for ${policy.summary.replace(/^Checks badges · /, '').replace(/no badge: [^·]+· ?/, '')}.`);
    return { face: shop[0], who, text };
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
  } else if (k === 'x') {
    toggleXray();
  } else if (k === 't') {
    run({ id: 'play', label: 'Who you play' }, {});
  }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

// For checking the game from a browser's console: open the town with ?debug.
if (new URLSearchParams(location.search).has('debug')) window.agenttown = { player, companion, standIn, sprites, view, get playing() { return playing; } };

canvas.addEventListener('pointerdown', (e) => {
  if (busyNow()) return;
  const wx = e.clientX / view.scale + view.x;
  const wy = e.clientY / view.scale + view.y;
  if (companion.active && Math.hypot(companion.x - wx, companion.y - 12 - wy) < 16) return agentMenu('agent');
  for (const s of sprites.values()) {
    if (s.id === playing || !(Math.hypot(s.x - wx, s.y - 14 - wy) < 16) || s.npc.status === 'gone') continue;
    return s.npc.kind === 'helper' && s.npc.owner === S?.me?.id ? agentMenu(s.id) : talkTo(s);
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
  // Open at once with the list fetched in the background, so the first keystrokes land in the search.
  if (!A.length || Date.now() - actionsAt > 6000) await loadActions();
  const next = isAgent() && S ? nextQuest(S, counts) : null;
  const choice = await openPalette({
    actions: A,
    pin: next ? { key: next.action, text: next.text } : null,
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

/** Your agent, or one of its sub-agents, clicked: play it, send it somewhere, call it over, or hand it to your own AI agent. */
async function agentMenu(target) {
  const isAgent = target === 'agent';
  const h = isAgent ? null : S?.helpers?.find((x) => x.id === target);
  const name = isAgent ? S?.agent?.name : h?.name;
  if (!name) return;
  const c = W.me?.companion;
  const driver = isAgent ? c?.client : S.helperPairs?.find((p) => p.helper === target)?.client;
  const busy = isAgent ? c?.errand : h?.busy;
  const r = await say({
    face: isAgent ? '🤖' : '🌱', who: name, where: isAgent ? 'Your agent' : `${S.agent.name}'s sub-agent${h.unregistered ? ', unregistered' : ''}`,
    text: `${busy ? `Out on an errand: ${busy}. ` : ''}${driver ? `${driver} is driving it. ` : ''}${isAgent ? 'Your agent stays where it is until you send it somewhere, call it over, or play it.' : `It stays where it is until it's sent somewhere. You instruct ${S.agent.name}, and ${S.agent.name} instructs its sub-agents, unless you play one yourself.`}`,
    choices: [
      ...(driver ? [] : [{ label: `Play ${name}`, value: 'play', primary: true }]),
      { label: isAgent ? 'Send it on an errand' : `Have ${S.agent.name} send it on an errand`, value: 'errand' },
      { label: 'Call it over', value: 'call' },
      { label: driver ? `Disconnect ${driver}` : 'Connect your own AI agent to it', value: driver ? 'unpair' : 'pair' },
      { label: 'Close', value: null, cancel: true },
    ],
  });
  closeDialog();
  if (!r?.value) return;
  if (r.value === 'play') return run({ id: 'play', label: 'Who you play' }, { as: target });
  if (r.value === 'call') return run(isAgent ? { id: 'agent.call', label: `Calling ${name} over` } : { id: 'helper.call', label: `Calling ${name} over` }, isAgent ? {} : { helper: target });
  if (r.value === 'pair') return connectAgent(target);
  if (r.value === 'unpair') {
    const out = await api.post('/api/pair/end', { target });
    toast(out.ended ? `${driver} is disconnected` : 'Nothing was connected', 'info');
    return refresh();
  }
  // An errand: straight to the deck's question "to do what?".
  await loadActions();
  const choice = await openPalette({
    actions: A, here: null, greeting: null, placeName, nearby: (o) => o,
    focus: isAgent ? { key: 'agent.errand' } : { key: 'helper.errand', params: { helper: target } },
  });
  if (choice) await run(choice.action, choice.params);
}

/** What a run counts toward, for the quests. */
function tally(action, params) {
  if (action.id.startsWith('mischief.')) counts.mischief++;
  if (action.id === 'helper.errand') counts.errands++;
  if (action.id === 'buy' && ['pawn', 'tavern', 'grocer'].includes(params.shop)) counts.oldQuarter++;
  saveCounts();
}

/** What your agent is out doing for you, if anything. */
let errandOut = null;
/** You stay; your agent goes. It walks there on its own, and its result comes back when it's done. */
async function sendAgent(action, params) {
  const name = S?.agent?.name ?? 'Your agent';
  if (errandOut) return toast(`${name} is still out (${errandOut}). Wait for it, or press T to play it.`, 'warn');
  tally(action, params);
  errandOut = action.label;
  toast(`${name} is on its way. You can carry on.`, 'info');
  try {
    const out = await api.post('/api/do', { action: action.id, params });
    while (busyNow()) await wait(250);
    interacting = true;
    try {
      await present(out, action);
    } finally {
      interacting = false;
    }
  } catch (err) {
    toast(err.message, 'bad');
  } finally {
    errandOut = null;
    await refresh();
  }
}

async function run(action, params) {
  if (interacting) return;
  // Switching who you play: whoever you leave stays exactly where you left them.
  if ((action.id === 'play' || action.id === 'acting') && playing !== 'me') params = { ...params, left: { x: Math.round(player.x), y: Math.round(player.y) } };
  // Something you ask your agent to do: it goes, you don't.
  const via = action.via ?? A.find((a) => a.id === action.id && (!action.key || a.key === action.key))?.via;
  if (via === 'agent' && playing === 'me') return sendAgent(action, params);
  interacting = true;
  try {
    if (action.place && !action.info && !(await walkToPlace(action.place))) return;
    const walkTarget = action.params?.flatMap((pm) => (Array.isArray(pm.options) ? pm.options : [])).find((o) => o.walk && Object.values(params).includes(o.value))?.walk;
    if (walkTarget && !(await walkToPlace(walkTarget))) return;
    if (action.id.startsWith('mischief.') && params.at && !(await walkToPlace(params.at))) return;
    // One passkey per account is enough: a second would just be another entry in your password manager.
    if ((action.client === 'passkey' || action.client === 'phone.passkey') && action.done) return toast(`You already have a passkey on ${action.client === 'phone.passkey' ? 'your phone' : 'your door'}. One is enough.`, 'info');
    if (action.client === 'passkey') return await setUpPasskey();
    if (action.client === 'phone.passkey') return await addPasskey('phone');
    if (action.client === 'pair') return await connectAgent(params?.target ?? 'agent');
    if (action.client === 'brief') return await writeBrief();
    if (action.client === 'hall') return await showHall(action.id === 'hall.records' ? 'records' : 'registries');
    if (action.client === 'unpair') {
      const r = await api.post('/api/pair/end');
      return toast(r.ended ? 'Your outside agent is disconnected: its token no longer works' : 'No outside agent was connected', 'info');
    }
    if (action.client === 'record') return await editRecord();
    if (action.client === 'register') {
      await refresh();
      return await showRegister(S);
    }
    if (action.client === 'night') return await nightfall();
    if (action.client === 'receipts') return await showReceipts();
    if (action.id === 'grant' && !S?.grant && !(await signOnPhone(params))) return;
    tally(action, params);
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
    if ('playing' in out) {
      if (out.playing === 'agent') counts.playedAgent = true;
      else if (out.playing !== 'me') counts.playedHelper = true;
      saveCounts();
      await refresh();
      const name = S?.agent?.name ?? 'your agent';
      toast(out.note ?? (out.playing === 'me'
        ? `You're yourself again; ${name} comes back to you. T switches.`
        : out.playing === 'agent'
          ? `You're playing ${name}, your agent. Walk it anywhere: what you do, it does, badge and all. You stand where you were. T switches.`
          : `You're playing ${out.name}, ${name}'s sub-agent. It can do only what ${name} delegated to it. T switches.`), 'info');
    }
    else if ('badge' in out) toast(out.badge ? 'Badge on: places see that someone answers for your agent (but not your name)' : 'Badge off: places will take your agent for a person, if they take people at their word', out.badge ? 'ok' : 'warn');
    if (out.note && 'acting' in out && out.acting === 'agent') toast(out.note, 'warn');
    return;
  }
  if (out.passkeyFor) {
    await card(out, { own: true });
    await addPasskey(out.passkeyFor);
    return;
  }
  if (out.pendingRequest?.auto && (await autoApprove(out))) return;
  if (out.type === 'check' && !out.errand) bubble(playing === 'me' && out.truth === 'agent' && companion.active ? companion : player, out.decision);
  const req = out.pending ?? out.pendingRequest;
  if (req) pending.set(req.request_id, req.retry);
  const choice = await card(out, { own: true, note: req && !out.story ? 'Check your phone (bottom right): you are the principal, so the lock asks you.' : undefined });
  if (choice?.startsWith('consent:')) {
    // Answered on the card, so the phone never needs to ask: share (or not), and try again at once.
    busy(choice === 'consent:decline' ? 'Declining' : 'Sharing, then trying again', '📱');
    const again = await api.post('/api/do', { action: 'consent', params: { ask: out.ask.id, choice: choice.slice(8) } });
    closeDialog();
    return present(again, action);
  }
  if (choice === 'fix' && out.fix?.action) return later(() => run({ id: out.fix.action, label: out.fix.label, place: out.fix.place }, out.fix.params ?? {}));
  if (choice === 'fix' && out.fix?.client) return later(() => clientFix(out.fix));
  if (choice === 'xray' || (xray.on && out.trace?.length)) replay(out);
  if (out.decision === 'allow' && out.result?.items && action?.id !== 'home.discard') await inside(out.result.items);
}

/** Run something once the current action has finished. */
const later = (fn) => setTimeout(fn, 0);

/** A request that waits on a passkey: ask for it now, then carry on. Dismissed, it stays on the phone. */
async function autoApprove(out) {
  const req = out.pendingRequest;
  const problem = api.passkeysUsable();
  if (problem) return false;
  busy(out.headline ?? out.title ?? 'Approve with your passkey', '📱');
  try {
    await api.approveWithPasskey(req.request_id);
  } catch (err) {
    closeDialog();
    pending.set(req.request_id, req.retry);
    toast(err.name === 'NotAllowedError' ? 'Not approved. It is still waiting on your phone.' : err.message, 'warn');
    return true;
  }
  const next = await api.post('/api/do', { action: req.retry.action, params: req.retry.params });
  closeDialog();
  await present(next, { id: req.retry.action });
  return true;
}

/** A fix the browser does itself: a passkey, or the record editor. */
async function clientFix(fix) {
  if (fix.client === 'phone.passkey') {
    if ((await addPasskey('phone')) && fix.then) await run({ id: fix.then.action, label: 'Trying again' }, fix.then.params);
  } else if (fix.client === 'passkey') {
    await addPasskey(fix.service ?? 'door');
  } else if (fix.client === 'record') {
    await run({ id: 'record', label: 'Your record', place: 'records', client: 'record' }, {});
  }
}

/**
 * A pairing code, and how to give it to your own AI agent: for your agent, or one of its sub-agents. A
 * shopkeeper's agent minds the counter instead.
 */
async function connectAgent(target = 'agent') {
  await refresh();
  const shop = S.me?.role === 'shopkeeper';
  if (!shop && (!S.agent || S.agent.status === 'revoked')) return toast('Start an agent first: your outside agent will drive it.', 'warn');
  const r = await api.post('/api/pair', shop ? {} : { target });
  const sub = !shop && r.target !== 'agent' ? S.helpers.find((h) => h.id === r.target) : null;
  const url = r.mcp;
  const block = (label, text) => `<div class="pair-block"><b>${esc(label)}</b><pre><code>${esc(text)}</code></pre><button class="quiet small" data-copy="${esc(text)}">Copy</button></div>`;
  await showCard(`
    <header><div><span class="eyebrow">Connect your own agent</span><h3>Pairing code <code class="pair-code">${esc(r.code)}</code></h3></div><div class="stamp info">2 hours</div></header>
    <p class="why">${shop
    ? `Give this code to your own AI agent. It will mind the counter at ${esc(S.place.name)} with you: look at each customer's check, change what you ask for, report a customer. You can change anything it does.`
    : sub
      ? `Give this code to your own AI agent. It will drive ${esc(sub.name)}, ${esc(S.agent.name)}'s sub-agent: run errands where they happen, within what ${esc(S.agent.name)} delegated to it. It can't ask you anything; a sub-agent answers a place's questions only where your record already says yes.`
      : `Give this code to your own AI agent. It will drive ${esc(S.agent.name)}: walk the town, shop, answer places. You stay the principal: anything that needs a passkey still comes to your phone here, and the agent can't approve it.`}</p>
    ${block('Claude Code', `claude mcp add --transport http agenttown "${url}"`)}
    ${block('Any MCP client (streamable HTTP)', url)}
    ${block('Claude Desktop and other stdio clients (from the AgentTown folder)', `node bin/agenttown-mcp.js --url ${location.origin} --code ${r.code}`)}
    ${block('A shell', `node bin/agenttown.js pair ${r.code} --url ${location.origin}`)}
    ${block('Or just tell your agent', shop ? `Read ${r.guide} and mind my counter at ${S.place.name} in AgentTown. The pairing code is ${r.code}.` : sub ? `Read ${r.guide} and play AgentTown as ${sub.name}, my agent's sub-agent. The pairing code is ${r.code}.` : `Read ${r.guide} and play AgentTown as my agent. The pairing code is ${r.code}.`)}
    <p class="muted small">Give it a brief, too: ${shop ? '“Brief it”, above your customers' : 'Actions → Give your outside agent a brief'}. Anyone with this code can ${shop ? 'mind your counter' : 'drive your agent'} until it expires or you disconnect it. It never gets your own session.</p>
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Done</button></div>`);
}

/**
 * The Hall of Registries (Town Hall) or of Record Keepers (the Records Office): every federation the town knows,
 * with its members, and two ways to add more. Places decide for themselves which federations to trust.
 */
const FED_KIND = { town: 'The town’s federation', participants: 'Run by the town for participants: a registry or record keeper can be admitted', outside: 'Added by its trust anchor’s address' };
async function showHall(which = 'registries') {
  const { federations } = await api.get('/api/federations');
  const fedHtml = federations.map((f) => {
    const check = (id) => `<button class="small quiet" data-check="${esc(id)}" title="Probe what it must answer, without changing anything">Check</button><div class="check" data-for="${esc(id)}"></div>`;
    const regs = f.registries.map((r) => `<li>🏛️ <b>${esc(r.name)}</b> <small class="muted">${esc(r.url ?? '')}${r.chain === 'verified' ? '' : ' · not answering yet'}</small> ${check(r.id)}</li>`).join('');
    const rks = f.recordKeepers.map((k) => `<li>🗄️ <b>${esc(k.name)}</b> <small class="muted">${esc((k.roles ?? []).join(', '))}${k.accredited ? ' · accredited by a registry here' : ' · not accredited yet'}</small> ${check(k.id)}</li>`).join('');
    return `<section class="fed"><h4>${esc(f.name)}</h4><small class="muted">${esc(FED_KIND[f.kind] ?? '')} · trust anchor <code>${esc(f.url)}</code>${f.acceptsTownVerifier ? '' : ' · doesn’t accept the town’s ID verifier'}</small>
      <ul>${(which === 'records' ? rks + regs : regs + rks) || '<li class="muted">No registries or record keepers yet.</li>'}</ul></section>`;
  }).join('');
  const a = S?.agent;
  const mine = a?.registered ? `<p class="why">${esc(a.name)} is registered at <b>${esc(a.registry)}</b>${a.federation ? `, in ${esc(a.federation)}` : ''}; its grant is kept at <b>${esc(a.keeper ?? '…')}</b>.</p>` : '';
  const choice = await showCard(`
    <header><div><span class="eyebrow">${which === 'records' ? 'Records Office' : 'Town Hall'}</span><h3>${which === 'records' ? 'The Hall of Record Keepers' : 'The Hall of Registries'}</h3></div><div class="stamp info">proposed</div></header>
    <p class="why">Anyone can run a registry or a record keeper. Whether a place takes its word is up to the place: each one chooses which federations it trusts, and a federation is whoever its trust anchor vouches for. ${which === 'records' ? 'Your grant is kept by a record keeper in your registry’s own federation.' : 'Register your agent at any counter here: Actions → Register.'}</p>
    ${mine}${fedHtml}
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Done</button></div>`, [
    { label: 'Admit a registry or record keeper', value: 'admit' },
    { label: 'Add a federation by address', value: 'federation' },
  ]);
  if (choice === 'federation') return addFederation();
  if (choice === 'admit') return admitService();
}

/** The check at the door, as a list: passed, failed, or not yet. */
const checkHtml = (c) => `<p class="small"><b>${esc(c.passed)} passed${c.failed ? `, ${esc(c.failed)} failed` : ''}</b></p><ul class="checks">${c.results.map((r) => `<li class="${r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'warn'}">${r.ok === true ? '✓' : r.ok === false ? '✗' : '…'} ${esc(r.check)} <small class="muted">${esc(r.detail)}</small></li>`).join('')}</ul>`;
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-check]');
  if (!b) return;
  const out = document.querySelector(`.check[data-for="${CSS.escape(b.dataset.check)}"]`);
  b.disabled = true;
  out.innerHTML = '<p class="small muted">Checking…</p>';
  try {
    out.innerHTML = checkHtml(await api.post('/api/participants/check', { entity_id: b.dataset.check }));
  } catch (err) {
    out.innerHTML = `<p class="small bad">${esc(err.message)}</p>`;
  } finally {
    b.disabled = false;
  }
});

/** A whole federation, by its trust anchor's address, and (to be sure of its key) a thumbprint to pin. */
async function addFederation() {
  const sample = W.director?.sample;
  const known = sample && (W.director.federations ?? []).some((f) => f.url === sample.url);
  const r = await say({
    face: '🏛️', who: 'Add a federation', where: 'Hall of Registries',
    text: `Give its trust anchor's address, like http://192.168.1.20:4100. The town reads whom the anchor vouches for. To be sure it's the right anchor, put its key's thumbprint after the address; otherwise the town takes the key it's shown and tells you the thumbprint to check.${sample && !known ? `\n\n${sample.name} is running at ${sample.url}.` : ''}`,
    input: { label: 'Trust anchor', value: sample && !known ? sample.url : '', max: 300, placeholder: 'http://…' },
    choices: [{ label: 'Add it', value: true, primary: true }, { label: 'Cancel', value: false, cancel: true }],
  });
  closeDialog();
  if (!r?.value || !r.input) return;
  const [url, pin] = r.input.split(/\s+/);
  busy('Reading its trust anchor', '🏛️');
  try {
    const f = await api.post('/api/federations', { url, pin });
    closeDialog();
    await say({ face: '🏛️', who: f.name, where: 'Added to the town', text: `${f.registries.length} registr${f.registries.length === 1 ? 'y' : 'ies'} and ${f.recordKeepers.length} record keeper${f.recordKeepers.length === 1 ? '' : 's'}. Its anchor's key has thumbprint **${f.thumbprint}**${f.pinned ? ', as you pinned' : ': check it with whoever runs it'}.\n\nNo place trusts it yet. Shopkeepers choose in their panel; the director can make every place trust it.${f.acceptsTownVerifier ? ' It accepts the town’s ID verifier, so you can register an agent at its counter.' : ''}` });
    closeDialog();
  } catch (err) {
    closeDialog();
    toast(err.message, 'bad');
  }
}

/** One registry or record keeper, into the participants' federation the town runs: by its address, or by its entity statement. */
async function admitService() {
  const r = await say({
    face: '🗄️', who: 'Admit a registry or record keeper', where: 'AgentTown Participants',
    text: 'Give its address. The town reads what it says about itself there (its OpenID Federation Entity Configuration) and admits it to AgentTown Participants, a federation the town runs for teams bringing their own implementations. Point your service at that federation’s trust anchor (it’s listed in the hall).\n\nIf your service can’t start until it’s a member, paste its entity statement (JSON: entity_id, entity_type, jwks, metadata) instead.',
    input: { label: 'Address or statement', value: '', max: 6000, placeholder: 'http://… or {"entity_id": …}' },
    choices: [{ label: 'Admit it', value: true, primary: true }, { label: 'Cancel', value: false, cancel: true }],
  });
  closeDialog();
  if (!r?.value || !r.input) return;
  let body;
  try {
    body = r.input.startsWith('{') ? { statement: JSON.parse(r.input) } : { url: r.input };
  } catch {
    return toast('That statement isn’t valid JSON.', 'bad');
  }
  busy('Reading it, and admitting it', '🗄️');
  try {
    const a = await api.post('/api/participants', body);
    closeDialog();
    await showCard(`
      <header><div><span class="eyebrow">AgentTown Participants</span><h3>${esc(a.name)} is admitted</h3></div><div class="stamp ${a.check?.failed ? 'warn' : 'ok'}">${a.type === 'aaf_registry' ? 'registry' : 'record keeper'}</div></header>
      <p class="why">${a.type === 'aaf_registry' ? 'It can now accredit record keepers in this federation. ' : 'A registry here has to accredit it before places rely on its records. '}No place trusts AgentTown Participants until it chooses to.${a.names_this_anchor || !a.check ? '' : ' It doesn’t name this federation’s trust anchor yet: point it at the bootstrap from /trust-anchor.json.'}</p>
      ${a.check ? `<h5>The check at the door</h5>${checkHtml(a.check)}` : '<p class="muted small">Admitted by its statement: check it from the hall once it’s running.</p>'}
      <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Done</button></div>`);
  } catch (err) {
    closeDialog();
    toast(err.message, 'bad');
  }
}

/** What you want your outside agent to do. It reads it when it looks; it can't approve anything. */
async function writeBrief() {
  await refresh();
  const shop = S.me?.role === 'shopkeeper';
  const r = await say({
    face: '📋', who: 'A brief for your agent', where: shop ? S.place.name : S.agent?.name ?? '',
    text: shop ? 'What should your agent do at the counter? It reads this when it looks.' : 'What should your outside agent do? It reads this when it looks. Anything that needs your passkey still comes to you.',
    input: { label: 'Brief', value: S.brief?.text ?? '', max: 400, placeholder: shop ? 'e.g. Ask for proof of age; report forged badges' : 'e.g. Win the reading nook race within my limits' },
    choices: [{ label: 'Save', value: true, primary: true }, { label: 'Cancel', value: false, cancel: true }],
  });
  closeDialog();
  if (!r?.value) return;
  await api.post('/api/pair/brief', { text: r.input });
  toast(r.input ? 'Brief saved: your agent sees it when it looks' : 'Brief cleared', 'ok');
  await refresh();
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  navigator.clipboard?.writeText(b.dataset.copy).then(() => toast('Copied', 'ok'), () => toast('Copy it by hand: the clipboard is not available here', 'warn'));
});

async function editRecord() {
  await refresh();
  if (!S.record) return toast('Tell Town Hall your name first.', 'warn');
  const next = await openRecordEditor(S);
  if (!next) return;
  busy('Signing your record', '🗂️');
  const out = await api.post('/api/do', { action: 'record.set', params: { record: next } });
  closeDialog();
  await present(out, { id: 'record.set' });
}

const PASSKEY_FOR = { door: 'your front door', phone: 'your phone' };
async function addPasskey(service = 'door') {
  const problem = api.passkeysUsable();
  if (problem) {
    await say({ face: '🔑', who: 'Passkeys', text: problem });
    closeDialog();
    return false;
  }
  busy('Waiting for your passkey', '🔑');
  try {
    await api.registerPasskey(service);
    closeDialog();
    toast(`Passkey set on ${PASSKEY_FOR[service] ?? `your account at ${S?.places?.[service.slice(6)]?.name ?? 'that place'}`}`, 'ok');
    await refresh();
    return true;
  } catch (e) {
    closeDialog();
    toast(e.name === 'NotAllowedError' ? 'The passkey prompt was dismissed.' : e.message, 'bad');
    return false;
  }
}

/** Answer a place's question: share once, always, or decline. */
async function answer(askId, choice) {
  await run({ id: 'consent', label: choice === 'decline' ? 'Declining' : 'Sharing, then trying again' }, { ask: askId, choice });
}

/** The principal signs the grant on their phone: what the agent may do, in plain words. */
async function signOnPhone({ budget = 50 }) {
  const name = S?.agent?.name ?? 'Your agent';
  const r = await say({
    face: '📱', who: 'Your phone', where: 'Sign a grant',
    text: `**${name} may:**\n• buy books, home goods, food and health goods, up to $${budget} each\n• pay bills up to $${budget}\n• trade up to $${budget} an order\n• rent compute, up to 8 GPU-hours\n• come and go at home\n\nNothing else. Places will see only the part that covers what ${name} asks them for. Sign it?`,
    choices: [{ label: 'Sign', value: true, primary: true }, { label: 'Not now', value: false, cancel: true }],
  });
  closeDialog();
  return r.value;
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
  await addPasskey('door');
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
    const kinds = { person: n.role ? 'someone playing' : 'a person, in person', companion: 'an agent following its resident', resident: 'a resident’s agent', helper: 'a sub-agent', swarm: 'a masked agent from the Old Mill', bot: 'a hooded figure with no badge', newcomer: 'a newcomer', unbadged: 'an honest agent nobody ever registered' };
    const r = await say({ face: '🔍', who: n.name, where: kinds[n.kind] ?? '', text: n.busy ? `Out on an errand: ${n.busy}.` : n.status !== 'active' ? `Status: ${n.status}.` : 'Ask to see their badge?', choices: [{ label: 'Ask to see their badge', value: true, primary: true }, { label: 'Leave them be', value: false, cancel: true }] });
    closeDialog();
    if (!r.value) return;
    const out = await api.post('/api/do', { action: 'id.ask', params: { npc: n.id } });
    if ((await card(out)) === 'xray') replay(out, s);
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
  const [info, { board }] = await Promise.all([api.get('/api/info'), api.get('/api/board')]);
  const standing = (e, i) => `${i + 1}. ${esc(e.name)}${e.by ? ` · ${esc(e.by)}` : ''}: ${e.finished ? `${esc(e.finished.seconds)} s, $${esc(e.finished.left)} to spare` : `${esc(e.met)}/${esc(e.of)}`}`;
  const races = board.map((c) => `<li><b>🏁 ${esc(c.name)}</b> ($${esc(c.budget)}): ${esc(c.blurb)}${c.entries.length ? `<br><small>${c.entries.slice(0, 3).map(standing).join(' · ')}</small>` : ''}</li>`).join('');
  const r = await say({
    face: '📋', who: 'Notice board', where: 'Town Square',
    html: `<ul class="notices">
      <li>Press <b>Q</b> for the action deck: everything you can do in town, wherever you are.</li>
      <li><b>Civic Row</b> (north): Town Hall, the Records Office, the Courthouse, the Orb.</li>
      <li><b>Market Lane</b> (west): books, kettles, bread, the bank. <b>The Works</b> (north-east): the Compute Forge.</li>
      <li><b>Hearthside</b> (east): homes. Hearth &amp; Key reminds residents to put a passkey on their door.</li>
      <li><b>The Harbor</b> (south, over the toll bridge): the EU registry and Café Lumière, under EU rules.</li>
      <li><b>The Old Quarter</b> (far east): a pawn shop that checks nothing, a tavern that bans agents, a grocer trying badges out. Willow Apothecary sits on the way.</li>
      <li>Press <b>X</b> for the <b>X-ray</b>: watch a request travel to the registry, the Records Office and back.</li>
      <li>Lost: one key tag, somewhere in Hearthside. —M. Avoid the Old Mill after dark.</li>
      <li class="muted">This town's federation: ${esc(info.federation)}, trust anchor ${esc(info.trust_anchor)}; registries: ${info.registries.map((r) => esc(r.name)).join(', ')}.</li>
      <li class="extras-title"><b>Errand races</b>: your agent against everyone else's. Only what it buys with its badge on counts.</li>
      ${races}
    </ul>`,
    choices: [...(S?.agent ? board.map((c) => ({ label: `Race: ${c.name}`, value: c.id })) : []), { label: 'Close', value: null, primary: !S?.agent, cancel: Boolean(S?.agent) }],
  });
  closeDialog();
  if (r?.value) later(() => run({ id: 'challenge.join', label: 'Taking on the errand' }, { challenge: r.value }));
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
  const adopt = (p) => d.adoptions.map((a) => `<option value="${esc(a.id)}" ${a.id === p.adoption ? 'selected' : ''}>${esc(a.label)}</option>`).join('');
  document.getElementById('directorBody').innerHTML = `
    <div class="cues">
      <button data-cue="swarm" ${d.swarm ? 'disabled' : ''}>🌫️ Rogue swarm from the Old Mill</button>
      <button data-cue="outage" ${d.outage_until ? 'disabled' : ''}>📡 Registry A outage (45 s)</button>
      <button data-cue="newcomer">🧳 A newcomer arrives</button>
      <button data-cue="night">🌙 Night at your house</button>
      <button data-cue="residents" data-on="${d.residents ? '0' : '1'}">${d.residents ? '⏸ Pause residents' : '▶️ Resume residents'}</button>
      <button data-cue="presenter">${document.body.classList.contains('presenter') ? '🖥 Leave presenter view' : '🖥 Presenter view'}</button>
    </div>
    <h5>Federations <span class="muted">(each place chooses which to trust)</span></h5>
    <ul class="feds">${(d.federations ?? []).map((f) => `<li><b>${esc(f.name)}</b> <small class="muted">${esc(FED_KIND[f.kind] ?? '')} · ${f.registries.length} registr${f.registries.length === 1 ? 'y' : 'ies'}, ${f.recordKeepers.length} record keeper${f.recordKeepers.length === 1 ? '' : 's'} · ${d.places.filter((p) => !p.anchors || p.anchors.includes(f.key)).length} of ${d.places.length} places trust it</small>
      <span class="btns"><button class="small" data-trust="${esc(f.key)}" data-on="1">Every place trusts it</button><button class="small quiet" data-trust="${esc(f.key)}" data-on="0">None does</button></span></li>`).join('')}</ul>
    <div class="cues"><button data-cue="sample" ${d.sample ? 'disabled' : ''}>🏘️ ${d.sample ? `Riverside Co-op runs at ${esc(d.sample.url)}` : 'Start a sample outside federation (Riverside Co-op)'}</button></div>
    <h5>The law <span class="muted">(registries and record keepers never change)</span></h5>
    ${lawHtml(d.law, { compact: true })}
    <h5>How much of town uses the framework</h5>
    ${presetsHtml(d.law)}
    ${scoreboardHtml(d.law.scoreboard, { table: false })}
    <h5>Each place</h5>
    <table class="policies">
      <thead><tr><th>Place</th><th>Uses the framework?</th><th>People without a badge</th><th>Registries</th><th title="An accountable agent with authority">Badge</th><th title="Simulated World ID: one per person">World ID</th><th title="Simulated x402 payment">x402</th></tr></thead>
      <tbody>${d.places.map((p) => `<tr data-place="${p.id}" class="${p.keeper ? 'claimed' : ''}" title="${esc(p.summary)}">
        <td>${esc(p.name)}${p.keeper ? `<small class="muted"> · run by ${esc(p.keeper)}</small>` : ''}</td>
        <td><select data-k="adoption" ${p.keeper ? 'disabled' : ''}>${adopt(p)}</select>${p.effective !== p.adoption ? ' <small class="muted">by law</small>' : ''}</td>
        <td><select data-k="people" ${p.keeper ? 'disabled' : ''}>${d.peoples.map((x) => `<option value="${esc(x.id)}" ${x.id === p.people ? 'selected' : ''}>${esc(x.label)}</option>`).join('')}</select></td>
        <td><select data-k="accepts" ${p.keeper ? 'disabled' : ''}>${regOpts(p.accepts)}</select></td>
        <td><input type="checkbox" data-k="aaf" ${p.aaf === 'required' ? 'checked' : ''} ${p.keeper ? 'disabled' : ''}></td>
        <td><input type="checkbox" data-k="worldid" ${p.worldid ? 'checked' : ''} ${p.keeper ? 'disabled' : ''}></td>
        <td><input type="checkbox" data-k="x402" ${p.x402 ? 'checked' : ''} ${p.keeper ? 'disabled' : ''}></td>
      </tr>`).join('')}</tbody>
    </table>
    <p class="muted small">A place run by a person playing is theirs to set. World ID and x402 are simulated in this town; the framework checks are real.</p>`;
}

document.getElementById('directorBody').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-cue]');
  if (!b) return;
  const cue = b.dataset.cue;
  if (cue === 'presenter') {
    document.body.classList.toggle('presenter');
    return renderDirector();
  }
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
  const law = e.target.dataset.law;
  if (law) {
    const [jurisdiction, regime] = law.split(':');
    const res = await api.post('/api/director', { cue: 'law', params: { jurisdiction, regime, on: e.target.checked } });
    toast(res.text, 'info');
    return poll();
  }
  const row = e.target.closest('[data-place]');
  if (!row) return;
  const k = e.target.dataset.k;
  if (k === 'adoption') {
    const res = await api.post('/api/director', { cue: 'adoption', params: { place: row.dataset.place, mode: e.target.value } });
    toast(res.text, res.ok === false ? 'warn' : 'info');
    return poll();
  }
  const v = k === 'accepts' ? (e.target.value === '*' ? null : [e.target.value]) : k === 'aaf' ? (e.target.checked ? 'required' : 'off') : k === 'x402' ? (e.target.checked ? 0.5 : null) : k === 'people' ? e.target.value : e.target.checked;
  const res = await api.post('/api/director', { cue: 'policy', params: { place: row.dataset.place, patch: { [k]: v } } });
  toast(res.text, 'info');
  await poll();
});
document.getElementById('directorBody').addEventListener('click', async (e) => {
  const trust = e.target.closest('[data-trust]');
  if (trust) {
    const res = await api.post('/api/director', { cue: 'trust', params: { key: trust.dataset.trust, on: trust.dataset.on === '1' } });
    toast(res.text, res.ok === false ? 'warn' : 'info');
    return poll();
  }
  const preset = e.target.closest('[data-preset]')?.dataset.preset;
  if (!preset) return;
  const res = await api.post('/api/director', { cue: 'adoption', params: { preset } });
  toast(res.text, 'info');
  await poll();
});
document.getElementById('directorBtn').addEventListener('click', () => toggleDirector());
document.getElementById('directorClose').addEventListener('click', () => toggleDirector(false));
document.getElementById('deckBtn').addEventListener('click', () => !busyNow() && deck());
document.getElementById('badgeBtn').addEventListener('click', () => !busyNow() && run({ id: 'badge', label: 'badge' }, {}));
// The kill switch works whoever you play: stopping your agents is always yours to do.
document.getElementById('stopBtn').addEventListener('click', async () => {
  if (busyNow()) return;
  if (S?.halted) return run({ id: 'agents.resume', label: 'Starting your agents again' }, {});
  const name = S?.agent?.name ?? 'your agent';
  const r = await say({
    face: '⏹️', who: 'Stop everything', where: 'Your device',
    text: `${name}${S?.helpers?.length ? ' and its sub-agents' : ''} stop where they are, and anything on its way to an errand stops there${S?.grant ? `. ${name}'s grant is revoked, and every budget it delegated with it` : ''}${S?.paired ? `. ${S.paired.client} is disconnected` : ''}. Stop everything?`,
    choices: [{ label: 'Stop everything', value: true, primary: true }, { label: 'Not now', value: false, cancel: true }],
  });
  closeDialog();
  if (r?.value) run({ id: 'stop.all', label: 'Stopping everything' }, {});
});
document.getElementById('xrayBtn').addEventListener('click', () => toggleXray());
document.getElementById('actBtn').addEventListener('click', () => !busyNow() && run({ id: 'play', label: 'Who you play' }, {}));
document.getElementById('townScore').addEventListener('click', () => {
  if (busyNow() || !W.director) return;
  showCard(`<header><div><span class="eyebrow">The town</span><h3>How much of town uses the framework</h3></div></header>
    <p>Places choose whether to check badges, and the law can make them. The registries and record keepers are the same either way.</p>
    ${scoreboardHtml(W.director.law.scoreboard)}
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`);
});

// ---------------------------------------------------------------------------
// The X-ray
// ---------------------------------------------------------------------------

const xray = createXray({ town, panel: document.getElementById('xray') });
document.getElementById('xray').addEventListener('click', (e) => {
  if (e.target.closest('[data-xray-close]')) xray.close();
});
function toggleXray() {
  xray.on = !xray.on;
  document.getElementById('xrayBtn').classList.toggle('on', xray.on);
  toast(xray.on ? 'X-ray on: watch what each request sends, and to whom' : 'X-ray off', 'info');
  if (!xray.on) xray.close();
}

/** Replay one request's plumbing, pulling the camera back to fit it all in. */
function replay(c, who = null) {
  // The agent made its request standing at the door; your badge reader is wherever you are.
  const door = placeFront(town, c.building ?? c.placeId);
  const actor = who ? () => ({ x: who.x, y: who.y }) : door ? () => ({ x: door.x - 22, y: door.y + 8 }) : () => ({ x: player.x, y: player.y });
  const placePos = c.placeId === 'reader' ? () => ({ x: player.x, y: player.y }) : null;
  const box = xray.bounds(c, actor, placePos);
  if (!xray.play(c, actor, { own: true, placePos }) || !box) return;
  counts.xray++;
  saveCounts();
  const w = box.x1 - box.x0 + 8 * TILE;
  const h = box.y1 - box.y0 + 8 * TILE;
  view.zoomTarget = Math.max(0.3, Math.min(1, innerWidth / view.base / w, innerHeight / view.base / h));
  camFocus = { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 + 20 };
  clearTimeout(replay.timer);
  replay.timer = setTimeout(() => {
    view.zoomTarget = 1;
    if (!scene) camFocus = null;
  }, xray.durationOf(c) + 900);
}
document.addEventListener('lens-opened', () => {
  counts.lens++;
  saveCounts();
});

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
const MINI_DOTS = { helper: '#5fd38a', resident: '#f2a541', swarm: '#9b6cff', bot: '#7d8590', newcomer: '#ff8fab', unbadged: '#c9a77c', person: '#e07a5f', companion: '#9fbbe0' };
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
  xray.drawMini(miniCtx, performance.now(), s, ox, oy);
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
const PERSON = PEOPLE_LOOKS;

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
  saveCounts();
  if (!isAgent()) {
    const panel = document.getElementById('rolePanel');
    if (!panel.contains(document.activeElement) && !panel.matches(':hover')) renderRolePanel(S);
    player.look = PERSON[S.me.role];
    player.label = `${S.me.name} · ${S.me.role}`;
    if (S.phone && renderPhone(S)) toast('Your phone buzzed', 'warn');
    return;
  }
  renderHud(S, counts);
  if (renderPhone(S)) toast('Your phone buzzed', 'warn');
  if (!paletteOpen()) loadActions().catch(() => {});
  if (S.playing && S.playing !== playing) becomePlaying(S.playing);
  if (playing !== 'me' && playing !== 'agent' && !helperIds().has(playing)) becomePlaying('me');
  player.look = lookOfPlayed();
  player.label = playing === 'me' ? 'You' : `${playedName()} (you)`;
  document.getElementById('badgeBtn').classList.toggle('on', S.badge);
  document.getElementById('badgeBtn').hidden = !S.agent || !S.agent.registered;
  const stop = document.getElementById('stopBtn');
  stop.hidden = !S.agent || S.agent.status === 'revoked';
  stop.classList.toggle('halted', Boolean(S.halted));
  stop.innerHTML = S.halted ? '<span>▶</span> Start again' : '<span>⏹</span> Stop everything';
  const act = document.getElementById('actBtn');
  act.hidden = !S.agent || S.agent.status === 'revoked';
  act.innerHTML = `<span>${playing === 'me' ? '🧍' : playing === 'agent' ? '🤖' : '🌱'}</span> Playing: ${esc(playing === 'me' ? 'you' : playedName())} <kbd>T</kbd>`;
  act.title = 'Who you play. Whoever you play walks and does what you pick; T switches.';
  act.classList.toggle('on', playing !== 'me');
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
let actionsAt = 0;
async function loadActions() {
  A = (await api.get('/api/actions')).actions;
  actionsAt = Date.now();
}

async function poll() {
  try {
    const me = playing === 'me' ? player : standIn;
    const played = playing === 'me' ? '' : `&as=${encodeURIComponent(playing)}&ax=${Math.round(player.x)}&ay=${Math.round(player.y)}`;
    W = await api.get(`/api/world?since=${seq}&x=${Math.round(me.x)}&y=${Math.round(me.y)}${played}`);
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
      if (e.reveal) reveal(e.text);
      if (e.kind === 'policy' && S?.me?.role === 'council') refresh();
      if (xray.on && e.card?.trace && !e.mine) {
        const sp = sprites.get(e.who);
        if (sp && e.card.placeId !== 'reader' && Math.hypot(sp.x - player.x, sp.y - player.y) < Math.max(view.w, view.h)) xray.play(e.card, () => ({ x: sp.x, y: sp.y }));
      }
    }
    ledger = [...ledger, ...W.events].slice(-200);
    seq = W.events.at(-1).seq; // the server sends the oldest unseen first: carry on from there
    renderLedger(ledger);
  }
  if (!document.getElementById('director').hidden && !document.activeElement?.closest?.('#director')) renderDirector();
  document.getElementById('outage').hidden = !W.director?.outage_until;
  const board = W.director?.law?.scoreboard;
  if (board) document.getElementById('townScore').innerHTML = `<b>${board.adopted}/${board.of}</b> places check badges · <b>${board.totals.unseen}</b> visits unchecked`;
}

/** A court order is public: everyone sees what it found. */
let revealTimer = null;
function reveal(text) {
  const el = document.getElementById('reveal');
  el.textContent = `⚖️ ${text}`;
  el.hidden = false;
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => { el.hidden = true; }, 12000);
}
document.getElementById('reveal').addEventListener('click', (e) => { e.currentTarget.hidden = true; });

/** A visit's ID card, with what your role can do about it. */
async function visitCard(ev) {
  const role = S?.me?.role;
  const c = ev.card;
  const buttons = [];
  if (c.ppid && ((role === 'shopkeeper' && c.placeId === S.me.claim) || (role === 'homeowner' && c.account === S.me.claim))) {
    buttons.push({ label: 'File with the police', value: 'police.file' }, { label: 'Report to its registry', value: role === 'shopkeeper' ? 'shop.report' : 'door.report' });
  }
  if (c.ppid && role === 'police') buttons.push({ label: 'Open a case about this badge', value: 'case.open' });
  const choice = await card(c, { buttons, own: ev.mine });
  if (choice === 'xray') {
    const sp = ev.mine ? player : sprites.get(ev.who);
    return replay(c, sp ? { x: sp.x, y: sp.y } : null);
  }
  if (choice?.startsWith('consent:') || choice === 'fix') return;
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
  if (act === 'pair') return connectAgent();
  if (act === 'brief') return writeBrief();
  if (act === 'unpair') {
    const r = await api.post('/api/pair/end');
    toast(r.ended ? 'Your outside agent is disconnected: its token no longer works' : 'No outside agent was connected', 'info');
    return refresh();
  }
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
rolePanel.addEventListener('click', async (e) => {
  const preset = e.target.closest('[data-preset]')?.dataset.preset;
  if (preset && !busyNow()) await doRole('adoption.preset', { preset });
});
rolePanel.addEventListener('change', async (e) => {
  const law = e.target.dataset.law;
  if (law) {
    const [jurisdiction, regime] = law.split(':');
    e.target.blur();
    return doRole('law.set', { jurisdiction, regime, on: e.target.checked });
  }
  if (e.target.dataset.anchor) {
    const anchors = [...rolePanel.querySelectorAll('[data-anchor]:checked')].map((x) => x.dataset.anchor);
    e.target.blur();
    return doRole('shop.policy', { patch: { anchors } });
  }
  const k = e.target.dataset.k;
  if (!k) return;
  if (k === 'adoption') {
    e.target.blur();
    return doRole('shop.adoption', { mode: e.target.value });
  }
  const v = k === 'accepts' ? (e.target.value === '*' ? null : [e.target.value]) : k === 'aaf' ? (e.target.checked ? 'required' : 'off') : k === 'x402' ? (e.target.checked ? 0.5 : null) : k === 'people' || k === 'facts' ? e.target.value : e.target.checked;
  e.target.blur();
  await doRole('shop.policy', { patch: { [k]: v } });
});

document.getElementById('phoneList').addEventListener('click', async (e) => {
  const approve = e.target.closest('[data-approve]');
  const decline = e.target.closest('[data-decline]');
  const consent = e.target.closest('[data-consent]');
  const unconsent = e.target.closest('[data-unconsent]');
  if (e.target.closest('[data-phone-passkey]') && !busyNow()) return addPasskey('phone');
  if (consent && !busyNow()) return answer(consent.dataset.consent, consent.dataset.choice);
  if (unconsent && !busyNow()) return run({ id: 'consent.revoke', label: 'Taking it back' }, { place: unconsent.dataset.unconsent });
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
    toast(pending.has(rid) ? 'Approved with your passkey' : `Approved with your passkey: ${S.agent?.name ?? 'your agent'} carries on`, 'ok');
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
  agent: "You're a **resident** of AgentTown: a person. Walk with **WASD** or the **arrow keys**, or click where you want to go, and shop in person: some places take you at your word, some ask you to sign in with a passkey, the tavern's doorman guesses.\n\nWhen you're ready, get verified at **Town Hall** and register an **agent**: it follows you. Send it on errands while you stay put, or press **T** to play it yourself: whoever you play walks and acts. You answer for what it does. Your **record** at the Records Office says what it may spend and what places may learn; when a place asks for more, your **phone** asks you.\n\nPress **Q** for the **action deck**: everything you can do in town. Some actions are refused; that's the point, and each refusal says how to fix it. Press **X** for the **X-ray**. Play it straight, or try to get away with something: the police and the courts are watching.",
  shopkeeper: "You run this place. Your panel (top left) is your counter: choose which registries you trust and what you ask for, and watch every customer's ID check as it happens.\n\nClick a customer to see exactly what they proved. If one misbehaves, report it to its registry (its principal hears about it) or file it with the police.",
  homeowner: "This house is yours. Put a passkey on your door first. When an agent knocks, your **phone** (bottom right) shows who stands behind it, never who they are, and you decide with your passkey.\n\nYour door log shows every visit. Lost keys are dangerous: change the locks any time.",
  police: "You investigate. Places send cases to your **case board**: suspicious payments, attempted break-ins, odd trading at the Exchange. You can open a case from any line in the town ledger.\n\nBadges don't say who anyone is. To find out, ask the court: it can order a registry to identify the principal, delete rogue agents, or ban a principal.",
  council: "You make the law. Your panel (top left) has the rulebook for the town and for the Harbor: anti-money-laundering, consumer protection, rules for high-risk AI, privacy first.\n\nSwitch one on and watch what places must ask for change, while the registries and record keepers stay exactly the same. You can also set how much of town uses the framework at all: partial adoption is where most towns start.",
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
  const at = { shopkeeper: S.me.claim, homeowner: S.me.claim, police: 'police', judge: 'court', council: 'townhall' }[S.me.role];
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
  updateCompanion(dt);
  if (Math.abs(view.zoom - view.zoomTarget) > 0.002) {
    view.zoom += (view.zoomTarget - view.zoom) * Math.min(1, dt * 2.5);
    applyZoom();
  }

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
  for (const s of sprites.values()) if (s.id !== playing && inView(s.x, s.y)) things.push({ y: s.y, draw: () => drawAgent(ctx, s, t) });
  if (standIn.active) things.push({ y: standIn.y, draw: () => drawAgent(ctx, standIn, t) });
  for (const v of visitors) things.push({ y: v.y, draw: () => drawAgent(ctx, v, t) });
  if (companion.active) things.push({ y: companion.y, draw: () => drawAgent(ctx, companion, t) });
  things.push({ y: player.y, draw: () => drawAgent(ctx, player, t) });
  things.sort((a, b) => a.y - b.y);
  for (const th of things) th.draw();

  drawNight(ctx, town, night, vw);
  xray.draw(ctx, performance.now(), 1 / view.zoom);
  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    const age = t - b.t0;
    if (age > (b.life ?? 2.6)) bubbles.splice(i, 1);
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
