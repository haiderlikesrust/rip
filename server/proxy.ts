import { BlockList, isIP } from 'node:net';

const internal = new BlockList();
internal.addSubnet('10.0.0.0', 8, 'ipv4');
internal.addSubnet('172.16.0.0', 12, 'ipv4');
internal.addSubnet('192.168.0.0', 16, 'ipv4');
internal.addSubnet('fc00::', 7, 'ipv6');

// Only bounded, private Docker peers can forward client identity. Public direct
// requests cannot gain trust by manufacturing a long X-Forwarded-For chain.
export function trustInternalProxies(hops: number) {
  if (!hops) return false;
  return (address: string, hop: number) => {
    const family = isIP(address);
    return hop < hops && family !== 0 && internal.check(address, family === 6 ? 'ipv6' : 'ipv4');
  };
}
