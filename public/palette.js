// The action deck: every action in town, always listed, searchable, with what
// you can do right here at the top. Picking an action somewhere else walks you
// there first. Some actions ask a question or two before they run.
import { esc } from './ui.js';

const GROUPS = ['You', 'Your agent', 'Your record', 'Sub-agents', 'Shops & services', 'Home', 'Mischief'];
const $ = (id) => document.getElementById(id);

let open = null;

export const paletteOpen = () => Boolean(open);

/**
 * Open the deck. Resolves with { action, params } or null.
 *   actions   the server's catalog
 *   pin       { key, text }: the step the day's list suggests next, pinned at the top
 *   here      { id, name } of the place you're standing at, or null
 *   greeting  { face, who, text } from the keeper here, or null
 *   placeName id -> display name
 *   nearby    (options) -> options sorted by distance, for "whom?" questions
 */
export function openPalette({ actions, pin = null, here, greeting, placeName, nearby }) {
  if (open) open.close(null);
  const root = $('palette');
  root.hidden = false;
  return new Promise((resolve) => {
    let query = '';
    let sel = 0;
    let stage = { kind: 'list' };
    let rows = [];

    const close = (result) => {
      root.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      open = null;
      resolve(result);
    };
    open = { close };

    const matches = (a) => !query || `${a.label} ${a.hint ?? ''} ${a.group} ${placeName(a.place) ?? ''}`.toLowerCase().includes(query);
    const rowHtml = (r, i) => `
      <li class="row ${i === sel ? 'sel' : ''} ${r.danger ? 'danger' : ''} ${r.disabled ? 'disabled' : ''}" data-i="${i}">
        <span class="ico">${esc(r.icon ?? '•')}</span>
        <span class="lbl">${esc(r.label)}${r.hint ? `<small>${esc(r.hint)}</small>` : ''}</span>
        ${r.done ? '<span class="chip done">✓ done</span>' : r.chip ? `<span class="chip ${r.chipTone ?? ''}">${esc(r.chip)}</span>` : ''}
      </li>`;

    function render() {
      const body = $('paletteBody');
      if (stage.kind === 'list') {
        $('paletteTitle').textContent = here ? `At ${here.name}` : 'What would you like to do?';
        rows = [];
        const sections = [];
        const pinned = pin && !query ? actions.find((a) => a.key === pin.key && !a.done) : null;
        if (pinned) sections.push({ title: `Next step · ${pin.text}`, items: [pinned], pinned: true });
        const hereRows = here ? actions.filter((a) => a.place === here.id && matches(a)) : [];
        if (hereRows.length) sections.push({ title: `Here · ${here.name}`, items: hereRows });
        for (const g of GROUPS) {
          const items = actions.filter((a) => a.group === g && matches(a) && !(here && a.place === here.id));
          if (items.length) sections.push({ title: g, items });
        }
        let html = greeting && !query ? `<div class="greet"><span class="face">${esc(greeting.face)}</span><p><b>${esc(greeting.who)}</b> ${esc(greeting.text)}</p></div>` : '';
        for (const s of sections) {
          html += `<h5 class="${s.pinned ? 'pinned' : ''}">${esc(s.title)}</h5><ul class="${s.pinned ? 'pinned' : ''}">`;
          for (const a of s.items) {
            const away = a.place && (!here || a.place !== here.id);
            const row = { ...a, chip: away ? `→ ${placeName(a.place)}` : a.place ? 'here' : null, chipTone: away ? '' : 'here', action: a };
            html += rowHtml(row, rows.length);
            rows.push(row);
          }
          html += '</ul>';
        }
        if (!rows.length) html += '<p class="empty">Nothing matches. Everything in town is in here somewhere; try another word.</p>';
        body.innerHTML = html;
        $('paletteSearch').hidden = false;
      } else {
        const { action, param, params } = stage;
        $('paletteTitle').textContent = `${action.label} · ${param.label}`;
        $('paletteSearch').hidden = true;
        if (param.input) {
          body.innerHTML = `<div class="ask"><input id="paletteInput" maxlength="24" value="${esc(param.value ?? '')}" autocomplete="off" spellcheck="false"><button class="primary" id="paletteGo"><kbd>↵</kbd>Go</button></div>`;
          rows = [];
          const input = $('paletteInput');
          setTimeout(() => { input.focus(); input.select(); }, 20);
          const go = () => next({ ...params, [param.key]: input.value });
          $('paletteGo').onclick = go;
          input.onkeydown = (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              go();
            }
          };
          return;
        }
        let options = param.options ?? [];
        if (param.key === 'npc') options = nearby(options);
        rows = options.map((o) => ({ icon: '›', label: o.label, hint: o.hint, value: o.value }));
        if (!rows.length) rows = [{ icon: '…', label: 'No one to choose yet', hint: 'Try anyway: the service will say why not', value: undefined, disabled: true }];
        body.innerHTML = `<ul>${rows.map(rowHtml).join('')}</ul><p class="back">Esc to go back</p>`;
      }
      body.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    }

    function next(params) {
      const { action } = stage;
      const missing = (action.params ?? []).find((pm) => !(pm.key in params) && !(pm.key in (action.fixed ?? {})));
      if (missing) {
        if (missing.here && here && missing.options?.some((o) => o.value === here.id)) return next({ ...params, [missing.key]: here.id });
        stage = { kind: 'param', action, param: missing, params };
        sel = 0;
        render();
        return;
      }
      close({ action, params: { ...(action.fixed ?? {}), ...params } });
    }

    function choose(i) {
      const r = rows[i];
      if (!r) return;
      if (stage.kind === 'list') {
        stage = { kind: 'list', action: r.action };
        next({});
      } else {
        next({ ...stage.params, [stage.param.key]: r.value });
      }
    }

    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (stage.kind === 'param') {
          stage = { kind: 'list' };
          sel = 0;
          render();
        } else close(null);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        if (!rows.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length;
        render();
      } else if (e.key === 'Enter') {
        if (e.target.id === 'paletteInput') return;
        e.preventDefault();
        e.stopPropagation();
        choose(sel);
      }
    }
    document.addEventListener('keydown', onKey, true);

    const search = $('paletteSearch');
    search.value = '';
    search.oninput = () => {
      query = search.value.trim().toLowerCase();
      sel = 0;
      render();
    };
    $('paletteBody').onclick = (e) => {
      const li = e.target.closest('.row');
      if (li) choose(Number(li.dataset.i));
    };
    $('paletteClose').onclick = () => close(null);
    root.onclick = (e) => {
      if (e.target === root) close(null);
    };
    render();
    setTimeout(() => search.focus(), 20);
  });
}

export function closePalette() {
  open?.close(null);
}
