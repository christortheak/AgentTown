// Where the town's registries and record keepers live.
//
//   local (default)  a fresh in-process federation from aaf-reference, in a temp folder
//   external         a real federation reached over the network: give the trust
//                    anchor's URL (an IP address is fine) and its public key; every
//                    registry and record keeper is discovered from it.
//
// Configure with a JSON file named by AGENTTOWN_CONFIG (see town.config.example.json):
//   {
//     "federation": {
//       "trustAnchor": "./trust-anchor.json"      // or { "entity_id", "url", "jwks" }
//       "urlOverrides": { "<entity id>": "http://192.168.1.21:4101" },
//       "authorityKeys": "./keys",                // optional: keys for the identity verifier and court this town operates
//       "registryOperatorTokens": { "<registry id>": "<token>" }  // optional: lets court orders revoke registrations
//     },
//     "places": { "cafe": { "accepts": ["https://registry-b.aaf.test"] } }
//   }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startFederationInProcess } from 'aaf-reference/src/lib/federation.js';
import { discoverWithRetry } from 'aaf-reference/src/lib/trust.js';

export function loadConfig(file = process.env.AGENTTOWN_CONFIG) {
  if (!file) return { federation: null, places: {}, law: null };
  const dir = path.dirname(path.resolve(file));
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const resolve = (p) => (typeof p === 'string' ? path.resolve(dir, p) : p);
  const fed = config.federation ?? null;
  return {
    federation: fed && {
      ...fed,
      trustAnchor: typeof fed.trustAnchor === 'string' ? JSON.parse(fs.readFileSync(resolve(fed.trustAnchor), 'utf8')) : fed.trustAnchor,
      authorityKeys: fed.authorityKeys ? resolve(fed.authorityKeys) : null,
    },
    places: config.places ?? {},
    law: config.law ?? null,
  };
}

/** Connect to the configured federation, or start a local one. */
export async function connectFederation({ federation, portOffset = 7000 } = {}) {
  if (!federation) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenttown-'));
    const fed = await startFederationInProcess({ dataDir, portOffset, quiet: true });
    return {
      kind: 'local', trust: fed.trustList, keysDir: fed.paths.keysDir, trustAnchorUrl: fed.trustAnchor.url,
      close: async () => {
        await fed.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
      },
    };
  }
  const ta = federation.trustAnchor;
  if (!ta?.url || !ta?.entity_id || !ta?.jwks) throw new Error('federation.trustAnchor needs entity_id, url and jwks (the trust anchor bootstrap, e.g. aaf-reference/data.nosync/trust-anchor.json)');
  let trust = await discoverWithRetry(ta, 15000);
  if (federation.urlOverrides) trust = trust.withUrlOverrides(federation.urlOverrides);
  return { kind: 'external', trust, keysDir: federation.authorityKeys, adminTokens: federation.registryOperatorTokens ?? {}, trustAnchorUrl: ta.url, close: async () => {} };
}
