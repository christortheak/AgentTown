#!/usr/bin/env node
// Bring a directory and a records service to an AgentTown event, built from the
// framework's sample implementation. A stand-in for a team's own implementation, and a
// template for what yours has to do. Two ways:
//
//   A federation of your own (its own trust anchor, directory and records service):
//     node bin/agenttown-federation.js --town http://192.168.1.20:4400 --name "Team Red" --address 192.168.1.30
//   It prints your trust anchor's address and key thumbprint. In the town:
//   Hall of Directories → Add a federation by address (or pass --add).
//
//   Just a directory and a records service, in the town's AgentTown Participants:
//     node bin/agenttown-federation.js --join --town http://192.168.1.20:4400 --name "Team Blue" --address 192.168.1.30
//   It admits them by their entity statements (they can't start until they're
//   members), starts them, has your directory accredit your records service, and
//   prints the check at the door.
//
// Your federation accepts the town's identity verifier and court (their public
// keys come from the town), so residents verified in town can register agents
// at your directory. Stop with Ctrl-C.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDirectory } from 'aaf-reference/src/directory/server.js';
import { startRecordsService } from 'aaf-reference/src/records/server.js';
import { generateSigningKey, generateEncryptionKey, b64u, thumbprint } from 'aaf-reference/src/lib/crypto.js';
import { jwksOf } from 'aaf-reference/src/lib/openid-federation.js';
import { discoverFederation, loadFederationConfig } from 'aaf-reference/src/lib/trust.js';
import { startSampleFederation } from '../src/proposed/sample-federation.js';

const HELP = `Bring a directory and a records service to AgentTown (the framework’s sample implementation, as a stand-in for yours).

  node bin/agenttown-federation.js --town <url> [--name "Team Red"] [--address <this machine>] [--port 4600] [--add]
      a federation of your own: trust anchor on --port, directory and records service on the next two ports
  node bin/agenttown-federation.js --join --town <url> [--name "Team Blue"] [--address <this machine>] [--port 4600]
      just a directory and a records service, admitted to the town's AgentTown Participants

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
    console.log(`  directory     ${fed.directory} at http://${at}:${port + 1}`);
    console.log(`  records service ${fed.recordsService} at http://${at}:${port + 2}`);
    if (args.includes('--add')) {
      const f = await call('POST', '/api/federations', { url: fed.url, pin: fed.thumbprint });
      console.log(`The town added it, pinned to that key. ${f.name}: places choose whether to trust it.`);
    } else {
      console.log(`In the town: Hall of Directories → Add a federation by address → ${fed.url} ${fed.thumbprint}`);
    }
  } else {
    // Just a directory and a records service, in AgentTown Participants.
    const boot = await call('GET', '/trust-anchor.json?federation=participants');
    console.log(`AgentTown Participants: trust anchor at ${boot.url}, key ${boot.thumbprint}. Check it with whoever runs the town.`);
    const [dirId, rsId] = [`https://directory.${slug}.test`, `https://records.${slug}.test`];
    const [dirUrl, rsUrl] = [`http://${at}:${port}`, `http://${at}:${port + 1}`];
    const dirKeys = { signing: generateSigningKey(), encryption: generateEncryptionKey(), pairwiseSecret: tok(), adminToken: tok() };
    const rsKeys = { signing: generateSigningKey(), encryption: null, pairwiseSecret: null, adminToken: tok() };
    await call('POST', '/api/participants', { statement: { entity_id: dirId, entity_type: 'aaf_directory', jwks: jwksOf(dirKeys.signing), metadata: { organization_name: `${name} Directory`, jurisdiction: 'US', endpoint_base: dirUrl, jwks: jwksOf(dirKeys.signing, dirKeys.encryption) } } });
    await call('POST', '/api/participants', { statement: { entity_id: rsId, entity_type: 'aaf_records_service', jwks: jwksOf(rsKeys.signing), metadata: { organization_name: `${name} Records`, roles: ['authorization', 'provenance', 'activity'], endpoint_base: rsUrl, jwks: jwksOf(rsKeys.signing) } } });
    console.log(`Admitted ${name} Directory and ${name} Records by their entity statements.`);
    const anchor = { entity_id: boot.entity_id, url: boot.url, jwks: boot.jwks };
    if (thumbprint(boot.jwks.keys.find((k) => k.use !== 'enc')) !== boot.thumbprint) throw new Error('The trust anchor key and its thumbprint disagree.');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `agenttown-${slug}-`));
    stops.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    const trust = await discoverFederation(anchor);
    const directory = await startDirectory({ id: dirId, port, host, trustList: trust, keys: dirKeys, dataDir: path.join(dir, 'directory'), quiet: true });
    const rs = await startRecordsService({ id: rsId, port: port + 1, host, trustList: trust, keys: rsKeys, dataDir: path.join(dir, 'records'), quiet: true });
    stops.unshift(() => directory.close(), () => rs.close());
    // Your directory accredits your records service; the keeper publishes the trust marks.
    const post = async (url, body, token) => (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })).json();
    const { trust_marks: marks } = await post(`${dirUrl}/admin/accreditations`, { rs: rsId }, dirKeys.adminToken);
    await post(`${rsUrl}/admin/trust-marks`, { trust_marks: marks }, rsKeys.adminToken);
    const fresh = await discoverFederation(anchor);
    directory.setTrust(fresh);
    rs.setTrust(fresh);
    setInterval(async () => {
      const t = await discoverFederation(anchor).catch(() => null);
      if (t) {
        directory.setTrust(t);
        rs.setTrust(t);
      }
    }, 30000).unref();
    console.log(`Running: ${name} Directory at ${dirUrl}, ${name} Records at ${rsUrl}. The check at the door:`);
    for (const id of [dirId, rsId]) printCheck(await call('POST', '/api/participants/check', { entity_id: id }));
    console.log('Residents can now register an agent at your counter in the Hall of Directories. Places serve it once they trust AgentTown Participants.');
  }
  console.log('Stop with Ctrl-C.');
  setInterval(() => {}, 1 << 30);
} catch (err) {
  console.error(err.message);
  for (const stop of stops) await stop().catch(() => {});
  process.exit(1);
}
