// A federation someone else runs: its own trust anchor, a directory and a record
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
import { startDirectory } from 'aaf-reference/src/directory/server.js';
import { startRecordsService } from 'aaf-reference/src/records/server.js';
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
  ...view.doc.designated_authorities.map((a) => ({ entity_id: a.id, entity_type: 'aaf_designated_authority', jwks: a.jwks, metadata: { organization_name: a.name, jwks: a.jwks } })),
];

/**
 * Start it: the anchor on any free port, the directory and records service on basePort and basePort + 1.
 * Returns its anchor's address (what you'd give the town) and how to stop it.
 */
export async function startSampleFederation({ name = 'Riverside Co-op', slug = 'riverside', basePort, host = '127.0.0.1', address = null, anchorPort = 0, policies, authorities = [] }) {
  // `host` is what it listens on; `address` is where others reach it (with host 0.0.0.0, say, on a network).
  const at = address ?? host;
  const id = (sub) => `https://${sub}.${slug}.test`;
  const [taId, dirId, rsId] = [id('federation'), id('directory'), id('records')];
  const dirKeys = { signing: generateSigningKey(), encryption: generateEncryptionKey(), pairwiseSecret: token(), adminToken: token() };
  const rsKeys = { signing: generateSigningKey(), encryption: null, pairwiseSecret: null, adminToken: token() };
  const url = (port) => `http://${at}:${port}`;
  const members = [
    { entity_id: dirId, entity_type: 'aaf_directory', jwks: jwksOf(dirKeys.signing), metadata: { organization_name: `${name} Directory`, jurisdiction: 'US', endpoint_base: url(basePort), jwks: jwksOf(dirKeys.signing, dirKeys.encryption) } },
    { entity_id: rsId, entity_type: 'aaf_records_service', jwks: jwksOf(rsKeys.signing), metadata: { organization_name: `${name} Records`, roles: ROLES, endpoint_base: url(basePort + 1), jwks: jwksOf(rsKeys.signing) } },
    ...authorities,
  ];
  // Its governance decision: its directory accredits records services, for every role.
  const trustMarkIssuers = Object.fromEntries(ROLES.map((r) => [trustMarkType(taId, r), [dirId]]));
  const anchor = await startAnchor({ entityId: taId, name: `${name} Federation`, key: generateSigningKey(), host, address, port: anchorPort, policies, members, trustMarkIssuers });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `agenttown-${slug}-`));
  const initial = await discoverFederation(anchor.anchor);
  const dir = await startDirectory({ id: dirId, port: basePort, host, trustList: initial, keys: dirKeys, dataDir: path.join(dataDir, 'directory'), quiet: true });
  const rs = await startRecordsService({ id: rsId, port: basePort + 1, host, trustList: initial, keys: rsKeys, dataDir: path.join(dataDir, 'records'), quiet: true });
  // The directory accredits its records service; the keeper publishes the trust marks.
  const { trust_marks: marks } = await postJson(`${url(basePort)}/admin/accreditations`, { rs: rsId }, { authorization: `Bearer ${dirKeys.adminToken}` });
  await postJson(`${url(basePort + 1)}/admin/trust-marks`, { trust_marks: marks }, { authorization: `Bearer ${rsKeys.adminToken}` });
  const fresh = await discoverFederation(anchor.anchor);
  dir.setTrust(fresh);
  rs.setTrust(fresh);
  return {
    name: `${name} Federation`, url: anchor.url, anchor: anchor.anchor, thumbprint: anchor.thumbprint, directory: dirId, recordsService: rsId,
    adminTokens: { [dirId]: dirKeys.adminToken },
    async close() {
      await Promise.all([dir.close(), rs.close(), anchor.close()]);
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
