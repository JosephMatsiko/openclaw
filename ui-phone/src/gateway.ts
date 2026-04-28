// Lightweight WebSocket client for the OpenClaw gateway.
//
// Speaks the same frame protocol as the Control UI (ui/src/ui/gateway.ts)
// but strips the retry-with-fresh-key loops, error taxonomy, reconnect
// throttling — just the minimum the phone needs. We DO sign the connect
// payload with an ed25519 device identity because the gateway won't grant
// operator.* scopes to a token-only device.
//
// Auth flow:
// 1. Token from URL query (?token=...), URL hash (#token=...), or localStorage.
// 2. Load/generate an ed25519 device identity (shared localStorage with the
//    Control UI on the same origin — inherits its paired approval).
// 3. First frame: `req` with method="connect", carrying the client info,
//    requested role+scopes, token, and a signed device envelope.
// 4. On pair-required error the server hands back a requestId — surface it
//    so the user can run `openclaw devices approve <requestId>` on the Mac.

import { loadOrCreateDeviceIdentity, signDeviceAuth } from "./device-identity.ts";

const TOKEN_LS_KEY = "openclaw.phone.token.v1";
const BASE_URL_LS_KEY = "openclaw.phone.baseUrl.v1";

const PHONE_CLIENT_ID = "webchat-ui";
const PHONE_CLIENT_MODE = "webchat";
const PHONE_ROLE = "operator";
const PHONE_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
] as const;

export type GatewayEvent = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewayResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string; details?: unknown };
};

export type GatewayFrame =
  | GatewayEvent
  | GatewayResponse
  | { type: string; [key: string]: unknown };

type PendingRequest = {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export type EventHandler = (frame: GatewayEvent) => void;

export type GatewayStatus = "connecting" | "ready" | "pair-required" | "auth-error" | "closed";

export type GatewayStatusDetail = {
  status: GatewayStatus;
  message?: string;
  pairRequestId?: string;
};

export type StatusHandler = (detail: GatewayStatusDetail) => void;

export function readStoredToken(): string | null {
  const url = new URL(globalThis.location.href);
  const fromQuery = url.searchParams.get("token");
  if (fromQuery) {
    localStorage.setItem(TOKEN_LS_KEY, fromQuery);
    url.searchParams.delete("token");
    globalThis.history.replaceState(null, "", url.toString());
    return fromQuery;
  }
  const hash = url.hash.replace(/^#/, "");
  if (hash.startsWith("token=")) {
    const tok = hash.slice(6);
    localStorage.setItem(TOKEN_LS_KEY, tok);
    url.hash = "";
    globalThis.history.replaceState(null, "", url.toString());
    return tok;
  }
  return localStorage.getItem(TOKEN_LS_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_LS_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_LS_KEY);
}

export function defaultWsUrl(): string {
  const stored = localStorage.getItem(BASE_URL_LS_KEY);
  if (stored) {
    return stored;
  }
  const loc = globalThis.location;
  const scheme = loc.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${loc.host}`;
}

// 30s budget per RPC — generous because chat.history over long sessions
// can take a beat on cold starts. Chat sends themselves ack fast.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class PhoneGateway {
  private ws: WebSocket | null = null;
  private token: string | null;
  private url: string;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly eventHandlers = new Set<EventHandler>();
  private readonly statusHandlers = new Set<StatusHandler>();
  private status: GatewayStatusDetail = { status: "closed" };
  private seq = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Request id for the connect handshake — the gateway acks with a normal
  // `res` frame carrying this id, so onMessage matches it specially rather
  // than looking it up in the pending map.
  private connectReqId: string | null = null;

  constructor(options?: { url?: string; token?: string }) {
    this.token = options?.token ?? readStoredToken();
    this.url = options?.url ?? defaultWsUrl();
  }

  getStatus(): GatewayStatusDetail {
    return this.status;
  }

  setToken(token: string): void {
    this.token = token;
    storeToken(token);
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  connect(): void {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      return;
    }
    this.setStatus({ status: "connecting" });
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => this.onOpen());
    ws.addEventListener("message", (ev) => this.onMessage(ev));
    ws.addEventListener("close", (ev) => this.onClose(ev));
    ws.addEventListener("error", () => {
      // close event follows; nothing to do here beyond logging in dev
    });
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }

  async request<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const id = `r-${Date.now().toString(36)}-${(this.seq += 1).toString(36)}`;
    const frame = { type: "req", id, method, params: params ?? {} };
    const timeoutMs = options?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`gateway request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (payload) => resolve(payload as T),
        reject,
        timeout,
      });
      this.ws?.send(JSON.stringify(frame));
    });
  }

  private onOpen(): void {
    // The server sends a `connect.challenge` event with a nonce *before*
    // we're supposed to send the connect request — the device signature
    // must use that server-generated nonce. See
    // src/gateway/server/ws-connection.ts where connectNonce = randomUUID()
    // is sent as the first frame. We stash the challenge-received promise
    // and build the connect frame once it resolves.
  }

  private async sendConnect(challengeNonce: string): Promise<void> {
    if (!this.token) {
      this.setStatus({
        status: "auth-error",
        message: "No gateway token. Append ?token=... to the URL once.",
      });
      this.ws?.close();
      return;
    }
    try {
      // Load the ed25519 identity. Shared STORAGE_KEY with the Control UI
      // means the phone inherits whatever pairing approval the desktop
      // session already has (same origin = same localStorage).
      const identity = await loadOrCreateDeviceIdentity();
      const signedAtMs = Date.now();
      // Use the server's challenge nonce, NOT a client-generated one.
      // The gateway rejects "device nonce mismatch" otherwise.
      const nonce = challengeNonce;
      const device = await signDeviceAuth(identity, {
        clientId: PHONE_CLIENT_ID,
        clientMode: PHONE_CLIENT_MODE,
        role: PHONE_ROLE,
        scopes: [...PHONE_SCOPES],
        signedAtMs,
        token: this.token,
        nonce,
        platform: "web",
        deviceFamily: null,
      });
      this.connectReqId = `c-${signedAtMs.toString(36)}-${(this.seq += 1).toString(36)}`;
      // ConnectParams schema: src/gateway/protocol/schema/frames.ts. The
      // signed device envelope is how the gateway grants operator.*
      // scopes — without it, chat.history returns
      // "missing scope: operator.read" even with a valid token. Protocol
      // version 3 is required for the v3 payload layout (platform +
      // deviceFamily fields).
      const connectFrame = {
        type: "req",
        id: this.connectReqId,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: PHONE_CLIENT_ID,
            displayName: "Chuck (phone)",
            version: "0.1.0",
            platform: "web",
            mode: PHONE_CLIENT_MODE,
          },
          role: PHONE_ROLE,
          scopes: [...PHONE_SCOPES],
          caps: ["tool-events"],
          device,
          auth: { token: this.token },
          userAgent: globalThis.navigator?.userAgent ?? "openclaw-phone",
          locale: globalThis.navigator?.language ?? "en",
        },
      };
      this.ws?.send(JSON.stringify(connectFrame));
    } catch (err) {
      this.setStatus({
        status: "auth-error",
        message: `device sign failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.ws?.close();
    }
  }

  private onMessage(ev: MessageEvent<string>): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(ev.data) as GatewayFrame;
    } catch {
      return;
    }
    // Connect handshake ack comes as a normal `res` frame tagged with our
    // connectReqId — catch it here before the generic res handler would
    // try to look it up in the pending map (it isn't there).
    if (
      frame.type === "res" &&
      this.connectReqId &&
      (frame as GatewayResponse).id === this.connectReqId
    ) {
      const res = frame as GatewayResponse;
      this.connectReqId = null;
      if (res.ok) {
        this.setStatus({ status: "ready" });
      } else {
        const code = res.error?.code ?? "unknown";
        // The gateway uses code=PAIRING_REQUIRED and puts the detail code +
        // requestId under err.details (see
        // src/gateway/protocol/connect-error-details.ts). `details` may
        // carry a nested `details` that contains the actual requestId.
        const rawDetails = res.error?.details as
          | {
              code?: string;
              requestId?: string;
              details?: { requestId?: string };
            }
          | undefined;
        const requestId = rawDetails?.requestId ?? rawDetails?.details?.requestId;
        if (
          code === "NOT_PAIRED" ||
          code === "PAIRING_REQUIRED" ||
          code === "PAIR_REQUIRED" ||
          code === "DEVICE_PAIRING_REQUIRED" ||
          code === "DEVICE_PAIR_PENDING"
        ) {
          this.setStatus({
            status: "pair-required",
            pairRequestId: requestId,
            message: res.error?.message,
          });
        } else {
          this.setStatus({ status: "auth-error", message: res.error?.message ?? code });
        }
      }
      return;
    }
    if (frame.type === "event") {
      const event = frame as GatewayEvent;
      // First frame from server is a connect.challenge event carrying the
      // nonce the device signature must use. Kick off sendConnect here.
      if (event.event === "connect.challenge") {
        const payload = event.payload as { nonce?: string } | null;
        const nonce = typeof payload?.nonce === "string" ? payload.nonce : null;
        if (nonce) {
          void this.sendConnect(nonce);
        } else {
          this.setStatus({ status: "auth-error", message: "missing challenge nonce" });
          this.ws?.close();
        }
        return;
      }
      // Auto-recover from pair-required -> approved without manual reload.
      // When the user approves the device via the Control UI (or the CLI),
      // the gateway emits `device.pair.resolved` with decision="approved".
      // Catch it and re-connect immediately.
      if (event.event === "device.pair.resolved") {
        const payload = event.payload as { decision?: string; requestId?: string } | null;
        const decision = payload?.decision;
        if (
          decision === "approved" &&
          (this.status.status === "pair-required" || this.status.status === "closed")
        ) {
          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          // Close the current ws (server will drop it anyway post-approval),
          // then reconnect fresh so the signed connect frame carries the new
          // pair state.
          this.ws?.close();
          this.ws = null;
          this.setStatus({ status: "connecting", message: "pair approved - reconnecting" });
          this.reconnectTimer = setTimeout(() => this.connect(), 400);
        }
        // fall through to event handlers so UI can reflect the resolution
      }
      for (const handler of this.eventHandlers) {
        try {
          handler(event);
        } catch {
          // one handler's failure shouldn't poison the others
        }
      }
      return;
    }
    if (frame.type === "res") {
      const res = frame as GatewayResponse;
      const pending = this.pending.get(res.id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(res.id);
      if (res.ok) {
        pending.resolve(res.payload);
      } else {
        pending.reject(
          new Error(res.error?.message ?? res.error?.code ?? "gateway request failed"),
        );
      }
    }
  }

  private onClose(ev: CloseEvent): void {
    this.ws = null;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`gateway disconnected: ${ev.reason || ev.code}`));
    }
    this.pending.clear();
    if (this.status.status === "auth-error") {
      // Hard auth failure — don't busy-loop. User must fix token.
      return;
    }
    if (this.status.status === "pair-required") {
      // Server commonly drops the ws after device.pair.resolved without
      // giving us a chance to react. Poll back in a few seconds so a
      // CLI-side approval is auto-picked-up even if the resolved event
      // never reached us (e.g. event fired before our listener attached,
      // or the subscription ws got closed).
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      return;
    }
    this.setStatus({ status: "closed", message: ev.reason || `code ${ev.code}` });
    // Retry after a second on normal closes — covers gateway restarts
    // during config edits without aggressive busy-looping.
    this.reconnectTimer = setTimeout(() => this.connect(), 1500);
  }

  private setStatus(next: GatewayStatusDetail): void {
    this.status = next;
    for (const handler of this.statusHandlers) {
      try {
        handler(next);
      } catch {
        // ignore
      }
    }
  }
}
