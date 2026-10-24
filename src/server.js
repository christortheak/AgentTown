// AgentTown's web server:  npm start, then open http://localhost:4400
//
// Serves the game and its API. By default the town runs its own in-process
// federation, so nothing here touches aaf-reference's data directory; set
// AGENTTOWN_CONFIG to use an external federation (see town.config.example.json).
// Open it at "localhost", not 127.0.0.1: passkeys are bound to the domain.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, closeServer, html, typed } from 'aaf-reference/src/lib/http.js';
import { createTown } from './town.js';

export const PORT = Number(process.env.PORT ?? 4400);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export async function startServer({ port = PORT, portOffset = Number(process.env.AGENTTOWN_PORT_OFFSET ?? 7000), host = process.env.HOST ?? '127.0.0.1', origin = process.env.ORIGIN, quiet = false, residents = true, timeScale = 1, config } = {}) {
  const townOrigin = origin ?? `http://localhost:${port}`;
  const town = await createTown({ origin: townOrigin, portOffset, residents, timeScale, ...(config ? { config } : {}) });
  const { accounts } = town.places.hearth.rp;
  const app = createApp('agenttown');

  app.get('/api/info', () => town.info());
  app.get('/api/state', () => town.player.state());
  app.get('/api/actions', () => ({ actions: town.actions() }));
  app.get('/api/world', ({ query }) => {
    town.player.setPos({ x: Number(query.x), y: Number(query.y) });
    return town.world_(Number(query.since ?? 0));
  });
  app.post('/api/enroll', ({ body }) => town.player.enroll(body ?? {}));
  app.post('/api/do', ({ body }) => town.player.run(body?.action, body?.params ?? {}));
  app.post('/api/director', ({ body }) => town.direct(body?.cue, body?.params ?? {}));
  app.post('/api/reset', () => town.reset());

  // Your front door's passkey ceremonies, handled by Hearth & Key's accounts.
  app.post('/api/passkey/options', () => accounts.passkeyRegistrationOptions('you'));
  app.post('/api/passkey', ({ body }) => accounts.registerPasskey('you', body?.credential));
  app.post('/api/approvals/:rid/options', ({ params }) => accounts.approvalOptions(params.rid));
  app.post('/api/approvals/:rid/approve', ({ params, body }) => accounts.approve(params.rid, body?.credential));
  app.post('/api/approvals/:rid/decline', ({ params }) => accounts.decline(params.rid));

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
    console.log('Use "localhost", not 127.0.0.1: passkeys are bound to the domain.');
  }
  return { town, origin: townOrigin, url: `http://127.0.0.1:${port}`, close: async () => { await closeServer(server); await town.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
