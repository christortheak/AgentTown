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
2. **Do a dry run**: start the town as below and open it from a second device on the same network.

## On the day

1. **Start the town in LAN mode**, in one step. In the AgentTown folder, double-click **Start LAN party.command** (on a Mac) or **Start LAN party.cmd** (on Windows). Or, in a terminal there:

   ```bash
   npm run lan
   ```

   It finds the host's address on the network, makes a director key, and prints:

   ```
     AgentTown is on your network.

     Players open     http://192.168.1.20:4400
     You direct from  http://localhost:4400/?director=3f9a0c1b7e22
   ```

   Then it opens the director's view in the host's browser.
2. **Let it through the firewall.** If the host's firewall asks whether Node may accept incoming connections, allow it. If players can't reach the town, this is the first thing to check.
3. **Check from another device**: open the players' address (`http://192.168.1.20:4400` here). You should see the join screen.
4. **In the director's view** that opened, join in any role, then press **🎬**. It's at `localhost`, not the network address: that's where passkeys work (see below). Only this tab has the key, so players can't run the cues. If you close it, open the director's link again; the key is new each time the town starts.
5. **Give players the address.** The join screen on the host shows it, and so does the director's **Presenter view**, for the big screen. Or put it on a slide, or in a QR code. Tell them:
   - Pick a role and a name. Any name: others see your agent's name, never yours.
   - Each browser tab is its own player, so one person can play two roles side by side.
   - Close the tab, or let the laptop sleep, for four minutes and you leave town. Joining again starts over.
   - The **Try AgentTown** guide's step 4, *Play the day*, is a good path for a first go.

When it's over, press **Ctrl-C** in the host's terminal. The town and everything in it are gone.

### Choosing the address or the key

LAN mode takes the first address it finds on Wi-Fi or a cable, and says which other networks the host is on. To choose one of those, or a director key of your own, set them:

```bash
AGENTTOWN_ADDRESS=192.168.1.20 AGENTTOWN_DIRECTOR_KEY=apple-tree npm run lan
```

On Windows, in PowerShell:

```powershell
$env:AGENTTOWN_ADDRESS="192.168.1.20"; $env:AGENTTOWN_DIRECTOR_KEY="apple-tree"; npm run lan
```

To find an address: on a Mac, `ipconfig getifaddr en0` (Wi-Fi) or `ipconfig getifaddr en1`; on Linux, `hostname -I`; on Windows, `ipconfig`, the IPv4 Address of the network you're on. It usually changes from one network to another.

On a laptop with no browser, or over SSH, `npm run lan -- --no-open` doesn't open one. `npm start` with `AGENTTOWN_ADDRESS` set works too, as before: it opens nothing, and without `AGENTTOWN_DIRECTOR_KEY` every player can run the director's cues.

## What players can do, and passkeys

Over plain HTTP on the network, players can do almost everything: shop, start agents (registered or not), send them on errands, spawn sub-agents, play their agents and try mischief, enter errand races, take any role, use the X-ray, and connect their own AI agent.

**What they can't do is use passkeys.** Browsers allow passkeys only on `localhost` or over HTTPS. So a player on another laptop can't put a passkey on their phone or front door, can't approve a place's question on their phone, and can't sign in in person at the places that use passkeys (Copper Kettle, First Ledger Bank, the Thistle Exchange and the Compute Forge). The game tells them so when they try. In the day's list, that's step 5 (a passkey on your phone), step 7 (answering a place on your phone) and step 9 (letting your agent into your house).

**The host's own screen can do all of it**, on `localhost`. Show those steps on the big screen.

To give every player passkeys, the game has to be served over HTTPS, at one name every player's browser trusts, and the town started with `ORIGIN` set to that address:

```bash
AGENTTOWN_ADDRESS=192.168.1.20 ORIGIN=https://agenttown.example.org npm start
```

Then everyone, the host included, opens that address. AgentTown doesn't set this up for you, and we haven't tested it at an event yet. It needs either a reverse proxy on the host (Caddy or nginx) with a certificate for a name that points to the host on your network, or a tunnel service that gives the town an HTTPS address, which also puts it on the internet: then start it in public mode ([On a public server](#on-a-public-server)).

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

## On a public server

Everything above is for one network you trust. To run one town on the internet, on a small server behind a tunnel such as Cloudflare Tunnel, start it in **public mode**:

```bash
AGENTTOWN_PUBLIC=1 ORIGIN=https://town.example.org AGENTTOWN_DIRECTOR_KEY=<at least 16 characters> \
  AGENTTOWN_PARTICIPANTS_URL=https://participants.example.org npm start
```

The town listens on the server only (127.0.0.1), and the tunnel brings everyone in. It's served over HTTPS at `ORIGIN`, so every player can use passkeys. With public mode off, nothing on this page changes. With it on:

- **It won't start without a long director key**, at least 16 characters: on the internet a short word can be guessed. Open the director's view once with `?director=<key>`; the tab keeps the key and takes it out of the address bar, so it doesn't end up in history or screenshots.
- **The server calls out only to public addresses.** Adding a federation, admitting a service and checking one at the door by its address are the director's. An address on a private network, on the server itself or at the cloud's metadata service is refused: "That address isn't on the public internet." A member a federation lists at such an address is left out, and checked again at every refresh. Anyone may still check a service the town knows, by its entity id. The town's own services are the exception, each at its own address. Since a name can resolve differently a moment after it's checked, the server's service file should also block the town from private addresses other than its own 127.0.0.1.
- **Joining is limited.** Up to 100 players at once, and from one address 6 joins in 10 minutes, 4 players at once and 2 single seats (a place, a house, the judge's bench). Past a limit, the town says so and asks people to wait. That leaves room for one person playing two roles side by side, and for rejoining. People sharing an office's address may need more: see the settings in the [README](../README.md#settings).
- **Players' addresses come from the tunnel.** Every connection comes from `cloudflared` on the server, so the town reads each player's address from Cloudflare's `CF-Connecting-IP` header (`AGENTTOWN_CLIENT_IP_HEADER` for another tunnel). Wrong pairing codes and joins count against each player's own address, not everyone's at once.
- **Players the server walks about** (`headless` joins, for tests) are the director's only.
- **The residents rest** after three minutes with nobody in town, and wake when someone joins. A pause the director chose stays until the director ends it.
- **AgentTown Participants needs a name of its own** for teams to join it ([EVENT.md](EVENT.md)). Route a second name on the tunnel, one level under your domain (`participants.example.org`; Cloudflare's free certificate doesn't cover deeper names), to `http://127.0.0.1:11170` (4170 plus the port offset), with no sign-in in front, and set `AGENTTOWN_PARTICIPANTS_URL` to it. `/trust-anchor.json` hands teams that address; the town keeps calling the anchor on the server. Public mode refuses `AGENTTOWN_ADDRESS`, which would open every federation port on every interface, over plain HTTP.
- **The places' front door stays on the server**, so agents that hold their own badge can't come to a public town yet. Residents' agents, paired with a code, can. `/agents.md` tells agents so.

This page doesn't cover setting up the server or the tunnel. To try public mode for a few minutes from your own machine, a quick tunnel is enough: run `cloudflared tunnel --url http://127.0.0.1:4400`, then start the town with `AGENTTOWN_PUBLIC=1`, `ORIGIN` set to the https address it prints, and a long director key. A quick tunnel has one name, so teams can't join AgentTown Participants through it. Anyone with the address can come in, with no sign-in in front, so stop the tunnel when you're done.

## If something goes wrong

- **"LAN mode couldn't find this machine's address on a network."** Join the Wi-Fi, or plug in a cable, and start it again. Or set `AGENTTOWN_ADDRESS` ([Choosing the address or the key](#choosing-the-address-or-the-key)).
- **"Port 4400 is in use"** (or another port). A town is already running, perhaps in another window: stop it there with Ctrl-C. Or set `PORT` and `AGENTTOWN_PORT_OFFSET` to use other ports.
- **Players can't reach the town.** Check the firewall allows Node, the network doesn't keep devices apart, and the host is on the same network as the players (LAN mode lists the others it's on). From a player's laptop, `http://192.168.1.20:4400/api/info` should answer.
- **"The director key is needed for that."** Open the director's view as `…/?director=<key>`. The browser tab remembers it, and takes it out of the address bar.
- **The town is slow or stuck.** Restart it: Ctrl-C, then start it again. Everyone joins again.
- **A player's AI agent can't connect.** The pairing card gives the address the player used to open the town. Their agent's machine has to reach it too.
