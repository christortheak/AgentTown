# Bring your implementation to AgentTown

For teams who have built a directory, a records service, or a whole federation for the Accountable Agents Framework (AAF), and want to see residents' agents use it in town. A directory is what the paper calls one (entity type `aaf_directory`), and a records service is the part of a directory that keeps its records (`aaf_records_service`); the town checks them against the sample implementation's profile 0.4, which uses the paper's words in its API. Everything here is a prototype: at a local event, plain HTTP on one network; or one town on a public server, which asks a little more of your services ([Limits](#limits)). Nothing is kept after the town stops.

There are two ways in:

| You bring | It joins | You need |
|---|---|---|
| A directory, a records service, or both | **AgentTown Participants**, a federation the town runs and admits members to while it runs | the town's trust-anchor bootstrap |
| A whole federation: a trust anchor and its members | the town's list of federations, by your anchor's address | the town's identity verifier and court, as members of your federation |

Either way, **no place trusts you until it chooses to.** Shopkeepers tick federations in their panel; the director can make every place trust one. That is the point: anyone can run a directory, and each counterparty decides whose badges it accepts.

## For the host

Run the town as in [Run AgentTown at a LAN event](HOST.md), with `npm run lan` (or `AGENTTOWN_ADDRESS` set), so the town's federations listen on the network and publish its address there. A town on a public server uses public mode instead, with `AGENTTOWN_PARTICIPANTS_URL` set to AgentTown Participants' own name ([On a public server](HOST.md#on-a-public-server)). Then:

- **Share the trust anchor's key thumbprint.** The startup log prints AgentTown Participants' trust anchor and its thumbprint: read it out, or put it on a slide, so teams can check it.
- **Decide who admits services.** With `AGENTTOWN_DIRECTOR_KEY` set, only the director can add federations or admit services (open the town with `?director=<key>`). Without it, anyone in town can. LAN mode makes one, and a public town always has one.
- **Have something to add while teams get ready.** The director's **Start a sample outside federation** runs Riverside Co-op.

## Joining AgentTown Participants

1. **Get the bootstrap.** `GET http://<town>:4400/trust-anchor.json` (on a public server, `https://town.example.org/trust-anchor.json`) returns `{ name, entity_id, url, jwks, thumbprint }`, the same shape as aaf-reference's `trust-anchor.json`. Check the thumbprint with the host. Configure your services with it: it's your trust anchor.
2. **Describe yourself.** Serve a self-signed Entity Configuration at `/.well-known/openid-federation` (OpenID Federation 1.0, as in §6 of the sample implementation's spec):
   - metadata `aaf_directory` or `aaf_records_service`, with `organization_name`, `endpoint_base` (where you're served), and `jwks` (a signing key; a directory also needs an encryption key). A records service lists its `roles`: `authorization`, `provenance`, `activity`;
   - `authority_hints: ["https://participants.agenttown.test"]`.
3. **Get admitted.** In the town: Hall of Directories → **Admit a directory or records service**, and give your address. If your service can't start until it's a member (the sample implementation's can't), paste its entity statement instead: `{ "entity_id", "entity_type", "jwks", "metadata" }`. Or `POST /api/participants` with `{ "url" }` or `{ "statement" }`.
4. **Accredit your records service.** In AgentTown Participants, any admitted directory may accredit records services. Your directory issues one trust mark per role, of type `https://participants.agenttown.test/trust-marks/record-keeper/<role>`, serves it at `GET /federation/trust-mark?trust_mark_type=…&sub=…`, and your records service publishes it in its Entity Configuration.
5. **Accept the town's identity verifier.** AgentTown Participants lists the town's verifier (VerityCheck) and court. Accept verifications they sign (`POST /v1/principals/{id}/verification`, `keyid="verifier:<entity>"`), and residents can register agents at your counter.

Credential and trust-mark types are named under this federation's anchor (`https://participants.agenttown.test/vct/accountability/1`, and so on), as the profile requires.

## Bringing a whole federation

1. Run your trust anchor and members. List the town's identity verifier and court as members of your federation: `GET http://<town>:4400/api/authorities` gives them as member entries, public keys and all.
2. In the town: Hall of Directories → **Add a federation by address**, and give your anchor's address and its key thumbprint (`http://192.168.1.30:4600 <thumbprint>`). Or `POST /api/federations` with `{ "url", "pin" }`.
3. An agent registered in your federation then visits town, and residents can register at your directory's counter.

## The check at the door

When a service is admitted by its address, and whenever someone presses **Check** beside it in the halls (or `POST /api/participants/check` with `{ "entity_id" }` or `{ "url" }`; in a public town, only the director checks by `url`), the town probes what it must answer, without changing anything:

| Every service | A directory | A records service |
|---|---|---|
| answers at its address | has a signing key and an encryption key | says which records it keeps |
| describes itself, self-signed | answers live status (`POST /v1/status`) | is accredited by a directory the town knows (trust marks) |
| says what it is | keeps a transparency log (`GET /v1/transparency/sth`) | keeps a tamper-evident log (`GET /v1/log/sth`) |
| names a trust anchor the town knows | accredits records services (`GET /v1/accreditations`) | answers token exchange (`POST /token`), if it keeps grants |
| says where it is served | publishes its practices (`GET /v1/practices`, the paper's DR-1) | |
| publishes a status list (`GET /status-lists/1`) | | |

Each check passes, fails, or isn't done yet (an accreditation still to come).

## What the town will call

Residents, their agents and the places use the API of the sample implementation's profile 0.4 (its spec's Appendix A). Against a directory: enrollment, verification and attributes (one principal record per verified identity: a second is refused as `duplicate_identity`), disclosure policy, notifications, registrations with the agent's proof that it holds its key (`agent_proof`) and revocation, accountability credentials (`POST /v1/attestations`) whose claims beyond the ID are each shown only when a place asks, live status and status lists, incident reports, and attribution and revocation under a designated authority's legal order (`POST /v1/attributions`, `POST /v1/revocations`). Against a records service: grants and their revocation, token exchange, status lists, provenance, the activity log, and approvals.

## A stand-in, and a template

`bin/agenttown-federation.js` runs the framework's sample implementation as a team would run theirs:

```bash
node bin/agenttown-federation.js --join --town http://192.168.1.20:4400 --name "Team Blue" --address 192.168.1.30
```

Joins AgentTown Participants with a directory and a records service: admits them by their statements, starts them, accredits the records service, and prints the check at the door.

```bash
node bin/agenttown-federation.js --town http://192.168.1.20:4400 --name "Team Red" --address 192.168.1.30 --add
```

Runs a federation of its own and has the town add it, pinned to its anchor's key.

## Limits

- **One anchor at a time, per service.** The town keeps several federations, but a directory or records service still trusts only its own anchor. So an agent registered in your federation keeps its grant with your records service, and its sub-agents register at your directory; see [PROPOSED.md](PROPOSED.md) §6.
- **No intermediate authorities**, and anchor keys aren't rolled over.
- **At a LAN event: plain HTTP, one network, nothing kept** after the town stops.
- **A public town calls only public addresses.** Your services must be on the public internet, on a server of your own or behind a tunnel of your own, with https recommended: a laptop on venue Wi-Fi can't be reached from a cloud server. The town refuses an address on a private network or on its own server ("That address isn't on the public internet"), and leaves out of its view any member listed at one, checking again at every refresh. The bootstrap is at `https://town.example.org/trust-anchor.json`, and the anchor it names has a public https address of its own. `bin/agenttown-federation.js` publishes `http://<--address>:<port>`, so it suits a server with a public address; behind a tunnel, give your own services' public `endpoint_base`.
- **A public town has no front door for agents that hold their own badge** yet: an agent registered in your federation comes as a resident's agent, paired with a code.
