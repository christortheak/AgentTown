// A stand-in for World ID, for comparison with the framework. It is NOT World ID.
//
// Real World ID proves, with a zero-knowledge proof, that the person is in the
// set of verified humans (Orb or another verification level). Each proof yields
// a nullifier that is the same every time the same person acts on the same app
// and action, and different across actions; the app verifies on its server and
// refuses a nullifier it has already seen. This keeps those properties (one
// nullifier per person per action, unlinkable across actions, bound to a
// signal) but replaces the zero-knowledge proof with a MAC from a simulated
// issuer, so it is not cryptographically equivalent.
import crypto from 'node:crypto';

const sha = (...parts) => crypto.createHash('sha256').update(parts.join('|')).digest('base64url');

export function createWorldId() {
  const key = crypto.randomBytes(32);
  const mac = (...parts) => crypto.createHmac('sha256', key).update(parts.join('|')).digest('base64url');
  const used = new Map(); // `${app}|${action}` -> Set of nullifiers

  return {
    /** Verification at the Orb: the person's World App gets an identity secret. */
    enroll(level = 'orb') {
      return { secret: crypto.randomBytes(16).toString('base64url'), level };
    },

    /** The person's World App proves "a verified human" for one app, action and signal. */
    prove(identity, { app, action, signal }) {
      const nullifierHash = sha(identity.secret, app, action);
      const signalHash = sha(signal);
      return { nullifier_hash: nullifierHash, verification_level: identity.level, signal_hash: signalHash, proof: mac(nullifierHash, app, action, signalHash, identity.level) };
    },

    /** The app's server check: a valid proof, the right level, a nullifier not used before. */
    check(proof, { app, action, signal, level = 'orb' }) {
      if (!proof) return { ok: false, reason: 'no World ID proof: the principal is not a verified human (an organization, or never verified)' };
      if (proof.signal_hash !== sha(signal) || proof.proof !== mac(proof.nullifier_hash, app, action, proof.signal_hash, proof.verification_level)) {
        return { ok: false, reason: 'World ID proof does not verify for this action and request' };
      }
      if (level === 'orb' && proof.verification_level !== 'orb') return { ok: false, reason: `verification level ${proof.verification_level} is below orb` };
      if (used.get(`${app}|${action}`)?.has(proof.nullifier_hash)) return { ok: false, reason: 'this person has already done this here (same nullifier)', nullifier: proof.nullifier_hash };
      return { ok: true, nullifier: proof.nullifier_hash };
    },

    /** Record the nullifier once the action has actually happened. */
    consume(proof, { app, action }) {
      const k = `${app}|${action}`;
      if (!used.has(k)) used.set(k, new Set());
      used.get(k).add(proof.nullifier_hash);
    },

    reset(app, action) {
      used.delete(`${app}|${action}`);
    },
  };
}
