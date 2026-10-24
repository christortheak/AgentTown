# AgentTown

A cozy town where you play an accountable agent. It is a launch demo for the *Accountable Agents* framework, and it is a separate project from the framework's reference implementation, which it uses as a dependency.

Many people can play at once, each in a role: an **agent** (you are its principal), a **shopkeeper**, a **homeowner**, the **police** or **the judge**. Simulated residents, a newcomer, sub-agents and, on cue, a rogue swarm fill the rest of the town. Every door, shop, bank, exchange and office is a real relying party. Every decision you see is a service's actual decision, with every check it ran, what it learned, and a verified receipt for its activity-log entry.

## Run it

Needs Node.js 22 or later, with `aaf-reference` checked out next to this folder.

```bash
npm install
npm start
```

Then open **http://localhost:4400**. Use `localhost`, not `127.0.0.1`, because passkeys are bound to a domain.

```bash
npm test
```

Plays a whole day through the API (town time runs 25× faster); runs a town against an external federation reached by address; and runs a town with five people in roles, in which a shopkeeper picks the registries she trusts, a homeowner approves a visitor from her own device, and police and a judge catch, delete and ban a crooked player, who then comes back under another name.

## Roles

Open the town and pick a role. Each browser tab is its own player, so two tabs (or two devices) can play two roles.

| Role | What you do |
|---|---|
| 🤖 Agent | You are the principal; your agent walks the town. Get verified, register, sign a grant, shop, bank, trade, spawn sub-agents and send them on errands. Play it straight, or try to get away with something. |
| 🏪 Shopkeeper | Run a shop, the bank, the exchange, the fair or the toll. Choose which registries you trust and what you ask for (badge, World ID, x402), watch every customer's ID check, report a customer to its registry (its principal hears about it, you still don't learn who), or file it with the police. |
| 🏡 Homeowner | Own a house in Hearthside. Put a passkey on your door; when an agent knocks, your phone shows who stands behind it and you decide. Change the locks when keys go astray. |
| 👮 Police | Cases arrive from places: refused payments the bank flags, attempted break-ins, a pump spotted at the Exchange. Open cases from any ledger line, and petition the court. |
| ⚖️ Judge | Rule on petitions. *Identify*: the registry resolves every badge in the case and groups them by principal, so bystanders are told apart from whoever ran the scheme. *Delete*: the registry's operator revokes the principal's agents under legal order, and the revocation cascades. *Ban*: the identity verifier withdraws the principal's verification, which suspends every agent under it at once, and won't verify that identity again. |

Nobody playing police or judge? A simulated inspector and judge take over: refused payments and complaints are only identified; a pump or break-ins lead to deletion, and a coordinated scheme or repeated misconduct to a ban.

**Getting away with it.** A banned player can leave and join again. As the same person they can't be verified; under another name they can, in this town. Real identity checks, with documents and liveness, exist to stop exactly that.

**Who sees what.** A badge never names its principal, so neither do the town's shared views: other players see your agent's name, never yours, and ledger lines that would link the two are visible only to you. A court order changes that, and its findings are public.

## Playing

| Key | |
|---|---|
| **Q** | The **action deck**: every action in town, grouped and searchable, with what you can do right here at the top. Picking an action somewhere else walks you there first. Nothing is hidden. Some actions are refused, and the refusal comes from the service that refused. |
| **E** | Talk to the place you're standing at (opens the deck there). |
| **B** | Take your badge off or put it back on. |
| Click | Walk; click a building to go and talk to it; click anyone to ask for their badge; click the minimap to run there. |
| 🎬 | The **director**: cues for demos and videos, and each place's policy. |

The HUD shows your quests, a minimap, **your record** (what the registry holds about you), **your phone** (approvals and incident reports for you as principal) and the **town ledger** (everything everyone does; click a line to see its ID check).

## The town

| District | Places | What they show |
|---|---|---|
| Civic Row | Town Hall (Registry A), Records Office (Ledgerline, Tessera), Courthouse, Police Station, Thistle Exchange, Orb Kiosk | Verification once, fast registration, grants, receipts; police and courts; commodities trading with market surveillance; a simulated World ID |
| Market Lane | Bramble Books, Copper Kettle, First Ledger Bank, Oakleaf Bakery | Selective disclosure, refusals over the limit or outside the categories, pairwise badge numbers; opening a bank account needs your name (know your customer); refused payments become SAR candidates |
| The Works | Compute Forge, Wren Labs | Large jobs need a disclosed principal and a bill of materials |
| Hearthside | Your house, Maple's, Hazel's, Ivy's | Passkeys: agent-bound access, the human path, step-up; stolen keys reported to the right principal |
| Town Square | Fountain, Harvest Fair | A free pie, one per person: World ID (simulated) next to the framework |
| The Harbor (EU) | Bridge Toll, Harbor Registry (Registry B), Café Lumière, Rook & Daughters | x402 (simulated) next to the framework; a café that only accepts EU badges; federated chains |
| The Wilds | The Old Mill | Where the swarm comes from |

### Director cues

- **Rogue swarm.** A verified company's compromised root agent registers eight sub-agents; the registry refuses every attempt to go a level deeper. Each sub-agent may trade a little, so together they pile into MOON at the Exchange: a pump. The Exchange can't tell they share a principal (each showed a fresh badge), so it reports them to the police. With six unlabeled bots they raid the rest of town: shops refuse them (no authority), the fair refuses them (no World ID), homes refuse stolen keys and report them. Their principal may revoke the root itself after a few incident reports; otherwise the court identifies it from the Exchange's evidence, deletes its agents and bans it. The bots get through only where a place asks for nothing but payment.
- **Registry outage.** The shops can't reach Registry A for 45 seconds and **defer** instead of refusing (`LOOKUP_FAILED`), while agents from Registry B are still served.
- **A newcomer arrives.** Ivy walks in from the east gate and goes through the slow step at Town Hall, the Orb and the Records Office, then moves in.
- **Night at your house.** Four visitors with a copy of your key.
- **Each place's policy**, live: which registries it accepts, whether it needs a badge, World ID, an x402 payment.

### World ID and x402 are simulated

They are here to show how they relate to the framework, not to implement them. World ID's stand-in keeps its properties (one nullifier per person per action, unlinkable across actions, bound to a signal) but replaces the zero-knowledge proof with a MAC. x402's stand-in follows the v2 shape (402 with `PAYMENT-REQUIRED`, a signed `PAYMENT-SIGNATURE`, a facilitator that verifies before the work and settles after, `PAYMENT-RESPONSE`) with in-memory wallets. What the town shows: personhood is not accountability, and payment is not authority. Each answers a different question, and a place can ask for any combination.

## External registries and record keepers

By default the town starts its own in-process federation. To use real, separately hosted services, point it at a trust anchor; every registry and record keeper is discovered from there.

```bash
AGENTTOWN_CONFIG=./town.config.json npm start
```

`town.config.example.json` shows the shape:

- `federation.trustAnchor`: the trust anchor's bootstrap (`entity_id`, `url`, `jwks`), inline or as a path. An IP address in `url` is fine.
- `federation.urlOverrides`: where to reach a member if its published `endpoint_base` isn't reachable from the town's host.
- `federation.authorityKeys`: a folder holding the keys of the identity verifier and court that this town operates. Without it, the town can't verify principals or resolve badges, and says so.
- `federation.registryOperatorTokens`: `{ "<registry id>": "<token>" }`, so court orders to delete agents reach the registry's operator. (Locally, the town has these already.)
- `places`: each place's starting policy, e.g. a bank that accepts only one registry.

To host the framework's services on a LAN with aaf-reference as it is: set `"host"` in `aaf-reference/config/federation.json` to the machine's address, run `npm run reset` and `npm start` there, then copy `data.nosync/trust-anchor.json` (and, for verification and courts, the verifier's and court's key files from `data.nosync/keys/`) to the town's host. Those keys are private: share them only with the town that plays those roles.

To let other machines open the game itself: `HOST=0.0.0.0`. Passkeys need a secure origin, so beyond `localhost` serve it over HTTPS and set `ORIGIN=https://your.domain`. For a public demo, set `AGENTTOWN_DIRECTOR_KEY` so only you can cue the swarm, outages and policies; open the town with `?director=<key>` to use them.

## Layout

| Path | What |
|---|---|
| `src/federation.js` | Local or external federation |
| `src/world.js` | The town's view of the federation: registries, record keepers, verifier, court |
| `src/places.js` | Places as relying parties, their live policies, and the World ID and x402 layers |
| `src/sim.js` | Residents, newcomers, sub-agents' errands, bots, the swarm; walks timed on the shared routes |
| `src/player.js` | A player with an agent, and the full action catalog |
| `src/sessions.js` | Joining, roles, what each role sees and can do, idle sessions let go |
| `src/justice.js` | Cases, petitions, and court orders run on the registry and the identity verifier |
| `src/town.js`, `src/server.js` | The ledger, director cues, and the HTTP API |
| `src/worldid.js`, `src/x402.js` | The simulations |
| `public/map.js`, `public/route.js` | The town's layout and drawing; routes shared with the server |
| `public/game.js`, `public/palette.js`, `public/roles.js`, `public/ui.js`, `public/api.js` | The game, the action deck, joining and the role panels, cards and HUD, server calls and WebAuthn |

## Limits of this prototype

- **State is in memory**, and each start is a new town. Leaving town lets go of your role; a passkey you made stays in your password manager until you delete it there.
- **No accounts.** A session is a tab; anyone can take any free role. That is the point for a demo, but a public one should keep the director key private.
- **The town ledger is a narrator's view**, for the demo: it shows what every place decided. Names of principals stay out of it unless a court finds them.
- **World ID and x402 are simulated**, as above.
