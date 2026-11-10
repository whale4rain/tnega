/**
 * A box's network on the host: its own namespace with one veth pair, the
 * host end in 10.88.0.0/16, and an nftables table that matches the host end.
 * The rule lives outside the box, in the host kernel, so nothing a command in
 * the box does can route around it.
 */
export interface BoxNet {
  /** Network namespace name (`/var/run/netns/<name>`). */
  namespace: string
  hostLink: string
  boxLink: string
  hostAddress: string
  boxAddress: string
  /** nftables table name, one per box. */
  table: string
}

/** 16,384 boxes of four addresses each in 10.88.0.0/16. */
export const MAX_BOXES = 16_384

export function boxNet(tag: string, index: number): BoxNet {
  if (!/^[0-9a-f]{6,16}$/u.test(tag)) throw new TypeError(`box tag must be hex: ${tag}`)
  if (!Number.isInteger(index) || index < 0 || index >= MAX_BOXES) throw new RangeError(`box network index out of range: ${index}`)
  const base = index * 4
  const octet3 = base >> 8
  const octet4 = base & 255
  // Link names stay within the kernel's 15 characters.
  const short = tag.slice(0, 8)
  return {
    namespace: `tnega-${short}`,
    hostLink: `tg${short}h`,
    boxLink: `tg${short}b`,
    hostAddress: `10.88.${octet3}.${octet4 + 1}`,
    boxAddress: `10.88.${octet3}.${octet4 + 2}`,
    table: `tnega_${short}`,
  }
}

export function netnsPath(net: BoxNet): string {
  return `/var/run/netns/${net.namespace}`
}

/**
 * The box's nftables rules. `allow` lists the only destinations (IPv4
 * addresses or CIDRs) the box may open connections to, through the host
 * (`input`) or past it (`forward`); `open` allows everything. Either way the
 * box's traffic leaves masqueraded as the host.
 */
export function nftRuleset(net: BoxNet, allow: readonly string[] | 'open'): string {
  const link = JSON.stringify(net.hostLink)
  const filter = allow === 'open'
    ? []
    : [
        `    iifname ${link} ct state established,related accept`,
        ...(allow.length ? [`    iifname ${link} ip daddr { ${allow.join(', ')} } accept`] : []),
        `    iifname ${link} drop`,
      ]
  return [
    `table inet ${net.table} {`,
    `  chain input {`,
    `    type filter hook input priority -10; policy accept;`,
    ...filter,
    `  }`,
    `  chain forward {`,
    `    type filter hook forward priority -10; policy accept;`,
    ...filter,
    `  }`,
    `}`,
    `table ip ${net.table}_nat {`,
    `  chain postrouting {`,
    `    type nat hook postrouting priority 100; policy accept;`,
    `    ip saddr ${net.boxAddress} oifname != ${link} masquerade`,
    `  }`,
    `}`,
    '',
  ].join('\n')
}

/** One host command, run without a shell. */
export interface HostCommand {
  command: string
  args: string[]
  /** Written to the command's standard input. */
  input?: string
}

/** Make the namespace, the veth pair and the rules. Each step must succeed, or the box does not start. */
export function networkUp(net: BoxNet, allow: readonly string[] | 'open'): HostCommand[] {
  const ip = (...args: string[]): HostCommand => ({ command: 'ip', args })
  return [
    ip('netns', 'add', net.namespace),
    ip('link', 'add', net.hostLink, 'type', 'veth', 'peer', 'name', net.boxLink),
    ip('link', 'set', net.boxLink, 'netns', net.namespace),
    ip('addr', 'add', `${net.hostAddress}/30`, 'dev', net.hostLink),
    ip('link', 'set', net.hostLink, 'up'),
    ip('-n', net.namespace, 'addr', 'add', `${net.boxAddress}/30`, 'dev', net.boxLink),
    ip('-n', net.namespace, 'link', 'set', net.boxLink, 'up'),
    ip('-n', net.namespace, 'link', 'set', 'lo', 'up'),
    ip('-n', net.namespace, 'route', 'add', 'default', 'via', net.hostAddress),
    // The rules go in before anything can run in the box.
    { command: 'nft', args: ['-f', '-'], input: nftRuleset(net, allow) },
    { command: 'sysctl', args: ['-w', 'net.ipv4.ip_forward=1'] },
  ]
}

/** Remove what {@link networkUp} made; each step may find its part gone already. */
export function networkDown(net: BoxNet): HostCommand[] {
  return [
    { command: 'nft', args: ['delete', 'table', 'inet', net.table] },
    { command: 'nft', args: ['delete', 'table', 'ip', `${net.table}_nat`] },
    // Deleting the namespace deletes the veth pair with it.
    { command: 'ip', args: ['netns', 'delete', net.namespace] },
  ]
}
