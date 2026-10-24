// Thistledown: the game loop, movement, and what happens at each place.
// Every decision shown comes from the town's real services (see src/town.js).
import {
  TILE, COLS, ROWS, BOARD, KEY_SPOT, POND, SPAWN, BURGLAR_START,
  buildTown, findPath, drawGround, drawWater, drawTree, drawLamp, drawBoard, drawBuilding, drawKey, drawAgent, drawBubble, drawNight,
} from './map.js';
import * as api from './api.js';
import { say, busy, closeDialog, dialogOpen, card, showCard, renderHud, renderPhone, toast, esc, DECISIONS, CLASSIFICATIONS } from './ui.js';

const canvas = document.getElementById('world');
const ctx = canvas.getContext('2d');
const town = buildTown();
const home = town.buildings.find((b) => b.id === 'home');

let S = null; // the town's latest state, from the server
const pending = new Map(); // approval request id -> what to do once you approve it
const lastCards = {}; // shop -> the last ID check there (what that shop knows about you)
let t = 0;

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

const view = { scale: 1, dpr: 1, w: 0, h: 0, x: 0, y: 0 };
let groundCache = null;
let camFocus = null;

function resize() {
  view.dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(innerWidth * view.dpr);
  canvas.height = Math.round(innerHeight * view.dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  view.scale = Math.max(0.55, Math.min(innerWidth / (24 * TILE), innerHeight / (15 * TILE), 3));
  view.w = innerWidth / view.scale;
  view.h = innerHeight / view.scale;
  const k = view.scale * view.dpr;
  groundCache = document.createElement('canvas');
  groundCache.width = Math.ceil(COLS * TILE * k);
  groundCache.height = Math.ceil(ROWS * TILE * k);
  const g = groundCache.getContext('2d');
  g.scale(k, k);
  drawGround(g, town);
}
addEventListener('resize', resize);
resize();

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
// Characters
// ---------------------------------------------------------------------------

const player = { x: SPAWN.x, y: SPAWN.y, facing: { x: 0, y: 1 }, walking: false, phase: 0, path: null, then: null, look: {}, seed: 0 };
const helper = { x: SPAWN.x, y: SPAWN.y, facing: { x: 0, y: 1 }, walking: false, phase: 0, look: { scale: 0.72, body: '#cdeed8', bulb: '#5fd38a', glow: true, badge: 'on' }, seed: 2, shown: false };
const trail = [];
let npcs = [];
const bubbles = [];

function playerLook() {
  if (!S?.agent) return { body: '#fff1d6', bulb: '#cfc6b8', badge: 'none' };
  if (S.agent.status === 'revoked') return { body: '#fff1d6', bulb: '#e05a4f', glow: true, badge: S.badge ? 'on' : 'none', badgeColor: '#f3c1bd', badgeMark: '#c8524a' };
  return { body: '#fff1d6', bulb: S.badge ? '#5fd38a' : '#f2c14e', glow: S.badge, badge: S.badge ? 'on' : 'none' };
}

const tileOf = (p) => ({ x: Math.floor(p.x / TILE), y: Math.floor((p.y - 4) / TILE) });
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

function walkTo(point, then = null) {
  const path = findPath(town, tileOf(player), tileOf(point));
  if (!path) return;
  path.push({ x: point.x, y: point.y });
  player.path = path;
  player.then = then;
}

const bubble = (who, c) => {
  const d = DECISIONS[c.decision] ?? { icon: '•', label: c.decision, tone: 'info' };
  bubbles.push({ who, text: `${d.icon} ${d.label}`, tone: d.tone, t0: t });
};

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const keys = new Set();
const MOVE = { arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1], arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0] };
let scene = false; // true while the night plays out

addEventListener('keydown', (e) => {
  if (dialogOpen() || scene || e.target.tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (MOVE[k]) {
    keys.add(k);
    player.path = null;
    player.then = null;
    e.preventDefault();
  } else if (k === 'e' || k === ' ' || k === 'enter') {
    e.preventDefault();
    const p = nearestPlace();
    if (p) interact(p);
  } else if (k === 'b') {
    toggleBadge();
  }
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

canvas.addEventListener('pointerdown', (e) => {
  if (dialogOpen() || scene) return;
  const wx = e.clientX / view.scale + view.x;
  const wy = e.clientY / view.scale + view.y;
  const hit = PLACES.find((p) => wx >= p.rect.x && wx <= p.rect.x + p.rect.w && wy >= p.rect.y && wy <= p.rect.y + p.rect.h);
  if (hit) return walkTo(hit.front, hit);
  if (!S?.found_key && Math.hypot(wx - (KEY_SPOT.x + 0.5) * TILE, wy - (KEY_SPOT.y + 0.5) * TILE) < 20) return walkTo({ x: (KEY_SPOT.x + 0.5) * TILE, y: (KEY_SPOT.y + 0.6) * TILE });
  walkTo({ x: wx, y: wy });
});

// ---------------------------------------------------------------------------
// Places
// ---------------------------------------------------------------------------

const PLACES = [
  ...town.buildings.map((b) => ({ id: b.id, name: b.name, front: b.front, rect: { x: b.x * TILE, y: b.y * TILE, w: b.w * TILE, h: b.h * TILE } })),
  { id: 'board', name: 'Notice board', front: { x: (BOARD.x + 0.5) * TILE, y: (BOARD.y + 1.6) * TILE }, rect: { x: BOARD.x * TILE - 4, y: (BOARD.y - 0.4) * TILE, w: TILE + 8, h: 1.4 * TILE } },
  { id: 'pond', name: 'Pond', front: { x: (POND.x + 2.5) * TILE, y: (POND.y + POND.h + 0.6) * TILE }, rect: { x: POND.x * TILE, y: POND.y * TILE, w: POND.w * TILE, h: POND.h * TILE } },
];

function nearestPlace() {
  let best = null;
  for (const p of PLACES) {
    const d = Math.hypot(p.front.x - player.x, p.front.y - player.y);
    if (d < 34 && (!best || d < best.d)) best = { ...p, d };
  }
  return best;
}

let interacting = false;
async function interact(place) {
  if (interacting) return;
  interacting = true;
  keys.clear();
  player.walking = false;
  player.facing = { x: 0, y: -1 };
  try {
    await SCRIPTS[place.id]();
  } catch (err) {
    await say({ face: '⚠️', who: 'Something went wrong', text: err.message });
  } finally {
    closeDialog();
    interacting = false;
    await refresh();
  }
}

const SCRIPTS = {
  townhall: townHall,
  records: recordsOffice,
  bramble: () => shop('bramble'),
  kettle: () => shop('kettle'),
  home: frontDoor,
  maple: maplesCottage,
  board: noticeBoard,
  pond,
};

// ---- Town Hall: Registry A ------------------------------------------------

async function townHall() {
  const J = (text, o = {}) => say({ face: '🦉', who: 'Registrar Juniper', where: 'Town Hall · Registry A (United States)', text, ...o });
  if (!S.principal) {
    const r = await J("Welcome to Thistledown! I'm Juniper, the registrar.\n\nBefore an agent can act for you here, the registry needs to know **who stands behind it**. That's you, the person at the keyboard. What's your name? Only this registry keeps it.", {
      input: { label: 'Your name', placeholder: 'e.g. Robin Ash' },
      choices: [{ label: 'Verify me', value: 'go', primary: true }, { label: 'Not yet', value: null, cancel: true }],
    });
    if (!r.value) return;
    busy('VerityCheck is checking your ID', '🦉');
    await api.post('/api/enroll', { name: r.input });
    await refresh();
    await J(`All done, ${S.principal.name}. VerityCheck verified you at **IAL2**.\n\nThat was the slow step, and you only do it once. Shops will never learn your name from your agent. Only this registry can say who you are, and only when a court orders it.`, { choices: [{ label: 'Next', value: true, primary: true }] });
  }
  if (!S.agent || S.agent.status === 'revoked') {
    const again = S.agent?.status === 'revoked';
    const r = await J(again
      ? "Let's register a fresh agent. The revoked one stays revoked, and what it did stays on record.\n\nWhat shall we call the new one?"
      : "Now let's register your agent. That's the little one you're steering around town.\n\nWhat shall we call it?", {
      input: { label: "Your agent's name", value: again ? '' : 'Pip' },
      choices: [{ label: 'Register', value: 'go', primary: true }, { label: 'Not yet', value: null, cancel: true }],
    });
    if (!r.value) return;
    busy('Registering', '🦉');
    const res = await api.post('/api/agent', { name: r.input || 'Pip' });
    await refresh();
    await J(`Registered in **${res.issuance_ms} ms**. That's the fast step, because you're already verified.\n\nHere's ${S.agent.name}'s badge. Every place sees a **different badge number**, so shops can't compare notes about you. Press **B** to take it off and see what happens.\n\nNext stop: the Records Office, to say what ${S.agent.name} may do.`);
    return;
  }
  for (;;) {
    const helperAlive = S.helper?.status === 'active';
    const choices = [];
    if (!helperAlive) choices.push({ label: 'Hire a helper (a sub-agent)', value: 'helper' });
    else choices.push({ label: `Ask ${S.helper.name} to hire a helper of its own`, value: 'deeper' });
    if (S.events.includes('night') && !S.events.includes('court')) choices.push({ label: "Take last night's visitors to court", value: 'court', primary: true });
    choices.push({ label: `Revoke ${S.agent.name} (my device was stolen)`, value: 'revoke' });
    choices.push({ label: 'Bye', value: null, cancel: true });
    const r = await J(`Hello again, ${S.principal.name}. What can the registry do for you?`, { choices });
    if (!r.value) return;

    if (r.value === 'helper') {
      const h = await J(`A helper is a **sub-agent**. ${S.agent.name} registers it, so its chain leads back to you. It's **ephemeral**: it lapses on its own in four minutes.\n\nWhat's its name?`, {
        input: { label: "Helper's name", value: 'Sprout' },
        choices: [{ label: 'Register helper', value: 'go', primary: true }, { label: 'Never mind', value: null, cancel: true }],
      });
      if (!h.value) continue;
      busy(`${S.agent.name} is registering a helper`, '🦉');
      const res = await api.post('/api/helper', { name: h.input || 'Sprout' });
      await refresh();
      if (!res.ok) {
        await J(`The registry refused: "${res.reasons.join('; ')}".`);
        continue;
      }
      helper.x = player.x + 18;
      helper.y = player.y + 6;
      await J(`${S.helper.name} is registered under ${S.agent.name}. It can't spend anything yet: authority lives at the **Records Office**, so ask the archivist to give it a budget.`);
      return;
    }
    if (r.value === 'deeper') {
      busy(`${S.helper.name} is trying to register a helper of its own`, '🦉');
      const res = await api.post('/api/helper/hire');
      await J(res.ok ? 'Registered. (That should not have happened!)' : `Refused: "${res.reasons[0]}".\n\nWhen you registered ${S.agent.name}, you gave its lineage a **depth budget of one**. A helper's helper would be two levels down.`);
      continue;
    }
    if (r.value === 'court') {
      busy('The court is considering your petition', '⚖️');
      const c = await api.post('/api/court');
      await refresh();
      await showCard(courtHtml(c));
      return;
    }
    if (r.value === 'revoke') {
      const sure = await J(`Revoking ${S.agent.name} cuts it off at once, everywhere that checks its badge. Any helper goes with it. Go ahead?`, {
        choices: [{ label: `Revoke ${S.agent.name}`, value: true, primary: true }, { label: 'Keep it', value: false, cancel: true }],
      });
      if (!sure.value) continue;
      busy('Revoking', '🦉');
      const res = await api.post('/api/revoke');
      await refresh();
      await J(`${S.agent.name} is revoked${res.cascades_to ? ', and so is its helper' : ''}. Places that check live status refuse it from now on: try a shop and see. You can register a new agent here any time.`);
      return;
    }
  }
}

function courtHtml(c) {
  return `
    <header><div><span class="eyebrow">Court order</span><h3>${esc(c.court)}</h3></div><div class="stamp info">Resolved</div></header>
    <p>The court ordered <b>${esc(c.registry)}</b> to say who stands behind one of the badges at your door last night.</p>
    <section><h4>Who stands behind it</h4><ul class="learned"><li><b>${esc(c.principal.name)}</b>, an organization registered in ${esc(c.principal.jurisdiction)} (no. ${esc(c.principal.registration_number)})</li></ul></section>
    <section><h4>The agent wearing that badge</h4><ul class="learned">${c.agents.map((a) => `<li>${esc(a.label)} (registration ${esc(a.status)})</li>`).join('')}</ul></section>
    <p class="note">${esc(c.related_at_hearth)} of its badges were seen at Hearth & Key last night. Neither you nor Hearth & Key knew this name until a court asked. The lookup itself went into the registry's transparency log (now ${esc(c.transparency_log_size)} entries), so lookups of identity can be audited too.</p>
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`;
}

// ---- Records Office: Ledgerline (authority) and Tessera (activity) ---------

async function recordsOffice() {
  const M = (text, o = {}) => say({ face: '🦔', who: 'Archivist Moss', where: 'Records Office · Ledgerline (authority) · Tessera (activity)', text, ...o });
  if (!S.agent) return M("I keep two kinds of record: what each agent **may** do, and what it **has** done.\n\nNeither means much until your agent is registered. Town Hall first, then come back.");
  if (S.agent.status === 'revoked') return M(`${S.agent.name} is revoked, so I can't record new authority for it. Register a new agent at Town Hall.`);
  if (!S.grant) {
    const choices = S.budgets.map((b) => ({ label: `Up to $${b} a purchase`, value: b, primary: b === 50 }));
    choices.push({ label: 'Not now', value: null, cancel: true });
    const r = await M(`What may ${S.agent.name} do for you? Sign a grant and I'll keep it on record.\n\nEvery grant here covers **buying books and home goods**, **entering your home**, and **passing part of this to one helper**. You choose the spending limit.`, { choices });
    if (!r.value) return;
    busy('Ledgerline is checking your signature', '🦔');
    await api.post('/api/grant', { budget: r.value });
    await refresh();
    await M(`Signed and deposited. ${S.agent.name} may now spend up to **$${S.grant.budget} a purchase** on books and home goods, and nothing else.\n\nA shop sees only the part of the grant that covers what ${S.agent.name} asks it for, never the rest.`);
    return;
  }
  for (;;) {
    const choices = [];
    if (S.helper?.status === 'active' && !S.helper.budget) choices.push({ label: `Give ${S.helper.name} a budget`, value: 'fund', primary: true });
    choices.push({ label: 'Show my activity receipts', value: 'receipts' });
    choices.push({ label: 'What do you keep, exactly?', value: 'explain' });
    choices.push({ label: 'Bye', value: null, cancel: true });
    const r = await M(`Hello, ${S.principal.name}. ${S.agent.name}'s grant is on file.`, { choices });
    if (!r.value) return;
    if (r.value === 'fund') {
      const b = S.grant.budget;
      const amounts = [Math.round(b / 5), Math.round(b / 2.5), b * 2];
      const r2 = await M(`How much may ${S.helper.name} spend? It can only get a slice of what ${S.agent.name} already has.`, {
        choices: [...amounts.map((v) => ({ label: `$${v} a purchase${v > b ? ` (more than ${S.agent.name} has)` : ''}`, value: v })), { label: 'Never mind', value: null, cancel: true }],
      });
      if (!r2.value) continue;
      busy('Ledgerline is checking the delegation', '🦔');
      const res = await api.post('/api/helper/fund', { budget: r2.value });
      await refresh();
      await M(res.ok
        ? `Recorded. ${S.helper.name} may spend up to **$${res.budget} a purchase**. Send it shopping: at a shop, choose ${S.helper.name} as the buyer.`
        : `Refused: "${res.reasons[0]}".\n\nA helper can't be given more than ${S.agent.name} has. Pick a smaller amount.`);
      continue;
    }
    if (r.value === 'receipts') {
      const rr = await api.get('/api/receipts');
      closeDialog();
      await showCard(receiptsHtml(rr));
      continue;
    }
    await M("**Ledgerline** holds grants: what each agent may do, signed by whoever stands behind it. When a shop asks, Ledgerline issues a credential for that shop alone, showing only the part that matters there.\n\n**Tessera** holds activity logs. The agent and the place it dealt with each write their own account of what happened. Every entry gets a signed receipt, so nobody can quietly rewrite it later.");
  }
}

function receiptsHtml(rr) {
  const rows = rr.receipts.map((r) => {
    const d = DECISIONS[r.decision] ?? { tone: 'info', label: r.decision };
    return `<li><span class="stamp-sm ${d.tone}">${esc(d.label)}</span> ${esc(r.place)} · <code>${esc(r.action)}</code><small>entry #${esc(r.index)} · receipt ${r.verified ? 'verified ✓' : 'failed'}</small></li>`;
  }).join('');
  return `
    <header><div><span class="eyebrow">Tessera Logs · activity</span><h3>Your receipts</h3></div><div class="stamp info">${esc(rr.total)} entries</div></header>
    <p>Each time a place decided something about your agent, it wrote a signed entry to your agent's activity log and kept a receipt. These are the latest.</p>
    ${rows ? `<ul class="receipts">${rows}</ul>` : '<p class="muted">Nothing yet. Go and do something!</p>'}
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`;
}

// ---- Shops ------------------------------------------------------------------

async function shop(key) {
  const def = S.shops[key];
  const keeper = key === 'bramble' ? { face: '🐻', who: 'Bram' } : { face: '🦊', who: 'Fennel' };
  const K = (text, o = {}) => say({ ...keeper, where: def.name, text, ...o });
  for (;;) {
    const choices = def.items.map((it) => ({ label: `${it.name} · $${it.price}`, value: it.id }));
    if (lastCards[key]) choices.push({ label: 'What do you know about me?', value: 'know' });
    choices.push({ label: 'Just looking', value: null, cancel: true });
    const r = await K(key === 'bramble'
      ? 'Welcome to Bramble Books! Everything is priced per volume. What can I find for you?'
      : 'Copper Kettle Goods, welcome! Kettles, lanterns, seeds, clocks. What catches your eye?', { choices });
    if (!r.value) return;
    if (r.value === 'know') {
      await showKnown(key, def);
      continue;
    }
    let by = 'agent';
    if (S.helper?.status === 'active' && S.agent?.status === 'active') {
      const w = await K('Who is buying?', { choices: [{ label: S.agent.name, value: 'agent', primary: true }, { label: `${S.helper.name} (your helper)`, value: 'helper' }] });
      by = w.value;
    }
    busy(`${keeper.who} is checking the badge`, keeper.face);
    const c = await api.post('/api/buy', { shop: key, item: r.value, by });
    if (c.ppid && by === 'agent') lastCards[key] = c;
    bubble(by === 'helper' ? helper : player, c);
    await refresh();
    await card(c, { note: shopNote(c, keeper.who) });
    if (c.decision === 'allow') toast(`Bought: ${c.result?.item}`, 'ok');
  }
}

function shopNote(c, keeper) {
  if (c.classification === 'UNLABELED') return `No badge, no sale. ${keeper} has no way to tell whether anyone would answer for this purchase.`;
  if (c.decision === 'allow' && c.chain_length === 2) return 'The shop can see a chain: a helper, acting for an agent, acting for a verified person. It still does not learn who that person is.';
  return null;
}

async function showKnown(key, def) {
  const c = lastCards[key];
  const other = Object.entries(lastCards).find(([k]) => k !== key)?.[1];
  closeDialog();
  await showCard(`
    <header><div><span class="eyebrow">${esc(def.name)}'s notebook</span><h3>What they know about you</h3></div></header>
    <ul class="learned">${c.learned.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    <p class="note">${other
      ? `${esc(other.place)} knows your agent by a different number (<code>…${esc(other.ppid.split(':').pop().slice(-8))}</code> there, <code>…${esc(c.ppid.split(':').pop().slice(-8))}</code> here). Nothing either shop holds can be matched against the other's.`
      : 'Buy something at the other shop, then compare: it will know your agent by a different number.'}</p>
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`);
}

// ---- Your house: Hearth & Key, with your passkey ------------------------------

async function frontDoor() {
  const H = (text, o = {}) => say({ face: '🏡', who: 'Your front door', where: 'Hearth & Key smart lock', text, ...o });
  if (!S.home.passkey) {
    const r = await H("Your house has a Hearth & Key lock, but no passkey on it yet.\n\nWith a passkey, the lock opens only for **you**, confirmed by Touch ID, Face ID or your device PIN, or for **agents you've approved**. A key on its own opens nothing.", {
      choices: [{ label: 'Set up a passkey', value: true, primary: true }, { label: 'Later', value: false, cancel: true }],
    });
    if (!r.value) return;
    const problem = api.passkeysUsable();
    if (problem) return H(problem);
    busy('Waiting for your passkey', '🏡');
    try {
      await api.registerPasskey();
    } catch (e) {
      return H(e.name === 'NotAllowedError' ? 'The passkey prompt was dismissed. Try again whenever you like.' : e.message);
    }
    await refresh();
    toast('Passkey set on your front door', 'ok');
  }
  for (;;) {
    const choices = [];
    if (S.badge) choices.push({ label: `Send ${S.agent.name} in`, value: 'agent', primary: true });
    else {
      choices.push({ label: 'Knock and confirm with your passkey', value: 'knock', primary: true });
      choices.push({ label: 'Just use your house key', value: 'key' });
    }
    choices.push({ label: 'Leave', value: null, cancel: true });
    const text = S.badge
      ? `Your front door. ${S.agent.name} is wearing its badge.`
      : `Your front door. ${S.agent ? `${S.agent.name} isn't wearing its badge, so` : "You haven't registered an agent, so"} the lock treats this as a **person** at the door, not an agent.`;
    const r = await H(text, { choices });
    if (!r.value) return;

    if (r.value === 'agent') {
      busy('The lock is checking the badge', '🏡');
      const c = await api.post('/api/door', { account: 'you' });
      await refresh();
      if (c.decision === 'step_up' && c.approval_request) {
        pending.set(c.approval_request.request_id, async () => {
          const again = await api.post('/api/door', { account: 'you' });
          await refresh();
          await card(again, { note: again.decision === 'allow' ? `You approved this agent with your passkey, so the lock now knows ${S.agent.name}. A copy of your key would not have done it.` : null });
          if (again.decision === 'allow') await inside(again.result.items);
        });
        await card(c, { note: 'This agent has never been to your door, so the lock asked you. Your phone (bottom right) shows who stands behind the agent. Approve with your passkey.' });
        return;
      }
      bubble(player, c);
      await card(c);
      if (c.decision === 'allow') return inside(c.result.items);
      continue;
    }
    if (r.value === 'key') {
      busy('The lock is looking at your key', '🏡');
      const c = await api.post('/api/door', { account: 'you', useKey: true });
      await refresh();
      bubble(player, c);
      await card(c, { note: 'In Thistledown a key is a bearer token. Whoever holds it could be anyone, so on its own it opens nothing.' });
      continue;
    }
    const req = await api.post('/api/knock');
    pending.set(req.request_id, async () => {
      const c = await api.post('/api/enter', { requestId: req.request_id });
      await refresh();
      await card(c, { note: 'Your passkey approved exactly this: opening this door, once, just now.' });
      if (c.decision === 'allow') await inside(c.result.items);
    });
    await refresh();
    return H('The lock sent a request to your phone (bottom right). Approve it with your passkey.');
  }
}

let lastApproval = null;
async function inside(items) {
  const I = (text, o = {}) => say({ face: '🛋️', who: 'Inside your house', where: 'Hearth & Key', text, ...o });
  for (;;) {
    const choices = [{ label: 'Throw something out', value: 'toss' }];
    if (lastApproval) choices.push({ label: 'Reuse your last approval for something else', value: 'reuse' });
    if (!S.events.includes('night')) choices.push({ label: 'Rest until night', value: 'night', primary: true });
    choices.push({ label: 'Go back outside', value: null, cancel: true });
    const r = await I(`Cozy. On the shelf: ${items.join(', ')}.`, { choices });
    if (!r.value) return;
    if (r.value === 'night') {
      closeDialog();
      return nightfall();
    }
    const what = await I('Which one?', { choices: [...items.map((i) => ({ label: i, value: i })), { label: 'Never mind', value: null, cancel: true }] });
    if (!what.value) continue;
    busy('The lock is checking', '🛋️');
    if (r.value === 'reuse') {
      const c = await api.post('/api/discard', { item: what.value, approvalRef: lastApproval });
      if (c.approval_request) await api.declineRequest(c.approval_request.request_id);
      await refresh();
      await card(c, { note: 'Not with that approval. Each approval covers one exact act, once: that one was for something else, and it is used up. This would need a fresh approval on your phone.' });
      continue;
    }
    const c = await api.post('/api/discard', { item: what.value });
    await refresh();
    if (c.decision === 'step_up' && c.approval_request) {
      const rid = c.approval_request.request_id;
      pending.set(rid, async () => {
        const done = await api.post('/api/discard', { item: what.value, approvalRef: rid });
        await refresh();
        await card(done, { note: done.decision === 'allow' ? 'Thrown out. Your approval named exactly this item, and now it is used up.' : null });
        if (done.decision === 'allow') {
          lastApproval = rid;
          await inside(done.result.items);
        }
      });
      await card(c, { note: 'Throwing things out needs your passkey every time, even from an agent you trust. Check your phone.' });
      return;
    }
    await card(c);
  }
}

// ---- Maple's cottage, and her lost key ------------------------------------------

async function maplesCottage() {
  const M = (text, o = {}) => say({ face: '🐰', who: "Maple's cottage", where: 'Hearth & Key smart lock', text, ...o });
  for (;;) {
    const choices = [{ label: 'Knock', value: 'knock', primary: true }];
    if (S.found_key) choices.push({ label: "Try Maple's key", value: 'key' });
    choices.push({ label: 'Leave', value: null, cancel: true });
    const r = await M("Maple's cottage. A note on the door says she's at the market today.", { choices });
    if (!r.value) return;
    busy(r.value === 'key' ? 'Trying the key' : 'Knocking', '🐰');
    const c = await api.post('/api/door', { account: 'maple', useKey: r.value === 'key' });
    await refresh();
    bubble(player, c);
    if (r.value === 'knock') {
      const who = c.approval_request?.details?.accountability;
      await card(c, {
        stamp: c.declined_by ? { label: 'Maple said no', tone: 'bad' } : undefined,
        note: c.declined_by && who
          ? `The lock asked Maple. Her phone buzzed at the market and told her a ${String(who.type).replace('_', ' ')} verified ${who.assurance} stands behind this agent, but not who. She doesn't know you, so she declined.`
          : null,
      });
    } else {
      await card(c, { note: S.badge
        ? "Your agent tried a key it had no business using, while wearing its badge. Hearth & Key reported it to the registry, and the registry told the person behind the agent: you. Check your phone."
        : "No badge, so the lock treats this as someone holding a key. A key alone opens nothing. And with no badge there's nobody to report it to." });
    }
  }
}

let keyPrompted = false;
async function keyFound() {
  interacting = true;
  keys.clear();
  player.path = null;
  try {
    const r = await say({
      face: '🔑', who: 'A key tag', where: 'The lower street',
      text: "Something glints on the path: a key tag reading **Hearth & Key · maple**. It must be Maple's spare.\n\nIn Thistledown a key works like an API token: it says which home it's for, not who is holding it.",
      choices: [{ label: 'Pick it up', value: true, primary: true }, { label: 'Leave it', value: false, cancel: true }],
    });
    if (r.value) {
      await api.post('/api/key');
      toast("You picked up Maple's key", 'info');
    }
  } finally {
    closeDialog();
    interacting = false;
    await refresh();
  }
}

// ---- Everything else ----------------------------------------------------------

function noticeBoard() {
  return say({
    face: '📋', who: 'Notice board', where: 'Thistledown',
    html: `<ul class="notices">
      <li><b>Town Hall</b>: verified once, agents registered in a blink.</li>
      <li><b>Records Office</b>: grants, and a receipt for everything.</li>
      <li><b>Bramble Books</b> &amp; <b>Copper Kettle</b>: open all day. Badges, please.</li>
      <li><b>Hearth &amp; Key</b> reminds residents: put a passkey on your door.</li>
      <li><b>Lost</b>: one key tag, somewhere on the lower street. —M.</li>
      <li><b>Night watch</b>: strangers seen about after dark.</li>
    </ul>`,
    choices: [{ label: 'Close', value: null, primary: true }],
  });
}

function pond() {
  const text = !S.agent ? "You see a small round creature with no badge. Nobody here knows who it answers to yet."
    : S.agent.status === 'revoked' ? `You see ${S.agent.name}, antenna glowing red. Revoked.`
      : S.badge ? `You see ${S.agent.name}, badge on, antenna glowing green.` : `You see ${S.agent.name}, badge tucked away.`;
  return say({ face: '🪷', who: 'The pond', where: 'Thistledown', text });
}

async function toggleBadge() {
  if (!S?.agent) return toast('No badge yet. Register your agent at Town Hall.', 'warn');
  const res = await api.post('/api/badge', { on: !S.badge });
  await refresh();
  toast(res.badge ? 'Badge on: places see who stands behind you (but not your name)' : 'Badge off: places see an unlabeled agent', res.badge ? 'ok' : 'warn');
}

// ---------------------------------------------------------------------------
// Night
// ---------------------------------------------------------------------------

let night = 0;
let nightTarget = 0;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const goTo = (w, x, y) => new Promise((resolve) => {
  const path = findPath(town, tileOf(w), tileOf({ x, y })) ?? [];
  path.push({ x, y });
  w.path = path;
  w.arrive = resolve;
});

const VISITOR_LOOKS = {
  badge: { body: '#6b5a8e', bulb: '#b18cff', glow: true, mask: true, badge: 'on', badgeColor: '#d9d2ff', badgeMark: '#6b5a8e', feet: '#3b3050' },
  none: { body: '#8d939c', hood: '#6f757f', eyes: '#f2f2f2', feet: '#4a4e55' },
};

async function nightfall() {
  scene = true;
  document.body.classList.add('scene');
  nightTarget = 1;
  keys.clear();
  player.path = null;
  player.x = home.front.x - 30;
  player.y = home.front.y + 4;
  player.facing = { x: 1, y: 0 };
  camFocus = { x: home.front.x + 50, y: home.front.y - 10 };
  toast('Night falls on Thistledown…', 'info');
  const res = await api.post('/api/night');
  await wait(1500);
  npcs = res.results.map((r, i) => ({
    x: BURGLAR_START.x + i * 6, y: BURGLAR_START.y + (i % 2) * 8, facing: { x: -1, y: 0 }, walking: false, phase: i, seed: i,
    look: r.ppid ? VISITOR_LOOKS.badge : VISITOR_LOOKS.none,
    label: r.ppid ? `badge …${r.ppid.split(':').pop().slice(-6)}` : 'no badge',
    result: r,
  }));
  const queue = npcs.map((v, i) => wait(i * 500).then(() => goTo(v, (32.8 + i * 1.3) * TILE, (i % 2 ? 11.7 : 10.6) * TILE)));
  await Promise.all(queue);
  for (const v of npcs) {
    await goTo(v, home.front.x + 6, home.front.y + 2);
    v.facing = { x: 0, y: -1 };
    await wait(350);
    bubble(v, v.result);
    await wait(1100);
    goTo(v, 38.5 * TILE, 11.6 * TILE);
  }
  await wait(2200);
  npcs = [];
  await showCard(nightHtml(res));
  nightTarget = 0;
  camFocus = null;
  scene = false;
  document.body.classList.remove('scene');
  await refresh();
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
    <p class="note">Hearth & Key reported each visitor who wore a badge to the registry that issued it, and the registry passed ${esc(res.incidents_relayed)} reports on to whoever stands behind them. You didn't learn who that is, and neither did Hearth & Key. A court can find out: ask at Town Hall.</p>
    <p class="note">The visitor with no badge was refused too, but there was nobody to report it to.</p>
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Good morning</button></div>`;
}

// ---------------------------------------------------------------------------
// State from the server
// ---------------------------------------------------------------------------

let helperWasActive = false;
async function refresh() {
  try {
    S = await api.get('/api/state');
  } catch {
    return;
  }
  renderHud(S);
  if (renderPhone(S)) toast('Your phone buzzed', 'warn');
  player.look = playerLook();
  player.label = S.agent ? S.agent.name : null;
  const active = S.helper?.status === 'active';
  if (helperWasActive && !active && S.helper?.status === 'expired') toast(`${S.helper.name}'s registration lapsed. Ephemeral sub-agents expire on their own.`, 'info');
  helperWasActive = active;
}

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
    const then = pending.get(rid);
    pending.delete(rid);
    if (then && !scene) {
      interacting = true;
      try {
        await then();
      } finally {
        closeDialog();
        interacting = false;
        await refresh();
      }
    }
  } else if (decline) {
    const rid = decline.dataset.decline;
    await api.declineRequest(rid);
    pending.delete(rid);
    toast('Declined');
    await refresh();
  }
});

for (const id of ['phone', 'record', 'quest']) {
  document.getElementById(`${id}Head`).addEventListener('click', () => document.getElementById(id).classList.toggle('open'));
}
if (innerWidth > 900) for (const id of ['phone', 'record', 'quest']) document.getElementById(id).classList.add('open');

document.getElementById('restart').addEventListener('click', async () => {
  const r = await say({ face: '🌼', who: 'Start over?', text: "This forgets your verification, your agent and everything it did, and empties your phone. You'll need a new passkey on your door. (Your old one stays in your password manager; you can delete it there.)", choices: [{ label: 'Start over', value: true, primary: true }, { label: 'Keep playing', value: false, cancel: true }] });
  closeDialog();
  if (!r.value) return;
  await api.post('/api/reset');
  pending.clear();
  for (const k of Object.keys(lastCards)) delete lastCards[k];
  lastApproval = null;
  keyPrompted = false;
  Object.assign(player, { x: SPAWN.x, y: SPAWN.y, path: null });
  await refresh();
  welcome();
});

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

function update(dt) {
  t += dt;
  night += (nightTarget - night) * Math.min(1, dt * 1.4);
  for (const v of npcs) {
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
  const frozen = dialogOpen() || scene || interacting;
  let dx = 0;
  let dy = 0;
  if (!frozen) for (const k of keys) { dx += MOVE[k][0]; dy += MOVE[k][1]; }
  if (dx || dy) {
    const len = Math.hypot(dx, dy);
    const step = 120 * dt;
    const nx = player.x + (dx / len) * step;
    const ny = player.y + (dy / len) * step;
    if (!blocked(nx, player.y)) player.x = nx;
    if (!blocked(player.x, ny)) player.y = ny;
    player.facing = { x: dx / len, y: dy / len };
    player.walking = true;
  } else if (!frozen && player.path?.length) {
    follow(player, dt, 125);
  } else {
    player.walking = false;
    if (!frozen && player.path && !player.path.length) {
      const then = player.then;
      player.path = null;
      player.then = null;
      if (then) interact(then);
    }
  }
  if (player.walking) {
    player.phase += dt * 12;
    trail.push({ x: player.x, y: player.y });
    if (trail.length > 60) trail.shift();
  }

  // The helper trails a little behind.
  helper.shown = S?.helper?.status === 'active';
  if (helper.shown) {
    const target = trail[Math.max(0, trail.length - 16)] ?? { x: player.x + 18, y: player.y + 4 };
    const d = Math.hypot(target.x - helper.x, target.y - helper.y);
    if (d > 2) {
      const step = Math.min(d, 130 * dt);
      helper.facing = { x: (target.x - helper.x) / d, y: (target.y - helper.y) / d };
      helper.x += helper.facing.x * step;
      helper.y += helper.facing.y * step;
      helper.walking = true;
      helper.phase += dt * 14;
    } else {
      helper.walking = false;
    }
    const left = Math.max(0, Math.round((S.helper.expires_at - Date.now()) / 1000));
    helper.label = `${S.helper.name} ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  // The key on the lower street.
  if (S && !S.found_key && !frozen) {
    const near = Math.hypot(player.x - (KEY_SPOT.x + 0.5) * TILE, player.y - (KEY_SPOT.y + 0.6) * TILE) < 18;
    if (near && !keyPrompted) {
      keyPrompted = true;
      keyFound();
    } else if (!near) {
      keyPrompted = false;
    }
  }
  updateCamera(dt);
}

function render() {
  const k = view.scale * view.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#3f8146';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(k, 0, 0, k, -view.x * k, -view.y * k);
  ctx.drawImage(groundCache, 0, 0, COLS * TILE, ROWS * TILE);
  drawWater(ctx, t);
  if (S && !S.found_key) drawKey(ctx, t);

  const inView = (x, y, m = 64) => x > view.x - m && x < view.x + view.w + m && y > view.y - m && y < view.y + view.h + m * 2;
  const things = [];
  for (const tr of town.trees) if (inView((tr.x + 0.5) * TILE, (tr.y + 1) * TILE)) things.push({ y: (tr.y + 1) * TILE - 3, draw: () => drawTree(ctx, tr, t) });
  for (const b of town.buildings) things.push({ y: (b.y + b.h) * TILE, draw: () => drawBuilding(ctx, b, t, night > 0.4) });
  for (const l of town.lamps) things.push({ y: (l.y + 1) * TILE - 6, draw: () => drawLamp(ctx, l, night > 0.4) });
  things.push({ y: (BOARD.y + 1) * TILE - 4, draw: () => drawBoard(ctx, t) });
  for (const v of npcs) things.push({ y: v.y, draw: () => drawAgent(ctx, v, t) });
  if (helper.shown) things.push({ y: helper.y, draw: () => drawAgent(ctx, helper, t) });
  things.push({ y: player.y, draw: () => drawAgent(ctx, player, t) });
  things.sort((a, b) => a.y - b.y);
  for (const th of things) th.draw();

  drawNight(ctx, town, night, view);

  for (let i = bubbles.length - 1; i >= 0; i--) {
    const b = bubbles[i];
    const age = t - b.t0;
    if (age > 2.6) bubbles.splice(i, 1);
    else drawBubble(ctx, b.who.x, b.who.y, b.text, b.tone, age);
  }
  if (!dialogOpen() && !scene && !interacting) {
    const p = nearestPlace();
    if (p) drawBubble(ctx, player.x, player.y + 4, `E · ${p.name}`, 'info', 1);
  }
}

let last = performance.now();
function frame(now) {
  // Generous enough that slow or throttled frames still move at the right speed;
  // a step stays shorter than a tile, so nobody walks through a wall.
  const dt = Math.min(0.2, (now - last) / 1000);
  last = now;
  update(dt);
  render();
  requestAnimationFrame(frame);
}

function welcome() {
  return say({
    face: '🌼', who: 'Welcome to Thistledown', where: 'where every agent answers to someone',
    text: "You're playing an **agent**: the little round one in the middle. You, at the keyboard, are its **principal**: the person who answers for what it does.\n\nYour **phone** (bottom right) is where places ask the principal for an OK. Approvals use a real passkey on this device.\n\nWalk with **WASD** or the **arrow keys**, or click where you want to go. Press **E** to talk and **B** to take your badge off. Start at **Town Hall**, up the lane.",
    choices: [{ label: "Let's go", value: true, primary: true }],
  }).then(closeDialog);
}

await refresh();
updateCamera(0, true);
requestAnimationFrame(frame);
setInterval(() => { if (!document.hidden && !interacting) refresh(); }, 2500);
if (!S?.principal) welcome();
