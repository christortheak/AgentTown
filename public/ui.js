// The DOM side of the game: conversations, result cards, the HUD (quests, your
// record, your phone, the town ledger) and toasts.
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

/** Show a result card; resolves with the value of the button pressed (extra `buttons`, or nothing for Okay). */
export function card(c, { note, buttons } = {}) {
  const service = c.type === 'service';
  const d = c.stamp ?? (service && c.decision === 'allow' ? { label: 'Done', tone: 'ok' } : DECISIONS[c.decision]) ?? { label: c.decision, tone: 'info' };
  const checks = c.checks ?? [];
  const failed = checks.filter((x) => !x.ok).length;
  const html = `
    <header>
      <div><span class="eyebrow">${esc(service ? c.place : c.title ? c.place : 'ID check')}</span><h3>${esc(c.title ?? c.place)}</h3></div>
      <div class="stamp ${d.tone}">${esc(d.label)}</div>
    </header>
    ${c.story ? `<div class="story"><span class="face">${esc(c.keeper?.face ?? '💬')}</span><div><b>${esc(c.keeper?.who ?? '')}</b>${prose(c.story)}</div></div>` : ''}
    ${!service ? `<p class="who"><b>${esc(c.actor)}</b> asked to <code>${esc(c.action)}</code>${c.classification ? ` · <span class="chip">${esc(CLASSIFICATIONS[c.classification] ?? c.classification)}</span>` : ''}</p>` : ''}
    ${c.reasons?.length ? `<ul class="reasons">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${c.note || note ? `<p class="note">${esc(c.note || note)}</p>` : ''}
    ${c.steps?.length ? `<section><h4>Before the badge check</h4><ul class="steps">${c.steps.map((s) => `<li class="${s.ok ? 'ok' : 'bad'}"><span>${s.ok ? '✓' : '✗'}</span><b>${esc(s.via)}</b> ${esc(s.text)}</li>`).join('')}</ul></section>` : ''}
    ${c.facts?.length ? `<dl class="facts">${c.facts.map((f) => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join('')}</dl>` : ''}
    ${c.learned?.length ? `<section><h4>What ${esc(c.place)} learned</h4><ul class="learned">${c.learned.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>` : ''}
    ${checks.length ? `<details><summary>What they checked (${checks.length - failed} of ${checks.length} passed)</summary><ul class="checks">${checks.map((x) => `<li class="${x.ok ? 'ok' : 'bad'}"><span>${x.ok ? '✓' : '✗'}</span>${esc(x.name)}${x.detail ? ` <small>${esc(x.detail)}</small>` : ''}</li>`).join('')}</ul></details>` : ''}
    ${c.policy ? `<p class="policy"><b>${esc(c.place)} asks for</b> ${esc(c.policy)}</p>` : ''}
    ${!service ? (c.receipt ? `<footer>Logged at ${esc(c.receipt.log.replace('https://', ''))}, entry #${esc(c.receipt.index)} · receipt ${c.receipt.verified ? 'verified ✓' : 'did NOT verify'}</footer>` : '<footer>Nothing was logged: there was no accountable agent to log against.</footer>') : ''}
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`;
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
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done();
      }
    };
    document.addEventListener('keydown', onKey, true);
    $('cardOk').onclick = () => done();
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
  { text: 'Get verified at Town Hall', done: (s) => Boolean(s.principal?.verified) },
  { text: 'Register your agent', done: (s) => Boolean(s.agent) },
  { text: 'Sign a grant at the Records Office', done: (s) => Boolean(s.grant) },
  { text: 'Buy something at two shops', done: (s) => s.events.filter((e) => e.startsWith('bought:')).length >= 2 },
  { text: 'Spawn a sub-agent and send it on an errand', done: (s, c) => c.errands > 0 },
  { text: 'Let your agent into your house', done: (s) => s.events.includes('home') },
  { text: 'Rest at home until night', done: (s) => s.events.includes('night') },
];

export const EXTRAS = [
  { text: 'Get a World ID; claim a pie (and try twice)', done: (s) => s.inventory.some((i) => i.name === 'A free pie') },
  { text: 'Pay the bridge toll (x402)', done: (s, c) => c.tolls > 0 },
  { text: 'Café Lumière only takes EU badges: get served', done: (s, c) => c.euCafe },
  { text: 'Unleash the rogue swarm (🎬)', done: (s, c) => c.swarm },
  { text: 'Try some mischief', done: (s, c) => c.mischief > 0 },
  { text: 'Take a badge to court', done: (s) => s.events.includes('court') },
  { text: 'Revoke your agent', done: (s) => s.agent?.status === 'revoked' },
];

const shortPpid = (p) => `…${String(p).split(':').pop().slice(-8)}`;

export function renderHud(s, counts) {
  const next = QUESTS.find((q) => !q.done(s, counts));
  $('questNext').textContent = next ? next.text : 'You did the whole day. Try the extras.';
  $('questList').innerHTML = QUESTS.map((q) => `<li class="${q.done(s, counts) ? 'done' : q === next ? 'next' : ''}">${esc(q.text)}</li>`).join('')
    + '<li class="extras-title">Try this</li>' + EXTRAS.map((q) => `<li class="extra ${q.done(s, counts) ? 'done' : ''}">${esc(q.text)}</li>`).join('');
  $('questCount').textContent = `${QUESTS.filter((q) => q.done(s, counts)).length}/${QUESTS.length}`;

  const rec = [];
  if (!s.principal) rec.push('<p class="muted">No record yet.</p>');
  else {
    const flags = [s.principal.verified ? '<span class="pill ok">verified IAL2</span>' : '<span class="pill">not verified</span>', s.principal.worldid ? '<span class="pill">World ID</span>' : '', s.principal.disclose ? '<span class="pill">name shown</span>' : ''].join(' ');
    rec.push(`<div class="row"><span>👤</span><div><b>${esc(s.principal.name)}</b> ${flags}<br><small>Principal at ${esc(s.principal.registry)} · only it knows your name</small></div></div>`);
  }
  if (s.agent) {
    const st = s.agent.status === 'revoked' ? '<span class="pill bad">revoked</span>' : s.badge ? '<span class="pill ok">badge on</span>' : '<span class="pill">badge off</span>';
    rec.push(`<div class="row"><span>🤖</span><div><b>${esc(s.agent.name)}</b> ${st}${s.agent.incognito ? ' <span class="pill">one-time numbers</span>' : ''}<br><small>Wallet ${esc(s.wallet.balance)} ${esc(s.wallet.asset)}</small></div></div>`);
  }
  if (s.grant) rec.push(`<div class="row"><span>📜</span><div><b>Grant</b><br><small>${s.grant.permissions.map(esc).join('<br>')}</small></div></div>`);
  if (s.helpers.length) {
    rec.push(`<div class="row"><span>🌱</span><div><b>Sub-agents</b><br><small>${s.helpers.map((h) => {
      const left = h.ephemeral_until ? Math.max(0, Math.round((h.ephemeral_until - Date.now()) / 1000)) : null;
      const status = h.status !== 'active' ? h.status : h.busy ? `out: ${h.busy}` : left !== null ? `lapses in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'standing';
      return `${esc(h.name)} · ${esc(status)}${h.budget ? ` · $${h.budget}` : ''}${/Harbor|B/.test(h.registry ?? '') ? ' · EU' : ''}`;
    }).join('<br>')}</small></div></div>`);
  }
  if (s.known.length) rec.push(`<div class="row"><span>🏷️</span><div><b>Places know you as</b><br><small>${s.known.map((k) => `${esc(k.place)} <code>${esc(shortPpid(k.ppid))}</code>`).join('<br>')}</small></div></div>`);
  $('recordBody').innerHTML = rec.join('');
}

let seenPhone = new Set();

/** Your phone: you are the principal, so approvals and incident reports come here. */
export function renderPhone(s) {
  const items = [];
  for (const a of s.phone.approvals) {
    const d = a.details;
    let text;
    if (a.purpose === 'delegate-agent') {
      const who = d.accountability ?? {};
      text = `<b>An agent wants into your house.</b><br><small>Who stands behind it: ${esc(String(who.type ?? '').replace('_', ' '))}, verified ${esc(who.assurance)} by ${esc(String(who.verifier ?? '').replace('https://', ''))}; chain length ${esc(who.chain_length)}.${who.identity ? '' : ' No name given.'}</small>`;
    } else {
      text = `<b>Approve this, just once?</b><br><small>${esc(d.summary ?? d.action)}${d.actor === 'human' ? '' : ' (asked by your agent)'}</small>`;
    }
    items.push(`<li class="approval"><div>${text}</div><div class="btns"><button class="primary" data-approve="${esc(a.request_id)}">Approve with passkey</button><button class="quiet" data-decline="${esc(a.request_id)}">Decline</button></div></li>`);
  }
  for (const n of [...s.phone.incidents].reverse()) {
    items.push(`<li class="incident"><b>⚠️ Report about ${esc(n.agent)}</b><br><small>${esc(n.summary)}. Reported by ${esc(n.reporter)}, relayed by the registry.</small></li>`);
  }
  $('phoneList').innerHTML = items.length ? items.join('') : '<li class="muted">Nothing yet. When a place needs your OK, it comes here.</li>';
  $('phoneCount').textContent = items.length ? String(items.length) : '';
  const ids = [...s.phone.approvals.map((a) => a.request_id), ...s.phone.incidents.map((n) => n.id)];
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

/** The town ledger: everything anyone did, newest first. Lines with a card open it. */
export function renderLedger(events) {
  const list = $('ledgerList');
  list.innerHTML = events.slice(-40).reverse().map((e) => `
    <li class="${e.tone ?? 'info'} ${e.mine ? 'mine' : ''} ${e.card ? 'open' : ''}" data-seq="${e.seq}">
      <i></i><span>${esc(e.text)}</span>
    </li>`).join('');
}

let toastTimer = null;
export function toast(text, tone = 'info') {
  const t = $('toast');
  t.textContent = text;
  t.className = `show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3600);
}
