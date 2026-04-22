import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { PhoneGateway, type GatewayEvent, type GatewayStatusDetail } from "./gateway.ts";

// One message as rendered in the chat list. Keep the shape narrow so we
// don't need to import the full core message type through the public SDK.
type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  ts: number;
  streaming?: boolean;
  toolName?: string;
};

type ChatHistoryEntry = {
  id?: string;
  role?: string;
  text?: string;
  content?: unknown;
  timestamp?: number;
  createdAt?: number;
  streaming?: boolean;
  tool?: { name?: string };
};

function extractText(entry: ChatHistoryEntry): string {
  if (typeof entry.text === "string") {
    return entry.text;
  }
  if (Array.isArray(entry.content)) {
    const parts: string[] = [];
    for (const block of entry.content) {
      if (!block || typeof block !== "object") {
        continue;
      }
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text);
      }
    }
    return parts.join("\n").trim();
  }
  if (typeof entry.content === "string") {
    return entry.content;
  }
  return "";
}

function normalizeEntry(entry: ChatHistoryEntry, fallbackId: number): ChatMessage | null {
  const roleRaw = entry.role ?? "assistant";
  const role: ChatMessage["role"] =
    roleRaw === "user" || roleRaw === "assistant" || roleRaw === "tool" || roleRaw === "system"
      ? roleRaw
      : "assistant";
  const text = extractText(entry);
  if (!text) {
    return null;
  }
  return {
    id: entry.id ?? `e-${fallbackId}`,
    role,
    text,
    ts: entry.timestamp ?? entry.createdAt ?? Date.now(),
    streaming: entry.streaming === true,
    toolName: entry.tool?.name,
  };
}

@customElement("chuck-app")
export class ChuckApp extends LitElement {
  static styles = css`
    :host {
      display: grid;
      grid-template-rows: auto 1fr auto;
      height: 100dvh;
      max-height: 100dvh;
      color: var(--text);
      overflow: hidden;
    }
    header {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg);
      position: sticky;
      top: 0;
    }
    header .title {
      font-weight: 600;
      color: var(--text-strong);
      letter-spacing: -0.02em;
      font-size: 17px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    header .status {
      margin-left: auto;
      font-size: 12px;
      color: var(--muted);
    }
    header .new-chat {
      background: transparent;
      border: 1px solid var(--border-strong);
      color: var(--text);
      border-radius: 8px;
      padding: 5px 10px;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    header .new-chat:hover {
      background: var(--bg-elevated);
    }
    header .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
    }
    header .dot.ready {
      background: var(--ok);
    }
    header .dot.err {
      background: var(--accent);
    }
    main {
      overflow-y: auto;
      -webkit-overflow-scrolling: touch;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 12px;
      background: var(--bg);
    }
    .banner {
      padding: 12px 14px;
      border-radius: 10px;
      background: var(--bg-elevated);
      border: 1px solid var(--border-strong);
      color: var(--text);
      font-size: 14px;
      line-height: 1.45;
    }
    .banner code {
      background: rgba(255, 255, 255, 0.06);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 12px;
      font-family: ui-monospace, "SF Mono", monospace;
    }
    .msg {
      display: flex;
      flex-direction: column;
      gap: 4px;
      max-width: 92%;
    }
    .msg.user {
      align-self: flex-end;
    }
    .msg.assistant,
    .msg.tool,
    .msg.system {
      align-self: flex-start;
    }
    .msg .bubble {
      padding: 10px 14px;
      border-radius: 14px;
      white-space: pre-wrap;
      word-wrap: break-word;
      overflow-wrap: anywhere;
      font-size: 15px;
      line-height: 1.4;
    }
    .msg.user .bubble {
      background: var(--bubble-me);
      color: var(--text-strong);
      border-bottom-right-radius: 4px;
    }
    .msg.assistant .bubble {
      background: var(--bubble-them);
      color: var(--text);
      border: 1px solid var(--border);
      border-bottom-left-radius: 4px;
    }
    .msg.assistant .bubble.streaming::after {
      content: "";
      display: inline-block;
      width: 7px;
      height: 14px;
      margin-left: 3px;
      vertical-align: text-bottom;
      background: var(--accent);
      border-radius: 1px;
      animation: bubble-pulse 0.9s ease-in-out infinite;
    }
    @keyframes bubble-pulse {
      0%,
      100% {
        opacity: 0.25;
      }
      50% {
        opacity: 1;
      }
    }
    .msg.tool .bubble {
      background: var(--accent-subtle);
      color: var(--text);
      border: 1px dashed var(--border-strong);
      font-size: 13px;
      font-family: ui-monospace, "SF Mono", monospace;
    }
    .msg.system .bubble {
      background: transparent;
      color: var(--muted);
      font-size: 13px;
      font-style: italic;
      border: none;
      padding: 2px 4px;
    }
    .msg .meta {
      font-size: 11px;
      color: var(--muted);
      padding: 0 4px;
    }
    footer {
      border-top: 1px solid var(--border);
      padding: 10px 12px calc(env(safe-area-inset-bottom) + 10px) 12px;
      background: var(--bg);
      display: flex;
      align-items: flex-end;
      gap: 8px;
    }
    footer textarea {
      flex: 1;
      min-height: 42px;
      max-height: 160px;
      padding: 10px 12px;
      font: inherit;
      background: var(--bg-elevated);
      color: var(--text-strong);
      border: 1px solid var(--border);
      border-radius: 12px;
      resize: none;
      outline: none;
    }
    footer textarea:focus {
      border-color: var(--border-strong);
    }
    footer button {
      height: 42px;
      padding: 0 16px;
      background: var(--accent);
      color: white;
      border: none;
      border-radius: 12px;
      font: 600 15px var(--font-body, inherit);
      cursor: pointer;
    }
    footer button:disabled {
      opacity: 0.5;
    }
    .empty {
      color: var(--muted);
      text-align: center;
      padding: 40px 16px;
      font-size: 14px;
    }
  `;

  @state() private messages: ChatMessage[] = [];
  @state() private status: GatewayStatusDetail = { status: "connecting" };
  @state() private draft = "";
  @state() private sending = false;
  @state() private sessionKey = "agent:main:main";

  private readonly gw = new PhoneGateway();

  override connectedCallback(): void {
    super.connectedCallback();
    this.gw.onStatus((s) => {
      this.status = s;
      if (s.status === "ready") {
        void this.loadHistory();
      }
    });
    this.gw.onEvent((ev) => this.handleEvent(ev));
    this.gw.connect();
    // If the URL carries an explicit session, honor it — lets us deep-link
    // to different agents later (agent:reviewer:..., agent:notes:...).
    const url = new URL(globalThis.location.href);
    const qs = url.searchParams.get("session");
    if (qs) {
      this.sessionKey = qs;
    }
  }

  private async loadHistory(): Promise<void> {
    try {
      const res = (await this.gw.request("chat.history", { sessionKey: this.sessionKey })) as {
        entries?: ChatHistoryEntry[];
        messages?: ChatHistoryEntry[];
      };
      const list = res.entries ?? res.messages ?? [];
      const normalized = list
        .map((e, i) => normalizeEntry(e, i))
        .filter((m): m is ChatMessage => m !== null);
      this.messages = normalized;
      this.scrollToBottomSoon();
    } catch (err) {
      this.pushSystem(`couldn't load history: ${(err as Error).message}`);
    }
  }

  private handleEvent(ev: GatewayEvent): void {
    // Chat event shape: { runId, sessionKey, seq, state, message, ... }
    // state ∈ {delta, final, aborted, error}. ChatEventSchema lives in
    // src/gateway/protocol/schema/logs-chat.ts. The server publishes a
    // single event name "chat" (not "chat.*"), so match exactly.
    if (ev.event !== "chat") {
      return;
    }
    const payload = ev.payload as {
      runId?: string;
      sessionKey?: string;
      seq?: number;
      state?: "delta" | "final" | "aborted" | "error";
      message?: ChatHistoryEntry;
      errorMessage?: string;
      errorKind?: string;
    } | null;
    if (!payload?.runId) {
      return;
    }
    if (payload.sessionKey && payload.sessionKey !== this.sessionKey) {
      return;
    }
    // Bucket assistant deltas under a stable bubble id keyed on runId so
    // incremental text accumulates in one place instead of spawning a new
    // bubble per delta. The transcript's own msg.id is ignored for
    // streaming — it changes per delta in some runtimes.
    const bubbleId = `run-${payload.runId}`;
    if (payload.state === "error") {
      this.pushSystem(`error: ${payload.errorMessage ?? payload.errorKind ?? "unknown"}`);
      return;
    }
    if (payload.state === "aborted") {
      const idx = this.messages.findIndex((m) => m.id === bubbleId);
      if (idx >= 0) {
        const next = [...this.messages];
        next[idx] = { ...next[idx], streaming: false, text: `${next[idx].text} [aborted]` };
        this.messages = next;
      }
      return;
    }
    // state === "delta" or "final"
    const msg = payload.message ? normalizeEntry(payload.message, this.messages.length) : null;
    if (!msg) {
      return;
    }
    const streaming = payload.state === "delta";
    const shaped: ChatMessage = { ...msg, id: bubbleId, streaming };
    const idx = this.messages.findIndex((m) => m.id === bubbleId);
    if (idx >= 0) {
      const next = [...this.messages];
      next[idx] = shaped;
      this.messages = next;
    } else {
      this.messages = [...this.messages, shaped];
    }
    this.scrollToBottomSoon();
  }

  private pushSystem(text: string): void {
    this.messages = [
      ...this.messages,
      {
        id: `sys-${Date.now()}`,
        role: "system",
        text,
        ts: Date.now(),
      },
    ];
  }

  private scrollToBottomSoon(): void {
    // After render. rAF gives Lit one cycle to flush DOM updates.
    requestAnimationFrame(() => {
      const main = this.renderRoot.querySelector("main");
      if (main) {
        main.scrollTop = main.scrollHeight;
      }
    });
  }

  // Fork a fresh session keyed on the current wall-clock so nothing
  // bleeds from the old one. The gateway treats any `agent:<agent>:<key>`
  // shape as a separate session; history for the new key starts empty.
  // Encoded in base36 + short random suffix to stay URL-safe and compact.
  private startNewSession(): void {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    this.sessionKey = `agent:main:${id}`;
    this.messages = [];
    const url = new URL(globalThis.location.href);
    url.searchParams.set("session", this.sessionKey);
    globalThis.history.replaceState(null, "", url.toString());
    // No history fetch — the new session has none. chat.send on the next
    // message will materialize the session server-side.
  }

  private async send(): Promise<void> {
    const text = this.draft.trim();
    if (!text || this.sending) {
      return;
    }
    this.sending = true;
    this.draft = "";
    // Optimistic append so the user sees their message immediately.
    this.messages = [
      ...this.messages,
      { id: `u-${Date.now()}`, role: "user", text, ts: Date.now() },
    ];
    this.scrollToBottomSoon();
    try {
      // chat.send schema expects `message` (not `text`) and requires an
      // idempotencyKey for retry de-dup. See src/gateway/protocol/schema/
      // chat-frames.ts — resending the same key while the run is in flight
      // returns { status: "in_flight" }.
      const idempotencyKey = `phone-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      await this.gw.request("chat.send", {
        sessionKey: this.sessionKey,
        message: text,
        idempotencyKey,
      });
    } catch (err) {
      this.pushSystem(`send failed: ${(err as Error).message}`);
    } finally {
      this.sending = false;
    }
  }

  private onKeyDown(ev: KeyboardEvent): void {
    // Enter sends, Shift+Enter is newline. Matches most chat UIs.
    if (ev.key === "Enter" && !ev.shiftKey) {
      ev.preventDefault();
      void this.send();
    }
  }

  private statusText(): { label: string; cls: string } {
    switch (this.status.status) {
      case "connecting":
        return { label: "connecting...", cls: "" };
      case "ready":
        return { label: "connected", cls: "ready" };
      case "pair-required":
        return { label: "pair required", cls: "err" };
      case "auth-error":
        return { label: "auth failed", cls: "err" };
      case "closed":
        return { label: "offline", cls: "err" };
      default:
        return { label: String(this.status.status), cls: "" };
    }
  }

  override render() {
    const s = this.statusText();
    return html`
      <header>
        <div class="title">🦞 Chuck</div>
        <button
          class="new-chat"
          @click=${() => this.startNewSession()}
          title="Fork a fresh session — history stays on the old one."
        >
          New chat
        </button>
        <div class="status">
          <span class="dot ${s.cls}"></span>
          ${s.label}
        </div>
      </header>
      <main>
        ${this.status.status === "pair-required"
          ? html`
              <div class="banner">
                This device needs pairing approval. On your Mac, run:
                <div style="margin-top:8px">
                  <code>openclaw devices approve ${this.status.pairRequestId ?? "<id>"}</code>
                </div>
              </div>
            `
          : nothing}
        ${this.status.status === "auth-error"
          ? html`
              <div class="banner">
                ${this.status.message ?? "Authentication failed."} Add
                <code>?token=...</code> to the URL to set a gateway token.
              </div>
            `
          : nothing}
        ${this.messages.length === 0 && this.status.status === "ready"
          ? html`<div class="empty">Session empty. Say hi.</div>`
          : nothing}
        ${repeat(
          this.messages,
          (m) => m.id,
          (m) => html`
            <div class="msg ${m.role}">
              ${m.role === "tool"
                ? html`<div class="meta">tool · ${m.toolName ?? "unknown"}</div>`
                : nothing}
              <div class="bubble ${m.streaming ? "streaming" : ""}">${m.text}</div>
            </div>
          `,
        )}
      </main>
      <footer>
        <textarea
          .value=${this.draft}
          @input=${(e: InputEvent) => {
            this.draft = (e.target as HTMLTextAreaElement).value;
          }}
          @keydown=${(e: KeyboardEvent) => this.onKeyDown(e)}
          placeholder="Message Chuck..."
          rows="1"
        ></textarea>
        <button
          ?disabled=${this.sending ||
          this.draft.trim().length === 0 ||
          this.status.status !== "ready"}
          @click=${() => void this.send()}
        >
          Send
        </button>
      </footer>
    `;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "chuck-app": ChuckApp;
  }
}
