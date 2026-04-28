import { LitElement, css, html, nothing } from "lit";
import { customElement, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { PhoneGateway, type GatewayEvent, type GatewayStatusDetail } from "./gateway.ts";

// Minimal structural types for the browser SpeechRecognition API so
// TypeScript stops complaining in strict mode. We only use a tiny
// surface (start/stop/onresult/onerror/onend).
type SpeechRecognitionResultItem = { 0: { transcript: string }; isFinal: boolean };
interface MinimalSpeechRecognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((ev: { results: ArrayLike<SpeechRecognitionResultItem> }) => void) | null;
  onerror: ((ev: { error?: string }) => void) | null;
  onend: (() => void) | null;
  addEventListener(type: "error", listener: () => void): void;
  start(): void;
  stop(): void;
}
type QuickAction = {
  id: string;
  label: string;
  hint?: string;
  send: string;
};
const QUICK_ACTIONS: QuickAction[] = [
  { id: "brief", label: "Brief", hint: "today's brief", send: "/apex-brief" },
  { id: "magazine", label: "Magazine", hint: "today's magazine", send: "/apex-magazine daily" },
  {
    id: "pinned",
    label: "Pinned",
    hint: "pinned claims",
    send: "Recall my pinned durable claims (facts, preferences, constraints, open loops). Return 5-10 crisp bullets.",
  },
  {
    id: "vanguard",
    label: "Vanguard",
    hint: "last audit",
    send: "Summarize the last Apex Vanguard run: any ATTENTION flags, drift, tech-debt items.",
  },
];

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

// Prep text for TTS playback: drop URLs (gets read as "h-t-t-p-s..."),
// ASCII rulers, and markdown punctuation. Keeps speech natural.
function stripForTts(raw: string): string {
  return raw
    .replaceAll(/\bhttps?:\/\/\S+/g, "")
    .replaceAll(/={3,}/g, "")
    .replaceAll(/-{3,}/g, "")
    .replaceAll(/[*_`]+/g, "")
    .replaceAll(/\s+/g, " ")
    .replace(/\s+([,.;:?!])/g, "$1")
    .trim();
}

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
    .msg .bubble-actions {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }
    .msg .bubble-actions button {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 999px;
      padding: 2px 8px;
      font: 500 11px var(--font-body, inherit);
      cursor: pointer;
    }
    .msg .bubble-actions button:hover {
      background: var(--bg-elevated);
      color: var(--text);
    }
    .msg .bubble-actions button.speaking {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
    }
    .quick-actions {
      display: flex;
      gap: 6px;
      padding: 6px 10px;
      overflow-x: auto;
      border-top: 1px solid var(--border);
      background: var(--bg);
      -webkit-overflow-scrolling: touch;
    }
    .quick-actions button {
      flex-shrink: 0;
      background: var(--bg-elevated);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 6px 12px;
      font: 500 12px var(--font-body, inherit);
      cursor: pointer;
    }
    .quick-actions button:hover:not(:disabled) {
      background: rgba(255, 255, 255, 0.06);
    }
    .quick-actions button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    footer {
      border-top: 1px solid var(--border);
      padding: 10px 12px calc(env(safe-area-inset-bottom) + 10px) 12px;
      background: var(--bg);
      display: flex;
      align-items: flex-end;
      gap: 8px;
    }
    footer .mic {
      height: 42px;
      width: 42px;
      padding: 0;
      background: var(--bg-elevated);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 12px;
      font-size: 18px;
      cursor: pointer;
    }
    footer .mic.listening {
      background: var(--accent);
      color: white;
      border-color: var(--accent);
      animation: mic-pulse 1s ease-in-out infinite;
    }
    @keyframes mic-pulse {
      0%,
      100% {
        opacity: 1;
      }
      50% {
        opacity: 0.65;
      }
    }
    footer .mic:disabled {
      opacity: 0.45;
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
  @state() private isListening = false;
  @state() private speakingId: string | null = null;

  private readonly gw = new PhoneGateway();
  private recognition: MinimalSpeechRecognition | null = null;
  private synthUtterance: SpeechSynthesisUtterance | null = null;

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
    // Handle chuck://prompt?text=... deep-links (iOS Shortcuts surface).
    const deepPrompt = url.searchParams.get("prompt");
    if (deepPrompt) {
      this.draft = deepPrompt;
      url.searchParams.delete("prompt");
      globalThis.history.replaceState(null, "", url.toString());
    }
    // Register the service worker for offline shell. Guarded so local dev
    // without https doesn't 500. Errors are non-fatal.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/m/sw.js").catch(() => {
        /* non-fatal; shell still works online */
      });
    }
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.stopVoiceInput();
    this.stopSpeaking();
  }

  // ---- Voice dictation (Gemini-voice is for output; input uses the
  // browser's free SpeechRecognition: sovereign, local, on-device) ----

  private buildRecognition(): MinimalSpeechRecognition | null {
    const SR =
      (
        globalThis as unknown as {
          SpeechRecognition?: new () => MinimalSpeechRecognition;
          webkitSpeechRecognition?: new () => MinimalSpeechRecognition;
        }
      ).SpeechRecognition ??
      (
        globalThis as unknown as {
          webkitSpeechRecognition?: new () => MinimalSpeechRecognition;
        }
      ).webkitSpeechRecognition;
    if (!SR) {
      return null;
    }
    const rec = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = globalThis.navigator?.language ?? "en-US";
    return rec;
  }

  private toggleVoiceInput(): void {
    if (this.isListening) {
      this.stopVoiceInput();
      return;
    }
    const rec = this.recognition ?? this.buildRecognition();
    if (!rec) {
      this.pushSystem("voice dictation unsupported in this browser");
      return;
    }
    this.recognition = rec;
    const starting = this.draft;
    rec.onresult = (ev) => {
      const parts: string[] = [];
      for (let i = 0; i < ev.results.length; i += 1) {
        parts.push(ev.results[i][0].transcript);
      }
      const joined = parts.join(" ").trim();
      this.draft = starting ? `${starting} ${joined}` : joined;
    };
    rec.addEventListener("error", () => {
      this.isListening = false;
    });
    rec.onend = () => {
      this.isListening = false;
    };
    try {
      rec.start();
      this.isListening = true;
    } catch {
      this.isListening = false;
    }
  }

  private stopVoiceInput(): void {
    if (this.recognition) {
      try {
        this.recognition.stop();
      } catch {
        /* noop */
      }
    }
    this.isListening = false;
  }

  private async runQuickAction(a: QuickAction): Promise<void> {
    if (this.status.status !== "ready") {
      this.pushSystem(`can't run ${a.label}: gateway ${this.status.status}`);
      return;
    }
    this.draft = a.send;
    await this.send();
  }

  // ---- Text-to-speech playback (SpeechSynthesis with Google voices) ----
  //
  // Per voice preference: Google/Gemini-family voices only, no macOS `say`,
  // no PAYG. Chrome's Web Speech Synthesis API exposes voices named
  // "Google US English" / "Google UK English Female" / etc. - those ARE
  // Google's voice stack, subscription-free, browser-native. We pick the
  // best available Google voice at speak-time, falling back to the
  // platform default if the browser has no Google voices loaded (rare on
  // Chrome; absent on Safari).

  private pickGoogleVoice(): SpeechSynthesisVoice | null {
    const synth = globalThis.speechSynthesis;
    if (!synth) {
      return null;
    }
    const voices = synth.getVoices();
    if (!voices.length) {
      return null;
    }
    const locale = (globalThis.navigator?.language ?? "en-US").toLowerCase();
    const localeBase = locale.split("-")[0];
    const google = voices.filter((v) => /^Google\b/i.test(v.name));
    // Prefer: exact locale > base-language > any Google voice > platform default.
    const exact = google.find((v) => v.lang.toLowerCase() === locale);
    if (exact) {
      return exact;
    }
    const baseLang = google.find((v) => v.lang.toLowerCase().startsWith(localeBase));
    if (baseLang) {
      return baseLang;
    }
    if (google.length > 0) {
      return google[0];
    }
    return voices[0] ?? null;
  }

  private stopSpeaking(): void {
    const synth = globalThis.speechSynthesis;
    if (synth) {
      synth.cancel();
    }
    this.synthUtterance = null;
    this.speakingId = null;
  }

  private toggleSpeak(message: ChatMessage): void {
    const synth = globalThis.speechSynthesis;
    if (!synth) {
      this.pushSystem("text-to-speech not supported in this browser");
      return;
    }
    if (this.speakingId === message.id) {
      this.stopSpeaking();
      return;
    }
    // Stop anything in flight before starting the new utterance.
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(stripForTts(message.text));
    const voice = this.pickGoogleVoice();
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = 1.02;
    utterance.pitch = 1;
    utterance.onend = () => {
      if (this.speakingId === message.id) {
        this.speakingId = null;
        this.synthUtterance = null;
      }
    };
    utterance.addEventListener("error", () => {
      this.speakingId = null;
      this.synthUtterance = null;
    });
    this.synthUtterance = utterance;
    this.speakingId = message.id;
    synth.speak(utterance);
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
              ${m.role === "assistant" && !m.streaming && m.text
                ? html`
                    <div class="bubble-actions">
                      <button
                        class=${this.speakingId === m.id ? "speaking" : ""}
                        title=${this.speakingId === m.id
                          ? "stop reading"
                          : "read aloud (Google voice)"}
                        @click=${() => this.toggleSpeak(m)}
                      >
                        ${this.speakingId === m.id ? "stop" : "play"}
                      </button>
                    </div>
                  `
                : nothing}
            </div>
          `,
        )}
      </main>
      <div class="quick-actions">
        ${QUICK_ACTIONS.map(
          (a) => html`
            <button
              ?disabled=${this.status.status !== "ready" || this.sending}
              title=${a.hint ?? a.label}
              @click=${() => void this.runQuickAction(a)}
            >
              ${a.label}
            </button>
          `,
        )}
      </div>
      <footer>
        <button
          class="mic ${this.isListening ? "listening" : ""}"
          ?disabled=${this.status.status !== "ready"}
          title=${this.isListening ? "stop dictation" : "voice dictation"}
          @click=${() => this.toggleVoiceInput()}
        >
          ${this.isListening ? "stop" : "mic"}
        </button>
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
