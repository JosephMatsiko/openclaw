/**
 * Translates networkProfile → Docker runtime args + optional iptables init.
 *
 * Profiles:
 *   "air-gap"        → --network none (default; no outbound allowed)
 *   "allow-outbound" → --network bridge + iptables rules blocking RFC1918,
 *                      link-local, loopback, and cloud-metadata endpoints
 *   "allow-list"     → --network bridge + iptables ACCEPT only listed
 *                      host:port pairs, DROP everything else
 */

export type NetworkProfile = "air-gap" | "allow-outbound" | "allow-list";

export function normalizeNetworkProfile(value: string | undefined): NetworkProfile | null {
  if (value === "air-gap" || value === "allow-outbound" || value === "allow-list") {
    return value;
  }
  return null;
}

// Ranges always blocked in allow-outbound mode (SSRF / lateral-movement sources).
const BLOCKED_OUTBOUND_CIDRS = [
  "10.0.0.0/8", // RFC1918 Class A
  "172.16.0.0/12", // RFC1918 Class B
  "192.168.0.0/16", // RFC1918 Class C
  "169.254.0.0/16", // link-local / cloud-metadata (AWS/GCP/Azure)
  "127.0.0.0/8", // loopback
  "100.64.0.0/10", // RFC6598 shared address space
  "0.0.0.0/8", // "this" network
  "240.0.0.0/4", // reserved
  "::1/128", // IPv6 loopback
  "fc00::/7", // IPv6 unique-local (ULA)
  "fe80::/10", // IPv6 link-local
];

function buildIptablesBlock(cidr: string): string {
  if (cidr.includes(":")) {
    // IPv6
    return `ip6tables -A OUTPUT -d ${cidr} -j DROP 2>/dev/null || true`;
  }
  return `iptables -A OUTPUT -d ${cidr} -j DROP`;
}

/**
 * Generate a shell setup script fragment that installs egress-blocking iptables
 * rules inside the container. Requires NET_ADMIN capability.
 */
export function buildAllowOutboundIptablesScript(): string {
  const lines = [
    "# Block private/internal CIDR ranges (installed by OpenClaw network-profile=allow-outbound)",
    ...BLOCKED_OUTBOUND_CIDRS.map(buildIptablesBlock),
  ];
  return lines.join("\n");
}

/**
 * Generate iptables rules that allow only specific host:port pairs and DROP
 * everything else. Each pattern may be "host:port" or "host:*" (any port).
 * Requires NET_ADMIN capability.
 */
export function buildAllowListIptablesScript(patterns: readonly string[]): string {
  if (patterns.length === 0) {
    return "# networkProfile=allow-list with no entries: block all outbound\niptables -A OUTPUT -j DROP\nip6tables -A OUTPUT -j DROP 2>/dev/null || true";
  }
  const lines: string[] = [
    "# Allow only listed host:port pairs (installed by OpenClaw network-profile=allow-list)",
  ];
  for (const entry of patterns) {
    const sep = entry.lastIndexOf(":");
    const host = sep > 0 ? entry.slice(0, sep).trim() : entry.trim();
    const port = sep > 0 ? entry.slice(sep + 1).trim() : "*";

    if (!host) {
      continue;
    }
    if (port === "*") {
      lines.push(`iptables -A OUTPUT -d ${host} -j ACCEPT`);
    } else {
      const portNum = Number.parseInt(port, 10);
      if (Number.isNaN(portNum)) {
        continue;
      }
      lines.push(`iptables -A OUTPUT -d ${host} -p tcp --dport ${portNum} -j ACCEPT`);
      lines.push(`iptables -A OUTPUT -d ${host} -p udp --dport ${portNum} -j ACCEPT`);
    }
  }
  // DNS must stay open for hostname resolution to work.
  lines.push("iptables -A OUTPUT -p udp --dport 53 -j ACCEPT");
  lines.push("iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT");
  lines.push("iptables -A OUTPUT -j DROP");
  return lines.join("\n");
}

export type NetworkProfileDockerArgs = {
  /** Value to pass to Docker --network (or undefined to keep existing). */
  network: string;
  /** Whether to add NET_ADMIN capability for iptables support. */
  addNetAdmin: boolean;
  /** Shell script fragment to prepend to setupCommand (empty string = nothing). */
  setupScript: string;
};

export function resolveNetworkProfileArgs(
  profile: NetworkProfile,
  allowList?: readonly string[],
): NetworkProfileDockerArgs {
  if (profile === "air-gap") {
    return { network: "none", addNetAdmin: false, setupScript: "" };
  }
  if (profile === "allow-outbound") {
    return {
      network: "bridge",
      addNetAdmin: true,
      setupScript: buildAllowOutboundIptablesScript(),
    };
  }
  return {
    network: "bridge",
    addNetAdmin: true,
    setupScript: buildAllowListIptablesScript(allowList ?? []),
  };
}
