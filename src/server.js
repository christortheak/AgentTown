// AgentTown's web server:  npm start, then open http://localhost:4400
//
// Serves the game and its API. The town (town.js) runs its own in-process
// federation, so nothing here touches aaf-reference's data directory.
// Open it at "localhost", not 127.0.0.1: passkeys are bound to the domain.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, closeServer, html, typed } from 'aaf-reference/src/lib/http.js';
import { createTown } from './town.js';

export const PORT = Number(process.env.PORT ?? 4400);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export async function startServer({ port = PORT, portOffset = Number(process.env.AGENTTOWN_PORT_OFFSET ?? 7000), quiet = false } = {}) {
  const origin = `http://localhost:${port}`;
  const town = await createTown({ origin, portOffset });
  const { accounts } = town.hearth;
  const app = createApp('agenttown');

  app.get('/api/state', () => town.state());
  app.post('/api/reset', () => town.reset());

  app.post('/api/enroll', ({ body }) => town.enroll(body ?? {}));
  app.post('/api/agent', ({ body }) => town.registerAgent(body ?? {}));
  app.post('/api/badge', ({ body }) => town.setBadge(body ?? {}));
  app.post('/api/revoke', () => town.revoke());
  app.post('/api/helper', ({ body }) => town.hireHelper(body ?? {}));
  app.post('/api/helper/hire', () => town.helperHiresHelper());
  app.post('/api/court', () => town.courtOrder());

  app.post('/api/grant', ({ body }) => town.grant(body ?? {}));
  app.post('/api/helper/fund', ({ body }) => town.fundHelper(body ?? {}));
  app.get('/api/receipts', () => town.receipts());

  app.post('/api/buy', ({ body }) => town.buy(body ?? {}));
  app.post('/api/key', () => town.pickUpKey());
  app.post('/api/door', ({ body }) => town.door(body ?? {}));
  app.post('/api/discard', ({ body }) => town.discard(body ?? {}));
  app.post('/api/knock', () => town.knockInPerson());
  app.post('/api/enter', ({ body }) => town.enterInPerson(body ?? {}));
  app.post('/api/night', () => town.night());

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

  const server = await app.listen(port, '127.0.0.1');
  if (!quiet) {
    console.log(`AgentTown is open at ${origin}`);
    console.log('Use "localhost", not 127.0.0.1: passkeys are bound to the domain.');
  }
  return { town, origin, url: `http://127.0.0.1:${port}`, close: async () => { await closeServer(server); await town.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await startServer();
}
