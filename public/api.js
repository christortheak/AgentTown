// Calls to the town's server, and the browser's half of the passkey ceremonies.
// Each tab is its own player: the session lives in sessionStorage, so two tabs
// on one machine can play two roles.
const b64u = {
  enc: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0)),
};

const store = {
  get: (k) => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { if (v) sessionStorage.setItem(k, v); else sessionStorage.removeItem(k); } catch { /* private mode: lasts until reload */ } },
};
let session = store.get('agenttown.session');
let directorKey = new URLSearchParams(location.search).get('director') ?? store.get('agenttown.director');
if (directorKey) store.set('agenttown.director', directorKey);

export const hasSession = () => Boolean(session);
export function setSession(token) {
  session = token;
  store.set('agenttown.session', token);
}
export function setDirectorKey(key) {
  directorKey = key;
  store.set('agenttown.director', key);
}

export class NoSession extends Error {}

async function call(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (session) headers['x-session'] = session;
  if (directorKey) headers['x-director-key'] = directorKey;
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && json.error === 'no_session') {
    setSession(null);
    throw new NoSession(json.message);
  }
  if (!res.ok && !json.decision) throw new Error(json.message || json.error || res.statusText);
  return json;
}

export const get = (path) => call('GET', path);
export const post = (path, body = {}) => call('POST', path, body);

export async function join(role, name, claim) {
  const r = await post('/api/join', { role, name, claim });
  setSession(r.session);
  return r;
}
export async function leave() {
  await post('/api/leave').catch(() => {});
  setSession(null);
}

export function passkeysUsable() {
  if (!window.PublicKeyCredential) return 'This browser does not support passkeys.';
  if (location.hostname !== 'localhost' && location.protocol !== 'https:') return `Passkeys need a secure origin. Open the town at http://localhost:${location.port}, or serve it over HTTPS.`;
  return null;
}

/** Put a passkey on your front door (Touch ID, Face ID, a security key or your device PIN). */
export async function registerPasskey() {
  const { publicKey } = await post('/api/passkey/options');
  publicKey.challenge = b64u.dec(publicKey.challenge);
  publicKey.user.id = b64u.dec(publicKey.user.id);
  const cred = await navigator.credentials.create({ publicKey });
  const credential = {
    id: cred.id, rawId: b64u.enc(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment,
    response: { clientDataJSON: b64u.enc(cred.response.clientDataJSON), attestationObject: b64u.enc(cred.response.attestationObject) },
  };
  return post('/api/passkey', { credential });
}

/** Approve one request with your passkey. The challenge commits to exactly what is being approved. */
export async function approveWithPasskey(requestId) {
  const opts = await post(`/api/approvals/${requestId}/options`);
  const pk = opts.publicKey;
  pk.challenge = b64u.dec(pk.challenge);
  pk.allowCredentials = pk.allowCredentials.map((c) => ({ ...c, id: b64u.dec(c.id) }));
  const a = await navigator.credentials.get({ publicKey: pk });
  const credential = {
    id: a.id, rawId: b64u.enc(a.rawId), type: a.type,
    response: {
      clientDataJSON: b64u.enc(a.response.clientDataJSON), authenticatorData: b64u.enc(a.response.authenticatorData),
      signature: b64u.enc(a.response.signature), userHandle: a.response.userHandle ? b64u.enc(a.response.userHandle) : null,
    },
  };
  return post(`/api/approvals/${requestId}/approve`, { credential });
}

export const declineRequest = (requestId) => post(`/api/approvals/${requestId}/decline`);
