# AgentTown

A cozy town where you play an accountable agent. It is a launch demo for the *Accountable Agents* framework, and it is a separate project from the framework's reference implementation, which it uses as a dependency.

You steer a small agent. You, at the keyboard, are its **principal**. Everyone else in town is an agent too: residents running errands for their own principals, a newcomer going through the slow step, your own sub-agents, and, on cue, a rogue swarm. Every door, shop, bank and office is a real relying party. Every decision you see is a service's actual decision, with every check it ran, what it learned, and a verified receipt for its activity-log entry.

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

Plays a whole day through the API (town time runs 25× faster), then runs a second town against an external federation reached by address.

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
| Civic Row | Town Hall (Registry A), Records Office (Ledgerline, Tessera), Courthouse, Orb Kiosk | Verification once, fast registration, grants, receipts, resolution under legal process; a simulated World ID |
| Market Lane | Bramble Books, Copper Kettle, First Ledger Bank, Oakleaf Bakery | Selective disclosure, refusals over the limit or outside the categories, pairwise badge numbers; the bank flags SAR candidates |
| The Works | Compute Forge, Wren Labs | Large jobs need a disclosed principal and a bill of materials |
| Hearthside | Your house, Maple's, Hazel's, Ivy's | Passkeys: agent-bound access, the human path, step-up; stolen keys reported to the right principal |
| Town Square | Fountain, Harvest Fair | A free pie, one per person: World ID (simulated) next to the framework |
| The Harbor (EU) | Bridge Toll, Harbor Registry (Registry B), Café Lumière, Rook & Daughters | x402 (simulated) next to the framework; a café that only accepts EU badges; federated chains |
| The Wilds | The Old Mill | Where the swarm comes from |

### Director cues

- **Rogue swarm.** A verified company's compromised root agent registers eight sub-agents; the registry refuses every attempt to go a level deeper. With six unlabeled bots, they raid the town: shops refuse them (no authority), the fair refuses them (no World ID), homes refuse stolen keys and report them. After a few reports, their principal revokes the root and the revocation cascades to all eight at once. The bots get through only where a place asks for nothing but payment.
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
- `places`: each place's starting policy, e.g. a bank that accepts only one registry.

To host the framework's services on a LAN with aaf-reference as it is: set `"host"` in `aaf-reference/config/federation.json` to the machine's address, run `npm run reset` and `npm start` there, then copy `data.nosync/trust-anchor.json` (and, for verification and courts, the verifier's and court's key files from `data.nosync/keys/`) to the town's host. Those keys are private: share them only with the town that plays those roles.

To let other machines open the game itself: `HOST=0.0.0.0`. Passkeys need a secure origin, so beyond `localhost` serve it over HTTPS and set `ORIGIN=https://your.domain`.

## Layout

| Path | What |
|---|---|
| `src/federation.js` | Local or external federation |
| `src/world.js` | The town's view of the federation: registries, record keepers, verifier, court |
| `src/places.js` | Places as relying parties, their live policies, and the World ID and x402 layers |
| `src/sim.js` | Residents, newcomers, sub-agents' errands, bots, the swarm; walks timed on the shared routes |
| `src/player.js` | The player and the full action catalog |
| `src/town.js`, `src/server.js` | The ledger, director cues, and the HTTP API |
| `src/worldid.js`, `src/x402.js` | The simulations |
| `public/map.js`, `public/route.js` | The town's layout and drawing; routes shared with the server |
| `public/game.js`, `public/palette.js`, `public/ui.js`, `public/api.js` | The game, the action deck, cards and HUD, server calls and WebAuthn |

## Limits of this prototype

- **One player.** Everyone else is simulated. A live demo with people in roles (agents, shopkeepers, homeowners) needs player sessions; the server already keeps the player separate from the town.
- **State is in memory**, and each start is a new town. *Start over* resets only you; your old door passkey stays in your password manager until you delete it there.
- **World ID and x402 are simulated**, as above.
