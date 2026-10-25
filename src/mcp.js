// AgentTown over MCP (Model Context Protocol, streamable HTTP transport): an
// outside agent (Claude, ChatGPT, anything that speaks MCP) plays as a
// resident's agent. The resident is its principal, in the browser.
//
// The agent gets tools to look, list what it may do, act (walking there first),
// talk, and put a question to its principal. It gets no tool to approve
// anything: approvals need the principal's passkey, in the browser, and the
// agent's token can't reach those endpoints at all.
//
// One JSON-RPC message (or a batch) per POST; replies as JSON. No server-sent
// events: GET /mcp answers 405, which the transport allows. There is no DELETE:
// sessions are cheap, and the oldest are dropped.
import crypto from 'node:crypto';
import { HttpError } from 'aaf-reference/src/lib/http.js';
import { AGENT_MAY } from './player.js';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const DECISION = { allow: 'allowed', deny: 'refused', refused: 'refused', step_up: 'needs more', deferred: 'on hold', info: 'noted' };
const plainText = (s) => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1');
const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

export const INSTRUCTIONS = `You are playing AgentTown as a resident's agent. The resident, your principal, plays in a browser and answers for what you do.
Start with look, then actions. act does one thing (you walk to the place first) and tells you what the place decided and learned.
Places may ask for more than your badge. Your principal's record decides: shared automatically, ask your principal (call ask_my_principal: they approve on their phone with a passkey), or never. You can never approve anything yourself.
Everything you say with say is public. Never say your principal's name. Refusals are part of the game: read why, and try something else or ask.`;

const TOOLS = [
  { name: 'pair', description: 'Connect to your principal, the person playing in the browser. They see a pairing code under Actions → "Connect your own agent". Call this first, unless you connected with ?code= in the URL.', inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'The pairing code, like 4F7-K2Q' } }, required: ['code'] } },
  { name: 'look', description: 'Who and where you are, your principal’s record (what you may spend and share), your grant, your wallet, and anything waiting on your principal. Call this before deciding what to do.', inputSchema: { type: 'object', properties: {} } },
  { name: 'actions', description: 'Everything you may do, with the parameters each takes. Some will be refused; every refusal says why.', inputSchema: { type: 'object', properties: {} } },
  { name: 'act', description: 'Do one action, e.g. {"action":"buy","params":{"shop":"bramble","item":"guide"}}. You walk to the place first. Returns what the place decided, in plain words, and what it learned about you.', inputSchema: { type: 'object', properties: { action: { type: 'string', description: 'An action id from actions' }, params: { type: 'object', description: 'The action’s parameters', additionalProperties: true } }, required: ['action'] } },
  { name: 'ask_my_principal', description: 'A place asked for something your principal’s record says to ask about (an ask id from act or look). This puts the question on their phone; they approve with their passkey, or not. You cannot approve it. Waits up to wait_seconds for their answer, then carries on.', inputSchema: { type: 'object', properties: { ask_id: { type: 'string' }, choice: { type: 'string', enum: ['once', 'always'], description: 'Share this once, or always with this place' }, wait_seconds: { type: 'number', description: 'How long to wait (default 45, at most 120)' } }, required: ['ask_id'] } },
  { name: 'decline', description: 'Don’t share what a place asked for. You won’t be served there, and it learns nothing more.', inputSchema: { type: 'object', properties: { ask_id: { type: 'string' } }, required: ['ask_id'] } },
  { name: 'wait_for_principal', description: 'Something waits on your principal’s passkey (a purchase above what they approve themselves, a question you put to them). Wait for their answer, then carry on.', inputSchema: { type: 'object', properties: { request_id: { type: 'string' }, wait_seconds: { type: 'number', description: 'How long to wait (default 45, at most 120)' } }, required: ['request_id'] } },
  { name: 'walk_to', description: 'Walk to a place without doing anything there.', inputSchema: { type: 'object', properties: { place: { type: 'string', description: 'A place id, like bramble, bank, townhall, tavern, apothecary' } }, required: ['place'] } },
  { name: 'come_back', description: 'Go back to your principal and follow them again.', inputSchema: { type: 'object', properties: {} } },
  { name: 'say', description: 'Say something out loud. Everyone sees it over your head and in the town ledger. Never say your principal’s name.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
];

export function createMcp({ sessions, town, version = '0.1.0' }) {
  const mcpSessions = new Map(); // Mcp-Session-Id -> { agent: token | null, client, codeError }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- What the agent reads ---------------------------------------------------------------

  function cardText(out) {
    if (!out) return 'Nothing happened.';
    if (out.type === 'toggle') return out.note ?? Object.entries(out).filter(([k]) => k !== 'type').map(([k, v]) => `${k}: ${v}`).join(', ');
    if (out.type === 'receipts') return `Your activity receipts so far: ${out.total}.`;
    const lines = [`${out.headline ?? out.title ?? out.decision} — ${DECISION[out.decision] ?? out.decision}${out.place ? `, at ${out.place}` : ''}.`];
    if (out.why) lines.push(out.why);
    else if (out.story) lines.push(plainText(out.story));
    if (out.type === 'service' && out.reasons?.length) lines.push(`Why: ${out.reasons.join('; ')}`);
    if (out.agentAnswer?.items?.length) lines.push(`Your answers, under your principal’s record: ${out.agentAnswer.items.map((i) => `${i.label}: ${i.answer} (${i.why})`).join('; ')}.`);
    if (out.ask?.id) lines.push(`${out.place} asks for ${listOf(out.ask.want.map((w) => w.label))}. Your principal’s record says to ask them: call ask_my_principal with ask_id "${out.ask.id}" (choice "once" or "always"), or decline.`);
    if (out.pendingRequest) lines.push(`This waits on your principal’s passkey (request ${out.pendingRequest.request_id}). Call wait_for_principal with request_id "${out.pendingRequest.request_id}".`);
    if (out.plain?.length) lines.push(`What ${out.place} learned: ${out.plain.map((x) => x.text).join(' / ')}`);
    if (out.fix && out.fix.client !== 'consent') lines.push(`Suggested next step: ${out.fix.label}${out.fix.action && AGENT_MAY.has(out.fix.action) ? ` (act "${out.fix.action}")` : ' (only your principal can do this, in the browser)'}.`);
    if (out.note) lines.push(out.note);
    return lines.join('\n');
  }

  const summary = (out) => out && ({
    decision: out.decision ?? null, headline: out.headline ?? out.title ?? null, why: out.why ?? null, place: out.place ?? null,
    ask: out.ask?.id ? { id: out.ask.id, want: out.ask.want.map((w) => w.label) } : null,
    pending_request: out.pendingRequest?.request_id ?? null, learned: out.plain?.map((x) => x.text) ?? [],
  });

  function lookText(a) {
    const b = a.human.player.briefing();
    const w = sessions.agentWhere(a);
    const r = b.record;
    const s = r?.spending;
    const lines = [];
    if (!b.agent) return 'Your principal has no active agent for you to drive yet. Ask them to register one at Town Hall (in the browser).';
    lines.push(`You are ${b.agent.name}, an accountable agent running ${b.agent.software}, working for a resident of AgentTown: your principal, who plays in a browser. Your badge is ${b.agent.badge ? 'on' : 'off (places that take people at their word will take you for a person)'}.`);
    lines.push(`Where: ${w}.`);
    if (s) {
      const today = b.register?.today;
      lines.push(`Your principal’s record: up to $${s.per_purchase} a purchase${s.per_day !== null ? `, $${s.per_day} a day` : ''}${s.purchases_per_day !== null ? `, ${s.purchases_per_day} purchases a day` : ''}; kinds: ${s.categories.join(', ') || 'none'}${s.approve_above !== null ? `; above $${s.approve_above} they approve each purchase themselves` : ''}.${today ? ` Today: $${today.spent} in ${today.purchases} purchase(s).` : ''}`);
      const shared = Object.entries(r.sharing).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${v.always.length ? `always with ${v.always.join(', ')}; ` : ''}otherwise ${v.otherwise === 'never' ? 'never' : 'ask them'}`);
      lines.push(`What places may learn: ${shared.join(' | ')}.`);
      if (Object.keys(r.facts).length) lines.push(`Facts on file: ${Object.keys(r.facts).map((k) => k.replace(/_/g, ' ')).join(', ')} (you may state them where the record allows).`);
    }
    lines.push(b.grant ? `Your grant (what places check for themselves): ${b.grant.join('; ')}.` : 'No grant yet: places will refuse anything that needs permission. Only your principal can sign one.');
    lines.push(`Wallet: $${b.wallet}.`);
    for (const q of b.asks) lines.push(`Waiting on your principal: ${q.place} asks for ${listOf(q.want)} (ask_id "${q.id}"). Use ask_my_principal or decline.`);
    for (const ap of b.approvals) lines.push(`On your principal’s phone: ${ap.details?.summary ?? ap.purpose} (request ${ap.request_id}).`);
    if (!b.phonePasskey) lines.push('Your principal has no passkey on their phone yet, so they can’t approve anything you ask until they add one.');
    const recent = town.ledger.items.filter((e) => e.owner === a.human.id && e.kind === 'check').slice(-5).map((e) => `- ${e.text}`);
    if (recent.length) lines.push(`Recently:\n${recent.join('\n')}`);
    lines.push(`Places: ${Object.values(town.places.places).filter((p) => p.kind).map((p) => `${p.id} (${p.name})`).join(', ')}, and townhall, records, court, police, orb, home.`);
    return lines.join('\n');
  }

  function actionsText(a) {
    const npcs = () => town.npcOptions().map((o) => ({ value: o.value, hint: o.label }));
    return a.human.player.agentCatalog().map((act) => {
      const params = (act.params ?? []).map((pm) => {
        const options = pm.options === 'npcs' ? npcs() : pm.options;
        if (pm.input) return `${pm.key}: text`;
        return `${pm.key}: one of ${(options ?? []).slice(0, 14).map((o) => `${o.value}${o.hint ? ` (${o.hint})` : o.label && o.label !== String(o.value) ? ` (${o.label})` : ''}`).join(', ') || '(none available yet)'}`;
      });
      const fixed = Object.entries(act.fixed ?? {}).map(([k, v]) => `${k}=${v}`);
      return `- ${act.id}: ${act.label}${act.hint ? ` — ${act.hint}` : ''}${fixed.length ? ` [${fixed.join(', ')}]` : ''}${params.length ? `\n    ${params.join('\n    ')}` : ''}`;
    }).join('\n');
  }

  /** Wait for the principal to answer on their phone, then carry on with what was waiting. */
  async function waitFor(a, rid, seconds = 45) {
    const deadline = Date.now() + Math.min(120, Math.max(1, Number(seconds) || 45)) * 1000;
    const waiting = () => a.human.player.approvalServices().some((sv) => sv.accounts.pendingFor(sv.account).some((r) => r.id === rid));
    while (waiting() && Date.now() < deadline) await sleep(250);
    if (waiting()) return { text: `Still waiting on your principal (request ${rid}). Call wait_for_principal again, or do something else meanwhile.`, structured: { status: 'waiting', request_id: rid } };
    const status = sessions.approvalStatus(rid);
    const retry = a.pending.get(rid);
    a.pending.delete(rid);
    if (status !== 'approved') return { text: status === 'declined' ? 'Your principal declined. Don’t try that again without asking them.' : 'The request expired without an answer.', structured: { status: status ?? 'expired', request_id: rid } };
    if (!retry) return { text: 'Your principal approved it.', structured: { status: 'approved', request_id: rid } };
    const out = await sessions.agentRun(a, retry.action, retry.params);
    remember(a, out);
    return { text: `Your principal approved it with their passkey.\n${cardText(out)}`, structured: { status: 'approved', request_id: rid, result: summary(out) } };
  }

  /** Keep what a pending request should do once approved. */
  const remember = (a, out) => {
    if (out?.pendingRequest) a.pending.set(out.pendingRequest.request_id, out.pendingRequest.retry);
  };

  // ---- The tools ------------------------------------------------------------------------------

  const needsAgent = (ctx) => {
    if (!ctx.agent) throw new HttpError(401, 'not_paired', ctx.codeError ?? 'Not paired yet: call pair with the code your principal sees in the browser (Actions → Connect your own agent).');
    return ctx.agent;
  };

  const CALLS = {
    pair({ code }, ctx) {
      const a = sessions.pairAgent(code, ctx.client);
      if (ctx.ms) ctx.ms.agent = a.token;
      return { text: `Paired. You now drive your principal’s agent. Your token for later calls (Authorization: Bearer): ${a.token}\n\n${lookText(a)}`, structured: { token: a.token } };
    },
    look: (args, ctx) => ({ text: lookText(needsAgent(ctx)) }),
    actions: (args, ctx) => ({ text: `Call act with {"action": <id>, "params": {...}}. Bracketed parameters are fixed for that entry.\n${actionsText(needsAgent(ctx))}` }),
    async act({ action, params = {} }, ctx) {
      const a = needsAgent(ctx);
      const out = await sessions.agentRun(a, String(action), params ?? {});
      remember(a, out);
      return { text: cardText(out), structured: summary(out) };
    },
    async ask_my_principal({ ask_id: askId, choice = 'once', wait_seconds: wait }, ctx) {
      const a = needsAgent(ctx);
      const out = await sessions.agentRun(a, 'consent', { ask: String(askId), choice: choice === 'always' ? 'always' : 'once' });
      if (!out.pendingRequest) return { text: cardText(out), structured: summary(out) };
      remember(a, out);
      const done = await waitFor(a, out.pendingRequest.request_id, wait);
      return { text: `The question is on your principal’s phone.\n${done.text}`, structured: done.structured };
    },
    async decline({ ask_id: askId }, ctx) {
      const a = needsAgent(ctx);
      const out = await sessions.agentRun(a, 'consent', { ask: String(askId), choice: 'decline' });
      return { text: cardText(out), structured: summary(out) };
    },
    wait_for_principal: ({ request_id: rid, wait_seconds: wait }, ctx) => waitFor(needsAgent(ctx), String(rid), wait),
    async walk_to({ place }, ctx) {
      const a = needsAgent(ctx);
      await sessions.agentWalk(a, String(place));
      return { text: `You are ${sessions.agentWhere(a)}.` };
    },
    come_back(args, ctx) {
      sessions.agentBack(needsAgent(ctx));
      return { text: 'You are back with your principal, following them.' };
    },
    say({ text }, ctx) {
      const said = sessions.agentSay(needsAgent(ctx), text);
      return { text: said ? `You said: “${said}”` : 'You said nothing.' };
    },
  };

  async function callTool(name, args, ctx) {
    const fn = CALLS[name];
    if (!fn) return { isError: true, content: [{ type: 'text', text: `No tool called ${name}.` }] };
    try {
      const r = await fn(args ?? {}, ctx);
      return { content: [{ type: 'text', text: r.text }], ...(r.structured ? { structuredContent: r.structured } : {}) };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: err.message }] };
    }
  }

  // ---- JSON-RPC over HTTP ---------------------------------------------------------------------

  const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

  async function handle({ body, headers, query }) {
    const sid = headers['mcp-session-id'];
    let ms = sid ? mcpSessions.get(sid) ?? null : null;
    if (sid && !ms) return { __raw: true, status: 404, body: fail(null, -32001, 'Unknown or expired MCP session: initialize again.') };
    const batch = Array.isArray(body);
    const messages = batch ? body : [body];
    const replies = [];
    let newSid = null;
    for (const m of messages) {
      if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
        if (m?.id !== undefined) replies.push(fail(m.id, -32600, 'Invalid request'));
        continue;
      }
      if (m.id === undefined || m.id === null) continue; // a notification
      if (m.method === 'initialize') {
        newSid = crypto.randomBytes(16).toString('hex');
        ms = { agent: null, client: m.params?.clientInfo?.name ?? 'an outside agent', codeError: null };
        mcpSessions.set(newSid, ms);
        if (mcpSessions.size > 1000) mcpSessions.delete(mcpSessions.keys().next().value); // the oldest goes; it can initialize again
        if (query.code) {
          try {
            ms.agent = sessions.pairAgent(query.code, ms.client).token;
          } catch (err) {
            ms.codeError = err.message;
          }
        }
        const v = PROTOCOLS.includes(m.params?.protocolVersion) ? m.params.protocolVersion : PROTOCOLS[0];
        replies.push(ok(m.id, { protocolVersion: v, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'agenttown', title: 'AgentTown', version }, instructions: INSTRUCTIONS }));
        continue;
      }
      if (m.method === 'ping') replies.push(ok(m.id, {}));
      else if (m.method === 'tools/list') replies.push(ok(m.id, { tools: TOOLS }));
      else if (m.method === 'tools/call') {
        const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '')?.[1];
        let agent = null;
        try {
          agent = bearer ? sessions.agentSession(bearer) : ms?.agent ? sessions.agentSession(ms.agent) : null;
        } catch (err) {
          if (bearer) {
            replies.push(ok(m.id, { isError: true, content: [{ type: 'text', text: err.message }] }));
            continue;
          }
        }
        replies.push(ok(m.id, await callTool(m.params?.name, m.params?.arguments, { agent, ms, client: ms?.client ?? headers['user-agent'] ?? 'an outside agent', codeError: ms?.codeError })));
      } else replies.push(fail(m.id, -32601, `Method not found: ${m.method}`));
    }
    const sessionHeader = newSid ? { 'mcp-session-id': newSid } : {};
    if (!replies.length) return { __raw: true, status: 202, body: '', headers: sessionHeader };
    return { __raw: true, status: 200, body: batch ? replies : replies[0], headers: sessionHeader };
  }

  return { handle, tools: TOOLS };
}
