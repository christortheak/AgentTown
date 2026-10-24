// "What would they know?": the same request, seen through other approaches.
// The framework's column comes from what this place actually learned; the
// others are typical answers, simplified. They aren't rivals: several of them
// combine with the framework (the Harvest Fair asks for World ID and a badge,
// the Bridge Toll for x402 and a badge).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const Y = 'yes';
const P = 'partly';
const N = 'no';

export const QUESTIONS = [
  { id: 'agent', q: 'Can it tell this is an agent?' },
  { id: 'answers', q: 'Does someone verified answer for it?' },
  { id: 'may', q: 'Does it know what the agent may do here?' },
  { id: 'stop', q: 'Can the agent be stopped everywhere at once?' },
  { id: 'report', q: 'Can the place report it to whoever answers for it?' },
  { id: 'court', q: 'Can a court find out who, without everyone else knowing?' },
  { id: 'private', q: 'Can places be kept from comparing notes on it?' },
];

const OTHERS = [
  {
    id: 'apikey', name: 'API key', blurb: 'An account at this one service',
    a: {
      agent: [P, 'Only if the account holder told this service it runs an agent.'],
      answers: [P, 'Its own customer, if this service checked who they are. Nobody else can rely on that.'],
      may: [P, "Whatever this service's own settings say. It doesn't travel to other places."],
      stop: [N, 'Each service revokes its own keys. There is no shared off switch.'],
      report: [P, 'To its own customer, by email.'],
      court: [P, "Only from this service's own records."],
      private: [P, 'Separate accounts, but the same email or card links them.'],
    },
  },
  {
    id: 'webbot', name: 'Web Bot Auth', blurb: 'Signed requests from a known bot operator',
    a: {
      agent: [Y, 'The request is signed with a bot operator’s published key.'],
      answers: [P, 'The operator (a company) is known; the person it acts for is not.'],
      may: [N, 'It identifies the bot, not what it was asked to do or within what limits.'],
      stop: [P, 'The operator can rotate its key, for all its users at once.'],
      report: [P, 'To the operator, who may or may not pass it on.'],
      court: [P, 'If the operator keeps records of which user sent what.'],
      private: [N, 'The same operator key shows up at every site.'],
    },
  },
  {
    id: 'worldid', name: 'World ID', blurb: 'Proof of a unique human (simulated here)',
    a: {
      agent: [N, 'It proves a human is behind the proof, not whether an agent is acting.'],
      answers: [P, 'A unique human, but not who, and not anyone who must answer for anything.'],
      may: [N, 'Nothing about authority.'],
      stop: [N, 'There is nothing to revoke per agent.'],
      report: [N, 'There is nobody to report to.'],
      court: [N, 'By design, nobody can say who it was.'],
      private: [Y, 'A different nullifier for each place and action.'],
    },
  },
  {
    id: 'x402', name: 'x402', blurb: 'Pay per request (simulated here)',
    a: {
      agent: [N, 'It only sees a payment.'],
      answers: [N, 'A wallet paid. Who controls it is unknown.'],
      may: [P, 'Only that it paid for this one request.'],
      stop: [N, 'A wallet can always pay again.'],
      report: [N, 'There is nobody to report to.'],
      court: [P, 'Sometimes, by tracing the wallet to an exchange that knows its customer.'],
      private: [N, 'A public wallet address links every payment it makes.'],
    },
  },
  {
    id: 'mandate', name: 'Payment mandate', blurb: 'An agent-payment token from a card network or wallet',
    a: {
      agent: [Y, 'For payments, the token says an agent is paying.'],
      answers: [P, 'The cardholder, known to their bank, not to the shop.'],
      may: [P, 'A signed mandate for this purchase. Nothing outside payments.'],
      stop: [P, 'The bank can cancel the token, for payments.'],
      report: [P, 'Through a payment dispute.'],
      court: [P, 'Through the bank, for payments.'],
      private: [P, 'Tokens can differ per merchant; the network sees all of them.'],
    },
  },
];

/** The framework's answers, from what this place actually checked and learned. */
function framework(c) {
  const kinds = new Set((c.plain ?? []).map((x) => x.kind));
  if (c.legacy || !c.ppid) {
    const why = c.legacy ? `${c.place} doesn't use the framework, so it learned nothing.` : 'No badge was shown, so there is nothing to rely on.';
    return Object.fromEntries(QUESTIONS.map((q) => [q.id, [N, why]]));
  }
  const revoked = c.classification === 'REVOKED';
  return {
    agent: [Y, 'The badge says an agent is acting, and which registry stands behind it.'],
    answers: kinds.has('root') ? [Y, kinds.has('identity') ? 'A verified person or organization, named because they agreed.' : 'A verified person or organization. Not who: only the registry knows.'] : [P, 'The badge did not check out here.'],
    may: kinds.has('authority') ? [Y, 'A permission slip covering only this place and this kind of action, with its limits.'] : [N, 'No permission was shown for this.'],
    stop: [Y, revoked ? 'It was stopped: every place that checks now refuses it.' : 'The place checks live status, so a revocation reaches every place at once.'],
    report: [Y, 'The place can file a report with the registry, which passes it to whoever answers for the agent.'],
    court: [Y, "A court order makes the registry say who. The lookup goes in the registry's public transparency log."],
    private: [Y, 'A different badge number at every place, so places can’t link visits.'],
  };
}

const MARK = { [Y]: '✓', [P]: '◐', [N]: '✗' };

/** The comparison table for one card. */
export function lensHtml(c) {
  const cols = [...OTHERS, { id: 'aaf', name: 'This framework', blurb: 'What happened just now', a: framework(c), ours: true }];
  return `
    <div class="lens">
      <table>
        <thead><tr><th></th>${cols.map((x) => `<th class="${x.ours ? 'ours' : ''}" title="${esc(x.blurb)}">${esc(x.name)}</th>`).join('')}</tr></thead>
        <tbody>${QUESTIONS.map((q) => `<tr><th>${esc(q.q)}</th>${cols.map((x) => {
          const [v, why] = x.a[q.id];
          return `<td class="${v} ${x.ours ? 'ours' : ''}" data-why="${esc(`${x.name}: ${why}`)}" tabindex="0">${MARK[v]}</td>`;
        }).join('')}</tr>`).join('')}</tbody>
      </table>
      <p class="lens-why muted small">Tap a mark to see why.</p>
      <p class="muted small">Simplified, and they combine: the Harvest Fair asks for World ID <i>and</i> a badge, the Bridge Toll for x402 <i>and</i> a badge. World ID and x402 are simulated in this town.</p>
    </div>`;
}

/** Wire the "tap a mark" explanations inside a rendered card. */
export function wireLens(root) {
  root.querySelectorAll('.lens td[data-why]').forEach((td) => {
    const show = () => {
      const box = td.closest('.lens').querySelector('.lens-why');
      box.textContent = td.dataset.why;
      box.classList.remove('muted');
    };
    td.addEventListener('click', show);
    td.addEventListener('focus', show);
  });
}
