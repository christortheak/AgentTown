# AgentTown

A cozy town where you play an accountable agent. It is a launch demo for the *Accountable Agents* framework, and it is a separate project from the framework's reference implementation, which it uses as a dependency.

Many people can play at once, each in a role: a **resident** (you walk the town yourself, and can register an agent and send it), a **shopkeeper**, a **homeowner**, the **police**, **the judge** or the **town council**. Simulated residents' agents, a person who shops in person, a newcomer, sub-agents, an honest agent nobody registered and, on cue, a rogue swarm fill the rest of the town. Every door, shop, bank, exchange and office is a real relying party. Every decision you see is a service's actual decision, told in plain words first (what happened, why, and what would fix it), with every check it ran, what it learned, and a verified receipt for its activity-log entry underneath.

What the town is built to show: the framework is neutral infrastructure for one thing, **a place asking a counterparty for information, the counterparty deciding whether to give it, and the answer being reliable**. Places decide what to ask; principals decide what to share; lawmakers decide what places must ask for; and none of that changes the registries, record keepers or badges. Not every place has to adopt it, and the town shows what that costs.

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

Plays a whole day through the API (town time runs 25× faster), starting in person, with disclosure requests answered once, always or not at all, by passkey; runs a town against an external federation reached by address; runs a town with five people in roles, in which a shopkeeper picks the registries she trusts, a homeowner approves a visitor from her own device, and police and a judge catch, delete and ban a crooked player, who then comes back under another name; runs a town where shops adopt the framework, or don't, and a council's laws change what they must ask for; plays people and agents side by side: signing in with a passkey, a record that stops the agent over its daily budget and asks before larger purchases, an agent taken for a person, and agent software that can't answer; and pairs an outside agent over MCP, the stdio bridge and the CLI, which asks its principal and can't approve anything itself.

## Roles

Open the town and pick a role. Each browser tab is its own player, so two tabs (or two devices) can play two roles.

| Role | What you do |
|---|---|
| 🧍 Resident | You walk the town yourself and shop in person. Get verified, register an agent (it follows you; **T** chooses who goes), set your record, bank, trade, spawn sub-agents and send them on errands. Play it straight, or try to get away with something: send your agent without its badge and see who notices. |
| 🏪 Shopkeeper | Run a shop, the bank, the exchange, the fair or the toll. Choose whether to use the framework at all (check badges, pilot it, ignore it, or block agents), which registries you trust and what you ask for (badge, proof of age, World ID, x402); see which of your questions come from you and which from the law; watch every customer's ID check, report a customer to its registry (its principal hears about it, you still don't learn who), or file it with the police. |
| 🏡 Homeowner | Own a house in Hearthside. Put a passkey on your door; when an agent knocks, your phone shows who stands behind it and you decide. Change the locks when keys go astray. |
| 👮 Police | Cases arrive from places: refused payments the bank flags, attempted break-ins, a pump spotted at the Exchange. Open cases from any ledger line, and petition the court. |
| 🏛️ Town council | Make the law, separately for the town (US rules) and the Harbor (EU rules): anti-money-laundering, consumer protection, high-risk AI services, privacy first. Set how much of town uses the framework. Watch the scoreboard. |
| ⚖️ Judge | Rule on petitions. *Identify*: the registry resolves every badge in the case and groups them by principal, so bystanders are told apart from whoever ran the scheme. *Delete*: the registry's operator revokes the principal's agents under legal order, and the revocation cascades. *Ban*: the identity verifier withdraws the principal's verification, which suspends every agent under it at once, and won't verify that identity again. |

Nobody playing police or judge? A simulated inspector and judge take over: refused payments and complaints are only identified; a pump or break-ins lead to deletion, and a coordinated scheme or repeated misconduct to a ban.

**Getting away with it.** A banned player can leave and join again. As the same person they can't be verified; under another name they can, in this town. Real identity checks, with documents and liveness, exist to stop exactly that.

**Who sees what.** A badge never names its principal, so neither do the town's shared views: other players see your agent's name, never yours, and ledger lines that would link the two are visible only to you. If you share your name with one place, that place sees it; everyone else's view of the same visit says only that a name was shared. A court order changes that, and its findings are public: a banner tells the whole town.

## Bring your own agent

Your own AI agent (Claude, ChatGPT, anything that speaks MCP or can run a command) can play as your agent in town, while you stay its principal in the browser. Register an agent, then choose **Actions → Connect your own agent** to get a pairing code, and give it to your agent:

| Client | How |
|---|---|
| Claude Code | `claude mcp add --transport http agenttown "http://localhost:4400/mcp?code=ABC-123"` |
| Any MCP client over HTTP (e.g. the OpenAI Agents SDK) | `http://localhost:4400/mcp?code=ABC-123` |
| Claude Desktop and other stdio clients | `node bin/agenttown-mcp.js --url http://localhost:4400 --code ABC-123` |
| A shell | `node bin/agenttown.js pair ABC-123 --url http://localhost:4400`, then `look`, `actions`, `do buy shop=bramble item=guide` |
| Anything that reads | "Read http://localhost:4400/agents.md and play AgentTown as my agent. The code is ABC-123." |

Your agent gets tools to look, list what it may do, act (it walks there first, and everyone sees it go), say something, walk, and put a question to you. It gets **no way to approve anything**:
- What your record says to ask about goes to your phone, and you approve with your passkey.
- The approval endpoints only take a person's own session; an agent's token isn't one.
- Verifying, registering, your record and your grant stay yours.

The town serves its guide for agents at `/agents.md`, with an index at `/llms.txt`. A code works for two hours, and reconnecting with it gets the same agent back. **Disconnect your outside agent** ends it at once. A player who joins through the API with `"headless": true` and no browser is walked about by the server, so others still see them move.

## People and agents

You start as a person. Places can't see who is at the counter: a request with no badge might be a person or an agent that isn't saying. Each place has a rule for requests with no badge, set by its keeper:

| Rule | Example | What happens |
|---|---|---|
| Take them at their word | Bramble Books, the bakery, the Old Quarter | People are served; so is any agent that hides its badge |
| "Seems human?" check | The Blue Door's doorman | A guess: some agents pass, some people are turned away |
| Sign in with a passkey | Copper Kettle, the bank, the Exchange, the Forge | Sign up once, then approve each request with your passkey: the framework's human path. No passkey, no service |
| World ID (simulated) | The Harvest Fair | One per person |
| Agents only | (set it in a shop) | No service without a badge |

The ledger marks agents taken for people (🥸): only the narrator knows; the places never do. Tom shops in person, and sometimes fails the doorman's check. Clank, an honest agent nobody registered, is taken for a person wherever people are taken at their word.

## Your record (a proposed extension)

The framework's grant says what an agent may do in one request. Your **record** at the Records Office says the rest: a limit per purchase, a total per day, purchases per day, kinds of purchase, the amount above which your phone asks you first, which places always get your name or proof of age (otherwise ask, or never), and facts on file such as a loyalty card. Before spending, your agent asks the Records Office for an **allowance**: a signed "within the record", for one place and one request, that never states your balance. A place may ask to see it. Over your limit, your agent doesn't go ahead, and the place is never asked. Your **register** shows every purchase your agents tried.

When a place asks a question, your agent answers each part from your record: **yes**, **ask you** (a passkey on your phone), **won't**, or **can't** (its software doesn't support that question, or there's nothing on file). When you register an agent you choose its software: Pocket Agent answers everything; Tinybot can show only a badge, a permission and a name.

None of this is part of the framework's reference implementation: it is prototyped in `src/proposed/`, and [docs/PROPOSED.md](docs/PROPOSED.md) sets it out for discussion.

## Asking and answering

The core loop. A place's policy may ask for more than a badge: the bank wants your name to open an account, the apothecary wants proof you're over 18 for a sleeping draught, the Compute Forge wants your name and your agent's bill of materials for a large job. The place answers *not yet* and says exactly what it needs; the question goes to your **phone** (and onto the result card):

- **Share once**: approved with your passkey. The registry adds just that to a fresh badge for that place, your agent shows it, and it's gone again afterwards.
- **Always here**: approved with your passkey, and added to your record; take it back on your phone any time.
- **Decline**: you aren't served, and the place learns nothing more.

Your agent never shows more than the place's rule needs: "over 18", not a birth date or a name. Verification at Town Hall records that one fact; your agent's maker publishes its bill of materials when you register it.

## Playing

| Key | |
|---|---|
| **Q** | The **action deck**: every action in town, grouped and searchable, with what you can do right here at the top. Picking an action somewhere else walks you there first. Nothing is hidden. Some actions are refused, and the refusal comes from the service that refused. |
| **E** | Talk to the place you're standing at (opens the deck there). |
| **B** | Take your badge off or put it back on. |
| **T** | Who goes: you, or your agent. |
| **X** | The **X-ray**: watch each request travel. Your agent asks its registry for a badge made out to this place only, swaps its grant for a permission slip at the Records Office, sends a signed request; the place checks the badge's status with the registry and the grant with the Records Office, writes to the activity log and answers. The camera pulls back to fit it all in, and the steps are listed in words. Every result card has an X-ray button too. |
| Click | Walk; click a building to go and talk to it; click anyone to ask for their badge; click the minimap to run there. |
| 🎬 | The **director**: cues for demos and videos, the law, adoption, each place's policy, and a presenter view. |

The HUD shows your quests, a minimap with the town's adoption score under it, **your record** (what the registry holds about you, your wallet, what your agent may do), **your phone** (questions from places, approvals and incident reports for you as principal) and the **town ledger** (everything everyone does, with the badge number each place saw; click a line to see its ID check). Each result card leads with a plain headline and a suggested fix, and has two folds: **Compare**, which shows what an API key, Web Bot Auth, World ID, x402 or a payment mandate would have told the same place, and the **technical record**.

## The town

| District | Places | What they show |
|---|---|---|
| Civic Row | Town Hall (Registry A), Records Office (Ledgerline, Tessera), Courthouse, Police Station, Thistle Exchange, Orb Kiosk | Verification once, fast registration, grants, receipts; police and courts; commodities trading with market surveillance; a simulated World ID |
| Market Lane | Bramble Books, Copper Kettle, First Ledger Bank, Oakleaf Bakery | Selective disclosure, refusals over the limit or outside the categories, pairwise badge numbers; opening a bank account needs your name (know your customer); refused payments become SAR candidates |
| The Works | Compute Forge, Wren Labs | Large jobs need a disclosed principal and a bill of materials |
| Hearthside | Your house, Maple's, Hazel's, Ivy's, Willow Apothecary | Passkeys: agent-bound access, the human path, step-up; stolen keys reported to the right principal; proof of age without a name |
| The Old Quarter | Mended Things (pawn), The Blue Door (tavern), Saffron Grocer | Partial adoption: a shop that checks nothing (and can report no one), a tavern that blocks agents (and turns away only the honest ones), a grocer piloting badges for bigger orders. Clank, an honest agent nobody registered, runs errands here |
| Town Square | Fountain, Harvest Fair | A free pie, one per person: World ID (simulated) next to the framework |
| The Harbor (EU) | Bridge Toll, Harbor Registry (Registry B), Café Lumière, Rook & Daughters | x402 (simulated) next to the framework; a café that only accepts EU badges; federated chains |
| The Wilds | The Old Mill | Where the swarm comes from |

### Director cues

- **Rogue swarm.** A verified company's compromised root agent registers eight sub-agents; the registry refuses every attempt to go a level deeper. Each sub-agent may trade a little, so together they pile into MOON at the Exchange: a pump. The Exchange can't tell they share a principal (each showed a fresh badge), so it reports them to the police. With six unlabeled bots they raid the rest of town: shops refuse them (no authority), the fair refuses them (no World ID), homes refuse stolen keys and report them. Their principal may revoke the root itself after a few incident reports; otherwise the court identifies it from the Exchange's evidence, deletes its agents and bans it. The bots get through only where a place asks for nothing but payment.
- **Registry outage.** The shops can't reach Registry A for 45 seconds and **defer** instead of refusing (`LOOKUP_FAILED`), while agents from Registry B are still served.
- **A newcomer arrives.** Ivy walks in from the east gate and goes through the slow step at Town Hall, the Orb and the Records Office, then moves in.
- **Night at your house.** Four visitors with a copy of your key.
- **The law**, per jurisdiction, and **adoption**: presets for "today", "early days" and "everyone", or one place at a time.
- **Each place's policy**, live: which registries it accepts, whether it needs a badge, World ID, an x402 payment. A place run by a person playing is theirs to set.
- **Presenter view**: hides the personal panels and enlarges the ledger, for a screen in a room.

## The rulebook and partial adoption

What a place asks for comes from three layers, kept apart (`src/places.js`, `src/rulebook.js`):

1. **Adoption**: does the place use the framework at all? *Checks badges*, *pilot* (badges optional for orders up to $20), *not on the framework* (checks nothing, keeps nothing), or *blocks agents* (refuses anything that says it is an agent, so an agent that hides its badge walks in).
2. **The keeper's policy**: which registries, whether a badge is needed, proof of age, World ID, x402.
3. **The law** for the place's jurisdiction and sector. Each regime sets *floors* (ask for at least this), *caps* (never ask for more) and *mandates* (this sector must check badges, whatever it chose):

| Regime | Sectors | Effect |
|---|---|---|
| Anti-money-laundering | finance | Payments and trades need an accountable agent with permission; over $100, the principal's name |
| Consumer protection | shops, pharmacies, inns | Permission for every purchase; verified proof of age for age-restricted goods |
| High-risk AI services | compute, finance | The principal's name and the agent's bill of materials for compute jobs and trades |
| Privacy first | everywhere | No place may demand a name; regimes that would are capped |

Switching a regime on rebuilds the affected places' rules in place and announces what changed: "Registries and record keepers unchanged; 4 places now ask for something different". The scoreboard counts, for every place, visits with a valid badge, without one, and unchecked; and for the swarm, how many of its visits were stopped, served but reportable, or served unseen. Set the starting law in the config: `"law": { "us": ["aml"], "eu": ["aml", "privacy"] }`.

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
- `places`: each place's starting policy and adoption, e.g. a bank that accepts only one registry, or a pawn shop that checks badges after all (`"adoption": "full"`).
- `law`: the regimes in force at the start, per jurisdiction.

To host the framework's services on a LAN with aaf-reference as it is: set `"host"` in `aaf-reference/config/federation.json` to the machine's address, run `npm run reset` and `npm start` there, then copy `data.nosync/trust-anchor.json` (and, for verification and courts, the verifier's and court's key files from `data.nosync/keys/`) to the town's host. Those keys are private: share them only with the town that plays those roles.

To let other machines open the game itself: `HOST=0.0.0.0`. Passkeys need a secure origin, so beyond `localhost` serve it over HTTPS and set `ORIGIN=https://your.domain`. For a public demo, set `AGENTTOWN_DIRECTOR_KEY` so only you can cue the swarm, outages and policies; open the town with `?director=<key>` to use them.

## Layout

| Path | What |
|---|---|
| `src/federation.js` | Local or external federation |
| `src/world.js` | The town's view of the federation: registries, record keepers, verifier, court |
| `src/places.js` | Places as relying parties: adoption, live policies, disclosure requests, plain-language results, X-ray traces, the scoreboard, and the World ID and x402 layers |
| `src/rulebook.js` | Jurisdictions, regimes, floors, caps and mandates |
| `src/mcp.js`, `src/guide.js`, `bin/agenttown-mcp.js`, `bin/agenttown.js` | Outside agents: the MCP endpoint and its tools, /agents.md and /llms.txt, the stdio bridge, the CLI |
| `src/proposed/keeper.js`, `src/proposed/driver.js` | Proposed: the principal's record, allowances, statements and the phone's passkey; the agent software that answers a place's question |
| `src/explain.js` | Headlines and reasons in plain words, and ledger lines |
| `src/sim.js` | Residents, newcomers, sub-agents' errands, bots, the swarm; walks timed on the shared routes |
| `src/player.js` | A player with an agent, and the full action catalog |
| `src/sessions.js` | Joining, roles, what each role sees and can do, idle sessions let go |
| `src/justice.js` | Cases, petitions, and court orders run on the registry and the identity verifier |
| `src/town.js`, `src/server.js` | The ledger, director cues, and the HTTP API |
| `src/worldid.js`, `src/x402.js` | The simulations |
| `public/map.js`, `public/route.js` | The town's layout and drawing; routes shared with the server |
| `public/game.js`, `public/palette.js`, `public/roles.js`, `public/ui.js`, `public/api.js` | The game, the action deck, joining and the role panels, cards and HUD, server calls and WebAuthn |
| `public/xray.js`, `public/lens.js`, `public/records.js` | The X-ray, the comparison with other approaches, and the Records Office counter |

## Limits of this prototype

- **State is in memory**, and each start is a new town. Leaving town lets go of your role; a passkey you made stays in your password manager until you delete it there.
- **No accounts.** A session is a tab; anyone can take any free role. That is the point for a demo, but a public one should keep the director key private.
- **The town ledger is a narrator's view**, for the demo: it shows what every place decided. Names of principals stay out of it unless a court finds them.
- **World ID and x402 are simulated**, as above.
- **The comparison is simplified.** "Compare" gives typical answers for each approach, not a full analysis, and several of them combine with the framework rather than compete with it.
- **The record, allowances, statements and the way agents answer are a prototype** of proposed extensions, not the framework; see docs/PROPOSED.md for what a real version would need (allowances bound to the presentation key, the registry checking the principal's signature itself).
- **The laws are illustrative.** The regimes are loosely modeled on real ones to show how one infrastructure serves different rules; they are not legal advice or faithful implementations.
