// Device identity + auth-payload signing for the OpenClaw gateway handshake.
//
// Copied in shape from ui/src/ui/device-identity.ts + ui/src/local-storage.ts
// + src/gateway/device-auth.ts so this workspace can build without reaching
// across into ui/src. The storage key is intentionally the same as the
// Control UI's — we're on the same origin, so the same localStorage entry
// makes this phone session inherit whatever device-pair approval the
// Control UI already has. That's why the phone can ride the Control UI's
// granted operator.* scopes without a fresh CLI-approval step.

import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";

const STORAGE_KEY = "openclaw-device-identity-v1";

export type DeviceIdentity = {
  deviceId: string;
  publicKey: string; // base64url
  privateKey: string; // base64url
};

export type DeviceAuthEnvelope = {
  id: string;
  publicKey: string;
  signature: string;
  signedAt: number;
  nonce: string;
};

function safeLocalStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const ls = window.localStorage;
    if (ls && typeof ls.getItem === "function" && typeof ls.setItem === "function") {
      return ls;
    }
    return null;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", publicKey.slice().buffer);
  return bytesToHex(new Uint8Array(hash));
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomSecretKey();
  const publicKey = await getPublicKeyAsync(privateKey);
  const deviceId = await fingerprintPublicKey(publicKey);
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  };
}

type StoredIdentity = {
  version: 1;
  deviceId: string;
  publicKey: string;
  privateKey: string;
  createdAtMs: number;
};

function parseStored(raw: string | null): StoredIdentity | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoredIdentity>;
    if (
      parsed.version === 1 &&
      typeof parsed.deviceId === "string" &&
      typeof parsed.publicKey === "string" &&
      typeof parsed.privateKey === "string"
    ) {
      return parsed as StoredIdentity;
    }
  } catch {
    return null;
  }
  return null;
}

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  const ls = safeLocalStorage();
  const existing = parseStored(ls?.getItem(STORAGE_KEY) ?? null);
  if (existing) {
    return {
      deviceId: existing.deviceId,
      publicKey: existing.publicKey,
      privateKey: existing.privateKey,
    };
  }
  const identity = await generateIdentity();
  if (ls) {
    const payload: StoredIdentity = {
      version: 1,
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
      privateKey: identity.privateKey,
      createdAtMs: Date.now(),
    };
    try {
      ls.setItem(STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // quota or private-mode refusal — not fatal
    }
  }
  return identity;
}

// Mirror of src/gateway/device-auth.ts buildDeviceAuthPayloadV3. The
// gateway signs these exact strings so bit-for-bit parity matters.
export type BuildAuthV3Params = {
  deviceId: string;
  clientId: string;
  clientMode: string;
  role: string;
  scopes: string[];
  signedAtMs: number;
  token?: string | null;
  nonce: string;
  platform?: string | null;
  deviceFamily?: string | null;
};

function normalizeDeviceMetadataForAuth(input?: string | null): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.trim().toLowerCase();
}

export function buildDeviceAuthPayloadV3(params: BuildAuthV3Params): string {
  const scopes = params.scopes.join(",");
  const token = params.token ?? "";
  const platform = normalizeDeviceMetadataForAuth(params.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(params.deviceFamily);
  return [
    "v3",
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
    params.nonce,
    platform,
    deviceFamily,
  ].join("|");
}

// Sign the connect device-auth payload with the identity's ed25519 private
// key. The gateway verifies by fingerprinting the declared publicKey to
// deviceId, then verifying the ed25519 signature over the payload string.
export async function signDeviceAuth(
  identity: DeviceIdentity,
  params: Omit<BuildAuthV3Params, "deviceId">,
): Promise<DeviceAuthEnvelope> {
  const full: BuildAuthV3Params = { ...params, deviceId: identity.deviceId };
  const payload = buildDeviceAuthPayloadV3(full);
  const privKey = base64UrlDecode(identity.privateKey);
  const message = new TextEncoder().encode(payload);
  const sig = await signAsync(message, privKey);
  return {
    id: identity.deviceId,
    publicKey: identity.publicKey,
    signature: base64UrlEncode(sig),
    signedAt: params.signedAtMs,
    nonce: params.nonce,
  };
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}
