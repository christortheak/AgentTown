# Proposed extensions, prototyped in AgentTown

Status: a prototype for discussion. Nothing here is part of the Reference Profile or of `aaf-reference`; it lives in `src/proposed/` and is wired into the game so it can be tried. If it holds up, it would be proposed as a change to the profile and the reference implementation.

The framework's central claim is that a counterparty can ask for information and the other side can decide whether to provide it, reliably. AgentTown prototypes four things that make that loop richer, and one that makes its limits visible.

## 1. The principal's record

The framework's grant says what an agent may do in one request (RFC 9396 `authorization_details`). Principals also want rules that no single request can carry, and the paper says the authorization record may hold purpose and "sector-specific data". The prototype gives each principal an extensible **record**, kept by the authorization record keeper:

| Part | Holds |
|---|---|
| `spending` | limit per purchase, total per day, purchases per day, kinds of purchase, and the amount above which the principal approves each purchase with a passkey |
| `sharing` | for each thing a place may ask about (name, proof of age, bill of materials, World ID, facts on file): the places that always get it, and otherwise "ask me" or "never" |
| `facts` | anything else the principal wants on file, e.g. a loyalty card number |
| `agents` | the key thumbprints of agents that may ask on the principal's behalf |

The record is a JWS signed by the principal (`typ: aaf-principal-record+jwt`). Every version is appended to the record keeper's Merkle log, so a principal, or a court, can see what was allowed and when. The per-purchase limit and kinds also go into the ordinary grant, which places check for themselves through the framework.

## 2. Allowances: limits no single place can enforce

Totals and counts span many places, and pairwise badge numbers stop places from pooling what they see, so no place can enforce them. The record keeper can. Before spending, an honest agent asks it for an **allowance** for one exact request (signed with the agent's long-term key, which the record lists). The keeper checks the record and logs the attempt in the principal's **register**, allowed or not. If the purchase is within the record, the keeper returns a JWS (`typ: aaf-allowance+jwt`) that:

- is made out to one place (`aud`) and one request (`params_digest`), and is single-use (`jti`) and short-lived;
- says `covered: true`, and `approved_by_principal` when the principal approved it by passkey;
- **never states the remaining balance**. "$173.50 left", seen at two places, would link them; the profile already rounds dates for the same reason.

A place may ask to see the allowance (in town, First Ledger Bank does). Places that don't ask still benefit, because an honest agent won't go ahead without one. If a place refuses or asks for more, the agent hands the allowance back and it no longer counts.

**Cost.** The record keeper learns which places and how much. That is within its role (it holds what is "too sensitive" for the registry), but it raises the stakes on its access rules (profile K4).

**Not yet done.** The allowance is bound to the request, not to the key the agent presents with, so another agent could spend it on the same purchase at the same place within two minutes. A profile version should bind it to the presentation key (`cnf`). Places should also verify the keeper through the federation (trust marks), not a configured key.

## 3. Statements of facts

A place may ask for facts that no verifier vouches for (a loyalty card, a dietary need). The record keeper signs a **statement** of the facts on file (`typ: aaf-statement+jwt`), made out to one place, with `source: principal, verified: false`. The place learns the fact and knows it is the principal's own word, attributable and tamper-evident, but not verified. The paper requires that claims "identify their source, scope, verification status, and currentness".

## 4. Asking and answering

A place asks in one neutral form. The framework's credential claims go in DCQL shape (OpenID4VP's query language), and the proposed items (allowance, statements) sit beside them:

```json
{ "want": [{ "kind": "identity" }, { "kind": "attribute", "name": "age_over_18" }, { "kind": "allowance" }, { "kind": "statement", "name": "loyalty_card" }],
  "dcql": { "credentials": [{ "id": "accountability", "format": "dc+sd-jwt", "claims": [{ "path": ["accountability", "root_principal", "disclosed_identity", "legal_name"] }] }] } }
```

The agent's software answers each item from the principal's record, with one of four answers:

| Answer | Meaning |
|---|---|
| **yes** | the record allows it for this place |
| **ask** | the record says to ask the principal, who approves on their phone with a passkey, once or always |
| **won't** | the record says never; the agent walks away and the place learns nothing more |
| **can't** | this software doesn't support that kind of question, or there is nothing on file |

"Can't" is kept apart from "won't" for the same reason the profile keeps `UNLABELED` apart from "rogue": an implementation that can't answer is not refusing. In town, Tinybot 0.9 can show only a badge, a permission and a name, so it shows "can't" for everything else. This seam is also where other implementations would plug in at an interop event: each translates the neutral ask into its own calls.

**Consent.** "Share once" and "always share" both need the principal's passkey; "decline" does not. "Always" adds the place to the record's list. The registry's own disclosure policy follows the record. In a profile version, the registry should check the principal's signature on the record itself rather than trust a copy, so that a compromised record keeper cannot release identities (the paper: a compromised record keeper must leave the registry intact).

## 5. People, and agents posing as people

The framework labels agents. It cannot prove that no agent is involved. A request with no badge is a person, or an agent that isn't saying. AgentTown gives each place a rule for requests with no badge, and shows what each can establish:

| Rule | What it establishes | What gets through |
|---|---|---|
| Take them at their word | nothing | any agent that hides its badge |
| "Seems human?" check | a guess | some agents; and it turns away some people |
| Sign in with a passkey (the profile's human path) | the account holder approved this exact request | nothing without the passkey |
| World ID (simulated) | a unique human made the proof | an agent carrying its human's proof, which is consent rather than spoofing |
| Agents only | nothing about people | nobody without a badge |

The game knows who was really a person and who wasn't, and counts agents taken for people. The places never know this; only the narrator does. Laws in town govern what places ask of agents. A law that made places check people too would have to require one of the rules above.

## Open questions

- Should cumulative limits live with the record keeper (enforceable, sees spending), with the agent (private, unverifiable), or be checked after the fact from activity logs (auditable, not a hard limit)?
- What is the right freshness for allowances, and should they be bound to the presentation key?
- Should "ask me" approvals be countersigned by the record keeper (as approvals are today) or verified by the registry directly?
- Which facts, if any, should a record keeper refuse to state?
- How should a place say a question is optional ("a loyalty card, if you have one")?
