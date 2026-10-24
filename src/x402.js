// A stand-in for x402 payments, for comparison with the framework. It is NOT x402.
//
// The shape follows x402 v2 over HTTP: the resource answers 402 with a
// PAYMENT-REQUIRED header describing what it accepts; the client signs a
// payment and retries with PAYMENT-SIGNATURE; the server asks a facilitator to
// verify it, does the work, then asks the facilitator to settle, and answers
// with PAYMENT-RESPONSE. Real x402 settles stablecoins on a blockchain. Here the
// wallets, signatures and facilitator are simulated in memory.
import crypto from 'node:crypto';

export const ASSET = 'USDC (simulated)';

export function createX402() {
  const wallets = new Map(); // wallet id -> { balance, key }
  const spentNonces = new Set();
  const sign = (w, ...parts) => crypto.createHmac('sha256', w.key).update(parts.join('|')).digest('base64url');

  const x402 = {
    wallet(id, opening = 0) {
      if (!wallets.has(id)) wallets.set(id, { balance: opening, key: crypto.randomBytes(32) });
      return wallets.get(id);
    },
    balance: (id) => wallets.get(id)?.balance ?? 0,
    /** Ordinary spending from the same wallet (purchases, bills, trades): not x402. */
    adjust(id, delta) {
      const w = x402.wallet(id);
      w.balance = Math.round((w.balance + delta) * 100) / 100;
      return w.balance;
    },

    /** What the resource puts in PAYMENT-REQUIRED. */
    requirements({ resource, amount, payTo, description }) {
      return { x402Version: 2, accepts: [{ scheme: 'exact', network: 'agenttown-sim', asset: ASSET, amount, payTo, resource, description, maxTimeoutSeconds: 60 }] };
    },

    /** The client's PAYMENT-SIGNATURE: an authorization to move `amount` from its wallet. */
    pay(walletId, required) {
      const w = wallets.get(walletId);
      const accepted = required.accepts[0];
      const nonce = crypto.randomBytes(12).toString('base64url');
      return { x402Version: 2, accepted, payload: { from: walletId, nonce, signature: w ? sign(w, accepted.payTo, accepted.amount, accepted.resource, nonce) : 'none' } };
    },

    facilitator: {
      verify(payment, required) {
        const accepted = required.accepts[0];
        const w = wallets.get(payment.payload.from);
        if (!w) return { isValid: false, invalidReason: 'unknown wallet' };
        if (payment.accepted.amount !== accepted.amount || payment.accepted.payTo !== accepted.payTo || payment.accepted.resource !== accepted.resource) {
          return { isValid: false, invalidReason: 'payment does not match the requirements' };
        }
        if (payment.payload.signature !== sign(w, accepted.payTo, accepted.amount, accepted.resource, payment.payload.nonce)) return { isValid: false, invalidReason: 'invalid signature' };
        if (spentNonces.has(payment.payload.nonce)) return { isValid: false, invalidReason: 'payment already used' };
        if (w.balance < accepted.amount) return { isValid: false, invalidReason: `insufficient funds (${w.balance} ${ASSET})` };
        return { isValid: true, payer: payment.payload.from };
      },
      settle(payment, required) {
        const v = x402.facilitator.verify(payment, required);
        if (!v.isValid) return { success: false, errorReason: v.invalidReason };
        const amount = required.accepts[0].amount;
        wallets.get(payment.payload.from).balance = Math.round((wallets.get(payment.payload.from).balance - amount) * 100) / 100;
        x402.wallet(required.accepts[0].payTo).balance += amount;
        spentNonces.add(payment.payload.nonce);
        return { success: true, transaction: `simtx_${crypto.randomBytes(6).toString('hex')}`, network: 'agenttown-sim', payer: payment.payload.from };
      },
    },
  };
  return x402;
}
