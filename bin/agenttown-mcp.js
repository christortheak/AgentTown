#!/usr/bin/env node
// AgentTown over MCP, on stdio: for clients that start MCP servers as a command
// (Claude Desktop, Codex and others). Each line on stdin is a JSON-RPC
// message; it goes to the town's /mcp endpoint and the reply comes back on
// stdout. Diagnostics go to stderr.
//
//   node bin/agenttown-mcp.js --url http://localhost:4400 --code 4F7-K2Q
//
// --code pairs this agent with the resident who made the code (in the browser:
// Actions → Connect your own agent). --token reuses a token from the CLI.
import readline from 'node:readline';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes('--help') || args.includes('-h')) {
  process.stderr.write('Usage: agenttown-mcp --url http://localhost:4400 --code ABC-123 [--token TOKEN]\n');
  process.exit(0);
}
const url = opt('url') ?? process.env.AGENTTOWN_URL ?? 'http://localhost:4400';
const code = opt('code') ?? process.env.AGENTTOWN_CODE;
const token = opt('token') ?? process.env.AGENTTOWN_TOKEN;

let sessionId = null;
let initialize = null; // kept, to start a new session if the town restarts
const write = (obj) => {
  for (const m of Array.isArray(obj) ? obj : [obj]) process.stdout.write(`${JSON.stringify(m)}\n`);
};

async function post(msg, init) {
  const target = new URL('/mcp', url);
  if (code && init) target.searchParams.set('code', code);
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  if (sessionId && !init) headers['mcp-session-id'] = sessionId;
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(target, { method: 'POST', headers, body: JSON.stringify(msg) });
  const sid = res.headers.get('mcp-session-id');
  if (sid) sessionId = sid;
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function forward(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const init = (Array.isArray(msg) ? msg : [msg]).some((m) => m.method === 'initialize');
  if (init) initialize = (Array.isArray(msg) ? msg : [msg]).find((m) => m.method === 'initialize');
  try {
    let r = await post(msg, init);
    if (r.status === 404 && sessionId && !init && initialize) {
      // The town restarted and forgot this session: start a new one, then try again.
      process.stderr.write('agenttown-mcp: session lost, starting a new one\n');
      sessionId = null;
      await post({ ...initialize, id: `reinit-${Date.now()}` }, true);
      r = await post(msg, false);
    }
    if (r.status === 202 || !r.body) return;
    if (r.body.jsonrpc || Array.isArray(r.body)) return write(r.body);
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: r.body.message ?? `HTTP ${r.status}` } });
  } catch (err) {
    process.stderr.write(`agenttown-mcp: ${err.message}\n`);
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: `AgentTown can't be reached at ${url}: ${err.message}` } });
  }
}

// One message at a time, in order.
let queue = Promise.resolve();
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  queue = queue.then(() => forward(line));
});
process.stderr.write(`agenttown-mcp: forwarding to ${url}/mcp${code ? ` (pairing code ${code})` : ''}\n`);
