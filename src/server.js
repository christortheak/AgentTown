// AgentTown's web server:  npm start, then open http://localhost:4400
//
// Serves the game and its API. By default the town runs its own in-process
// federation, so nothing here touches aaf-reference's data directory; set
// AGENTTOWN_CONFIG to use an external federation (see town.config.example.json).
// Each browser tab that joins gets a session (the x-session header).
// Set AGENTTOWN_DIRECTOR_KEY to keep the director's cues to whoever has the key.
// Open it at "localhost", not 127.0.0.1: passkeys are bound to the domain.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, closeServer, html, typed, HttpError } from 'aaf-reference/src/lib/http.js';
import { createTown } from './town.js';
import { createMcp } from './mcp.js';
import { agentsMd, llmsTxt } from './guide.js';

export const PORT = Number(process.env.PORT ?? 4400);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export async function startServer({
  port = PORT, portOffset = Number(process.env.AGENTTOWN_PORT_OFFSET ?? 7000), host = process.env.HOST ?? '127.0.0.1', origin = process.env.ORIGIN,
  directorKey = process.env.AGENTTOWN_DIRECTOR_KEY ?? null, quiet = false, residents = true, timeScale = 1, config,
} = {}) {
  const townOrigin = origin ?? `http://localhost:${port}`;
  const town = await createTown({ origin: townOrigin, portOffset, residents, timeScale, ...(config ? { config } : {}) });
  const { sessions } = town;
  const app = createApp('agenttown');
  const me = (headers) => sessions.get(headers['x-session']);
  const mcp = createMcp({ sessions, town });
  // An approval belongs to one of the session's own services: its phone, its door, or a place it signs in to.
  const mine = (s, rid) => sessions.approvalFor(s, rid);

  app.get('/api/info', () => ({ ...town.info(), director_locked: Boolean(directorKey) }));
  app.get('/api/roles', () => sessions.roles());
  app.post('/api/join', ({ body }) => sessions.join(body ?? {}));
  app.post('/api/leave', ({ headers }) => {
    sessions.leave(me(headers));
    return { ok: true };
  });

  app.get('/api/state', ({ headers }) => sessions.state(me(headers)));
  app.get('/api/actions', ({ headers }) => ({ actions: town.actions(me(headers)) }));
  app.get('/api/world', ({ query, headers }) => {
    const s = headers['x-session'] ? me(headers) : null;
    if (s) sessions.setPos(s, { x: Number(query.x), y: Number(query.y) });
    return town.world_(Number(query.since ?? 0), s);
  });
  app.post('/api/do', ({ body, headers }) => sessions.run(me(headers), body?.action, body?.params ?? {}));
  app.post('/api/director', ({ body, headers }) => {
    if (directorKey && headers['x-director-key'] !== directorKey) throw new HttpError(403, 'director_only', 'The director key is needed for that.');
    return town.direct(body?.cue, body?.params ?? {});
  });

  // Passkeys: a player's phone (proposed), their front door or a place they sign in to; a homeowner's door.
  app.post('/api/passkey/options', ({ body, headers }) => {
    const sv = sessions.serviceFor(me(headers), body?.service);
    return sv.accounts.passkeyRegistrationOptions(sv.account);
  });
  app.post('/api/passkey', ({ body, headers }) => {
    const sv = sessions.serviceFor(me(headers), body?.service);
    return sv.accounts.registerPasskey(sv.account, body?.credential);
  });
  app.post('/api/approvals/:rid/options', ({ params, headers }) => mine(me(headers), params.rid).approvalOptions(params.rid));
  // Only a person's own session reaches these: a paired agent's token is not a session.
  app.post('/api/approvals/:rid/approve', ({ params, body, headers }) => {
    const r = mine(me(headers), params.rid).approve(params.rid, body?.credential);
    sessions.noteApproval(params.rid, 'approved');
    return r;
  });
  app.post('/api/approvals/:rid/decline', ({ params, headers }) => {
    const r = mine(me(headers), params.rid).decline(params.rid);
    sessions.noteApproval(params.rid, 'declined');
    return r;
  });

  // An outside agent: the resident makes a pairing code; the agent plays over MCP.
  app.post('/api/pair', ({ headers }) => {
    const { code, expires } = sessions.pairCode(me(headers));
    return { code, expires, mcp: `${townOrigin}/mcp?code=${code}`, guide: `${townOrigin}/agents.md` };
  });
  app.post('/api/pair/end', ({ headers }) => ({ ended: sessions.unpair(me(headers)) }));
  app.post('/api/pair/brief', ({ body, headers }) => sessions.setBrief(me(headers), body?.text));
  app.get('/api/board', () => ({ board: sessions.board() }));
  // Wrong pairing codes are counted per address (the socket's, not a header anyone can set).
  app.post('/mcp', ({ body, headers, query, req }) => mcp.handle({ body, headers, query, ip: req.socket.remoteAddress ?? 'unknown' }));
  app.get('/mcp', () => ({ __raw: true, status: 405, body: { error: 'method_not_allowed', message: 'This server sends no event stream; POST JSON-RPC to /mcp.' } }));
  app.get('/agents.md', () => typed(agentsMd(townOrigin), 'text/markdown; charset=utf-8'));
  app.get('/llms.txt', () => typed(llmsTxt(townOrigin), 'text/plain; charset=utf-8'));

  const page = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  app.get('/', () => html(page('index.html')));
  app.get('/:file', ({ params }) => {
    const file = path.basename(params.file);
    const type = TYPES[path.extname(file)];
    if (!type || !fs.existsSync(path.join(PUBLIC_DIR, file))) return typed('not found', 'text/plain', 404);
    return typed(page(file), type);
  });

  const server = await app.listen(port, host);
  if (!quiet) {
    const info = town.info();
    console.log(`AgentTown is open at ${townOrigin}`);
    console.log(`Federation: ${info.federation}, trust anchor ${info.trust_anchor}; registries: ${info.registries.map((r) => `${r.name} (${r.url})`).join(', ')}`);
    console.log(`Director: ${directorKey ? 'locked (AGENTTOWN_DIRECTOR_KEY)' : 'open to everyone'}. Use "localhost", not 127.0.0.1: passkeys are bound to the domain.`);
  }
  return { town, origin: townOrigin, url: `http://127.0.0.1:${port}`, close: async () => { await closeServer(server); await town.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
