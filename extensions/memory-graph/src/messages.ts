// Helpers for pulling text out of the AgentMessage shape used by the
// ContextEngine interface. AgentMessage is structurally `{ role, content }`
// where content is either a string or an array of typed content blocks
// (`{ type: "text", text: string }`, etc.). These helpers avoid importing
// pi-agent-core as a direct dep and keep the engine resilient to message
// shape variations across provider families.

type UnknownMessage = {
  role?: unknown;
  content?: unknown;
};

type ContentBlock = {
  type?: unknown;
  text?: unknown;
};

function collectTextFromContent(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const texts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const { type, text } = block as ContentBlock;
    if (type === "text" && typeof text === "string" && text.length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

function messageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const role = (message as UnknownMessage).role;
  return typeof role === "string" ? role : undefined;
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  return collectTextFromContent((message as UnknownMessage).content).join("\n");
}

// Return the last user message's text in the batch, or undefined if no user
// message carries any textual content.
export function lastUserText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messageRole(messages[i]) === "user") {
      const text = messageText(messages[i]).trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

// Return the last assistant message's text in the batch.
export function lastAssistantText(messages: readonly unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messageRole(messages[i]) === "assistant") {
      const text = messageText(messages[i]).trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}
