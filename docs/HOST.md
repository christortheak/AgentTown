# Run AgentTown at a LAN event

For whoever hosts. One laptop runs the whole town; everyone else plays in a browser on their own laptop, on the same network. Nothing is installed on players' machines, and nothing is kept after the town stops.

## What you need

- **A host laptop** with Node.js 22 or later, git, and access to the two GitHub repositories (both private for now). Keep it plugged in, and stop it sleeping.
- **A network where devices can reach each other.** Conference and guest Wi-Fi often keeps devices apart ("client isolation"), and then nobody can reach the town. Check at the venue, or bring your own router.
- **A big screen** for the host, if you can: the director's presenter view shows the town to the room.
- **Players** need only a laptop with a current browser. Phones and tablets can open the town, but it's made for a keyboard and mouse.
- **Players who want to bring their own AI agent** need Claude Code, Codex or another MCP client on their laptop. Nothing from AgentTown.

## Before the day

1. **Set up the host laptop** as in [Try AgentTown on your own computer](TRY-IT.md), steps 1 and 2, and play a few minutes on it to check it works.
2. **Find the host's address on the network**:
   - macOS: `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1`
   - Linux: `hostname -I`
   - Windows: `ipconfig`, the IPv4 Address of the network you're on

   It usually changes from one network to another, so look again at the venue.
3. **Pick a director key**, any word or phrase. With one, only someone who has it can run the director's cues and add federations. Without one, every player can.
4. **Do a dry run**: start the town as below and open it from a second device on the same network.

## On the day

1. **Start the town** with the host's address and your director key:

   ```bash
   AGENTTOWN_ADDRESS=192.168.1.20 AGENTTOWN_DIRECTOR_KEY=apple-tree npm start
   ```

   On Windows, in PowerShell:

   ```powershell
   $env:AGENTTOWN_ADDRESS="192.168.1.20"; $env:AGENTTOWN_DIRECTOR_KEY="apple-tree"; npm start
   ```

   It prints, among other things:

   ```
   AgentTown is open at http://localhost:4400
   Players on other machines open http://192.168.1.20:4400
   Director: locked (AGENTTOWN_DIRECTOR_KEY). …
   ```

2. **Let it through the firewall.** If the host's firewall asks whether Node may accept incoming connections, allow it. If players can't reach the town, this is the first thing to check.
3. **Check from another device**: open `http://192.168.1.20:4400`. You should see the join screen.
4. **Open the director's view on the host**: `http://localhost:4400/?director=apple-tree`. Join in any role, then press **🎬**. On the host, use `localhost`, not the network address: that's where passkeys work (see below).
5. **Give players the address**, on a slide or as a QR code: `http://192.168.1.20:4400`. Tell them:
   - Pick a role and a name. Any name: others see your agent's name, never yours.
   - Each browser tab is its own player, so one person can play two roles side by side.
   - Close the tab, or let the laptop sleep, for four minutes and you leave town. Joining again starts over.
   - The **Try AgentTown** guide's step 4, *Play the day*, is a good path for a first go.

When it's over, press **Ctrl-C** in the host's terminal. The town and everything in it are gone.

## What players can do, and passkeys

Over plain HTTP on the network, players can do almost everything: shop, start agents (registered or not), send them on errands, spawn sub-agents, play their agents and try mischief, enter errand races, take any role, use the X-ray, and connect their own AI agent.

**What they can't do is use passkeys.** Browsers allow passkeys only on `localhost` or over HTTPS. So a player on another laptop can't put a passkey on their phone or front door, can't approve a place's question on their phone, and can't sign in in person at the places that use passkeys (Copper Kettle, First Ledger Bank, the Thistle Exchange and the Compute Forge). The game tells them so when they try. In the day's list, that's step 5 (a passkey on your phone), step 7 (answering a place on your phone) and step 9 (letting your agent into your house).

**The host's own screen can do all of it**, on `localhost`. Show those steps on the big screen.

To give every player passkeys, the game has to be served over HTTPS, at one name every player's browser trusts, and the town started with `ORIGIN` set to that address:

```bash
AGENTTOWN_ADDRESS=192.168.1.20 ORIGIN=https://agenttown.example.org npm start
```

Then everyone, the host included, opens that address. AgentTown doesn't set this up for you, and we haven't tested it at an event yet. It needs either a reverse proxy on the host (Caddy or nginx) with a certificate for a name that points to the host on your network, or a tunnel service that gives the town an HTTPS address, which also puts it on the internet.

## Running the session

A suggestion, for about an hour:

1. **Five minutes, on the big screen.** Join as a resident on the host and play the first few steps of the day: buy something in person, get verified, start an agent and register it, put a passkey on your phone.
2. **Half an hour of play.** Everyone plays the day's list. Ask a few people to take roles: a **shopkeeper** decides what their place asks for and sees what each customer proves; the **police** and **the judge** take cases to court; the **town council** makes laws.
3. **Ten minutes of cues**, from the director (🎬):
   - **Rogue swarm from the Old Mill**: who stops it, and who doesn't?
   - **Registry A outage (45 s)**: places defer instead of refusing.
   - **The law**: switch a law on, and watch what places must ask for change, while the registries stay as they are.
   - **Each place**: change what a place accepts, live.
   - **Presenter view** for the big screen.
4. **Errand races**, on the notice board in the square: players' agents against each other, within each player's record. Players who connected Claude or Codex can enter theirs.
5. **Ten minutes to talk it over.** The town ledger (bottom left) and each result card's **Compare** fold are good places to start.

## Teams bringing their own registry or record keeper

If a team has built a registry, a record keeper or a whole federation, they can bring it: see [Bring your implementation to AgentTown](EVENT.md). It also says what the host has to do: share the trust anchor's key thumbprint (the startup log prints it), and admit services in the **Hall of Registries**, or let the teams do it themselves.

## If something goes wrong

- **Players can't reach the town.** Check the host's address hasn't changed, the firewall allows Node, and the network doesn't keep devices apart. From a player's laptop, `http://192.168.1.20:4400/api/info` should answer.
- **"The director key is needed for that."** Open the director's view as `…/?director=<key>`. The browser tab remembers it.
- **The town is slow or stuck.** Restart it: Ctrl-C, then start it again. Everyone joins again.
- **A player's AI agent can't connect.** The pairing card gives the address the player used to open the town. Their agent's machine has to reach it too.
