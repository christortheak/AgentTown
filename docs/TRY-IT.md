# Try AgentTown on your own computer

About half an hour, start to finish. You play a resident of a small town: you shop in person, start an agent, decide what it may do, and watch every shop, bank and door check who answers for it.

## What you need

- **Node.js 22 or later.** Check with `node --version`. If it's missing or older, install the current LTS from [nodejs.org](https://nodejs.org).
- **git.**
- **Access to [christortheak/AgentTown](https://github.com/christortheak/AgentTown)** on GitHub, which is private for now. Ask for access if you don't have it. The framework's [sample implementation](https://github.com/christortheak/accountable-agents-sample-implementation) is public, and `npm install` fetches it for you.
- **A current browser**: Chrome, Edge, Safari or Firefox.

## 1. Get the code

AgentTown runs on the framework's sample implementation. `npm install` fetches it from GitHub, at the commit AgentTown names, so there's nothing else to clone.

```bash
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
2. Pick **A resident**, type a name and press **Join the town**. Any name will do, as long as no other resident is using it: a directory keeps one record per verified identity, and in this town your name is your identity. Only the town's directory keeps it; other players never see it.
3. Read the welcome and press **Let's go**.

How it works:
- **Walk** with WASD or the arrow keys, or click where you want to go. Click a building to walk to it and talk to it.
- **Look around** by dragging the town, or the map at the top right (two fingers on a trackpad work too, and a pinch zooms). **F**, or **Back to you**, brings the camera back.
- **Q** opens the **action deck**: what you can do now, what you can do where you stand first. Pick something elsewhere and you walk there first.
- The **You** panel (right) shows who you are and holds your settings. Your **phone** (bottom right) shows up once you have an agent: it's where places ask for your OK.
- Panels start folded. Click a heading with a **›** to open it; it stays open next time.
- The town explains the framework in the paper's words: Town Hall is a **directory**, your agent's badge is its **presentation**, and the number on it is an **ID**. **Actions → The framework's words** lists them all.

## 4. Play the day

The panel at the top left shows your next step; click its heading for the whole day. Do it in order; the deck pins the next step at the top.

1. **Buy something yourself, in person.** Walk to Oakleaf Bakery and buy something. No agent yet: the bakery takes you at your word.
2. **Get verified at Town Hall.** The slow step, done once. The directory learns your name; places don't.
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

- **X** turns on the **X-ray**: watch each request travel between your agent, its directory, the Records Office and the place.
- **Play your agent.** **T**, or **Playing** in the dock, switches who you play: you, your agent, or a sub-agent. Playing your agent, you can try **mischief** (a forged badge, a replayed one) and see who catches it.
- **Badge off.** **B** takes your agent's badge off. Places that take people at their word will take it for a person. Which ones notice?
- **An agent nobody registered.** Actions → **Start another agent** → **Don't register it**. Most agents today are like this. See where it gets served, and where it doesn't.
- **Stop everything** (in the dock) is your kill switch. See what it can reach and what it can't.
- **🎬, the director.** Unleash a rogue swarm or ticket bots at the ferry, take a directory offline, or change the town's laws, and watch what places ask for.
- **Cross the river.** The Harbor, over any bridge, runs on EU rules. Badges work the same there; the law doesn't. Read it on the notice board on the quay, then compare the one in Town Square. In the Harbor, an agent must make clear it's an agent: try your agent with its badge in its pocket at Brine & Barrel.
- **Take a badge to court.** After a night at home, bring one of your visitors' badges. A badge you only checked won't do: the court needs harm on record.
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
- **`npm install` says fetching packages from git is disabled.** You're running it outside the `AgentTown` folder, or from a copy without its `.npmrc`. That file lets npm 12 and later install the framework from GitHub. Run `npm install` inside `AgentTown`. If you ran AgentTown before and pulled a newer version, run `npm ci` instead: npm won't reliably swap the framework for a newer commit in place, and `npm ci` installs everything afresh, exactly as `package-lock.json` says.
- **"Passkeys need a secure origin."** You opened `127.0.0.1` or another address. Use `http://localhost:4400`.
- **The page asks you to join again.** The town forgets a player whose tab has been closed (or asleep) for four minutes, and restarting the town forgets everyone. Join again.
