// Plain words for a place's decision: a headline anyone can read and a line on
// why. The technical record (checks, classification, receipts) stays on the card
// for anyone who wants it.
import { CLASSIFICATION as C } from 'aaf-reference/src/lib/protocol.js';

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const listOf = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const dollars = (v) => `$${Number.isInteger(v) ? v : Number(v).toFixed(2)}`;

function gotWhat(card) {
  const r = card.result ?? {};
  if (card.action === 'commerce.purchase' && r.item) return `Bought ${r.item.toLowerCase().replace(/^a /, 'a ')}${card.amount ? ` for ${dollars(card.amount)}` : ''}`;
  if (card.action === 'payments.authorize') return card.placeId === 'toll' ? 'Paid the bridge toll' : `Paid ${r.payee ?? 'the bill'}${card.amount ? ` (${dollars(card.amount)})` : ''}`;
  if (card.action === 'trading.order' && r.item) return cap(r.item);
  if (card.action === 'compute.provision') return `Got ${r.gpu_hours} GPU-hours`;
  if (card.action === 'fair.claim') return 'A free pie!';
  if (card.action === 'banking.open_account') return 'Account opened';
  if (card.action === 'home.enter') return card.result?.visited ? `Let in at ${card.result.visited}` : 'The door opened';
  if (card.action === 'home.discard') return `Threw out ${r.discarded}`;
  if (card.action === 'id.check') return 'Badge shown';
  return 'Done';
}

function learnedLine(card) {
  const kinds = new Set((card.plain ?? []).map((x) => x.kind));
  if (!card.ppid) return `${card.place} learned nothing about who is behind it.`;
  const parts = [kinds.has('root') ? 'that someone verified answers for this agent' : 'a badge number'];
  if (kinds.has('authority')) parts.push('what it may do here');
  if (kinds.has('attribute')) parts.push('a verified fact it asked for');
  if (kinds.has('provenance')) parts.push('its bill of materials');
  if (kinds.has('identity')) return `${card.place} learned ${listOf(parts)}, and the name behind it, because you agreed.`;
  return `${card.place} learned ${listOf(parts)}, but not who.`;
}

function refusedWhy(card) {
  const r = card.reasons?.[0] ?? '';
  const amount = r.match(/exceeds authorized limit (\S+) (\S+)/);
  if (amount) return { headline: 'Refused: over the spending limit', why: `The grant allows up to $${amount[1]} for this. The place saw the limit, not the person who set it.` };
  const cat = r.match(/category "([^"]+)" not authorized/);
  if (cat) return { headline: 'Refused: not something it may buy', why: `The grant doesn't cover ${cat[1]}.` };
  const units = r.match(/(\d+) gpu_hours exceeds authorized (\d+)/);
  if (units) return { headline: 'Refused: bigger than its grant allows', why: `The grant covers up to ${units[2]} GPU-hours, and this asks for ${units[1]}.` };
  if (/no authorization presented/.test(r)) return { headline: 'Refused: no permission on file', why: 'The agent has a badge, but nobody has said what it may do.' };
  if (/no disclosed permission covers|prohibited/.test(r)) return { headline: 'Refused: it has no permission for this', why: 'Its grant covers other things, not this.' };
  if (/grant is (revoked|suspended)/.test(r)) return { headline: 'Refused: the grant was withdrawn', why: 'The record keeper says the grant behind this agent is no longer in force.' };
  if (/expired/.test(r)) return { headline: 'Refused: something has expired', why: cap(r) };
  return null;
}

export function explain(card) {
  if (!card || card.type !== 'check') return null;
  const place = card.place;
  const ask = card.ask;

  if (card.decision === 'allow') {
    const got = gotWhat(card);
    if (card.legacy === 'none') return { tone: 'ok', headline: `${got}, no questions asked`, why: `${place} isn't on the framework. It checked nothing, so it can't tell an agent from a person, and if this goes wrong there's nobody to report it to.` };
    if (card.legacy === 'block') return { tone: 'ok', headline: got, why: `${place} blocks agents, but this one didn't say it was one, so it walked straight in.` };
    if (card.classification === C.UNLABELED || !card.classification) return { tone: 'ok', headline: got, why: `${place} lets anyone do this, so it didn't need a badge. It learned nothing about who is behind it.` };
    if (card.classification === C.HUMAN) return { tone: 'ok', headline: got, why: 'The owner approved it with a passkey on their phone.' };
    return { tone: 'ok', headline: got, why: learnedLine(card) };
  }

  if (card.decision === 'step_up') {
    if (ask) {
      const missing = ask.what.filter((w) => !w.shared).map((w) => w.label);
      const because = ask.law?.length ? `${listOf(ask.law)} requires it` : `that's ${place}'s own policy`;
      return { tone: 'ask', headline: `${place} asks for ${listOf(missing.length ? missing : ask.what.map((w) => w.label))}`, why: `For ${ask.tier}, ${because}. You decide: your agent shows only that, and only to ${place}.` };
    }
    if (card.approval_request) return { tone: 'warn', headline: "Waiting for the owner's OK", why: "The lock sent a request to the owner's phone. It shows who answers for the agent in general terms, never a name." };
    return { tone: 'warn', headline: 'Needs more', why: cap(card.reasons?.[0] ?? '') };
  }

  if (card.decision === 'deferred') return { tone: 'warn', headline: "On hold: the registry can't be reached", why: `${place} couldn't check the badge's status, so it waits instead of guessing. That isn't a sign anyone did anything wrong.` };

  // Refusals
  if (card.decision === 'refused' && /registration is expired/.test(card.reasons?.[0] ?? '')) {
    return { tone: 'bad', headline: 'Refused: this agent has lapsed', why: 'It was registered for a short time only, and that time is up. Its registry no longer issues it badges.' };
  }
  if (card.decision === 'refused' && /registration is (revoked|suspended)/.test(card.reasons?.[0] ?? '')) {
    const suspended = /suspended/.test(card.reasons[0]);
    return { tone: 'bad', headline: suspended ? 'Refused: this agent is suspended' : 'Refused: this agent has been revoked', why: suspended ? "Its principal's verification was withdrawn, so its registry won't issue it a badge for anywhere." : "Its registry won't issue it a badge any more, so it can't show one anywhere." };
  }
  if (card.legacy === 'block') return { tone: 'bad', headline: 'Turned away: no agents served', why: `${place} blocks anything that says it is an agent. An agent that hid its badge would have walked in: blocking stops only the honest ones.` };
  const r = card.reasons?.[0] ?? '';
  if (/World ID|nullifier|already done this here|verified human/.test(r)) {
    return /already done this here/.test(r)
      ? { tone: 'bad', headline: 'Refused: one per person', why: 'This person has already done this here. World ID tells the same place it\'s the same human, without a name.' }
      : { tone: 'bad', headline: 'Refused: proof of a unique human needed', why: 'This place wants a World ID proof (simulated) on top of the badge.' };
  }
  if (/payment/.test(r)) return { tone: 'bad', headline: 'Refused: payment needed first', why: cap(r) };
  switch (card.classification) {
    case C.UNLABELED:
      return { tone: 'bad', headline: 'Refused: no badge shown', why: `${place} only deals with agents someone answers for, and this request showed no badge.` };
    case C.REVOKED:
      return { tone: 'bad', headline: 'Refused: this agent has been revoked', why: "Its registry says the registration is no longer active, so every place that checks refuses it at once." };
    case C.UNSUPPORTED: {
      if (/self-asserted/.test(r)) return { tone: 'bad', headline: 'Refused: saying so is not proof', why: '"Someone stands behind me" means nothing until a registry vouches for it.' };
      if (/issued for someone else/.test(r)) return { tone: 'bad', headline: 'Refused: badge made out to another place', why: 'Every badge works at one place only. This one proves nothing here.' };
      if (/not a member of the federation|could not be verified/.test(r)) return { tone: 'bad', headline: 'Refused: no registry it trusts signed this badge', why: card.policy?.includes(' only') ? `${place} takes badges from some registries only.` : 'The signature doesn\'t lead back to any registry in the federation.' };
      if (/does not hold the credential's key/.test(r)) return { tone: 'bad', headline: 'Refused: a copied badge', why: 'The request wasn\'t signed by the key the badge is bound to. A copy of a badge is useless without it.' };
      return { tone: 'bad', headline: 'Refused: the badge proves nothing here', why: cap(r) };
    }
    default:
      break;
  }
  const authority = refusedWhy(card);
  if (authority) return { tone: 'bad', ...authority };
  if (/not established/.test(r) || /not trusted|accept/.test(r)) return { tone: 'bad', headline: 'Refused: not a registry this place accepts', why: cap(r) };
  return { tone: 'bad', headline: 'Refused', why: cap(r || card.classification || '') };
}

/** A line in the town ledger from a place's decision, with the plain words added to the card. */
export function eventFromCard(card, by = {}) {
  const plain = explain(card);
  if (plain && !card.headline) Object.assign(card, { headline: plain.headline, why: plain.why, tone: plain.tone });
  return {
    kind: 'check', who: by.id ?? null, actor: card.actor, place: card.place, placeId: card.placeId,
    decision: card.decision, classification: card.classification, badge: card.ppid ? `…${card.ppid.slice(-6)}` : null,
    tone: card.decision === 'allow' ? 'ok' : card.decision === 'deny' || card.decision === 'refused' ? 'bad' : 'warn',
    text: `${card.place} → ${card.actor}: ${card.headline ?? card.decision}`, owner: by.owner ?? null, card,
  };
}
