import type { OperatorSurfaceProfile } from "./types.js";

export function createOperatorSurfaceProfile(
  input: OperatorSurfaceProfile,
): OperatorSurfaceProfile {
  assertNoRawSecret(input);
  return input;
}

export function redactedOperatorSurface(profile: OperatorSurfaceProfile): OperatorSurfaceProfile {
  return {
    ...profile,
    identifierHint: profile.identifierHint ? redactIdentifier(profile.identifierHint) : undefined,
    secretRef: profile.secretRef ? "<secret-ref>" : undefined,
  };
}

export function summarizeOperatorSurfaces(profiles: OperatorSurfaceProfile[]): {
  total: number;
  verified: number;
  byKind: Record<string, number>;
  missingSecretRefs: string[];
} {
  const byKind: Record<string, number> = {};
  const missingSecretRefs: string[] = [];
  for (const profile of profiles) {
    byKind[profile.kind] = (byKind[profile.kind] ?? 0) + 1;
    if (
      !profile.secretRef &&
      ["gmail", "apple-id", "whatsapp", "telegram"].includes(profile.kind)
    ) {
      missingSecretRefs.push(profile.profileId);
    }
  }
  return {
    total: profiles.length,
    verified: profiles.filter((profile) => profile.verified).length,
    byKind,
    missingSecretRefs,
  };
}

function assertNoRawSecret(profile: OperatorSurfaceProfile): void {
  const values = [
    profile.profileId,
    profile.label,
    profile.identifierHint,
    profile.secretRef,
    ...(profile.notes ?? []),
  ].filter((value): value is string => typeof value === "string");
  for (const value of values) {
    if (
      /(api[_-]?key|password|bearer\s+[a-z0-9._-]+|xai-[a-z0-9._-]+|sk-[a-z0-9._-]+)/i.test(value)
    ) {
      throw new Error(`operator surface ${profile.profileId} appears to contain a raw secret`);
    }
  }
}

function redactIdentifier(identifier: string): string {
  if (identifier.includes("@")) {
    const [name, domain] = identifier.split("@");
    return `${redactMiddle(name)}@${domain}`;
  }
  const digits = identifier.replace(/\D/g, "");
  if (digits.length >= 7) {
    return `${identifier.slice(0, 3)}...${identifier.slice(-2)}`;
  }
  return redactMiddle(identifier);
}

function redactMiddle(value: string): string {
  if (value.length <= 4) {
    return "*".repeat(value.length);
  }
  return `${value.slice(0, 2)}...${value.slice(-2)}`;
}
