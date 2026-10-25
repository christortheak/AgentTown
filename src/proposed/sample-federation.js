// A federation someone else runs: its own trust anchor, a registry and a record
// keeper, built from the reference implementation's parts. It stands in for a
// team that brings its own implementation to an event: they run theirs on
// their own machine, and the town adds it by its trust anchor's address.
//
// It accepts the town's identity verifier and court (their public keys are
// among its members), so a resident verified in town can register an agent
// here too. A real federation would choose its own.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startRegistry } from 'aaf-reference/src/registry/server.js';
import { startRecordKeeper } from 'aaf-reference/src/recordkeeper/server.js';
import { generateSigningKey, generateEncryptionKey, b64u } from 'aaf-reference/src/lib/crypto.js';
import { jwksOf, trustMarkType } from 'aaf-reference/src/lib/openid-federation.js';
import { discoverFederation } from 'aaf-reference/src/lib/trust.js';
import { postJson } from 'aaf-reference/src/lib/http.js';
import { startAnchor } from './anchors.js';

const ROLES = ['authorization', 'provenance', 'activity'];
const token = () => b64u.encode(crypto.randomBytes(18));

/** The members another federation lists for authorities it accepts: their names and public keys, as this one vouches. */
export const asMembers = (view) => [
  ...view.doc.verifiers.map((v) => ({ entity_id: v.id, entity_type: 'aaf_identity_verifier', jwks: v.jwks, metadata: { organization_name: v.name, jwks: v.jwks } })),
  ...view.doc.resolution_authorities.map((a) => ({ entity_id: a.id, entity_type: 'aaf_resolution_authority', jwks: a.jwks, metadata: { organization_name: a.name, jwks: a.jwks } })),
];

/**
 * Start it: the anchor on any free port, the registry and record keeper on basePort and basePort + 1.
 * Returns its anchor's address (what you'd give the town) and how to stop it.
 */
export async function startSampleFederation({ name = 'Riverside Co-op', slug = 'riverside', basePort, host = '127.0.0.1', policies, authorities = [] }) {
  const id = (sub) => `https://${sub}.${slug}.test`;
  const [taId, regId, rkId] = [id('federation'), id('registry'), id('records')];
  const regKeys = { signing: generateSigningKey(), encryption: generateEncryptionKey(), pairwiseSecret: token(), adminToken: token() };
  const rkKeys = { signing: generateSigningKey(), encryption: null, pairwiseSecret: null, adminToken: token() };
  const url = (port) => `http://${host}:${port}`;
  const members = [
    { entity_id: regId, entity_type: 'aaf_registry', jwks: jwksOf(regKeys.signing), metadata: { organization_name: `${name} Registry`, jurisdiction: 'US', endpoint_base: url(basePort), jwks: jwksOf(regKeys.signing, regKeys.encryption) } },
    { entity_id: rkId, entity_type: 'aaf_record_keeper', jwks: jwksOf(rkKeys.signing), metadata: { organization_name: `${name} Records`, roles: ROLES, endpoint_base: url(basePort + 1), jwks: jwksOf(rkKeys.signing) } },
    ...authorities,
  ];
  // Its governance decision: its registry accredits record keepers, for every role.
  const trustMarkIssuers = Object.fromEntries(ROLES.map((r) => [trustMarkType(taId, r), [regId]]));
  const anchor = await startAnchor({ entityId: taId, name: `${name} Federation`, key: generateSigningKey(), host, policies, members, trustMarkIssuers });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `agenttown-${slug}-`));
  const initial = await discoverFederation(anchor.anchor);
  const reg = await startRegistry({ id: regId, port: basePort, host, trustList: initial, keys: regKeys, dataDir: path.join(dataDir, 'registry'), quiet: true });
  const rk = await startRecordKeeper({ id: rkId, port: basePort + 1, host, trustList: initial, keys: rkKeys, dataDir: path.join(dataDir, 'records'), quiet: true });
  // The registry accredits its record keeper; the keeper publishes the trust marks.
  const { trust_marks: marks } = await postJson(`${url(basePort)}/admin/accreditations`, { rk: rkId }, { authorization: `Bearer ${regKeys.adminToken}` });
  await postJson(`${url(basePort + 1)}/admin/trust-marks`, { trust_marks: marks }, { authorization: `Bearer ${rkKeys.adminToken}` });
  const fresh = await discoverFederation(anchor.anchor);
  reg.setTrust(fresh);
  rk.setTrust(fresh);
  return {
    name: `${name} Federation`, url: anchor.url, anchor: anchor.anchor, registry: regId, recordKeeper: rkId,
    adminTokens: { [regId]: regKeys.adminToken },
    async close() {
      await Promise.all([reg.close(), rk.close(), anchor.close()]);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
