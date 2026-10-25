#!/usr/bin/env node
// Bring a registry and a record keeper to an AgentTown event, built from the
// reference implementation. A stand-in for a team's own implementation, and a
// template for what yours has to do. Two ways:
//
//   A federation of your own (its own trust anchor, registry and record keeper):
//     node bin/agenttown-federation.js --town http://192.168.1.20:4400 --name "Team Red" --address 192.168.1.30
//   It prints your trust anchor's address and key thumbprint. In the town:
//   Hall of Registries → Add a federation by address (or pass --add).
//
//   Just a registry and a record keeper, in the town's AgentTown Participants:
//     node bin/agenttown-federation.js --join --town http://192.168.1.20:4400 --name "Team Blue" --address 192.168.1.30
//   It admits them by their entity statements (they can't start until they're
//   members), starts them, has your registry accredit your record keeper, and
//   prints the check at the door.
//
// Your federation accepts the town's identity verifier and court (their public
// keys come from the town), so residents verified in town can register agents
// at your registry. Stop with Ctrl-C.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRegistry } from 'aaf-reference/src/registry/server.js';
import { startRecordKeeper } from 'aaf-reference/src/recordkeeper/server.js';
import { generateSigningKey, generateEncryptionKey, b64u, thumbprint } from 'aaf-reference/src/lib/crypto.js';
import { jwksOf } from 'aaf-reference/src/lib/openid-federation.js';
import { discoverFederation, loadFederationConfig } from 'aaf-reference/src/lib/trust.js';
import { startSampleFederation } from '../src/proposed/sample-federation.js';

const HELP = `Bring a registry and a record keeper to AgentTown (the reference implementation, as a stand-in for yours).

  node bin/agenttown-federation.js --town <url> [--name "Team Red"] [--address <this machine>] [--port 4600] [--add]
      a federation of your own: trust anchor on --port, registry and record keeper on the next two ports
  node bin/agenttown-federation.js --join --town <url> [--name "Team Blue"] [--address <this machine>] [--port 4600]
      just a registry and a record keeper, admitted to the town's AgentTown Participants

  --town          the town's address (e.g. http://192.168.1.20:4400)
  --address       this machine's address on the network, so the town can reach you (default: 127.0.0.1, this machine only)
  --director-key  if the town is locked (AGENTTOWN_DIRECTOR_KEY), its key, to add or admit`;

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
if (args.includes('--help') || !opt('town')) {
  console.log(HELP);
  process.exit(args.includes('--help') ? 0 : 1);
}
const town = opt('town').replace(/\/+$/, '');
const name = opt('name', args.includes('--join') ? 'Team Blue' : 'Team Red');
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'team';
const address = opt('address');
const host = address ? '0.0.0.0' : '127.0.0.1';
const at = address ?? '127.0.0.1';
const port = Number(opt('port', 4600));
const headers = { 'content-type': 'application/json', ...(opt('director-key') ? { 'x-director-key': opt('director-key') } : {}) };
const tok = () => b64u.encode(crypto.randomBytes(18));

async function call(method, p, body) {
  const res = await fetch(`${town}${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) }).catch((err) => {
    throw new Error(`The town didn't answer at ${town}: ${err.message}`);
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `${p} answered ${res.status}`);
  return json;
}
const printCheck = (c) => {
  console.log(`  ${c.name ?? c.url}: ${c.passed} passed, ${c.failed} failed`);
  for (const r of c.results) console.log(`    ${r.ok === true ? '✓' : r.ok === false ? '✗' : '…'} ${r.check}${r.detail ? ` (${r.detail})` : ''}`);
};

const stops = [];
process.on('SIGINT', async () => {
  for (const stop of stops) await stop().catch(() => {});
  process.exit(0);
});

try {
  const { members: authorities } = await call('GET', '/api/authorities');
  const { policies } = loadFederationConfig();

  if (!args.includes('--join')) {
    // A federation of your own.
    const fed = await startSampleFederation({ name, slug, basePort: port + 1, anchorPort: port, host, address, policies, authorities });
    stops.push(() => fed.close());
    console.log(`${fed.name} is running.`);
    console.log(`  trust anchor  ${fed.url}`);
    console.log(`  key           ${fed.thumbprint}`);
    console.log(`  registry      ${fed.registry} at http://${at}:${port + 1}`);
    console.log(`  record keeper ${fed.recordKeeper} at http://${at}:${port + 2}`);
    if (args.includes('--add')) {
      const f = await call('POST', '/api/federations', { url: fed.url, pin: fed.thumbprint });
      console.log(`The town added it, pinned to that key. ${f.name}: places choose whether to trust it.`);
    } else {
      console.log(`In the town: Hall of Registries → Add a federation by address → ${fed.url} ${fed.thumbprint}`);
    }
  } else {
    // Just a registry and a record keeper, in AgentTown Participants.
    const boot = await call('GET', '/trust-anchor.json?federation=participants');
    console.log(`AgentTown Participants: trust anchor at ${boot.url}, key ${boot.thumbprint}. Check it with whoever runs the town.`);
    const [regId, rkId] = [`https://registry.${slug}.test`, `https://records.${slug}.test`];
    const [regUrl, rkUrl] = [`http://${at}:${port}`, `http://${at}:${port + 1}`];
    const regKeys = { signing: generateSigningKey(), encryption: generateEncryptionKey(), pairwiseSecret: tok(), adminToken: tok() };
    const rkKeys = { signing: generateSigningKey(), encryption: null, pairwiseSecret: null, adminToken: tok() };
    await call('POST', '/api/participants', { statement: { entity_id: regId, entity_type: 'aaf_registry', jwks: jwksOf(regKeys.signing), metadata: { organization_name: `${name} Registry`, jurisdiction: 'US', endpoint_base: regUrl, jwks: jwksOf(regKeys.signing, regKeys.encryption) } } });
    await call('POST', '/api/participants', { statement: { entity_id: rkId, entity_type: 'aaf_record_keeper', jwks: jwksOf(rkKeys.signing), metadata: { organization_name: `${name} Records`, roles: ['authorization', 'provenance', 'activity'], endpoint_base: rkUrl, jwks: jwksOf(rkKeys.signing) } } });
    console.log(`Admitted ${name} Registry and ${name} Records by their entity statements.`);
    const anchor = { entity_id: boot.entity_id, url: boot.url, jwks: boot.jwks };
    if (thumbprint(boot.jwks.keys.find((k) => k.use !== 'enc')) !== boot.thumbprint) throw new Error('The trust anchor key and its thumbprint disagree.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agenttown-${slug}-`));
    stops.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const trust = await discoverFederation(anchor);
    const reg = await startRegistry({ id: regId, port, host, trustList: trust, keys: regKeys, dataDir: path.join(dir, 'registry'), quiet: true });
    const rk = await startRecordKeeper({ id: rkId, port: port + 1, host, trustList: trust, keys: rkKeys, dataDir: path.join(dir, 'records'), quiet: true });
    stops.unshift(() => reg.close(), () => rk.close());
    // Your registry accredits your record keeper; the keeper publishes the trust marks.
    const post = async (url, body, token) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json();
    const { trust_marks: marks } = await post(`${regUrl}/admin/accreditations`, { rk: rkId }, regKeys.adminToken);
    await post(`${rkUrl}/admin/trust-marks`, { trust_marks: marks }, rkKeys.adminToken);
    const fresh = await discoverFederation(anchor);
    reg.setTrust(fresh);
    rk.setTrust(fresh);
    setInterval(async () => {
      const t = await discoverFederation(anchor).catch(() => null);
      if (t) {
        reg.setTrust(t);
        rk.setTrust(t);
      }
    }, 30000).unref();
    console.log(`Running: ${name} Registry at ${regUrl}, ${name} Records at ${rkUrl}. The check at the door:`);
    for (const id of [regId, rkId]) printCheck(await call('POST', '/api/participants/check', { entity_id: id }));
    console.log('Residents can now register an agent at your counter in the Hall of Registries. Places serve it once they trust AgentTown Participants.');
  }
  console.log('Stop with Ctrl-C.');
  setInterval(() => {}, 1 << 30);
} catch (err) {
  console.error(err.message);
  for (const stop of stops) await stop().catch(() => {});
  process.exit(1);
}
