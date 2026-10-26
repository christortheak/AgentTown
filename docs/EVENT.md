# Bring your implementation to AgentTown

For teams who have built a registry, a record keeper, or a whole federation for the Accountable Agents framework, and want to see residents' agents use it in town. Everything here is a prototype for a local event: plain HTTP on one network, nothing kept after the town stops.

There are two ways in:

| You bring | It joins | You need |
|---|---|---|
| A registry, a record keeper, or both | **AgentTown Participants**, a federation the town runs and admits members to while it runs | the town's trust-anchor bootstrap |
| A whole federation: a trust anchor and its members | the town's list of federations, by your anchor's address | the town's identity verifier and court, as members of your federation |

Either way, **no place trusts you until it chooses to.** Shopkeepers tick federations in their panel; the director can make every place trust one. That is the point: anyone can run a registry, and each relying party decides whose badges it accepts.

## For the host

Run the town as in [Run AgentTown at a LAN event](HOST.md), with `AGENTTOWN_ADDRESS` set so the town's federations listen on the network and publish that address. Then:

- **Share the trust anchor's key thumbprint.** The startup log prints AgentTown Participants' trust anchor and its thumbprint: read it out, or put it on a slide, so teams can check it.
- **Decide who admits services.** With `AGENTTOWN_DIRECTOR_KEY` set, only the director can add federations or admit services (open the town with `?director=<key>`). Without it, anyone in town can.
- **Have something to add while teams get ready.** The director's **Start a sample outside federation** runs Riverside Co-op.

## Joining AgentTown Participants

1. **Get the bootstrap.** `GET http://<town>:4400/trust-anchor.json` returns `{ name, entity_id, url, jwks, thumbprint }`, the same shape as aaf-reference's `trust-anchor.json`. Check the thumbprint with the host. Configure your services with it: it's your trust anchor.
2. **Describe yourself.** Serve a self-signed Entity Configuration at `/.well-known/openid-federation` (OpenID Federation 1.0, Reference Profile §6):
   - metadata `aaf_registry` or `aaf_record_keeper`, with `organization_name`, `endpoint_base` (where you're served), and `jwks` (a signing key; a registry also needs an encryption key). A record keeper lists its `roles`: `authorization`, `provenance`, `activity`;
   - `authority_hints: ["https://participants.agenttown.test"]`.
3. **Get admitted.** In the town: Hall of Registries → **Admit a registry or record keeper**, and give your address. If your service can't start until it's a member (the reference one can't), paste its entity statement instead: `{ "entity_id", "entity_type", "jwks", "metadata" }`. Or `POST /api/participants` with `{ "url" }` or `{ "statement" }`.
4. **Accredit your record keeper.** In AgentTown Participants, any admitted registry may accredit record keepers. Your registry issues one trust mark per role, of type `https://participants.agenttown.test/trust-marks/record-keeper/<role>`, serves it at `GET /federation/trust-mark?trust_mark_type=…&sub=…`, and your record keeper publishes it in its Entity Configuration.
5. **Accept the town's identity verifier.** AgentTown Participants lists the town's verifier (VerityCheck) and court. Accept verifications they sign (`POST /v1/principals/{id}/verification`, `keyid="verifier:<entity>"`), and residents can register agents at your counter.

Credential and trust-mark types are named under this federation's anchor (`https://participants.agenttown.test/vct/accountability/1`, and so on), as the profile requires.

## Bringing a whole federation

1. Run your trust anchor and members. List the town's identity verifier and court as members of your federation: `GET http://<town>:4400/api/authorities` gives them as member entries, public keys and all.
2. In the town: Hall of Registries → **Add a federation by address**, and give your anchor's address and its key thumbprint (`http://192.168.1.30:4600 <thumbprint>`). Or `POST /api/federations` with `{ "url", "pin" }`.
3. An agent registered in your federation then visits town, and residents can register at your registry's counter.

## The check at the door

When a service is admitted by its address, and whenever someone presses **Check** beside it in the halls (or `POST /api/participants/check` with `{ "entity_id" }` or `{ "url" }`), the town probes what it must answer, without changing anything:

| Every service | A registry | A record keeper |
|---|---|---|
| answers at its address | has a signing key and an encryption key | says which records it keeps |
| describes itself, self-signed | answers live status (`POST /v1/status`) | is accredited by a registry the town knows (trust marks) |
| says what it is | keeps a transparency log (`GET /v1/transparency/sth`) | keeps a tamper-evident log (`GET /v1/log/sth`) |
| names a trust anchor the town knows | accredits record keepers (`GET /v1/accreditations`) | answers token exchange (`POST /token`), if it keeps grants |
| says where it is served | | |
| publishes a status list (`GET /status-lists/1`) | | |

Each check passes, fails, or isn't done yet (an accreditation still to come).

## What the town will call

Residents, their agents and the places use the Reference Profile's API (Appendix A). Against a registry: enrollment, verification and attributes, disclosure policy, notifications, registrations and revocation, accountability credentials (`POST /v1/attestations`), live status and status lists, incident reports, and court-ordered resolution. Against a record keeper: grants and their revocation, token exchange, status lists, provenance, the activity log, and approvals.

## A stand-in, and a template

`bin/agenttown-federation.js` runs the reference implementation as a team would run theirs:

```bash
node bin/agenttown-federation.js --join --town http://192.168.1.20:4400 --name "Team Blue" --address 192.168.1.30
```

Joins AgentTown Participants with a registry and a record keeper: admits them by their statements, starts them, accredits the record keeper, and prints the check at the door.

```bash
node bin/agenttown-federation.js --town http://192.168.1.20:4400 --name "Team Red" --address 192.168.1.30 --add
```

Runs a federation of its own and has the town add it, pinned to its anchor's key.

## Limits

- **One anchor at a time, per service.** The town keeps several federations, but a registry or record keeper still trusts only its own anchor. So an agent registered in your federation keeps its grant with your record keeper, and its sub-agents register at your registry; see [PROPOSED.md](PROPOSED.md) §6.
- **No intermediate authorities**, and anchor keys aren't rolled over.
- **Plain HTTP, one network, nothing kept** after the town stops. Not for a public server.
