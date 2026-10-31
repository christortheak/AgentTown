// The places' front doors: one address where an agent that holds its own badge,
// registered in another federation, sends its requests. A place's relying party
// checks each request's signature against the address it was sent to, so the
// town's own agents come through here too, marked so the place can tell them
// apart. Only what an agent may ask of a place gets through: its description
// and its actions. The accounts and passkey routes behind it stay on this machine.
import http from 'node:http';
import crypto from 'node:crypto';
import { closeServer } from 'aaf-reference/src/lib/http.js';
import { HEADERS, RP_METADATA_PATH } from 'aaf-reference/src/lib/protocol.js';

/** The header the town's own requests carry, with a value only this town knows. */
export const OWN_HEADER = 'x-agenttown-own';
const MAX_BODY = 256 * 1024;
const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', OWN_HEADER]);

const send = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('request too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Listen on a steady port, or on any free one if it's taken (another town on this machine, say). */
function listen(handler, port, host) {
  const attempt = (p) => new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(p, host, () => resolve(server));
  });
  return attempt(port).catch((err) => (err.code === 'EADDRINUSE' && port ? attempt(0) : Promise.reject(err)));
}

/**
 * Start the front. `address` is where others reach it (this machine's address on the network), when it listens
 * on every interface. Mount each place's relying party with `mount`: its URL becomes its address here.
 */
export async function startFront({ port = 0, host = '127.0.0.1', address = null } = {}) {
  const secret = crypto.randomBytes(18).toString('base64url');
  const mounts = new Map(); // slug -> { rp, visitor }

  async function handle(req, res) {
    const { pathname } = new URL(req.url, 'http://front');
    const m = /^\/([a-z0-9-]+)(\/actions\/[\w.*-]+|\/\.well-known\/aaf-relying-party)$/.exec(pathname);
    const mount = m && mounts.get(m[1]);
    const isAction = Boolean(m?.[2].startsWith('/actions/'));
    if (!mount || req.method !== (isAction ? 'POST' : 'GET')) {
      return send(res, 404, { error: 'not_found', message: `Only a place's description (GET /<place>${RP_METADATA_PATH}) and its actions (POST /<place>/actions/<action>) are served here. GET /api/places on the town lists the places.` });
    }
    const body = isAction ? await readBody(req) : null;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !HOP_BY_HOP.has(k)));
    // The body goes on byte for byte: its digest is part of what the agent signed.
    const forward = async () => {
      const r = await fetch(`${mount.rp.privateUrl}${m[2]}`, { method: req.method, headers, body, signal: AbortSignal.timeout(30000) });
      return { status: r.status, type: r.headers.get('content-type') ?? 'application/json', text: await r.text() };
    };
    const pass = (r) => {
      res.writeHead(r.status, { 'content-type': r.type });
      res.end(r.text);
    };
    if (!isAction || !mount.visitor || req.headers[OWN_HEADER] === secret) return pass(await forward());

    // An agent the town didn't make: the place decides whether it serves such agents, then the town notes the visit.
    let params = {};
    try {
      params = JSON.parse(body.toString('utf8') || '{}');
    } catch {
      // The relying party refuses a body it can't read; the town still notes that someone came.
    }
    const action = m[2].slice('/actions/'.length);
    const out = await mount.visitor({
      action, params, badged: Boolean(req.headers[HEADERS.presentation]),
      forward: async () => {
        const r = await forward();
        let json = null;
        try {
          json = JSON.parse(r.text);
        } catch {
          // Not JSON: passed on as it came.
        }
        return { status: r.status, body: json, raw: r };
      },
    });
    return out.raw ? pass(out.raw) : send(res, out.status, out.body);
  }

  const server = await listen((req, res) => {
    handle(req, res).catch((err) => send(res, err.status ?? 502, { error: err.status === 413 ? 'too_large' : 'unreachable', message: err.message }));
  }, port, host);
  const url = `http://${address ?? host}:${server.address().port}`;

  return {
    url,
    /** Headers for the town's own requests. */
    mark: { [OWN_HEADER]: secret },
    /** Put a relying party behind the front, at /<slug>. `visitor` handles requests from agents the town didn't make. */
    mount(slug, rp, visitor = null) {
      // Where it really listens (on this machine), whatever URL it was started with: the relying party checks
      // signatures against rp.url, read on each request, so that becomes its address here.
      rp.privateUrl = `http://127.0.0.1:${rp.server.address().port}`;
      rp.url = `${url}/${slug}`;
      mounts.set(slug, { rp, visitor });
      return rp.url;
    },
    close: () => closeServer(server),
  };
}
