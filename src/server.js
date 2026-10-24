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
  const { accounts } = town.places.hearth.rp;
  const app = createApp('agenttown');
  const me = (headers) => sessions.get(headers['x-session']);
  const mine = (s, rid) => {
    const account = sessions.accountOf(s);
    if (!accounts.pendingFor(account).some((r) => r.id === rid)) throw new HttpError(403, 'not_yours', 'That request is not for your door.');
    return account;
  };

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

  // Front-door passkeys: each player's own door, or the house a homeowner holds.
  app.post('/api/passkey/options', ({ headers }) => accounts.passkeyRegistrationOptions(sessions.accountOf(me(headers))));
  app.post('/api/passkey', ({ body, headers }) => accounts.registerPasskey(sessions.accountOf(me(headers)), body?.credential));
  app.post('/api/approvals/:rid/options', ({ params, headers }) => {
    mine(me(headers), params.rid);
    return accounts.approvalOptions(params.rid);
  });
  app.post('/api/approvals/:rid/approve', ({ params, body, headers }) => {
    mine(me(headers), params.rid);
    return accounts.approve(params.rid, body?.credential);
  });
  app.post('/api/approvals/:rid/decline', ({ params, headers }) => {
    mine(me(headers), params.rid);
    return accounts.decline(params.rid);
  });

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
