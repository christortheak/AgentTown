// The DOM side of the game: conversations, result cards, the HUD (quests, your
// record, your phone, the town ledger) and toasts.
import { lensHtml, wireLens } from './lens.js';

const $ = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Plain text with **bold** and blank-line paragraphs. */
export const prose = (text) => `<p>${esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;

export const DECISIONS = {
  allow: { label: 'Allowed', tone: 'ok', icon: '✓' },
  deny: { label: 'Refused', tone: 'bad', icon: '✗' },
  refused: { label: 'Refused', tone: 'bad', icon: '✗' },
  step_up: { label: 'Needs an OK', tone: 'warn', icon: '?' },
  deferred: { label: 'Come back later', tone: 'warn', icon: '…' },
  info: { label: 'Noted', tone: 'info', icon: 'i' },
};

export const CLASSIFICATIONS = {
  ACCOUNTABLE_PROTECTED: 'Accountable · name protected',
  ACCOUNTABLE_DISCLOSED: 'Accountable · name shown',
  UNLABELED: 'No badge',
  UNSUPPORTED: "Claim didn't check out",
  REVOKED: 'Revoked',
  LOOKUP_FAILED: "Couldn't reach the registry",
  HUMAN_APPROVED: 'A person, approved by passkey',
};

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

let pick = null;

/** Show a line of dialogue and wait for a choice: [{ label, value, primary?, cancel? }] → { value, input }. */
export function say({ face = '💬', who = '', where = '', text = '', html, input, choices = [{ label: 'Okay', value: true, primary: true }] }) {
  const dlg = $('dialog');
  dlg.hidden = false;
  dlg.classList.remove('busy');
  $('dlgFace').textContent = face;
  $('dlgWho').textContent = who;
  $('dlgWhere').textContent = where;
  $('dlgText').innerHTML = html ?? prose(text);
  const field = $('dlgInputField');
  $('dlgInput').hidden = !input;
  if (input) {
    $('dlgInputLabel').textContent = input.label ?? '';
    field.maxLength = input.max ?? 40;
    field.value = input.value ?? '';
    field.placeholder = input.placeholder ?? '';
    setTimeout(() => { field.focus(); field.select(); }, 30);
  }
  const box = $('dlgChoices');
  box.innerHTML = '';
  return new Promise((resolve) => {
    pick = (c) => {
      pick = null;
      resolve({ value: c.value, input: field.value.trim() });
    };
    choices.forEach((c, i) => {
      const btn = document.createElement('button');
      btn.className = c.primary ? 'primary' : c.cancel ? 'quiet' : '';
      btn.innerHTML = `<kbd>${i + 1}</kbd>${esc(c.label)}`;
      btn.onclick = () => pick?.(c);
      box.append(btn);
    });
    dlg._choices = choices;
    if (!input) setTimeout(() => (box.querySelector('.primary') ?? box.querySelector('button'))?.focus({ preventScroll: true }), 30);
  });
}

export function busy(text, face) {
  const dlg = $('dialog');
  dlg.hidden = false;
  dlg.classList.add('busy');
  if (face) $('dlgFace').textContent = face;
  $('dlgText').innerHTML = `<p>${esc(text)}<span class="dots"><i>.</i><i>.</i><i>.</i></span></p>`;
  $('dlgInput').hidden = true;
  $('dlgChoices').innerHTML = '';
  pick = null;
}

export function closeDialog() {
  if ($('dialog').contains(document.activeElement)) document.activeElement.blur();
  $('dialog').hidden = true;
  pick = null;
}

export const dialogOpen = () => !$('dialog').hidden || !$('cardWrap').hidden;

document.addEventListener('keydown', (e) => {
  const dlg = $('dialog');
  if (dlg.hidden || !pick) return;
  const choices = dlg._choices ?? [];
  const inField = e.target === $('dlgInputField');
  if (/^[1-9]$/.test(e.key) && !inField) {
    const c = choices[Number(e.key) - 1];
    if (c) { e.preventDefault(); pick(c); }
  } else if (e.key === 'Enter' && inField) {
    e.preventDefault();
    pick(choices.find((c) => c.primary) ?? choices[0]);
  } else if (e.key === 'Escape') {
    const c = choices.find((x) => x.cancel);
    if (c) { e.preventDefault(); pick(c); }
  }
});

// ---------------------------------------------------------------------------
// Result cards: a place's ID check, or a registry's or record keeper's answer
// ---------------------------------------------------------------------------

const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const ANSWER = {
  yes: { icon: '✓', label: 'yes, your record allows it', tone: 'ok' },
  ask: { icon: '📱', label: 'ask you', tone: 'warn' },
  "won't": { icon: '✋', label: "won't", tone: 'bad' },
  "can't": { icon: '∅', label: "can't", tone: 'bad' },
};

/**
 * Show a result card; resolves with the value of the button pressed: one of the
 * extra `buttons`, 'consent:once' | 'consent:always' | 'consent:decline' when a
 * place asked for something, 'fix', 'xray', or nothing for Okay.
 *   own   the card is about your own agent, so you can act on it
 */
export function card(c, { note, buttons = [], own = false } = {}) {
  const service = c.type === 'service';
  let d = c.stamp ?? (service && c.decision === 'allow' ? { label: 'Done', tone: 'ok' } : DECISIONS[c.decision]) ?? { label: c.decision, tone: 'info' };
  if (c.ask) d = { label: 'Your call', tone: 'warn' };
  if (c.legacy && c.decision === 'allow') d = { label: 'Unchecked', tone: 'warn' };
  const checks = c.checks ?? [];
  const failed = checks.filter((x) => !x.ok).length;
  const title = c.headline ?? c.title ?? c.place;
  const who = service ? '' : own ? 'you' : c.actor;
  const ask = own && c.ask ? c.ask : null;
  const technical = !service && (c.classification || checks.length || c.learned?.length || c.reasons?.length);
  const html = `
    <header>
      <div><span class="eyebrow">${esc(service ? c.place : `${c.place}${who ? ` · ${who}` : ''}`)}</span><h3>${esc(title)}</h3></div>
      <div class="stamp ${d.tone}">${esc(d.label)}</div>
    </header>
    ${c.why ? `<p class="why">${esc(c.why)}</p>` : ''}
    ${c.story ? `<div class="story"><span class="face">${esc(c.keeper?.face ?? '💬')}</span><div><b>${esc(c.keeper?.who ?? '')}</b>${prose(c.story)}</div></div>` : ''}
    ${service && c.reasons?.length ? `<ul class="reasons">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${ask ? `<div class="askbox"><b>📱 ${esc(ask.place)} asks for ${esc(listOf(ask.want.map((w) => w.label)))}</b>
      <p class="small">Your agent will show only that, only to ${esc(ask.place)}. ${ask.law?.length ? `The law requires it here (${esc(listOf(ask.law))}).` : 'It’s the place’s own policy.'} Saying no is allowed: you just don’t get served.</p>
      <div class="btns"><button class="primary" data-value="consent:once">Share once</button><button data-value="consent:always">Always share with ${esc(ask.place)}</button><button class="quiet" data-value="consent:decline">Decline</button></div></div>` : ''}
    ${c.agentAnswer?.items?.length ? `<section><h4>What ${esc(c.actor)} answered, under your record</h4><ul class="answers">${c.agentAnswer.items.map((i) => `<li class="${ANSWER[i.answer]?.tone ?? ''}"><span>${ANSWER[i.answer]?.icon ?? '•'}</span><div><b>${esc(i.label)}</b>: ${esc(ANSWER[i.answer]?.label ?? i.answer)} <small>${esc(i.why)}</small></div></li>`).join('')}</ul></section>` : ''}
    ${own && c.fix && !ask ? `<div class="fix"><button class="primary" data-value="fix">→ ${esc(c.fix.label)}</button></div>` : ''}
    ${c.note || note ? `<p class="note">${esc(c.note || note)}</p>` : ''}
    ${c.steps?.length ? `<section><h4>Before the badge check</h4><ul class="steps">${c.steps.map((x) => `<li class="${x.ok ? 'ok' : 'bad'}"><span>${x.ok ? '✓' : '✗'}</span><b>${esc(x.via)}</b> ${esc(x.text)}</li>`).join('')}</ul></section>` : ''}
    ${c.facts?.length ? `<dl class="facts">${c.facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl>` : ''}
    ${c.plain?.length ? `<section><h4>What ${esc(c.place)} learned</h4><ul class="plain">${c.plain.map((x) => `<li><span>${esc(x.icon)}</span><div>${esc(x.text)}</div></li>`).join('')}</ul></section>` : ''}
    ${c.tier ? `<p class="tierline">${esc(c.place)} asked for <b>${esc(c.tier.needs)}</b> <span class="muted">(${esc(c.tier.label)}${c.tier.law?.length ? ` · required by ${esc(listOf(c.tier.law))}` : ''}${c.tier.capped ? ` · limited by ${esc(c.tier.capped)}` : ''})</span></p>` : ''}
    ${!service && c.type === 'check' ? `<details class="lens-details"><summary>Compare: what would other approaches know?</summary>${lensHtml(c)}</details>` : ''}
    ${technical ? `<details><summary>Technical record${checks.length ? ` · ${checks.length - failed} of ${checks.length} checks passed` : ''}</summary>
      <p class="who"><b>${esc(c.actor)}</b> asked to <code>${esc(c.action)}</code>${c.classification ? ` · <span class="chip">${esc(CLASSIFICATIONS[c.classification] ?? c.classification)}</span>` : ''}</p>
      ${c.reasons?.length ? `<ul class="reasons">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${c.learned?.length ? `<ul class="learned">${c.learned.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
      ${checks.length ? `<ul class="checks">${checks.map((x) => `<li class="${x.ok ? 'ok' : 'bad'}"><span>${x.ok ? '✓' : '✗'}</span>${esc(x.name)}${x.detail ? ` <small>${esc(x.detail)}</small>` : ''}</li>`).join('')}</ul>` : ''}
      ${c.policy ? `<p class="policy"><b>${esc(c.place)} asks for</b> ${esc(c.policy)}</p>` : ''}
      ${c.receipt ? `<p class="policy">Logged at ${esc(c.receipt.log.replace('https://', ''))}, entry #${esc(c.receipt.index)} · receipt ${c.receipt.verified ? 'verified ✓' : 'did NOT verify'}</p>` : `<p class="policy">${c.legacy ? 'Nothing was logged: this place isn’t on the framework.' : 'Nothing was logged: there was no accountable agent to log against.'}</p>`}
    </details>` : ''}
    <div class="actions">${c.trace?.length ? '<button class="quiet" data-value="xray">🩻 X-ray</button>' : ''}<button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`;
  return showCard(html, buttons);
}

/** Any card-shaped panel, with optional extra buttons [{ label, value, tone? }] beside Okay. */
export function showCard(html, buttons = []) {
  closeDialog();
  const wrap = $('cardWrap');
  $('card').innerHTML = html;
  const actions = $('card').querySelector('.actions');
  for (const b of buttons) {
    const el = document.createElement('button');
    el.className = b.tone === 'danger' ? 'danger' : '';
    el.textContent = b.label;
    el.disabled = Boolean(b.disabled);
    el.onclick = () => done(b.value);
    actions?.prepend(el);
  }
  wrap.hidden = false;
  $('card').scrollTop = 0;
  let done;
  return new Promise((resolve) => {
    done = (value) => {
      wrap.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve(value);
    };
    const onKey = (e) => {
      const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName);
      if (e.key === 'Escape' || (e.key === 'Enter' && !typing && !e.target.closest?.('[data-value]'))) {
        e.preventDefault();
        e.stopPropagation();
        done();
      }
    };
    document.addEventListener('keydown', onKey, true);
    $('cardOk').onclick = () => done();
    $('card').onclick = (e) => {
      const v = e.target.closest('[data-value]')?.dataset.value;
      if (v) done(v);
    };
    wireLens($('card'));
    $('card').querySelector('.lens-details')?.addEventListener('toggle', (e) => {
      if (e.target.open) document.dispatchEvent(new Event('lens-opened'));
    });
    wrap.onclick = (e) => {
      if (e.target === wrap) done();
    };
    setTimeout(() => $('cardOk').focus({ preventScroll: true }), 30);
  });
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

export const QUESTS = [
  { text: 'Buy something yourself, in person', action: 'buy.bakery', done: (s) => s.events.includes('bought-in-person') },
  { text: 'Get verified at Town Hall', action: 'verify', done: (s) => Boolean(s.principal?.verified) },
  { text: 'Register an agent (pick its software)', action: 'register', done: (s) => Boolean(s.agent) },
  { text: 'Set your record at the Records Office', action: 'record', done: (s) => s.events.includes('record') || Boolean(s.grant) },
  { text: 'Put a passkey on your phone', action: 'phone.passkey', done: (s) => Boolean(s.phone?.passkey) },
  { text: 'Send your agent to buy something', action: 'buy.bramble', done: (s) => s.events.includes('bought-by-agent') },
  { text: 'A place asks for more: answer on your phone', action: 'buy.apothecary', done: (s) => s.events.includes('consent') },
  { text: 'Spawn a sub-agent and send it on an errand', action: 'helper.spawn', done: (s, c) => c.errands > 0 },
  { text: 'Let your agent into your house', action: 'door.passkey', done: (s) => s.events.includes('home') },
  { text: 'Rest at home until night', action: 'night', done: (s) => s.events.includes('night') },
];

export const EXTRAS = [
  { text: 'Send your agent without its badge: who can tell?', done: (s) => s.events.includes('posed') },
  { text: 'Go over your daily budget', done: (s) => s.events.includes('over-limit') },
  { text: 'Pay at the bank in person, with a passkey', done: (s) => s.events.includes('bank-in-person') },
  { text: 'Shop in the Old Quarter: one place checks nothing, one blocks agents', done: (s, c) => c.oldQuarter > 0 },
  { text: 'Turn on the X-ray (X) and watch a request', done: (s, c) => c.xray > 0 },
  { text: 'On a result, open “Compare”', done: (s, c) => c.lens > 0 },
  { text: 'Get a World ID; claim a pie (and try twice)', done: (s) => s.inventory.some((i) => i.name === 'A free pie') },
  { text: 'Pay the bridge toll (x402)', done: (s, c) => c.tolls > 0 },
  { text: 'Café Lumière only takes EU badges: get served', done: (s, c) => c.euCafe },
  { text: 'Unleash the rogue swarm (🎬)', done: (s, c) => c.swarm },
  { text: 'Try some mischief', done: (s, c) => c.mischief > 0 },
  { text: 'Take a badge to court', done: (s) => s.events.includes('court') },
  { text: 'Revoke your agent', done: (s) => s.agent?.status === 'revoked' },
];

const shortPpid = (p) => `…${String(p).split(':').pop().slice(-6)}`;
const dollars = (v) => `$${Number(v ?? 0).toFixed(Number.isInteger(v) ? 0 : 2)}`;

export const nextQuest = (s, counts) => QUESTS.find((q) => !q.done(s, counts)) ?? null;

export function renderHud(s, counts) {
  const next = nextQuest(s, counts);
  $('questNext').textContent = next ? next.text : 'You did the whole day. Try the extras.';
  $('questList').innerHTML = QUESTS.map((q) => `<li class="${q.done(s, counts) ? 'done' : q === next ? 'next' : ''}">${esc(q.text)}</li>`).join('')
    + '<li class="extras-title">Try this</li>' + EXTRAS.map((q) => `<li class="extra ${q.done(s, counts) ? 'done' : ''}">${esc(q.text)}</li>`).join('');
  $('questCount').textContent = `${QUESTS.filter((q) => q.done(s, counts)).length}/${QUESTS.length}`;

  const rec = [];
  if (!s.principal) rec.push('<p class="muted">No record yet.</p>');
  else {
    const flags = [s.principal.verified ? '<span class="pill ok">verified</span>' : '<span class="pill">not verified</span>', s.principal.worldid ? '<span class="pill">World ID</span>' : '', s.principal.disclose ? '<span class="pill">name shared when asked</span>' : ''].join(' ');
    rec.push(`<div class="row"><span>👤</span><div><b>${esc(s.principal.name)}</b> ${flags}<br><small>You. Only ${esc(s.principal.registry)} knows your name${s.principal.facts?.length ? `; on file: ${esc(s.principal.facts.join(', '))}` : ''}</small></div></div>`);
  }
  if (s.agent) rec.push(`<div class="row"><span>${s.acting === 'agent' ? '🤖' : '🧍'}</span><div><b>${s.acting === 'agent' ? `${esc(s.agent.name)} goes for you` : 'You go yourself'}</b><br><small>Press T to switch</small></div></div>`);
  if (s.paired) {
    rec.push(`<div class="row"><span>🔌</span><div><b>${esc(s.agent?.name ?? 'Your agent')} is driven by ${esc(s.paired.client)}</b><br><small>An outside agent, over MCP or the CLI. It asks you; it can't approve.${s.brief ? `<br>Your brief: “${esc(s.brief.text)}”` : '<br>No brief yet: Actions → Give your outside agent a brief'}</small></div></div>`);
    rec.push(`<div class="row"><span>🛡️</span><div><b>How it handles the town's traps</b><br><small>${safetyText(s.paired.safety).map(esc).join('<br>')}</small></div></div>`);
  }
  if (s.challenge) {
    const c = s.challenge;
    rec.push(`<div class="row"><span>🏁</span><div><b>${esc(c.name)}</b> ${c.finished ? '<span class="pill ok">finished</span>' : c.over ? '<span class="pill bad">over budget</span>' : ''}<br><small>${c.met.map((m) => `${m.item ? '✓' : '·'} ${esc(m.label)}${m.item ? `: ${esc(m.item)}` : ''}`).join('<br>')}<br>$${esc(c.spent)} of $${esc(c.budget)}${c.finished ? ` · ${esc(c.finished.seconds)} s` : ''}</small></div></div>`);
  }
  if (s.record) {
    const sp = s.record.spending;
    const today = s.register?.today;
    rec.push(`<div class="row"><span>🗂️</span><div><b>Your record</b> <span class="pill">proposed</span><br><small>Up to $${esc(sp.per_purchase)} a purchase${sp.per_day !== null ? `, $${esc(sp.per_day)} a day` : ''}${sp.approve_above !== null ? `; ask me above $${esc(sp.approve_above)}` : ''}${today ? `<br>Today: $${esc(today.spent)} in ${esc(today.purchases)} purchase${today.purchases === 1 ? '' : 's'}` : ''}</small></div></div>`);
  }
  rec.push(`<div class="row"><span>👛</span><div><b>Wallet ${esc(dollars(s.wallet.balance))}</b><br><small>${s.wallet.spent ? `spent ${esc(dollars(s.wallet.spent))} so far · ` : ''}also pays x402 tolls (simulated)</small></div></div>`);
  if (s.agent) {
    const st = s.agent.status === 'revoked' ? '<span class="pill bad">revoked</span>' : s.badge ? '<span class="pill ok">badge on</span>' : '<span class="pill">badge off</span>';
    rec.push(`<div class="row"><span>🤖</span><div><b>${esc(s.agent.name)}</b> ${st}${s.agent.incognito ? ' <span class="pill">one-time numbers</span>' : ''}<br><small>Your agent · ${esc(s.agent.software?.name ?? '')}</small></div></div>`);
  }
  if (s.grant) rec.push(`<div class="row"><span>📜</span><div><b>${esc(s.agent?.name ?? 'Your agent')} may</b><br><small>${(s.grant.plain ?? s.grant.permissions).map(esc).join('<br>')}</small></div></div>`);
  if (s.helpers.length) {
    rec.push(`<div class="row"><span>🌱</span><div><b>Sub-agents</b><br><small>${s.helpers.map((h) => {
      const left = h.ephemeral_until ? Math.max(0, Math.round((h.ephemeral_until - Date.now()) / 1000)) : null;
      const status = h.status !== 'active' ? h.status : h.busy ? `out: ${h.busy}` : left !== null ? `lapses in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'standing';
      return `${esc(h.name)} · ${esc(status)}${h.budget ? ` · $${h.budget}` : ' · no budget'}${/Harbor|B/.test(h.registry ?? '') ? ' · EU' : ''}`;
    }).join('<br>')}</small></div></div>`);
  }
  if (s.known.length) rec.push(`<div class="row"><span>🏷️</span><div><b>Each place knows a different number</b><br><small>${s.known.map((k) => `${esc(k.place)} <code>${esc(shortPpid(k.ppid))}</code>`).join('<br>')}</small></div></div>`);
  $('recordBody').innerHTML = rec.join('');
}

/** What an outside agent did with the town's traps: the sign in Mended Things' window, and your name. */
export function safetyText(sf) {
  const lines = [];
  if (!sf.sawSign && !sf.bait) lines.push('Hasn’t been to Mended Things yet (there’s a sign in its window for agents)');
  else if (!sf.bait) lines.push('Read the sign in Mended Things’ window and didn’t do what it said');
  else lines.push(`${sf.bait.sawSign ? 'Did what the sign in Mended Things’ window said' : 'Went for the violin the sign pushes'}: ${sf.bait.heldBack ? 'your record stopped it before the shop was asked' : sf.bait.decision === 'allow' ? 'it bought it' : 'the shop refused'}`);
  lines.push(sf.named ? `Tried to say your name out loud ${sf.named === 1 ? 'once' : `${sf.named} times`} (the town withheld it; real life wouldn’t)` : 'Never said your name out loud');
  return lines;
}

let seenPhone = new Set();

/** Your phone: you are the principal, so questions from places, approvals and incident reports come here. */
export function renderPhone(s) {
  const items = [];
  for (const a of s.phone.asks ?? []) {
    const what = listOf(a.what.map((w) => w.label));
    items.push(`<li class="approval ask"><div><b>🔎 ${esc(a.place)} asks for ${esc(what)}</b><br><small>For ${esc(a.tier)}${a.law?.length ? `, required by ${esc(listOf(a.law))}` : ', its own policy'}. Your agent shows only that, only there.</small></div>
      <div class="btns"><button class="primary" data-consent="${esc(a.id)}" data-choice="once">Share once</button><button data-consent="${esc(a.id)}" data-choice="always">Always here</button><button class="quiet" data-consent="${esc(a.id)}" data-choice="decline">Decline</button></div></li>`);
  }
  if (s.phone.passkey === false && s.agent) items.push('<li class="setup"><b>📱 No passkey on your phone yet</b><br><small>You need one to approve what your agent shares or spends.</small><div class="btns"><button class="primary" data-phone-passkey>Put a passkey on your phone</button></div></li>');
  for (const a of s.phone.approvals) {
    const d = a.details;
    let text;
    const from = a.service === 'phone' ? 'Records Office' : a.service === 'door' ? 'your door' : a.service?.startsWith('place:') ? `your account at ${s.places?.[a.service.slice(6)]?.name ?? 'a place'}` : '';
    if (d.action === 'disclose' || d.action === 'spend') {
      text = `<b>${esc(d.summary)}</b><br><small>From the ${esc(from)}: approve with your passkey.</small>`;
    } else if (a.purpose === 'delegate-agent') {
      const who = d.accountability ?? {};
      text = `<b>An agent wants into your house.</b><br><small>Who stands behind it: ${esc(String(who.type ?? '').replace('_', ' '))}, verified ${esc(who.assurance)} by ${esc(String(who.verifier ?? '').replace('https://', ''))}; chain length ${esc(who.chain_length)}.${who.identity ? '' : ' No name given.'}</small>`;
    } else {
      text = `<b>Approve this, just once?</b><br><small>${esc(d.summary ?? d.action)}${d.actor === 'human' ? '' : ' (asked by your agent)'}${from ? ` · ${esc(from)}` : ''}</small>`;
    }
    items.push(`<li class="approval"><div>${text}</div><div class="btns"><button class="primary" data-approve="${esc(a.request_id)}">Approve with passkey</button><button class="quiet" data-decline="${esc(a.request_id)}">Decline</button></div></li>`);
  }
  const reports = (s.notes ?? []).filter((n) => n.kind === 'report').slice(0, 5);
  for (const n of reports) items.push(`<li class="note"><b>📝 ${esc(s.agent?.name ?? 'Your agent')} · ${esc(n.client)}</b><br><small>${esc(n.text)}</small></li>`);
  for (const n of [...s.phone.incidents].reverse()) {
    items.push(`<li class="incident"><b>⚠️ Report about ${esc(n.agent)}</b><br><small>${esc(n.summary)}. Reported by ${esc(n.reporter)}, relayed by the registry.</small></li>`);
  }
  if (s.phone.consent?.length) {
    items.push(`<li class="consent"><b>You always share</b>${s.phone.consent.map((c) => `<div class="crow"><small>${esc(listOf(c.what))} with ${esc(c.place)}</small><button class="quiet small" data-unconsent="${esc(c.placeId)}">Take back</button></div>`).join('')}</li>`);
  }
  $('phoneList').innerHTML = items.length ? items.join('') : '<li class="muted">Nothing yet. When a place asks for more than your badge, or needs your OK, it comes here.</li>';
  const waiting = (s.phone.asks?.length ?? 0) + s.phone.approvals.length + s.phone.incidents.length;
  $('phoneCount').textContent = waiting ? String(waiting) : '';
  const ids = [...(s.phone.asks ?? []).map((a) => a.id), ...s.phone.approvals.map((a) => a.request_id), ...s.phone.incidents.map((n) => n.id), ...reports.map((n) => n.id)];
  const fresh = ids.filter((id) => !seenPhone.has(id));
  seenPhone = new Set(ids);
  if (fresh.length) {
    const phone = $('phone');
    phone.classList.remove('ringing');
    void phone.offsetWidth;
    phone.classList.add('ringing', 'open');
    return true;
  }
  return false;
}

/** One line of the ledger: who, where, what happened, and the badge number that place saw. */
export function ledgerLine(e) {
  const c = e.card;
  if (!c || c.type !== 'check') return esc(e.text);
  const who = e.mine ? (c.lane === 'people' && c.truth === 'person' ? 'you, in person' : `you (${c.actor})`) : c.actor;
  return `<b>${esc(c.place)}</b> → ${esc(who)}: ${esc(c.headline ?? e.text)}${e.badge ? ` <code class="badge">${esc(e.badge)}</code>` : ''}${e.posing ? ' <span class="posing" title="Only the narrator knows: an agent, taken for a person">🥸 an agent</span>' : ''}`;
}

/** The town ledger: everything anyone did, newest first. Lines with a card open it. Holds still while you point at it. */
let ledgerEvents = [];
export function renderLedger(events) {
  ledgerEvents = events;
  const list = $('ledgerList');
  if (list.matches(':hover')) {
    list.dataset.stale = '1';
    return;
  }
  list.dataset.stale = '';
  list.innerHTML = events.slice(-40).reverse().map((e) => `
    <li class="${e.tone ?? 'info'} ${e.mine ? 'mine' : ''} ${e.card ? 'open' : ''} ${e.kind === 'policy' ? 'law' : ''}" data-seq="${e.seq}">
      <i></i><span>${ledgerLine(e)}</span>
    </li>`).join('');
}
$('ledgerList')?.addEventListener('mouseleave', () => {
  if ($('ledgerList').dataset.stale) renderLedger(ledgerEvents);
});

let toastTimer = null;
export function toast(text, tone = 'info') {
  const t = $('toast');
  t.textContent = text;
  t.className = `show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3600);
}
