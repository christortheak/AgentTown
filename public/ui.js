// The DOM side of the game: conversations, ID-check cards, the HUD (quests,
// your record, your phone) and toasts.
const $ = (id) => document.getElementById(id);

export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** Plain text with **bold** and blank-line paragraphs. */
const prose = (text) => `<p>${esc(text).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;

export const DECISIONS = {
  allow: { label: 'Allowed', tone: 'ok', icon: '✓' },
  deny: { label: 'Refused', tone: 'bad', icon: '✗' },
  refused: { label: 'Refused', tone: 'bad', icon: '✗' },
  step_up: { label: 'Needs your OK', tone: 'warn', icon: '?' },
  deferred: { label: 'Come back later', tone: 'warn', icon: '…' },
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

/**
 * Show a line of dialogue and wait for a choice.
 * choices: [{ label, value, primary?, cancel? }]; resolves { value, input }.
 */
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
    box.dataset.count = choices.length;
    dlg._choices = choices;
    if (!input) setTimeout(() => (box.querySelector('.primary') ?? box.querySelector('button'))?.focus({ preventScroll: true }), 30);
  });
}

/** Keep the dialog up while the town's services work. */
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
// The ID-check card: what a place decided, checked and learned
// ---------------------------------------------------------------------------

export function card(c, { note, title, stamp } = {}) {
  const d = stamp ?? DECISIONS[c.decision] ?? { label: c.decision, tone: 'info', icon: '•' };
  const checks = c.checks ?? [];
  const failed = checks.filter((x) => !x.ok).length;
  const html = `
    <header>
      <div><span class="eyebrow">${esc(title ?? 'ID check')}</span><h3>${esc(c.place)}</h3></div>
      <div class="stamp ${d.tone}">${esc(d.label)}</div>
    </header>
    <p class="who"><b>${esc(c.actor)}</b> asked to <code>${esc(c.action)}</code>${c.classification ? ` · <span class="chip">${esc(CLASSIFICATIONS[c.classification] ?? c.classification)}</span>` : ''}</p>
    ${c.reasons?.length ? `<ul class="reasons">${c.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
    ${c.learned?.length ? `<section><h4>What ${esc(c.place)} learned</h4><ul class="learned">${c.learned.map((l) => `<li>${esc(l)}</li>`).join('')}</ul></section>` : ''}
    ${checks.length ? `<details><summary>What they checked (${checks.length - failed} of ${checks.length} passed)</summary><ul class="checks">${checks.map((x) => `<li class="${x.ok ? 'ok' : 'bad'}"><span>${x.ok ? '✓' : '✗'}</span>${esc(x.name)}${x.detail ? ` <small>${esc(x.detail)}</small>` : ''}</li>`).join('')}</ul></details>` : ''}
    ${c.receipt ? `<footer>Logged at ${esc(c.receipt.log.replace('https://', ''))}, entry #${esc(c.receipt.index)} · receipt ${c.receipt.verified ? 'verified ✓' : 'did NOT verify'}</footer>` : '<footer>Nothing was logged: there was no accountable agent to log against.</footer>'}
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`;
  return showCard(html);
}

/** Any card-shaped panel (the night report, the court's answer, receipts). */
export function showCard(html) {
  closeDialog();
  const wrap = $('cardWrap');
  $('card').innerHTML = html;
  wrap.hidden = false;
  $('card').scrollTop = 0;
  return new Promise((resolve) => {
    const done = () => {
      wrap.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      resolve();
    };
    const onKey = (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done();
      }
    };
    document.addEventListener('keydown', onKey, true);
    const ok = $('cardOk');
    ok.onclick = done;
    setTimeout(() => ok.focus({ preventScroll: true }), 30);
  });
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

export const QUESTS = [
  { id: 'verified', text: 'Get verified at Town Hall', done: (s) => Boolean(s.principal) },
  { id: 'agent', text: 'Register your agent', done: (s) => Boolean(s.agent) },
  { id: 'grant', text: 'Sign a grant at the Records Office', done: (s) => Boolean(s.grant) },
  { id: 'shops', text: 'Buy something at both shops', done: (s) => s.events.includes('both-shops') },
  { id: 'passkey', text: 'Put a passkey on your front door', done: (s) => s.home.passkey },
  { id: 'home', text: 'Let your agent into your house', done: (s) => s.events.includes('home') },
  { id: 'night', text: 'Rest at home until night', done: (s) => s.events.includes('night') },
];

export const EXTRAS = [
  { text: 'Shop with your badge off (press B)', done: () => false },
  { text: "Find Maple's lost key and try it", done: (s) => s.events.includes('tried-key') },
  { text: 'Hire a helper; give it more than you have', done: (s) => Boolean(s.helper) },
  { text: "Take the night's visitors to court", done: (s) => s.events.includes('court') },
  { text: 'Revoke your agent', done: (s) => s.agent?.status === 'revoked' },
];

const shortPpid = (p) => `…${String(p).split(':').pop().slice(-8)}`;

export function renderHud(s) {
  const next = QUESTS.find((q) => !q.done(s));
  $('questNext').textContent = next ? next.text : 'You did the whole day. Try the extras.';
  $('questList').innerHTML = QUESTS.map((q) => `<li class="${q.done(s) ? 'done' : q === next ? 'next' : ''}">${esc(q.text)}</li>`).join('')
    + `<li class="extras-title">Try this</li>` + EXTRAS.map((q) => `<li class="extra ${q.done(s) ? 'done' : ''}">${esc(q.text)}</li>`).join('');
  $('questCount').textContent = `${QUESTS.filter((q) => q.done(s)).length}/${QUESTS.length}`;

  const rec = [];
  if (!s.principal) {
    rec.push('<p class="muted">No record yet. Town Hall keeps a record of who stands behind each agent.</p>');
  } else {
    rec.push(`<div class="row"><span>👤</span><div><b>${esc(s.principal.name)}</b> <span class="muted">(you, the principal)</span><br><small>Verified ${esc(s.principal.assurance)} by VerityCheck · only the registry knows your name</small></div></div>`);
  }
  if (s.agent) {
    const st = s.agent.status === 'revoked' ? '<span class="pill bad">revoked</span>' : s.badge ? '<span class="pill ok">badge on</span>' : '<span class="pill">badge off</span>';
    rec.push(`<div class="row"><span>🤖</span><div><b>${esc(s.agent.name)}</b> ${st}<br><small>Registered at Registry A · lineage depth budget 1</small></div></div>`);
  }
  if (s.grant) {
    rec.push(`<div class="row"><span>📜</span><div><b>Grant</b> <span class="muted">at Ledgerline</span><br><small>${s.grant.permissions.map(esc).join('<br>')}</small></div></div>`);
  }
  if (s.helper) {
    const left = Math.max(0, Math.round((s.helper.expires_at - Date.now()) / 1000));
    const st = s.helper.status === 'active' ? `<span class="pill">lapses in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}</span>` : `<span class="pill bad">${esc(s.helper.status)}</span>`;
    rec.push(`<div class="row"><span>🌱</span><div><b>${esc(s.helper.name)}</b> ${st}<br><small>Sub-agent · ${s.helper.budget ? `up to $${s.helper.budget} a purchase` : 'no budget yet'}</small></div></div>`);
  }
  if (s.known.length) {
    rec.push(`<div class="row"><span>🏷️</span><div><b>Places know you as</b><br><small>${s.known.map((k) => `${esc(k.place)} <code>${esc(shortPpid(k.ppid))}</code>`).join('<br>')}</small></div></div>`);
  }
  if (s.receipts) rec.push(`<p class="muted small">${s.receipts} entr${s.receipts === 1 ? 'y' : 'ies'} in the activity log, each with a signed receipt.</p>`);
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

let toastTimer = null;
export function toast(text, tone = 'info') {
  const t = $('toast');
  t.textContent = text;
  t.className = `show ${tone}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 3600);
}
