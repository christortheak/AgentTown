// The X-ray: the plumbing behind one decision, drawn on the map. Each hop in a
// card's trace (agent to registry, agent to record keeper, agent to place,
// place back to registry, ...) travels as a little packet between buildings,
// with its label, and the steps are listed in words alongside.
import { placeFront } from './map.js';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const HOP_MS = 900;
const GAP_MS = 140;
const NODE_NAMES = { townhall: 'Town Hall (registry)', harbor: 'Harbor Registry', records: 'Records Office', orb: 'the Orb', facilitator: 'the payment facilitator' };

export function createXray({ town, panel, onFinish = () => {} }) {
  const plays = []; // { trace, start, actor: () => {x, y}, title, own }
  let on = false;

  /** Where a node is: the requester, a building's door, or (for a place with no building) `placePos`. */
  const at = (node, actor, building, placePos) => {
    if (node === 'actor') return actor();
    if (node === building && placePos) return placePos();
    if (node === 'facilitator') return placeFront(town, 'bank');
    return placeFront(town, node === 'place' ? building : node) ?? actor();
  };

  function duration(p) {
    return p.trace.length * (HOP_MS + GAP_MS);
  }

  /** Play one card's trace. `actor` returns the requester's live position. */
  function play(card, actor, { own = false, placePos = null } = {}) {
    if (!card?.trace?.length) return null;
    const p = { trace: card.trace, start: performance.now(), actor, placePos, building: card.building ?? card.placeId, title: `${card.actor} at ${card.place}`, own, headline: card.headline };
    if (!own && plays.filter((x) => !x.own).length >= 4) return null;
    plays.push(p);
    if (own) renderPanel(p);
    return p;
  }

  /** Every point a trace touches, to frame the camera on it. */
  function bounds(card, actor, placePos = null) {
    const building = card.building ?? card.placeId;
    const pts = (card.trace ?? []).flatMap((h) => [at(h.from, actor, building, placePos), at(h.to, actor, building, placePos)]);
    if (!pts.length) return null;
    const xs = pts.map((q) => q.x);
    const ys = pts.map((q) => q.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  function renderPanel(p, active = -1) {
    if (!panel) return;
    panel.hidden = false;
    panel.innerHTML = `
      <header><h2>🩻 X-ray <span class="muted">· ${esc(p.title)}</span></h2><button class="quiet small" data-xray-close>Close</button></header>
      <ol>${p.trace.map((h, i) => `<li class="${i === active ? 'now' : i < active || active === -2 ? 'done' : ''} ${h.ok ? '' : 'bad'}"><b>${esc(nodeName(h.from, p))} → ${esc(nodeName(h.to, p))}</b> ${esc(h.label)}</li>`).join('')}</ol>
      ${p.headline ? `<p class="small"><b>Result:</b> ${esc(p.headline)}</p>` : ''}
      <p class="muted small">Badges, permission slips and status checks: everything here is the framework's real traffic. The place never learns more than the badge shows.</p>`;
  }
  const nodeName = (n, p) => (n === 'actor' ? p.title.split(' at ')[0] : n === p.building ? p.title.split(' at ')[1] ?? n : NODE_NAMES[n] ?? n);

  /** Draw packets for every playing trace (world coordinates); `k` grows them when the camera pulls back. */
  function draw(ctx, now, k = 1) {
    for (let i = plays.length - 1; i >= 0; i--) {
      const p = plays[i];
      const elapsed = now - p.start;
      const total = duration(p);
      if (elapsed > total + 1200) {
        plays.splice(i, 1);
        if (p.own) {
          renderPanel(p, -2);
          onFinish(p);
        }
        continue;
      }
      const hop = Math.min(p.trace.length - 1, Math.floor(elapsed / (HOP_MS + GAP_MS)));
      const f = Math.min(1, (elapsed - hop * (HOP_MS + GAP_MS)) / HOP_MS);
      if (p.own && p.shown !== hop) {
        p.shown = hop;
        renderPanel(p, hop);
      }
      // Earlier hops leave a faint trail.
      for (let j = 0; j <= hop; j++) {
        const h = p.trace[j];
        const a = at(h.from, p.actor, p.building, p.placePos);
        const b = at(h.to, p.actor, p.building, p.placePos);
        ctx.save();
        ctx.strokeStyle = h.ok ? 'rgba(79,127,191,0.55)' : 'rgba(200,82,74,0.6)';
        ctx.lineWidth = (j === hop ? 2.4 : 1.4) * k;
        ctx.setLineDash([5 * k, 5 * k]);
        ctx.lineDashOffset = -now / 40;
        ctx.beginPath();
        const mx = (a.x + b.x) / 2;
        const my = Math.min(a.y, b.y) - Math.min(120, Math.hypot(b.x - a.x, b.y - a.y) * 0.25);
        ctx.moveTo(a.x, a.y - 14);
        ctx.quadraticCurveTo(mx, my, b.x, b.y - 14);
        ctx.stroke();
        ctx.restore();
        if (j === hop && elapsed <= total) {
          const t = f;
          const x = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x;
          const y = (1 - t) * (1 - t) * (a.y - 14) + 2 * (1 - t) * t * my + t * t * (b.y - 14);
          if (t > 0.85) ring(ctx, b.x, b.y - 14, (t - 0.85) / 0.15, h.ok, k);
          packet(ctx, x, y, h, p.own, k);
        }
      }
    }
  }

  function packet(ctx, x, y, h, label, k) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(k, k);
    ctx.fillStyle = h.ok ? '#4f7fbf' : '#c8524a';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-7, -5, 14, 10, 3);
    ctx.fill();
    ctx.stroke();
    if (label) {
      ctx.font = '700 10px ui-rounded, system-ui, sans-serif';
      const text = h.label.length > 52 ? `${h.label.slice(0, 50)}…` : h.label;
      // Room on each side for the rounded ends, and the text centred on the pill, not on its baseline.
      const w = ctx.measureText(text).width + 24;
      ctx.fillStyle = 'rgba(255,250,240,0.96)';
      ctx.strokeStyle = h.ok ? '#4f7fbf' : '#c8524a';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.roundRect(-w / 2, -31, w, 20, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#4a3a2c';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 0, -20.5);
    }
    ctx.restore();
  }

  /** A ripple where a packet lands. */
  function ring(ctx, x, y, t, ok, k) {
    ctx.save();
    ctx.strokeStyle = ok ? `rgba(79,127,191,${1 - t})` : `rgba(200,82,74,${1 - t})`;
    ctx.lineWidth = 2 * k;
    ctx.beginPath();
    ctx.arc(x, y, (8 + t * 18) * k, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  /** The same packets, as dots on the minimap. */
  function drawMini(ctx, now, s, ox, oy) {
    for (const p of plays) {
      const elapsed = now - p.start;
      const k = Math.min(p.trace.length - 1, Math.floor(elapsed / (HOP_MS + GAP_MS)));
      const f = Math.min(1, (elapsed - k * (HOP_MS + GAP_MS)) / HOP_MS);
      const h = p.trace[k];
      const a = at(h.from, p.actor, p.building, p.placePos);
      const b = at(h.to, p.actor, p.building, p.placePos);
      ctx.strokeStyle = 'rgba(79,127,191,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(ox + a.x * s, oy + a.y * s);
      ctx.lineTo(ox + b.x * s, oy + b.y * s);
      ctx.stroke();
      ctx.fillStyle = h.ok ? '#4f7fbf' : '#c8524a';
      ctx.beginPath();
      ctx.arc(ox + (a.x + (b.x - a.x) * f) * s, oy + (a.y + (b.y - a.y) * f) * s, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  return {
    play, bounds, draw, drawMini,
    get on() { return on; },
    set on(v) {
      on = Boolean(v);
      document.body.classList.toggle('xray', on);
    },
    get busy() { return plays.some((p) => p.own); },
    durationOf: (card) => (card?.trace?.length ?? 0) * (HOP_MS + GAP_MS) + 600,
    close() {
      if (panel) panel.hidden = true;
    },
  };
}
