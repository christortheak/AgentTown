// Where the server may go for a visitor, and where a visitor's request came from.
//
// A public town (AGENTTOWN_PUBLIC=1) fetches an outside address only if it is
// on the public internet, so nobody can have it probe the machines around it:
// the server itself, the provider's private network, the cloud's metadata
// service. The town's own services are exempt, each at exactly its own address.
// Behind a tunnel every connection comes from this machine, so a public town
// takes a player's address from the header the tunnel sets.
// At a LAN event (public mode off) none of this applies, as before; LAN mode
// (npm run lan) finds this machine's address on the network for itself.
import dns from 'node:dns';
import net from 'node:net';
import os from 'node:os';
import { HttpError } from 'aaf-reference/src/lib/http.js';

export const NOT_PUBLIC = 'That address isn\'t on the public internet.';

// Loopback, private, link-local, carrier-grade NAT, unique-local, unspecified, multicast and reserved.
const BLOCKED = new net.BlockList();
for (const [a, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16], ['224.0.0.0', 4], ['240.0.0.0', 4]]) BLOCKED.addSubnet(a, bits, 'ipv4');
for (const [a, bits] of [['::', 96], ['::ffff:0:0:0', 96], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]]) BLOCKED.addSubnet(a, bits, 'ipv6');

/** Is this IP address on the public internet? An IPv4 address written as IPv6 (::ffff:127.0.0.1) is judged as IPv4. */
export function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) return !BLOCKED.check(ip, 'ipv4');
  if (family !== 6) return false;
  let canon;
  try {
    canon = new URL(`http://[${ip}]`).hostname.slice(1, -1); // one spelling for each address
  } catch {
    return false; // a zone (fe80::1%en0) or something else no public address has
  }
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canon);
  if (mapped) {
    const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
    return isPublicIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return !BLOCKED.check(canon, 'ipv6');
}

/**
 * Throws unless the address is http or https at a host on the public internet. A name is looked up, and every
 * address it resolves to must be public. `lookup` is dns.promises.lookup's shape, so tests can stub it.
 */
export async function assertPublicAddress(url, { lookup = dns.promises.lookup } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new HttpError(400, 'bad_url', 'Give an address, like https://registry.example.org');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'bad_url', 'Only http and https addresses.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const found = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (!found.length || !found.every((a) => isPublicIp(a.address))) throw new HttpError(400, 'not_public', NOT_PUBLIC);
}

/**
 * The guard for one town. Off, everything passes, as at a LAN event. On, an address passes only if it is public,
 * or one of the town's own services: that service's exact address and, for a federation member, its entity id too.
 * (Exempting every member of the town's federations would let an outside anchor, or a team admitted to AgentTown
 * Participants, list a member at one of the town's own ports.)
 */
export function createGuard({ on = false, lookup } = {}) {
  const own = []; // { id, origin }
  const originOf = (url) => {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  };
  const isOwn = (url, id) => own.some((s) => s.origin === originOf(url) && (id === undefined || s.id === id));
  return {
    on,
    /** The town's own services, as { id, url }: exempt at exactly these addresses. */
    allow(...services) {
      for (const s of services) if (s?.url) own.push({ id: s.id, origin: originOf(s.url) });
    },
    /** Throws unless the town may fetch this address; `id` is the entity it's meant to be, for a member. */
    async check(url, { id } = {}) {
      if (!on || isOwn(url, id)) return;
      await assertPublicAddress(url, { lookup });
    },
    async allows(url, opts) {
      return this.check(url, opts).then(() => true, () => false);
    },
    /** Fetch options for an outside address: in a public town a redirect is an answer, not somewhere to go. */
    fetchOptions: on ? { redirect: 'manual' } : {},
  };
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Is this address on this machine only? Then whatever is published at it needn't listen on the network. */
export const isLoopback = (address) => LOOPBACK.has(address) || address === 'localhost' || /^127\./.test(address ?? '');

/**
 * Where a request came from. In a public town, a connection from this machine is the tunnel, and the header it
 * sets (Cloudflare's CF-Connecting-IP by default) names the visitor. Anywhere else, or without the header, the
 * socket's address: at a LAN event there is no tunnel, and anyone could write that header.
 */
export function clientAddress(req, { trustHeader = false, header = 'cf-connecting-ip' } = {}) {
  const socket = req.socket?.remoteAddress ?? 'unknown';
  if (!trustHeader || !LOOPBACK.has(socket)) return socket;
  const given = String(req.headers?.[header.toLowerCase()] ?? '').trim();
  return net.isIP(given) ? given : socket;
}

// Interfaces that aren't the network the room is on: virtual machines and containers, VPNs, Apple's own
// peer-to-peer links, Bluetooth.
const VIRTUAL = /^(lo\d*$|docker|br-|veth|virbr|vmnet|vboxnet|bridge|utun|tun\d|tap\d|wg\d|zt|tailscale|awdl|llw|anpi|ap\d|vEthernet)|virtual|vmware|hyper-v|bluetooth|loopback/i;
const HOME = new net.BlockList(); // the ranges home, office and party routers hand out
for (const [a, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16]]) HOME.addSubnet(a, bits, 'ipv4');

/**
 * This machine's address on the network the room shares, for LAN mode: IPv4, on a real interface (Wi-Fi or a
 * cable), an address a router hands out first. Returns { address, name, others } (others: the rest, best first),
 * or null when there's none. `interfaces` is os.networkInterfaces()'s shape, so tests can give their own.
 */
export function lanAddress(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, addrs] of Object.entries(interfaces ?? {})) {
    if (VIRTUAL.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.internal || net.isIP(a.address) !== 4 || isLoopback(a.address) || a.address.startsWith('169.254.')) continue;
      found.push({ address: a.address, name, home: HOME.check(a.address, 'ipv4') });
    }
  }
  found.sort((a, b) => b.home - a.home); // stable: otherwise in the system's order
  if (!found.length) return null;
  const [first, ...others] = found.map(({ address, name }) => ({ address, name }));
  return { ...first, others };
}
