# AgentTown

A cozy town where you play an accountable agent. It is a launch demo for the *Accountable Agents* framework, and it is a separate project from the framework's reference implementation.

You steer a small agent around town. You, at the keyboard, are its **principal**. Your phone (a panel in the corner) is where places ask the principal for approval, using a **real passkey** on your device.

Nothing in the town is faked. Each door, shop and office is a real relying party running on the reference implementation's federation: a trust anchor, two registries and two record keepers. Each ID card the game shows is a service's actual decision. It lists every check the service ran and what the service learned, along with a verified receipt for the entry it wrote to the activity log.

## Run it

Needs Node.js 22 or later, with `aaf-reference` checked out next to this folder.

```bash
npm install
npm start
```

Then open **http://localhost:4400** in Chrome, Safari, Edge or Firefox. Use `localhost`, not `127.0.0.1`, because passkeys are bound to a domain.

```bash
npm test
```

This plays a whole day through the game's API. A software authenticator stands in for your passkey.

## The day

| Quest | Where | What it shows (framework) |
|---|---|---|
| Get verified | Town Hall (Registry A) | Enrollment and identity verification once (IAL2), the slow step |
| Register your agent | Town Hall | Fast registration; a badge with a different PPID at every place; a lineage depth budget of 1 |
| Sign a grant | Records Office (Ledgerline) | Authority as RAR `authorization_details`: purchases ≤ $25/$50/$100, books and home goods only, home access, delegable one level |
| Buy at both shops | Bramble Books, Copper Kettle | Selective disclosure; refusals over the limit and outside the categories; "what do you know about me?" shows the shops can't link you |
| Put a passkey on your door | Your house (Hearth & Key) | WebAuthn registration at a service with accounts |
| Let your agent in | Your house | Agent-bound access: the first visit opens an approval on your phone showing who stands behind the agent, and you approve with your passkey |
| Rest until night | Your house | The Hugging Face replay: three accountable agents and one anonymous client try a copied key. All are refused, and incidents are relayed to their principal without you learning who it is |

**Try this:** shop with your badge off (`B`) and get `UNLABELED`. Pick up Maple's lost key and try it: you are refused, and an incident report about *your* agent arrives on *your* phone. Hire an ephemeral helper (a sub-agent) and try to give it more than you have, which fails with `exceeds_parent_authority`. Ask the helper to hire its own helper (`lineage_depth_exceeded`). Throw something out at home, which needs a passkey step-up every time; approvals can't be reused. Take the night's visitors to court, which resolves their principal and records the lookup in the transparency log. Revoke your agent, which cascades to its helper.

## Layout

| Path | What |
|---|---|
| `src/town.js` | The town: an in-process federation, the places (each a relying party), the player's principal and agent, the night visitors |
| `src/server.js` | HTTP server: the game page, the game API, the front door's passkey ceremonies |
| `public/map.js` | Map layout, pathfinding, and all the canvas drawing |
| `public/game.js` | Game loop, movement, and the script at each place |
| `public/ui.js` | Dialogue, ID cards, the quest list, your record, your phone |
| `public/api.js` | Server calls and the browser half of WebAuthn |
| `test/town.test.js` | The whole day, end to end |

The game imports `aaf-reference` through a `file:` dependency and never writes to that repository's data directory. Each run starts a fresh federation in a temporary folder.

## Limits of this prototype

- **One player, in memory.** State lasts until the server restarts. *Start over* resets the town; your old door passkey stays in your password manager until you delete it there.
- **Local only.** A shared or hosted world needs HTTPS on a real domain (for passkeys), one federation per room, rate limits, and the hardening listed in the reference implementation's spec §16.
- **Night visitors are scripted.** Players can't yet act as the burglars, or visit each other's homes.
