# Try AgentTown on your own computer

About half an hour, start to finish. You play a resident of a small town: you shop in person, start an agent, decide what it may do, and watch every shop, bank and door check who answers for it.

## What you need

- **Node.js 22 or later.** Check with `node --version`. If it's missing or older, install the current LTS from [nodejs.org](https://nodejs.org).
- **git.**
- **Access to two GitHub repositories**, both private for now: [christortheak/AgentTown](https://github.com/christortheak/AgentTown) and [christortheak/accountable-agents-framework](https://github.com/christortheak/accountable-agents-framework). Ask for access if you don't have it.
- **A current browser**: Chrome, Edge, Safari or Firefox.

## 1. Get the code

AgentTown uses the framework's reference implementation, which has to sit in a folder called `aaf-reference` right next to the `AgentTown` folder.

```bash
mkdir agenttown && cd agenttown
git clone https://github.com/christortheak/accountable-agents-framework.git aaf-reference
git clone https://github.com/christortheak/AgentTown.git
cd AgentTown
npm install
```

## 2. Start the town

```bash
npm start
```

It's ready when it prints `AgentTown is open at http://localhost:4400`. Leave that terminal open: the town runs as long as it does. **Ctrl-C** stops it, and nothing is kept: each start is a fresh town.

## 3. Open it and join

1. Open **http://localhost:4400**. Use `localhost`, not `127.0.0.1`: passkeys only work at the address they were made for.
2. Pick **A resident**, type a name and press **Join the town**. Any name will do. Only the town's registry keeps it; other players never see it.
3. Read the welcome and press **Let's go**.

How it works:
- **Walk** with WASD or the arrow keys, or click where you want to go. Click a building to walk to it and talk to it.
- **Q** opens the **action deck**: what you can do now, what you can do where you stand first. Pick something elsewhere and you walk there first.
- The **You** panel (right) shows who you are and holds your settings. Your **phone** (bottom right) is where places ask for your OK.
- Panels with a **›** fold and unfold when you click their heading.

## 4. Play the day

The list at the top left is your day. Do it in order; the deck pins the next step at the top.

1. **Buy something yourself, in person.** Walk to Oakleaf Bakery and buy something. No agent yet: the bakery takes you at your word.
2. **Get verified at Town Hall.** The slow step, done once. The registry learns your name; places don't.
3. **Start an agent and register it.** Actions → **Start an agent** → **Register it at Town Hall**, name it (Pip, say), and pick its software. It appears beside you and stays where you leave it.
4. **Set your record at the Records Office.** Say what your agent may spend, and what places may learn about you.
5. **Put a passkey on your phone.** In the phone panel. You'll approve things with it. (See [About passkeys](#about-passkeys) first if you'd rather not save a real one.)
6. **Send your agent to buy something.** Actions → **Ask Pip to…** → **Run an errand**. Pip walks there on its own; you carry on.
7. **Send your agent for the sleeping draught (18+): answer on your phone.** Ask Pip to run an errand, and pick the sleeping draught at Willow Apothecary. The apothecary asks for proof Pip's owner is over 18. Your record doesn't say to share that, so your phone asks you: share once, always, or not at all. (Buy it in person and nobody asks: the apothecary takes people at their word.)
8. **Have your agent spawn a sub-agent and send it on an errand.** Ask Pip to spawn one, give it a budget, and send it off.
9. **Let your agent into your house.** Put a passkey on your front door, then ask Pip to go in. The lock asks you on your phone.
10. **Rest at home until night.**

Each result card leads with what happened and why, in plain words, and suggests a next step. **Compare** shows what an API key, Web Bot Auth, World ID or x402 would have told the same place; the technical record is underneath.

## 5. Then try these

The **Try this** list under your day has more. Some favorites:

- **X** turns on the **X-ray**: watch each request travel between your agent, its registry, the Records Office and the place.
- **Play your agent.** **T**, or **Playing** in the dock, switches who you play: you, your agent, or a sub-agent. Playing your agent, you can try **mischief** (a forged badge, a replayed one) and see who catches it.
- **Badge off.** **B** takes your agent's badge off. Places that take people at their word will take it for a person. Which ones notice?
- **An agent nobody registered.** Actions → **Start another agent** → **Don't register it**. Most agents today are like this. See where it gets served, and where it doesn't.
- **Stop everything** (in the dock) is your kill switch. See what it can reach and what it can't.
- **🎬, the director.** Unleash a rogue swarm, take a registry offline, or change the town's laws, and watch what places ask for.
- **Another role.** Each browser tab is its own player. Open a second tab as a shopkeeper and choose what your shop asks for, then shop there from the first.

## 6. Connect your own AI agent (optional)

Claude, Codex, or any agent that speaks MCP or can run a command can play as your agent while you stay its principal in the browser.

1. In the **You** panel, press **Connect Claude, Codex…** beside your agent. You get a pairing code and instructions.
2. With Claude Code, run the command the card shows:
   ```bash
   claude mcp add --transport http agenttown "http://localhost:4400/mcp?code=ABC-123"
   ```
   Then start Claude Code and say: *Play AgentTown as my agent. Read http://localhost:4400/agents.md first.*
3. Give it a **Brief** (beside your agent in the You panel): what you'd like it to do.

It walks the town, shops and answers places. Anything that needs your OK still comes to your phone in the browser; it can't approve anything itself. **Disconnect** cuts it off at once.

## About passkeys

AgentTown uses real passkeys (Touch ID, Face ID, Windows Hello or a security key) for your phone, your front door and the places you sign in to. Your browser or password manager saves each one for `localhost`. They do nothing outside the town, and you can delete them afterwards (look for `localhost` in your passwords).

To try it without saving any, use Chrome's virtual authenticator: open DevTools, then **⋮ → More tools → WebAuthn**, tick **Enable virtual authenticator environment**, and **Add** an authenticator. Chrome then makes passkeys that vanish when you close DevTools.

## If something goes wrong

- **`npm start` says the address is already in use.** Another town (or something else) is using the ports. Stop it, or start this one elsewhere: `PORT=4500 AGENTTOWN_PORT_OFFSET=8000 npm start`, then open http://localhost:4500.
- **It can't find `aaf-reference`.** The two folders have to sit side by side, and the framework's folder has to be named `aaf-reference`.
- **"Passkeys need a secure origin."** You opened `127.0.0.1` or another address. Use `http://localhost:4400`.
- **The page asks you to join again.** The town forgets a player whose tab has been closed (or asleep) for four minutes, and restarting the town forgets everyone. Join again.
