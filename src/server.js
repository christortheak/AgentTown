// AgentTown's web server:  npm start, then open http://localhost:4400
//
// Serves the game and its API. By default the town runs its own in-process
// federation, so nothing here touches aaf-reference's data directory; set
// AGENTTOWN_CONFIG to use an external federation (see town.config.example.json).
// Each browser tab that joins gets a session (the x-session header).
// Set AGENTTOWN_DIRECTOR_KEY to keep the director's cues to whoever has the key.
// Set AGENTTOWN_ADDRESS (this machine's address on the network, e.g. 192.168.1.20)
// to make the town's federations reachable by teams on other machines.
// Set AGENTTOWN_PUBLIC=1 for a town on the internet, behind a tunnel: see
// "On a public server" in docs/HOST.md, and the settings in README.md.
// Open it at "localhost", not 127.0.0.1: passkeys are bound to the domain.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, closeServer, html, typed, HttpError } from 'aaf-reference/src/lib/http.js';
import { createTown } from './town.js';
import { createMcp } from './mcp.js';
import { agentsMd, llmsTxt } from './guide.js';
import { clientAddress } from './addresses.js';

export const PORT = Number(process.env.PORT ?? 4400);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const MIN_KEY = 16; // a public town's director key: long enough not to be guessed

/** A reason the town won't start, said plainly. */
class SetupError extends Error {}
const flag = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
/** A setting that counts something: a whole number, at least 1. */
function count(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new SetupError(`${name} must be a whole number, at least 1 (it is "${v}").`);
  return n;
}
/**
 * A public town's limits on joining (src/sessions.js). An empty town takes about 125 MB; each player who plays
 * adds about 1 MB (measured 31 October: 150 players who verified, registered, granted and bought, 278 MB). 100
 * players leaves room under 500 MB for a day of the residents' own growth.
 */
const limitsFromEnv = () => ({
  maxPlayers: count('AGENTTOWN_MAX_PLAYERS', 100),
  joinsPerAddress: count('AGENTTOWN_JOINS_PER_ADDRESS', 6), // in 10 minutes
  playersPerAddress: count('AGENTTOWN_PLAYERS_PER_ADDRESS', 4),
  seatsPerAddress: count('AGENTTOWN_SEATS_PER_ADDRESS', 2),
});

/**
 * Start the town and its web server. Every setting comes from the environment unless given here (tests give them).
 *   public:          a town on the internet (AGENTTOWN_PUBLIC=1): it needs a long director key, calls out only to
 *                    public addresses, limits joins, and reads players' addresses from the tunnel's header
 *   participantsUrl: where teams reach AgentTown Participants (AGENTTOWN_PARTICIPANTS_URL)
 *   limits:          a public town's limits on joining, over those from the environment
 *   lookup:          how the guard looks up names (tests stub it)
 */
export async function startServer({
  port = PORT, portOffset = Number(process.env.AGENTTOWN_PORT_OFFSET ?? 7000), host = process.env.HOST, origin = process.env.ORIGIN,
  directorKey = process.env.AGENTTOWN_DIRECTOR_KEY ?? null, quiet = false, residents = true, timeScale = 1, config, address = process.env.AGENTTOWN_ADDRESS ?? null,
  public: isPublic = flag(process.env.AGENTTOWN_PUBLIC), participantsUrl = process.env.AGENTTOWN_PARTICIPANTS_URL || null,
  clientIpHeader = process.env.AGENTTOWN_CLIENT_IP_HEADER || 'cf-connecting-ip', limits: given = {}, lookup,
} = {}) {
  // What a public town refuses to start without, before anything starts.
  if (isPublic && (!directorKey || directorKey.length < MIN_KEY)) {
    throw new SetupError(`Public mode needs AGENTTOWN_DIRECTOR_KEY, at least ${MIN_KEY} characters: without it, anyone on the internet could run the director's cues and add federations.`);
  }
  if (isPublic && address) {
    throw new SetupError('Public mode doesn\'t use AGENTTOWN_ADDRESS: it would open every federation port on every interface, over plain HTTP. Leave it unset, and set AGENTTOWN_PARTICIPANTS_URL to AgentTown Participants\' public address instead.');
  }
  if (participantsUrl) {
    let u = null;
    try {
      u = new URL(participantsUrl);
    } catch {
      // said below
    }
    if (!u || !['http:', 'https:'].includes(u.protocol) || u.pathname !== '/' || u.search) {
      throw new SetupError(`AGENTTOWN_PARTICIPANTS_URL must be an address of its own, like https://participants.example.org, with no path: teams' services fetch /.well-known/openid-federation, /list and /fetch at its root (it is "${participantsUrl}").`);
    }
    participantsUrl = u.origin;
  }
  const limits = isPublic ? { ...limitsFromEnv(), ...given } : null;

  const townOrigin = origin ?? `http://localhost:${port}`;
  // Where to tell someone the town is: where they reached it (at an event, another machine uses this one's address,
  // not localhost), unless ORIGIN says where it is served.
  const reachedAt = (headers) => origin ?? (/^[\w.\-:[\]]+$/.test(headers?.host ?? '') ? `http://${headers.host}` : townOrigin);
  const lanOrigin = address && !origin ? `http://${address}:${port}` : townOrigin;
  const town = await createTown({ origin: townOrigin, portOffset, residents, timeScale, address, public: isPublic, participantsUrl, limits, lookup, ...(config ? { config } : {}) });
  const { sessions } = town;
  const app = createApp('agenttown');
  const me = (headers) => sessions.get(headers['x-session']);
  const mcp = createMcp({ sessions, town });
  // An approval belongs to one of the session's own services: its phone, its door, or a place it signs in to.
  const mine = (s, rid) => sessions.approvalFor(s, rid);
  // Where a request came from: behind the tunnel, the header it sets (src/addresses.js).
  const from = (req) => clientAddress(req, { trustHeader: isPublic, header: clientIpHeader });
  // The director's key, compared in constant time. Without a key (a LAN event may have none), everyone directs.
  const digest = (k) => crypto.createHash('sha256').update(String(k)).digest();
  const isDirector = (headers) => !directorKey || (typeof headers['x-director-key'] === 'string' && crypto.timingSafeEqual(digest(headers['x-director-key']), digest(directorKey)));
  const directorOnly = (headers, message) => {
    if (!isDirector(headers)) throw new HttpError(403, 'director_only', message);
  };

  app.get('/api/info', () => ({ ...town.info(), director_locked: Boolean(directorKey) }));
  app.get('/api/roles', () => sessions.roles());
  app.post('/api/join', ({ body, headers, req }) => sessions.join(body ?? {}, { from: from(req), director: isDirector(headers) }));
  app.post('/api/leave', ({ headers }) => {
    sessions.leave(me(headers));
    return { ok: true };
  });

  app.get('/api/state', ({ headers }) => sessions.state(me(headers)));
  app.get('/api/actions', ({ headers }) => ({ actions: town.actions(me(headers)) }));
  app.get('/api/world', ({ query, headers }) => {
    const s = headers['x-session'] ? me(headers) : null;
    if (s) sessions.setPos(s, { x: Number(query.x), y: Number(query.y) }, query.as ? { as: query.as, x: Number(query.ax), y: Number(query.ay) } : null);
    return town.world_(Number(query.since ?? 0), s);
  });
  app.post('/api/do', ({ body, headers }) => sessions.run(me(headers), body?.action, body?.params ?? {}));
  app.post('/api/director', ({ body, headers }) => {
    directorOnly(headers, 'The director key is needed for that.');
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
  // A code for your agent (target "agent", the default) or one of its sub-agents (its id).
  app.post('/api/pair', ({ body, headers }) => {
    const { code, expires, target } = sessions.pairCode(me(headers), body?.target);
    return { code, expires, target, mcp: `${reachedAt(headers)}/mcp?code=${code}`, guide: `${reachedAt(headers)}/agents.md` };
  });
  app.post('/api/pair/end', ({ body, headers }) => ({ ended: sessions.unpair(me(headers), body?.target ?? null) }));
  app.post('/api/pair/brief', ({ body, headers }) => sessions.setBrief(me(headers), body?.text));
  app.get('/api/board', () => ({ board: sessions.board() }));
  // The halls: every federation the town knows. In a local town anyone may add one or admit a service (each place
  // still decides whom to trust); with a director key, only the director may.
  const mayAdd = (headers) => directorOnly(headers, 'In this town only the director adds federations and admits services.');
  // For an agent that holds its own badge: where each place takes requests, what it takes, and whose badges.
  app.get('/api/places', () => ({ places: town.places.directory() }));
  app.get('/api/federations', () => ({ federations: town.federationsView() }));
  app.post('/api/federations', async ({ body, headers }) => {
    mayAdd(headers);
    return town.addFederation({ url: body?.url, pin: body?.pin });
  });
  app.post('/api/participants', async ({ body, headers }) => {
    mayAdd(headers);
    return town.admit({ url: body?.url, statement: body?.statement });
  });
  // By entity id, it checks a service the town already knows. By address, it has the server call out wherever it's
  // told: in a public town, only the director may.
  app.post('/api/participants/check', async ({ body, headers }) => {
    if (isPublic && body?.url && !body?.entity_id) directorOnly(headers, 'In a public town only the director checks a service by its address. Check one the town knows by its entity id.');
    return town.check({ url: body?.url, entity_id: body?.entity_id });
  });
  // For teams: a federation's trust-anchor bootstrap (what a service is configured with, like aaf-reference's
  // trust-anchor.json), and the town's identity verifier and court, to list in a federation of their own.
  app.get('/trust-anchor.json', ({ query }) => town.bootstrap(query.federation ?? 'participants'));
  app.get('/api/authorities', () => ({ members: town.authorities() }));
  // Wrong pairing codes are counted per address: the socket's, or in a public town the tunnel's header for it.
  app.post('/mcp', ({ body, headers, query, req }) => mcp.handle({ body, headers, query, ip: from(req) }));
  app.get('/mcp', () => ({ __raw: true, status: 405, body: { error: 'method_not_allowed', message: 'This server sends no event stream; POST JSON-RPC to /mcp.' } }));
  // The places' front doors stay on this machine in a public town (docs/HOST.md), so agents outside can't reach them.
  app.get('/agents.md', ({ headers }) => typed(agentsMd(reachedAt(headers), { placesOpen: !isPublic }), 'text/markdown; charset=utf-8'));
  app.get('/llms.txt', ({ headers }) => typed(llmsTxt(reachedAt(headers)), 'text/plain; charset=utf-8'));

  const page = (file) => fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8');
  app.get('/', () => html(page('index.html')));
  app.get('/:file', ({ params }) => {
    const file = path.basename(params.file);
    const type = TYPES[path.extname(file)];
    if (!type || !fs.existsSync(path.join(PUBLIC_DIR, file))) return typed('not found', 'text/plain', 404);
    return typed(page(file), type);
  });

  // With an address for the network, the game listens there too (unless HOST says otherwise), so teams can reach /trust-anchor.json and the halls.
  const server = await app.listen(port, host ?? (address ? '0.0.0.0' : '127.0.0.1'));
  if (!quiet) {
    const info = town.info();
    console.log(`AgentTown is open at ${townOrigin}`);
    if (lanOrigin !== townOrigin) console.log(`Players on other machines open ${lanOrigin}`);
    console.log(`Federation: ${info.federation}, trust anchor ${info.trust_anchor}; registries: ${info.registries.map((r) => `${r.name} (${r.url})`).join(', ')}`);
    const p = town.bootstrap('participants');
    console.log(`AgentTown Participants: trust anchor at ${p.url} (key thumbprint ${p.thumbprint}); teams fetch ${lanOrigin}/trust-anchor.json`);
    if (isPublic) {
      console.log(`Public mode: on. Up to ${limits.maxPlayers} players; from one address, ${limits.joinsPerAddress} joins in 10 minutes, ${limits.playersPerAddress} players at once and ${limits.seatsPerAddress} single seats (a place, a house, the judge's). The server calls out only to public addresses. Players' addresses come from the ${clientIpHeader} header on connections from this machine.`);
      if (!participantsUrl) console.log(`Teams outside can't reach AgentTown Participants: set AGENTTOWN_PARTICIPANTS_URL to its public address, served from port ${new URL(town.federations.get('participants').anchor.url).port} on this machine.`);
      console.log(`The places' front door stays on this machine (${info.places}), so agents that hold their own badge can't come yet.`);
    } else {
      console.log(`Places take agents that hold their own badge at ${info.places}/<place>; ${lanOrigin}/api/places lists them`);
      if (!address) console.log('The federations listen on this machine only. To let teams on other machines reach them, set AGENTTOWN_ADDRESS to this machine\'s address on the network.');
    }
    if (!isPublic && /^https:/.test(townOrigin) && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(new URL(townOrigin).hostname)) {
      console.log(`Warning: ORIGIN is ${townOrigin}, and public mode is off. If this town is on the internet, set AGENTTOWN_PUBLIC=1.`);
    }
    console.log(`Director: ${directorKey ? 'locked (AGENTTOWN_DIRECTOR_KEY)' : 'open to everyone'}. Use "localhost", not 127.0.0.1: passkeys are bound to the domain.`);
  }
  return { town, origin: townOrigin, url: `http://127.0.0.1:${port}`, close: async () => { await closeServer(server); await town.close(); } };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await startServer();
  } catch (err) {
    if (!(err instanceof SetupError)) throw err;
    console.error(`AgentTown didn't start. ${err.message}`);
    process.exit(1); // so a service manager shows the failure
  }
}
