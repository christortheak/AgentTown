# Working on AgentTown

This file is for coding agents (and people) changing AgentTown. The guide for agents *playing* the town is a different thing: the server builds it at `/agents.md` from `src/guide.js`.

AgentTown is the launch demo for the Accountable Agents framework: a town in the browser where every shop, door and office is a real relying party. The [README](README.md) explains what it shows, the roles, and the layout of `src/` and `public/`.

## Run and test

Needs Node.js 22 or later, with `aaf-reference` checked out next to this folder (`package.json` depends on `file:../aaf-reference`).

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

- **Don't edit `../aaf-reference`.** The local folder is a snapshot, not a git checkout, and may be behind the framework's own repository. Use it as it is.
- **Check against the framework's repository too.** Newcomers clone [christortheak/accountable-agents-framework](https://github.com/christortheak/accountable-agents-framework) as `aaf-reference` ([docs/TRY-IT.md](docs/TRY-IT.md)), and a snapshot can hide a break: clone it into a scratch folder beside a copy of this one, `npm install`, and run the tests there before telling anyone the guides work.
- Changes we'd like in the framework are prototyped here, in `src/proposed/`, and set out for discussion in [docs/PROPOSED.md](docs/PROPOSED.md). Label anything built on them as proposed in the UI.
- A resident may run several agents. In `src/player.js`, `p.agent`, `p.grant`, `p.badge` and the other per-agent fields are accessors onto one of them: the agent named for the call (`run(id, params, { agent })`, `params.agent`), the one you play, a sub-agent's own (`ofAgent`), or else `p.current`, the one you last played or picked. An async call keeps its agent to the end. Use `p.agents` (or `live()`) where you mean all of them; in `src/sessions.js` each has its own body (`bodyOf(s, id)`), errand and outside agent (`s.agentPairs`).
- The framework assumes one trust anchor; the town prototypes several (`src/proposed/anchors.js`). `world.trust` is a view across every federation the town knows, and each place's view keeps to the federations it trusts. Use `world.keeperFor(registryId, role)` and `world.recordsFor(registryId)`, not `world.authRk` or `world.records()`, wherever an agent may be registered outside the town's federation.
- The framework's router (`createApp` in `aaf-reference/src/lib/http.js`) handles GET, POST and PUT only. Handlers get `{ req, url, params, query, body, headers }`; return `{ __raw: true, status, body, headers }` for anything that isn't a 200 JSON reply.

## Rules the code keeps

- **A principal's name never appears in a shared view.** Others see an agent's name, never its principal's. Ledger lines that name a principal, or link them to their agent, are `private: true` with an `owner`, and `/api/world` shows them only to that owner. Cards go through `places.publicCard` for everyone but their owner and the place that served them. A court's public findings are the one exception.
- **Places never learn the truth.** `card.truth` (person or agent) and the scoreboard's people/posed counts are the narrator's: show them in the ledger and the director's views, never to a place, a shopkeeper's agent or another player.
- **Approvals stay human.** Nothing an outside agent can reach approves anything. The approval and passkey endpoints take only a person's own session (`x-session`); an agent's token is never one. Outside agents may only do what `AGENT_MAY` in `src/player.js` allows (and, at a counter, `SHOP_AGENT_MAY` in `src/sessions.js`). Don't add an MCP tool or CLI command that approves, verifies, registers, signs a grant or edits the record.
- **Places are reached through the front.** A place's `rp.url` is its address at the front door (`src/front.js`), which passes on only its description and its actions; its accounts are used in-process (`rp.accounts`). The town's own requests carry the front's mark (`world.agent`, `rawRequest` and `handBuiltRequest` add it), and anything without it is an agent that came with its own badge. Never serve `rp.privateUrl`.
- **Plain words first.** A result card leads with what happened, why, and what would fix it; the technical record comes after. Write for someone who has never heard of the framework.
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
