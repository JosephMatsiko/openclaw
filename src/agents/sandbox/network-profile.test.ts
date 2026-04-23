import { describe, expect, it } from "vitest";
import {
  buildAllowListIptablesScript,
  buildAllowOutboundIptablesScript,
  normalizeNetworkProfile,
  resolveNetworkProfileArgs,
} from "./network-profile.js";

describe("normalizeNetworkProfile", () => {
  it("accepts valid profiles", () => {
    expect(normalizeNetworkProfile("air-gap")).toBe("air-gap");
    expect(normalizeNetworkProfile("allow-outbound")).toBe("allow-outbound");
    expect(normalizeNetworkProfile("allow-list")).toBe("allow-list");
  });

  it("returns null for unknown values", () => {
    expect(normalizeNetworkProfile("host")).toBeNull();
    expect(normalizeNetworkProfile("bridge")).toBeNull();
    expect(normalizeNetworkProfile(undefined)).toBeNull();
  });
});

describe("resolveNetworkProfileArgs", () => {
  it("air-gap → network=none, no NET_ADMIN, no setup script", () => {
    const result = resolveNetworkProfileArgs("air-gap");
    expect(result.network).toBe("none");
    expect(result.addNetAdmin).toBe(false);
    expect(result.setupScript).toBe("");
  });

  it("allow-outbound → network=bridge, addNetAdmin=true, iptables script present", () => {
    const result = resolveNetworkProfileArgs("allow-outbound");
    expect(result.network).toBe("bridge");
    expect(result.addNetAdmin).toBe(true);
    expect(result.setupScript).toContain("iptables");
    expect(result.setupScript).toContain("10.0.0.0/8");
    expect(result.setupScript).toContain("169.254.0.0/16");
    expect(result.setupScript).toContain("127.0.0.0/8");
  });

  it("allow-list → network=bridge, addNetAdmin=true, script allows listed hosts + drops rest", () => {
    const result = resolveNetworkProfileArgs("allow-list", ["api.github.com:443", "1.1.1.1:53"]);
    expect(result.network).toBe("bridge");
    expect(result.addNetAdmin).toBe(true);
    expect(result.setupScript).toContain("api.github.com");
    expect(result.setupScript).toContain("1.1.1.1");
    expect(result.setupScript).toContain("DROP");
  });

  it("allow-list with no entries blocks everything", () => {
    const result = resolveNetworkProfileArgs("allow-list", []);
    expect(result.setupScript).toContain("DROP");
    // Does not include any ACCEPT lines for specific hosts
    expect(result.setupScript).not.toContain("ACCEPT");
  });

  it("allow-list preserves DNS port (UDP/TCP 53)", () => {
    const result = resolveNetworkProfileArgs("allow-list", ["api.example.com:443"]);
    expect(result.setupScript).toMatch(/--dport 53.*ACCEPT/);
  });
});

describe("buildAllowOutboundIptablesScript", () => {
  it("blocks all RFC1918 ranges", () => {
    const script = buildAllowOutboundIptablesScript();
    expect(script).toContain("10.0.0.0/8");
    expect(script).toContain("172.16.0.0/12");
    expect(script).toContain("192.168.0.0/16");
  });

  it("blocks cloud metadata endpoint range", () => {
    const script = buildAllowOutboundIptablesScript();
    expect(script).toContain("169.254.0.0/16");
  });

  it("blocks IPv6 local ranges", () => {
    const script = buildAllowOutboundIptablesScript();
    expect(script).toContain("::1/128");
    expect(script).toContain("fc00::/7");
    expect(script).toContain("fe80::/10");
  });
});

describe("buildAllowListIptablesScript", () => {
  it("generates ACCEPT rule for each host:port entry", () => {
    const script = buildAllowListIptablesScript(["8.8.8.8:53", "1.1.1.1:443"]);
    expect(script).toContain("8.8.8.8");
    expect(script).toContain("1.1.1.1");
    expect(script).toContain("--dport 443");
    expect(script).toContain("--dport 53");
  });

  it("generates wildcard ACCEPT for host:* pattern", () => {
    const script = buildAllowListIptablesScript(["cdn.example.com:*"]);
    expect(script).toContain("cdn.example.com");
    // No dport for wildcard
    expect(script).not.toMatch(/cdn\.example\.com.*--dport/);
  });

  it("ends with DROP-all rule", () => {
    const script = buildAllowListIptablesScript(["8.8.8.8:53"]);
    const lines = script.split("\n");
    const lastNonEmpty = lines.findLast((l) => l.trim());
    expect(lastNonEmpty).toMatch(/DROP/);
  });

  it("empty list blocks everything except DNS", () => {
    const script = buildAllowListIptablesScript([]);
    expect(script).toContain("DROP");
  });

  it("skips invalid entries gracefully", () => {
    // Should not throw — just skip malformed entries
    expect(() => buildAllowListIptablesScript(["::", "", "host:notaport"])).not.toThrow();
  });
});
