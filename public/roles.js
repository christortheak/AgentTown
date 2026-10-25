// Joining the town, and the panel each role works from: a shopkeeper's counter,
// a homeowner's door, the police case board, the judge's docket, the council's
// rulebook.
import * as api from './api.js';
import { esc, DECISIONS, CLASSIFICATIONS, showCard } from './ui.js';

const $ = (id) => document.getElementById(id);
const tail = (ppid) => `…${String(ppid).split(':').pop().slice(-8)}`;

/** The join screen. Resolves with the join result once the server has a session for this tab. */
export async function showJoin() {
  const root = $('join');
  const box = $('joinBox');
  root.hidden = false;
  let roles = await api.get('/api/roles');
  let role = 'agent';
  let claim = null;
  let name = '';
  return new Promise((resolve) => {
    const render = (error) => {
      const r = roles.roles.find((x) => x.id === role);
      const claims = role === 'shopkeeper' ? roles.shops : role === 'homeowner' ? roles.houses : null;
      if (claims && (!claim || claims.find((c) => c.id === claim)?.taken)) claim = claims.find((c) => !c.taken)?.id ?? null;
      box.innerHTML = `
        <header><h3>Join AgentTown</h3><span class="hint">many people can play at once</span></header>
        <div class="roles">${roles.roles.map((x) => `<button class="role ${x.id === role ? 'sel' : ''}" data-role="${x.id}" ${x.taken ? 'disabled' : ''}><span>${x.icon}</span><b>${esc(x.label)}</b>${x.taken ? '<small>taken</small>' : ''}</button>`).join('')}</div>
        <p class="blurb">${esc(r.blurb)}</p>
        ${claims ? `<h5>${role === 'shopkeeper' ? 'Which place will you run?' : 'Which house is yours?'}</h5><div class="claims">${claims.map((c) => `<button class="${c.id === claim ? 'sel' : ''}" data-claim="${c.id}" ${c.taken ? 'disabled' : ''}>${esc(c.name)}${c.taken ? ' · taken' : ''}</button>`).join('')}</div>` : ''}
        <label class="input"><span>${role === 'agent' ? 'Your name (only the registry keeps it)' : 'Your name'}</span><input id="joinName" maxlength="30" placeholder="e.g. Robin Ash" value="${esc(name)}" autocomplete="off" spellcheck="false"></label>
        ${error ? `<p class="err">${esc(error)}</p>` : ''}
        <div class="actions"><button class="primary" id="joinGo">Join the town</button></div>
        <p class="muted small">To play another role at the same time, open the town in another tab or on another device. Anyone can leave and join again, under any name.</p>`;
      const input = $('joinName');
      input.oninput = () => { name = input.value; };
      input.onkeydown = (e) => { if (e.key === 'Enter') go(); };
      $('joinGo').onclick = go;
    };
    const go = async () => {
      if ((role === 'shopkeeper' || role === 'homeowner') && !claim) return render('Everything of that kind is taken. Pick another role.');
      try {
        const res = await api.join(role, name.trim() || 'Robin Ash', claim);
        root.hidden = true;
        resolve(res);
      } catch (err) {
        roles = await api.get('/api/roles');
        render(err.message);
      }
    };
    box.onclick = (e) => {
      const r = e.target.closest('[data-role]');
      const c = e.target.closest('[data-claim]');
      if (r) { role = r.dataset.role; claim = null; render(); }
      if (c) { claim = c.dataset.claim; render(); }
    };
    render();
    setTimeout(() => $('joinName')?.focus(), 30);
  });
}

const row = (e) => {
  const d = DECISIONS[e.decision] ?? { label: e.decision ?? '', tone: e.tone ?? 'info' };
  const c = e.card;
  const what = c?.headline ?? d.label;
  const seen = c?.legacy ? 'not checked' : c?.lane === 'people' && c.classification !== 'HUMAN_APPROVED' ? c.seenAs ?? 'no badge' : e.classification ? CLASSIFICATIONS[e.classification] ?? e.classification : '';
  return `<li class="${d.tone}" data-seq="${e.seq}"><i></i><span><b>${esc(c?.actor ?? '')}</b> · ${esc(what)}${seen ? ` <small class="muted">· ${esc(seen)}</small>` : ''}${e.badge ? ` <code class="badge">${esc(e.badge)}</code>` : ''}</span></li>`;
};

const ADOPTION_WORDS = { full: 'checks badges', pilot: 'pilot', none: 'not on the framework', block: 'blocks agents' };
const FROM = { keeper: 'your choice', law: 'the law', adoption: 'adoption', rails: 'other rails', people: 'people', proposed: 'proposed' };
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 0);

/** How much of town is on the framework, and what that meant for the visits so far. */
export function scoreboardHtml(board, { table = true } = {}) {
  const t = board.totals;
  const checked = t.visits - t.unseen;
  const rogue = t.rogueServed + t.rogueUnseen + t.rogueStopped;
  return `
    <div class="score">
      <div><b>${board.adopted}</b> of ${board.of}<small>places check badges</small></div>
      <div><b>${pct(t.accountable, checked)}%</b><small>of checked visits showed a valid badge</small></div>
      <div><b>${t.unseen}</b><small>visits nobody checked</small></div>
      ${rogue ? `<div><b>${t.rogueStopped}</b>/${rogue}<small>rogue visits stopped; ${t.rogueServed} more reportable, ${t.rogueUnseen} unseen</small></div>` : ''}
      <div><b>${t.posed ?? 0}</b><small>agents taken for people (only the narrator knows); ${t.posersStopped ?? 0} more stopped</small></div>
      <div><b>${(t.people ?? 0) - (t.peopleTurnedAway ?? 0)}</b>/${t.people ?? 0}<small>people served in person</small></div>
    </div>
    ${table ? `<table class="policies score-table"><thead><tr><th>Place</th><th>Uses the framework?</th><th title="visits">Visits</th><th title="showed a valid badge">Badge</th><th title="showed no badge">None</th><th title="nobody checked">Unchecked</th><th title="agents taken for people">🥸</th></tr></thead>
      <tbody>${board.rows.map((r) => `<tr><td>${esc(r.name)} <small class="muted">${esc(r.jurisdiction === 'eu' ? 'EU' : 'US')}</small></td><td>${esc(ADOPTION_WORDS[r.adoption])}${r.mandated ? ' <small class="muted">(by law)</small>' : ''}</td><td>${r.visits ?? 0}</td><td>${r.accountable ?? 0}</td><td>${r.unbadged ?? 0}</td><td>${r.unseen ?? 0}</td><td>${r.posed ?? 0}</td></tr>`).join('')}</tbody></table>` : ''}`;
}

/** Each jurisdiction's regimes, as switches; `compact` puts each jurisdiction on one line. */
export function lawHtml(law, { compact = false } = {}) {
  if (compact) {
    return law.jurisdictions.map((j) => `<div class="law-row"><b>${esc(j.name[0].toUpperCase() + j.name.slice(1))}</b>${law.regimes.map((r) => `<label class="chip-toggle" title="${esc(r.blurb)}"><input type="checkbox" data-law="${esc(j.id)}:${esc(r.id)}" ${j.regimes.includes(r.id) ? 'checked' : ''}>${esc(r.name)}</label>`).join('')}</div>`).join('');
  }
  return law.jurisdictions.map((j) => `
    <h5>${esc(j.name[0].toUpperCase() + j.name.slice(1))}</h5>
    <div class="regimes">${law.regimes.map((r) => `<label class="regime"><input type="checkbox" data-law="${esc(j.id)}:${esc(r.id)}" ${j.regimes.includes(r.id) ? 'checked' : ''}><span><b>${esc(r.name)}</b><small>${esc(r.blurb)}</small></span></label>`).join('')}</div>`).join('');
}

export const presetsHtml = (law) => `<div class="btns">${law.presets.map((p) => `<button data-preset="${esc(p.id)}" title="${esc(p.blurb)}">${esc(p.label)}</button>`).join('')}</div>`;

/** The panel for someone who isn't playing an agent. */
export function renderRolePanel(S) {
  const me = S.me;
  let html = '';
  if (me.role === 'shopkeeper') {
    const p = S.place;
    const regs = `<option value="*" ${!p.policy.accepts ? 'selected' : ''}>Any registry</option>${S.registries.map((r) => `<option value="${esc(r.id)}" ${p.policy.accepts?.length === 1 && p.policy.accepts[0] === r.id ? 'selected' : ''}>${esc(r.name)} only</option>`).join('')}`;
    const checking = p.effective === 'full' || p.effective === 'pilot';
    const st = S.stats ?? {};
    html = `
      <header><div><h1>🏪 ${esc(p.name)}</h1><p>${esc(me.name)}, you run this place · ${esc(p.jurisdiction === 'eu' ? 'Harbor (EU rules)' : 'the town (US rules)')}</p></div></header>
      <div class="assistant">
        <b>🔌 ${S.paired ? `${esc(S.paired.client)} minds the counter with you` : 'Your own agent at the counter'}</b>
        <div class="btns">${S.paired ? '<button data-act="brief">Brief it</button><button class="quiet" data-act="unpair">Disconnect</button>' : '<button data-act="pair">Connect your own agent</button>'}</div>
        ${S.brief ? `<small>Your brief: “${esc(S.brief.text)}”</small>` : ''}
        ${S.notes?.length ? `<ul class="notes">${S.notes.slice(0, 5).map((n) => `<li>${n.kind === 'think' ? '💭' : '📝'} ${esc(n.text)}</li>`).join('')}</ul>` : ''}
      </div>
      <label class="adopt">Use the framework? <select data-k="adoption">${S.adoptions.map((a) => `<option value="${esc(a.id)}" ${a.id === p.adoption ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label>
      <p class="muted small">${esc(S.adoptions.find((a) => a.id === p.effective)?.blurb ?? '')}${p.effective !== p.adoption ? ' <b>The law requires this here, whatever you choose.</b>' : ''}</p>
      <label class="adopt">People without a badge: <select data-k="people">${S.peoples.map((a) => `<option value="${esc(a.id)}" ${a.id === p.policy.people ? 'selected' : ''}>${esc(a.label)}</option>`).join('')}</select></label>
      <p class="muted small">${esc(S.peoples.find((a) => a.id === p.policy.people)?.blurb ?? '')}</p>
      ${checking ? `<div class="policy-row">
        <label>Registries <select data-k="accepts">${regs}</select></label>
        <label><input type="checkbox" data-k="aaf" ${p.policy.aaf === 'required' ? 'checked' : ''}> Badge</label>
        ${p.kind === 'shop' ? `<label><input type="checkbox" data-k="age" ${p.policy.age ? 'checked' : ''}> Proof of age (18+)</label>` : ''}
        <label><input type="checkbox" data-k="worldid" ${p.policy.worldid ? 'checked' : ''}> World ID</label>
        <label><input type="checkbox" data-k="x402" ${p.policy.x402 ? 'checked' : ''}> x402</label>
        <label title="Proposed extension"><input type="checkbox" data-k="budget" ${p.policy.budget ? 'checked' : ''}> Within its owner's budget</label>
        <label title="Proposed extension: facts from the owner's record, labelled not verified">Also ask for <input data-k="facts" value="${esc((p.policy.facts ?? []).join(', ').replace(/_/g, ' '))}" placeholder="e.g. loyalty card" size="12"></label>
      </div>` : ''}
      <h5>What you ask for, and why</h5>
      <ul class="lines">${p.lines.map((l) => `<li><span class="tag ${esc(l.from)}">${esc(FROM[l.from] ?? l.from)}</span>${esc(l.text)}</li>`).join('')}</ul>
      ${S.market ? `<div class="ticker">${S.market.map((m) => `<span><b>${esc(m.id)}</b> $${esc(m.price)} <em class="${m.change >= 0 ? 'up' : 'down'}">${m.change >= 0 ? '▲' : '▼'}${Math.abs(m.change)}%</em></span>`).join('')}</div>` : ''}
      <p class="small muted">${st.visits ?? 0} visits · ${st.accountable ?? 0} with a valid badge · ${st.unbadged ?? 0} with none · ${st.unseen ?? 0} unchecked</p>
      <h5>Customers <span class="muted">(click one)</span></h5>
      <ol class="rows">${S.customers.map(row).join('') || '<li class="muted">Nobody yet.</li>'}</ol>`;
  } else if (me.role === 'homeowner') {
    html = `
      <header><div><h1>🏡 ${esc(me.claimName)}</h1><p>${esc(me.name)}, this is your house</p></div></header>
      <div class="btns">${S.home.passkey ? '<span class="pill ok">passkey on the door</span>' : '<button class="primary" data-act="passkey">Put a passkey on your door</button>'}<button data-act="locks">Change the locks</button></div>
      <p class="muted small">When an agent wants in, your phone (bottom right) shows who stands behind it, and you decide.</p>
      <h5>At your door <span class="muted">(click one)</span></h5>
      <ol class="rows">${S.door.map(row).join('') || '<li class="muted">Nobody has come by yet.</li>'}</ol>`;
  } else if (me.role === 'police') {
    html = `
      <header><div><h1>👮 Case board</h1><p>Officer ${esc(me.name)}</p></div></header>
      <p class="muted small">Places send in cases. Click any line in the town ledger to open one yourself. Only a court order makes a registry say who stands behind a badge.</p>
      <ol class="rows">${S.cases.map((c) => `<li class="${c.findings ? 'ok' : 'warn'}" data-case="${c.id}"><i></i><span><b>${esc(c.id)}</b> ${esc(c.title)} · ${esc(c.status)} · ${c.evidence.length} badge${c.evidence.length === 1 ? '' : 's'}${c.findings ? ` · ${esc(c.findings.principal.identity.legal_name)}` : ''}</span></li>`).join('') || '<li class="muted">No cases yet. Quiet town.</li>'}</ol>`;
  } else if (me.role === 'council') {
    html = `
      <header><div><h1>🏛️ Town council</h1><p>Councillor ${esc(me.name)}</p></div></header>
      <p class="small">Make the law. <b>Registries, record keepers and badges stay exactly the same</b>: only what places must ask for changes.</p>
      ${lawHtml(S.law)}
      <h5>How much of town uses the framework</h5>
      ${presetsHtml(S.law)}
      ${scoreboardHtml(S.law.scoreboard)}`;
  } else if (me.role === 'judge') {
    const pending = S.petitions.filter((p) => p.status === 'pending');
    const done = S.petitions.filter((p) => p.status !== 'pending');
    const pet = (p) => `<li class="${p.status === 'pending' ? 'warn' : p.status === 'granted' ? 'ok' : 'bad'}" data-petition="${p.id}"><i></i><span><b>${esc(p.kind)}</b> in ${esc(p.case)} · asked by ${esc(p.by)}${p.status !== 'pending' ? ` · ${esc(p.status)}` : ''}</span></li>`;
    html = `
      <header><div><h1>⚖️ Docket</h1><p>Judge ${esc(me.name)}</p></div></header>
      <h5>Waiting for you</h5>
      <ol class="rows">${pending.map(pet).join('') || '<li class="muted">Nothing to rule on.</li>'}</ol>
      <h5>Ruled</h5>
      <ol class="rows">${done.map(pet).join('') || '<li class="muted">Nothing yet.</li>'}</ol>`;
  }
  $('rolePanel').innerHTML = `${html}<button class="quiet small" data-act="leave">Leave town</button>`;
}

/** A case file, as the police and the judge see it. */
export function caseCard(c, { petition, buttons = [] } = {}) {
  const f = c.findings;
  return showCard(`
    <header><div><span class="eyebrow">Case ${esc(c.id)} · ${esc(c.kind)}</span><h3>${esc(c.title)}</h3></div><div class="stamp ${f ? 'ok' : 'warn'}">${esc(c.status)}</div></header>
    ${petition ? `<p class="note">The police ask the court to <b>${esc(petition.kind)}</b> (petition ${esc(petition.id)}, by ${esc(petition.by)}).</p>` : ''}
    <p>Filed by ${esc(c.by)}.</p>
    <section><h4>Evidence</h4><ul class="learned">${c.evidence.map((e) => `<li>${esc(e.place)}: badge <code>${esc(tail(e.ppid))}</code></li>`).join('')}</ul></section>
    ${f ? `<section><h4>What the court found</h4><dl class="facts">
        <dt>Principal</dt><dd>${esc(f.principal.identity.legal_name)} (${esc(f.principal.type.replace('_', ' '))}, ${esc(f.principal.identity.jurisdiction)})</dd>
        <dt>Chain</dt><dd>${f.chain.map((x) => `${esc(x.label)} (${esc(x.status)})`).join(' → ')}</dd>
        <dt>Its badges in the case</dt><dd>${esc(f.linked)} of ${c.evidence.length}; ${esc(f.related)} at that place in all</dd>
        ${f.others?.length ? `<dt>Not the same principal</dt><dd>${f.others.map((o) => `${esc(o.name)} (${o.badges} badge${o.badges === 1 ? '' : 's'})`).join(', ')}: likely bystanders</dd>` : ''}
      </dl></section>` : '<p class="note">Nobody knows who stands behind these badges yet: each place saw a different number, and none of them can link the numbers. A court order can make the registry say.</p>'}
    ${c.outcome.length ? `<p class="policy">${esc(c.outcome.join(' · '))}</p>` : ''}
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`, buttons);
}

export const policeButtons = (c) => {
  const who = c.findings?.principal.identity.legal_name;
  return [
    { label: who ? `Ask to ban ${who}` : 'Ask the court to ban', value: 'ban', disabled: !c.findings, tone: 'danger' },
    { label: who ? `Ask to delete ${who}'s agents` : 'Ask to delete the agents', value: 'delete', disabled: !c.findings },
    { label: 'Ask the court to identify', value: 'identify', disabled: Boolean(c.findings) },
  ];
};
