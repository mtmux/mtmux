import os from "node:os";

export type LanAddress = {
  /** IPv4 dotted-quad, e.g. "192.168.1.5". */
  address: string;
  /** Interface it was found on, e.g. "wlp3s0". Shown in the banner. */
  iface: string;
};

/**
 * Interfaces that are up and have an IPv4 address but are never the address a
 * phone on the couch should be told to dial. Container bridges and VM host-only
 * networks are unreachable from the rest of the LAN; overlay VPNs (Tailscale,
 * ZeroTier, WireGuard) are reachable but only from inside the overlay, so
 * advertising them as "on your network" is misleading.
 */
const VIRTUAL_IFACE =
  /^(docker|br-|veth|virbr|vmnet|vboxnet|tun|tap|utun|ham|zt|tailscale|wg|lxcbr|cni|flannel|kube)/i;

/**
 * Preference order for private IPv4 ranges. Lower sorts first.
 *
 * 192.168/16 is the overwhelmingly common home-router range, so it wins. 10/8
 * and 172.16/12 are typically corporate or container networks. 169.254/16 is
 * link-local — it means DHCP failed, so it is a genuine last resort rather than
 * a normal answer. Anything else (public, CGNAT, loopback) returns null and is
 * dropped: a public address is not "your network", and printing it would
 * advertise the box to the internet.
 */
function rankOf(address: string): number | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((p) => Number(p));
  if (
    octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255) ||
    parts.some((p) => p === "" || !/^\d+$/.test(p))
  ) {
    return null;
  }
  const [a, b] = octets as [number, number, number, number];
  if (a === 192 && b === 168) return 0;
  if (a === 10) return 1;
  if (a === 172 && b >= 16 && b <= 31) return 2;
  if (a === 169 && b === 254) return 3;
  return null;
}

/**
 * Every IPv4 address on this machine that another device on the same network
 * could plausibly reach, best first.
 *
 * The interface table is injectable so the ranking rules can be tested against
 * fixtures instead of whatever hardware the test happens to run on.
 */
export function getLanAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): LanAddress[] {
  const found: (LanAddress & { rank: number })[] = [];

  for (const [iface, infos] of Object.entries(interfaces)) {
    if (!infos || VIRTUAL_IFACE.test(iface)) continue;
    for (const info of infos) {
      // Node <18.4 reported `family` as the number 4; newer versions use "IPv4".
      const isIpv4 = info.family === "IPv4" || (info.family as unknown) === 4;
      if (!isIpv4 || info.internal) continue;
      const rank = rankOf(info.address);
      if (rank === null) continue;
      found.push({ address: info.address, iface, rank });
    }
  }

  found.sort((x, y) => x.rank - y.rank || x.iface.localeCompare(y.iface));
  return found.map(({ address, iface }) => ({ address, iface }));
}

/** The single address to print and bind for, or null if there is no LAN. */
export function primaryLanAddress(
  interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): LanAddress | null {
  return getLanAddresses(interfaces)[0] ?? null;
}
