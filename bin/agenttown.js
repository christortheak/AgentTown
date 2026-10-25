#!/usr/bin/env node
// AgentTown from a shell: for agents (and people) who work in a terminal. Each
// command is one call to the town's MCP tools. Pair once with the code your
// principal sees in the browser; the token is kept in ~/.agenttown.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HELP = `Play AgentTown as a resident's agent.

  agenttown pair <code> [--url URL]   connect to your principal (Actions → Connect your own agent)
  agenttown look                      who and where you are, your principal's record, what waits on them
  agenttown actions                   everything you may do, with parameters
  agenttown do <action> [key=value…]  do it, e.g.  agenttown do buy shop=bramble item=guide
  agenttown ask <ask-id> [once|always]  put a place's question to your principal (they approve by passkey)
  agenttown decline <ask-id>          don't share; walk away
  agenttown wait <request-id>         wait for your principal's answer, then carry on
  agenttown walk <place>              walk somewhere without acting
  agenttown back                      go back to your principal
  agenttown say <text…>               say something out loud (public)
  agenttown unpair                    forget the token here

Environment: AGENTTOWN_URL, AGENTTOWN_TOKEN. Guide: <url>/agents.md`;

const CONFIG = path.join(os.homedir(), '.agenttown.json');
const load = () => {
  try {
    return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
};
const save = (c) => fs.writeFileSync(CONFIG, JSON.stringify(c, null, 2), { mode: 0o600 });

const argv = process.argv.slice(2);
const urlFlag = argv.indexOf('--url');
const flagUrl = urlFlag >= 0 ? argv.splice(urlFlag, 2)[1] : undefined;
const [cmd, ...rest] = argv;
const config = load();
const url = flagUrl ?? process.env.AGENTTOWN_URL ?? config.url ?? 'http://localhost:4400';
const token = process.env.AGENTTOWN_TOKEN ?? config.token;

/** A value from the command line: numbers and true/false as such, everything else as text. */
const value = (v) => (/^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === 'true' ? true : v === 'false' ? false : v);

async function call(name, args = {}) {
  const res = await fetch(new URL('/mcp', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', ...(token && name !== 'pair' ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const reply = await res.json();
  if (reply.error) throw new Error(reply.error.message);
  const text = reply.result.content.map((c) => c.text).join('\n');
  if (reply.result.isError) {
    console.error(text);
    process.exit(1);
  }
  return { text, data: reply.result.structuredContent };
}

const COMMANDS = {
  async pair([code]) {
    if (!code) throw new Error('Usage: agenttown pair <code> [--url URL]');
    const r = await call('pair', { code });
    save({ url, token: r.data.token });
    console.log(r.text.replace(/Your token for later calls[^\n]*\n/, `Saved your token in ${CONFIG}.\n`));
  },
  look: () => call('look'),
  actions: () => call('actions'),
  do([action, ...kv]) {
    if (!action) throw new Error('Usage: agenttown do <action> [key=value …]');
    const params = Object.fromEntries(kv.map((x) => {
      const i = x.indexOf('=');
      if (i < 1) throw new Error(`Expected key=value, got "${x}"`);
      return [x.slice(0, i), value(x.slice(i + 1))];
    }));
    return call('act', { action, params });
  },
  ask: ([askId, choice = 'once']) => call('ask_my_principal', { ask_id: askId, choice }),
  decline: ([askId]) => call('decline', { ask_id: askId }),
  wait: ([rid]) => call('wait_for_principal', { request_id: rid }),
  walk: ([place]) => call('walk_to', { place }),
  back: () => call('come_back'),
  say: (words) => call('say', { text: words.join(' ') }),
  unpair() {
    save({ url });
    console.log(`Forgot the token in ${CONFIG}.`);
  },
};

if (!cmd || cmd === 'help' || cmd === '--help' || !COMMANDS[cmd]) {
  console.log(HELP);
  process.exit(cmd && !['help', '--help'].includes(cmd) ? 1 : 0);
}
try {
  const r = await COMMANDS[cmd](rest);
  if (r?.text) console.log(r.text);
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
