// The Records Office counter (a proposed extension; see docs/PROPOSED.md): your
// record, which says how your agents may spend and what places may learn, and
// your register of every purchase they tried.
import { esc, showCard } from './ui.js';

const KINDS = ['books', 'home', 'food', 'health', 'garden'];
const SHARE_LABELS = {
  name: 'Your name',
  age_over_18: 'Proof you are over 18',
  bill_of_materials: "Your agent's bill of materials",
  world_id: 'Your World ID (lets your agent prove a unique human)',
  facts: 'Other facts on your record',
};
const OUTCOMES = {
  covered: ['ok', 'within your record'],
  released: ['info', 'not used: the place said no or asked for more'],
  needs_approval: ['warn', 'asked you first'],
  per_purchase: ['bad', 'over the limit per purchase'],
  per_day: ['bad', 'over the daily budget'],
  count: ['bad', 'too many purchases today'],
  category: ['bad', 'not a kind your record covers'],
};
const money = (v) => (v === null || v === undefined ? '' : String(v));

/** Edit your record. Resolves with the new record, or null if you leave it as it was. */
export async function openRecordEditor(S) {
  const r = S.record;
  const places = Object.entries(S.places).map(([id, p]) => ({ id, name: p.name }));
  const share = (key) => {
    const rule = r.sharing[key];
    return `<div class="share-row" data-share="${key}">
      <div class="share-head"><b>${esc(SHARE_LABELS[key])}</b><label>Unless listed below: <select data-k="otherwise"><option value="ask" ${rule.otherwise === 'ask' ? 'selected' : ''}>ask me (passkey)</option><option value="never" ${rule.otherwise === 'never' ? 'selected' : ''}>never share</option></select></label></div>
      <div class="chips"><small class="muted">Always share with:</small>${places.map((p) => `<label class="chip-toggle"><input type="checkbox" data-always="${p.id}" ${rule.always.includes(p.id) ? 'checked' : ''}>${esc(p.name)}</label>`).join('')}</div>
    </div>`;
  };
  const facts = Object.entries(r.facts);
  const value = await showCard(`
    <header><div><span class="eyebrow">Records Office · proposed extension</span><h3>Your record</h3></div><div class="stamp info">v${esc(S.register?.version ?? 1)}</div></header>
    <p class="why">What your agents may spend, and what places may learn about you. The limit per purchase also goes into your grant at Ledgerline, which places check themselves. The totals, counts and "ask me first" are checked here before ${esc(S.agent?.name ?? 'your agent')} spends: no single place could.</p>
    <form id="recordForm" class="record-form" onsubmit="return false">
      <h4>Spending</h4>
      <div class="grid2">
        <label>Per purchase, up to $<input type="number" min="0" step="1" name="per_purchase" value="${money(r.spending.per_purchase)}"></label>
        <label>Per day, in all, up to $<input type="number" min="0" step="1" name="per_day" value="${money(r.spending.per_day)}" placeholder="no total"></label>
        <label>Purchases a day, at most <input type="number" min="0" step="1" name="purchases_per_day" value="${money(r.spending.purchases_per_day)}" placeholder="no limit"></label>
        <label>Ask me first above $<input type="number" min="0" step="1" name="approve_above" value="${money(r.spending.approve_above)}" placeholder="never"></label>
      </div>
      <div class="chips">${KINDS.map((k) => `<label class="chip-toggle"><input type="checkbox" name="cat" value="${k}" ${r.spending.categories.includes(k) ? 'checked' : ''}>${k}</label>`).join('')}</div>
      <h4>When a place asks</h4>
      ${Object.keys(SHARE_LABELS).map(share).join('')}
      <h4>Facts on file <span class="muted">(your own statements; places see them labelled "not verified")</span></h4>
      <div id="factRows">${[...facts, ['', '']].map(([k, v]) => `<div class="fact"><input placeholder="what, e.g. loyalty card" value="${esc(k.replace(/_/g, ' '))}" data-fact="k"><input placeholder="value" value="${esc(v)}" data-fact="v"></div>`).join('')}</div>
      <button type="button" class="quiet small" data-add-fact>+ another fact</button>
    </form>
    <div class="actions"><button data-value="save" class="primary">Sign and file this version</button><button class="quiet" id="cardOk">Leave it</button></div>`);
  if (value !== 'save') return null;
  return readForm(r);
}

/** Read the editor's form. showCard leaves the card's HTML in place until the next one. */
function readForm(r) {
  const form = document.getElementById('recordForm');
  const num = (name) => {
    const v = form.elements[name].value.trim();
    return v === '' ? null : Number(v);
  };
  const sharing = {};
  for (const row of form.querySelectorAll('[data-share]')) {
    sharing[row.dataset.share] = {
      otherwise: row.querySelector('[data-k="otherwise"]').value,
      always: [...row.querySelectorAll('[data-always]')].filter((x) => x.checked).map((x) => x.dataset.always),
    };
  }
  const facts = {};
  for (const row of form.querySelectorAll('.fact')) {
    const k = row.querySelector('[data-fact="k"]').value.trim();
    const v = row.querySelector('[data-fact="v"]').value.trim();
    if (k && v) facts[k] = v;
  }
  return {
    spending: {
      per_purchase: num('per_purchase') ?? r.spending.per_purchase, per_day: num('per_day'), purchases_per_day: num('purchases_per_day'), approve_above: num('approve_above'),
      categories: [...form.querySelectorAll('[name="cat"]')].filter((x) => x.checked).map((x) => x.value),
    },
    sharing, facts,
  };
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('[data-add-fact]')) return;
  const row = document.createElement('div');
  row.className = 'fact';
  row.innerHTML = '<input placeholder="what" data-fact="k"><input placeholder="value" data-fact="v">';
  document.getElementById('factRows')?.append(row);
});

/** Every purchase your agents tried, as the Records Office saw it. */
export function showRegister(S) {
  const reg = S.register;
  const s = reg?.record.spending;
  const rows = (reg?.attempts ?? []).map((a) => {
    const [tone, label] = OUTCOMES[a.outcome] ?? ['info', a.outcome];
    return `<li><span class="stamp-sm ${tone}">${esc(label)}</span>$${esc(a.amount)} at ${esc(a.place)}<small>${new Date(a.at).toLocaleTimeString()}${a.approved ? ' · approved with your passkey' : ''}${a.reason && tone !== 'ok' ? ` · ${esc(a.reason)}` : ''}</small></li>`;
  }).join('');
  return showCard(`
    <header><div><span class="eyebrow">Records Office · proposed extension</span><h3>Your register</h3></div></header>
    ${reg ? `<div class="score">
      <div><b>$${esc(reg.today.spent)}</b>${s.per_day !== null ? ` of $${esc(s.per_day)}` : ''}<small>spent in the last 24 hours</small></div>
      <div><b>${esc(reg.today.purchases)}</b>${s.purchases_per_day !== null ? ` of ${esc(s.purchases_per_day)}` : ''}<small>purchases</small></div>
    </div>
    <p class="muted small">Places never see these totals: each one gets only a signed "within the record", for its own purchase. The Records Office does see where and how much. That is the price of limits no single place can check.</p>
    ${rows ? `<ul class="receipts">${rows}</ul>` : '<p class="muted">Nothing yet. Every purchase your agents try shows up here, including the ones your record stopped.</p>'}` : '<p class="muted">No record yet.</p>'}
    <div class="actions"><button class="primary" id="cardOk"><kbd>↵</kbd>Okay</button></div>`);
}
