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
    // chat.* events carry the same shape as chat.history entries — reuse
    // the normalizer so streaming deltas and final frames converge cleanly.
    if (!ev.event.startsWith("chat.")) {
      return;
    }
    const payload = ev.payload as
      | (ChatHistoryEntry & { sessionKey?: string; kind?: string })
      | null;
    if (!payload) {
      return;
    }
    if (payload.sessionKey && payload.sessionKey !== this.sessionKey) {
      return;
    }
    const msg = normalizeEntry(payload, this.messages.length);
    if (!msg) {
      return;
    }
    // If we already have this id (streaming delta), replace in-place.
    const idx = this.messages.findIndex((m) => m.id === msg.id);
    if (idx >= 0) {
      const next = [...this.messages];
      next[idx] = msg;
      this.messages = next;
    } else {
      this.messages = [...this.messages, msg];
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
      await this.gw.request("chat.send", {
        sessionKey: this.sessionKey,
        text,
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
              <div class="bubble">${m.text}</div>
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
