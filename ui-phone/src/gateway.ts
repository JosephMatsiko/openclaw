// Lightweight WebSocket client for the OpenClaw gateway.
//
// Speaks the same frame protocol as the Control UI (ui/src/ui/gateway.ts)
// but strips everything the phone doesn't need: device-identity signing,
// retry-with-fresh-key loops, error taxonomy, reconnect throttling. We
// just want: connect, send request, subscribe to events, stay alive.
//
// Auth flow on mobile:
// 1. Token from URL query (?token=...), URL hash (#token=...), or localStorage.
// 2. First frame: { type: "connect", params: { auth: { token } } }.
// 3. On pair-required error the server hands back a requestId — we surface
//    that to the user for CLI approval (same one-time flow as Control UI).

const TOKEN_LS_KEY = "openclaw.phone.token.v1";
const BASE_URL_LS_KEY = "openclaw.phone.baseUrl.v1";

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
    if (!this.token) {
      this.setStatus({
        status: "auth-error",
        message: "No gateway token. Append ?token=... to the URL once.",
      });
      this.ws?.close();
      return;
    }
    const connectFrame = {
      type: "connect",
      params: {
        auth: { token: this.token },
        client: { name: "openclaw-phone", version: "0.1.0", mode: "phone" },
      },
    };
    this.ws?.send(JSON.stringify(connectFrame));
  }

  private onMessage(ev: MessageEvent<string>): void {
    let frame: GatewayFrame;
    try {
      frame = JSON.parse(ev.data) as GatewayFrame;
    } catch {
      return;
    }
    if (frame.type === "connect-ack") {
      this.setStatus({ status: "ready" });
      return;
    }
    if (frame.type === "connect-error" || frame.type === "error") {
      const err = (frame as { error?: { code?: string; message?: string; details?: unknown } })
        .error;
      // The gateway signals pair-required with a specific error code + a
      // requestId in details; surface it so the user can run
      // `openclaw devices approve <requestId>` on the Mac.
      const code = err?.code ?? "unknown";
      const details = err?.details as { requestId?: string } | undefined;
      if (code === "PAIR_REQUIRED" || code === "DEVICE_PAIRING_REQUIRED") {
        this.setStatus({
          status: "pair-required",
          pairRequestId: details?.requestId,
          message: err?.message,
        });
      } else {
        this.setStatus({ status: "auth-error", message: err?.message ?? code });
      }
      return;
    }
    if (frame.type === "event") {
      const event = frame as GatewayEvent;
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
    if (this.status.status !== "pair-required" && this.status.status !== "auth-error") {
      this.setStatus({ status: "closed", message: ev.reason || `code ${ev.code}` });
      // Retry once after a second — covers gateway restarts (which happen
      // during config edits) without aggressive busy-looping on real auth
      // failures.
      this.reconnectTimer = setTimeout(() => this.connect(), 1500);
    }
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
