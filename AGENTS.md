# Working on AgentTown

This file is for coding agents (and people) changing AgentTown. The guide for agents *playing* the town is a different thing: the server builds it at `/agents.md` from `src/guide.js`.

AgentTown is the launch demo for the Accountable Agents Framework (AAF), as the paper *The Accountable Agents Framework (AAF): A Blueprint for AI Agent IDs* sets it out: a town in the browser where every shop, door and office is a real counterparty. The [README](README.md) explains what it shows, the roles, and the layout of `src/` and `public/`.

## Run and test

Needs Node.js 22 or later and git. `package.json` depends on the framework's [sample implementation](https://github.com/christortheak/accountable-agents-sample-implementation) at one tagged version, under its package name `aaf-reference`, and `npm install` fetches it from GitHub. npm 12 and later fetch nothing from git by default; `.npmrc` (`allow-git=root`) lets them fetch this one dependency.

```bash
npm install
npm start        # http://localhost:4400 (use localhost, not 127.0.0.1: passkeys are bound to a domain)
npm run lan      # a party on one network: finds this machine's address, makes a director key, opens the director's view
npm test         # the whole suite, one test file at a time; a few minutes
```

- Each test starts its own town on its own port (4490s, with its own `portOffset`) and runs town time 25× faster (`timeScale: 25`). Pick a free port and offset for a new test. A town's sample outside federation listens at `4150 + portOffset` and the next port, and the participants' test uses 15501–15502.
- A test of LAN mode or `AGENTTOWN_ADDRESS` gives the address `127.0.0.1`: at a loopback address nothing listens on the network, and LAN mode doesn't look for one.
- Tests that run the CLI give it a scratch `HOME`: the CLI writes `~/.agenttown.json`, and a test must never touch the real one.
- There is no build step and no bundler. The browser loads `public/*.js` as ES modules; the server shares `public/map.js` and `public/route.js`, so keep those free of DOM code.

## The framework

- **The framework is pinned.** `package.json` names one tagged version of the sample implementation (`v0.4.0`, profile 0.4), and `package-lock.json` records its commit (`4a5acd5`). AgentTown's own version matches the profile it runs on (0.4.0, tagged `v0.4.0` here too); move both together. To move to a newer one, run `npm install github:christortheak/accountable-agents-sample-implementation#<tag>` (npm 12 won't replace an installed git dependency in place: if it refuses, `npm uninstall aaf-reference` first, then that), and run the tests; then bring the town's code and text in line with what changed.
- **Don't edit the framework from here**, in `node_modules/aaf-reference` or anywhere else. If the town needs something from it, prototype it in `src/proposed/` and write it up in [docs/PROPOSED.md](docs/PROPOSED.md).
- **Check a fresh clone too.** Before telling anyone the guides work, clone this repository into a scratch folder, `npm install` and run the tests there, as a newcomer would ([docs/TRY-IT.md](docs/TRY-IT.md)).
- **Words.** The town uses the paper's terms wherever it explains the framework, to players or in the guides: directory, records service (a part of a directory), counterparty, ID, PPID (only the kind that stays the same at one place), unlinkable ID, presentation and claims, attribution and identity escrow, designated authority, delegating agent. A badge is the town's own word for an agent's presentation. Code uses the same words, as the framework's does since profile 0.4 (`directory`, `aaf_id`, `counterparty`, `rs`, `trace`); never `registry`. WebAuthn's own *counterparty* (`rpId`) keeps its name. The town's own directories have ids and names in the paper's terms (`src/federation.js`). **Actions → The framework's words** is the list players see; keep it, `src/guide.js` and the README in step.
- Changes we'd like in the framework are prototyped here, in `src/proposed/`, and set out for discussion in [docs/PROPOSED.md](docs/PROPOSED.md). Label anything built on them as proposed in the UI.
- A resident may run several agents. In `src/player.js`, `p.agent`, `p.grant`, `p.badge` and the other per-agent fields are accessors onto one of them: the agent named for the call (`run(id, params, { agent })`, `params.agent`), the one you play, a sub-agent's own (`ofAgent`), or else `p.current`, the one you last played or picked. An async call keeps its agent to the end. Use `p.agents` (or `live()`) where you mean all of them; in `src/sessions.js` each has its own body (`bodyOf(s, id)`), errand and outside agent (`s.agentPairs`).
- The framework assumes one trust anchor; the town prototypes several (`src/proposed/anchors.js`). `world.trust` is a view across every federation the town knows, and each place's view keeps to the federations it trusts. Use `world.recordsServiceFor(directoryId, role)` and `world.recordsFor(directoryId)`, not `world.authRs` or `world.records()`, wherever an agent may be registered outside the town's federation.
- The framework's router (`createApp` in its `src/lib/http.js`) handles GET, POST and PUT only. Handlers get `{ req, url, params, query, body, headers }`; return `{ __raw: true, status, body, headers }` for anything that isn't a 200 JSON reply.

## Rules the code keeps

- **A principal's name never appears in a shared view.** Others see an agent's name, never its principal's. Ledger lines that name a principal, or link them to their agent, are `private: true` with an `owner`, and `/api/world` shows them only to that owner. Cards go through `places.publicCard` for everyone but their owner and the place that served them. A court's trace goes only to the people in the case (`private` lines to whoever brought it, and the case board for the police and the judge). A judgment is the one exception: it names whoever it rules against, except an individual in the Harbor (`published` in `src/justice.js`).
- **Places never learn the truth.** `card.truth` (person or agent) and the scoreboard's people/posed counts are the narrator's: show them in the ledger and the director's views, never to a place, a shopkeeper's agent or another player.
- **Approvals stay human.** Nothing an outside agent can reach approves anything. The approval and passkey endpoints take only a person's own session (`x-session`); an agent's token is never one. Outside agents may only do what `AGENT_MAY` in `src/player.js` allows (and, at a counter, `SHOP_AGENT_MAY` in `src/sessions.js`). Don't add an MCP tool or CLI command that approves, verifies, registers, signs a grant or edits the record.
- **Places are reached through the front.** A place's `counterparty.url` is its address at the front door (`src/front.js`), which passes on only its description and its actions; its accounts are used in-process (`counterparty.accounts`). The town's own requests carry the front's mark (`world.agent`, `rawRequest` and `handBuiltRequest` add it), and anything without it is an agent that came with its own badge. Never serve `counterparty.privateUrl`.
- **Plain words first.** A result card leads with what happened, why, and what would fix it; the technical record comes after. Write for someone who has never heard of the framework.
- **A court acts on harm.** The simulated judge grants an order only when the case's grounds support it (`ruling` in `src/justice.js`): a case needs harm on record (`HARM`) to be traced at all, and only what the law forbids earns a judgment (`criminal`); breaking a place's own rules gets a remedy at most, like the ferry cancelling seats over its limit. A ban is for a second offence. Don't add a way to have an ID traced that skips the petition and the ruling.
- **Two jurisdictions.** The river is the border (`jurisdictionAt` in `public/map.js`): the town north of it under US rules, the Harbor south of it under EU rules. A place's `jurisdiction` says which law it is under, and a case takes the jurisdiction of the place where the harm happened. Each side's law is posted from `public/laws.js` (the notice boards, the border banner, the guide for outside agents); keep it in step with what the court and the places do.
- **Simulations say so.** World ID and x402 are simulated, and the UI says so wherever they appear.
- **Outside addresses go through the guard.** Anything that fetches an address a visitor, a team or an outside anchor gave calls `guard.check` (`src/addresses.js`) first and fetches with `guard.fetchOptions`. In public mode (`AGENTTOWN_PUBLIC=1`) only public addresses pass; the town's own services are exempt by entity id and address together, never for being in a federation the town knows. With public mode off, nothing may change: LAN events use private addresses.

## Testing in a browser

Use test names only (like "Robin Ash"), never real credentials. Don't create real passkeys on your machine: test passkeys with a virtual or software authenticator (the tests use `SoftwareAuthenticator` from aaf-reference).

## Style

- ES modules, two-space indent, single quotes, semicolons, no TypeScript, no new dependencies without asking.
- Short comments that say why, in the same plain voice as the UI. Match the code around you.
- Keep `README.md`, `docs/PROPOSED.md` and `src/guide.js` in step with what you change.

## Git

The repository is private, on GitHub. Commit and push only when asked.
