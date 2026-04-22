import { describe, expect, test, vi } from "vitest";
import {
  classify,
  classifyByHeuristic,
  classifyByLLM,
  classifyWithLLMFallback,
  DEFAULT_TIER_TO_MODEL,
  routeAndAnswer,
  type LLMClassifyOptions,
  type OrchestratorTier,
} from "./orchestrator.js";

function tier(text: string, opts?: Parameters<typeof classify>[1]): OrchestratorTier {
  return classify(text, opts).tier;
}

describe("orchestrator classifyByHeuristic", () => {
  test("empty input → trivial", () => {
    const v = classifyByHeuristic("");
    expect(v).not.toBeNull();
    expect(v!.tier).toBe("trivial");
    expect(v!.signals).toContain("empty");
  });

  test("whitespace-only → trivial", () => {
    expect(classifyByHeuristic("   \n\t  ")!.tier).toBe("trivial");
  });

  test("code fence → complex", () => {
    expect(tier("```\nconst x = 1\n```")).toBe("complex");
  });

  test("unfenced code keyword → complex", () => {
    expect(tier("function helloWorld() { return 1; }")).toBe("complex");
    expect(tier("const userId = 42")).toBe("complex");
    expect(tier("def hello():")).toBe("complex");
    expect(tier("class Foo(Bar):")).toBe("complex");
  });

  test("memory-mutating phrases → complex", () => {
    expect(tier("remember that my wife is Sarah")).toBe("complex");
    expect(tier("please remember I'm allergic to peanuts")).toBe("complex");
    expect(tier("Don't let me forget about the dentist.")).toBe("complex");
    expect(tier("I just realized the bug is in the hook.")).toBe("complex");
  });

  test("engineering verbs → complex", () => {
    expect(tier("implement a CRDT for cross-device sync")).toBe("complex");
    expect(tier("refactor the auth module")).toBe("complex");
    expect(tier("debug why the engine drops tool turns")).toBe("complex");
    expect(tier("wire the classifier into the gateway")).toBe("complex");
    expect(tier("ship phase 3")).toBe("complex");
  });

  test("long paragraph → complex", () => {
    const long =
      "I have a bunch of thoughts about how this should work. " +
      "First, we need to think about the gateway integration carefully. " +
      "Second, the classifier should be testable. " +
      "Third, the routing table should be overridable. " +
      "Fourth, we need a smoke script. " +
      "Fifth, the MCP tool matters. Sixth, cost reporting. Seventh, telemetry.";
    expect(tier(long)).toBe("complex");
  });

  test("memory-recall questions → contextual", () => {
    expect(tier("What did we talk about yesterday?")).toBe("contextual");
    expect(tier("Remind me what I said about Kibo.")).toBe("contextual");
    expect(tier("Summarize my open loops.")).toBe("contextual");
    expect(tier("What's in my memory about Sarah?")).toBe("contextual");
  });

  test("pure greetings / acks → trivial", () => {
    expect(tier("hi")).toBe("trivial");
    expect(tier("hello!")).toBe("trivial");
    expect(tier("thanks")).toBe("trivial");
    expect(tier("ok")).toBe("trivial");
    expect(tier("got it")).toBe("trivial");
    expect(tier("Perfect.")).toBe("trivial");
    expect(tier("yes")).toBe("trivial");
  });

  test("very short questions → trivial", () => {
    expect(tier("What time is it?")).toBe("trivial");
    expect(tier("where's home?")).toBe("trivial");
  });

  test("single-sentence medium question → contextual", () => {
    expect(tier("How do we usually handle DB migrations in this repo?")).toBe("contextual");
    expect(tier("Which Gemini model is cheapest for long context?")).toBe("contextual");
  });

  test("genuinely ambiguous → null (caller decides)", () => {
    // Five-word declarative statement, no code, no verbs, no markers.
    // Classifier should return null rather than guess.
    expect(classifyByHeuristic("the weather feels fine today.")).toBeNull();
  });

  test("short reply tiers up when prior assistant asked a question", () => {
    expect(tier("yes")).toBe("trivial");
    expect(tier("yes", { lastAssistantEndedInQuestion: true })).toBe("contextual");
    expect(tier("the left one", { lastAssistantEndedInQuestion: true })).toBe("contextual");
  });

  test("memory-mutating still overrides lastAssistantEndedInQuestion", () => {
    // Claim-writing should hit Opus regardless of thread shape.
    expect(tier("remember that i prefer vim", { lastAssistantEndedInQuestion: true })).toBe(
      "complex",
    );
  });

  test("first match wins: code-in-greeting → complex", () => {
    // Greeting plus code anywhere in the turn: code must win so we don't
    // drop a "hi, can you look at `const x = 1`" style onto Flash.
    expect(tier("hey! can you look at const x = computed() for me")).toBe("complex");
  });
});

describe("orchestrator classify (entry point)", () => {
  test("heuristic miss → defaults to complex (conservative)", () => {
    const v = classify("the weather feels fine today.");
    expect(v.tier).toBe("complex");
    expect(v.signals).toContain("heuristic-miss");
    expect(v.confidence).toBeLessThan(0.8);
  });

  test("tier→model mapping hits the default routing table", () => {
    expect(classify("hi").model).toBe(DEFAULT_TIER_TO_MODEL.trivial);
    expect(classify("what did we discuss yesterday?").model).toBe(DEFAULT_TIER_TO_MODEL.contextual);
    expect(classify("refactor the engine").model).toBe(DEFAULT_TIER_TO_MODEL.complex);
  });

  test("caller can override the routing table", () => {
    const v = classify("hi", {
      tierToModel: { trivial: "gemini-2.5-flash-lite" },
    });
    expect(v.tier).toBe("trivial");
    expect(v.model).toBe("gemini-2.5-flash-lite");
  });

  test("verdict shape is stable", () => {
    const v = classify("what did we talk about yesterday?");
    expect(v).toMatchObject({
      tier: "contextual",
      model: "gemini-2.5-pro",
      viaHeuristic: true,
    });
    expect(typeof v.rationale).toBe("string");
    expect(v.rationale.length).toBeGreaterThan(0);
    expect(typeof v.confidence).toBe("number");
    expect(Array.isArray(v.signals)).toBe(true);
    expect(v.signals.length).toBeGreaterThan(0);
  });
});

describe("orchestrator classifyByLLM (mocked fetch)", () => {
  function llmOpts(mockFetch: typeof fetch): LLMClassifyOptions {
    return { apiKey: "test-key", fetchImpl: mockFetch };
  }

  function mockGeminiResponse(text: string, status = 200): typeof fetch {
    return vi.fn(async () => {
      return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
          return { candidates: [{ content: { parts: [{ text }] } }] };
        },
        async text() {
          return JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] });
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  test("LLM returns 'trivial' → trivial verdict, viaHeuristic false", async () => {
    const fetchMock = mockGeminiResponse("trivial");
    const v = await classifyByLLM("reply with just the word FLASH", llmOpts(fetchMock));
    expect(v.tier).toBe("trivial");
    expect(v.model).toBe(DEFAULT_TIER_TO_MODEL.trivial);
    expect(v.viaHeuristic).toBe(false);
    expect(v.signals).toContain("llm-classifier");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("LLM output is normalized (punctuation, case, surrounding text)", async () => {
    const v1 = await classifyByLLM("x", llmOpts(mockGeminiResponse("Trivial.")));
    expect(v1.tier).toBe("trivial");

    const v2 = await classifyByLLM("x", llmOpts(mockGeminiResponse("CONTEXTUAL")));
    expect(v2.tier).toBe("contextual");

    const v3 = await classifyByLLM("x", llmOpts(mockGeminiResponse("The tier is: complex")));
    expect(v3.tier).toBe("complex");
  });

  test("unrecognized LLM output → complex fallback with signal", async () => {
    const v = await classifyByLLM("x", llmOpts(mockGeminiResponse("maybe idk")));
    expect(v.tier).toBe("complex");
    expect(v.viaHeuristic).toBe(false);
    expect(v.signals).toContain("llm-fallback-failed");
    expect(v.signals.some((s) => s.startsWith("unrecognized:"))).toBe(true);
  });

  test("HTTP error → complex fallback with http-<code>", async () => {
    const v = await classifyByLLM("x", llmOpts(mockGeminiResponse("", 503)));
    expect(v.tier).toBe("complex");
    expect(v.signals).toContain("http-503");
  });

  test("empty response → complex fallback", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          async json() {
            return { candidates: [{ content: { parts: [{ text: "" }] } }] };
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    const v = await classifyByLLM("x", llmOpts(fetchMock));
    expect(v.tier).toBe("complex");
    expect(v.signals).toContain("empty-response");
  });

  test("fetch throws → complex fallback", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("ECONNRESET socket hangup");
    }) as unknown as typeof fetch;
    const v = await classifyByLLM("x", llmOpts(fetchMock));
    expect(v.tier).toBe("complex");
    expect(v.signals).toContain("llm-fallback-failed");
  });

  test("classifier never throws — even on malformed JSON", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          async json() {
            throw new Error("bad JSON");
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    await expect(classifyByLLM("x", llmOpts(fetchMock))).resolves.toMatchObject({
      tier: "complex",
    });
  });
});

describe("orchestrator classifyWithLLMFallback", () => {
  function llmOpts(mockFetch: typeof fetch): LLMClassifyOptions {
    return { apiKey: "test-key", fetchImpl: mockFetch };
  }

  test("heuristic hit short-circuits — LLM not called", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const v = await classifyWithLLMFallback("hi", { llm: llmOpts(fetchMock) });
    expect(v.tier).toBe("trivial");
    expect(v.viaHeuristic).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("heuristic miss → LLM called and result used", async () => {
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          async json() {
            return { candidates: [{ content: { parts: [{ text: "trivial" }] } }] };
          },
        }) as unknown as Response,
    ) as unknown as typeof fetch;
    // Heuristic-miss input: short declarative statement with no code, eng
    // verb, memory trigger, or question mark.
    const v = await classifyWithLLMFallback("the weather feels fine today.", {
      llm: llmOpts(fetchMock),
    });
    expect(v.tier).toBe("trivial");
    expect(v.viaHeuristic).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("heuristic miss + LLM fail → complex fallback", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const v = await classifyWithLLMFallback("the weather feels fine today.", {
      llm: llmOpts(fetchMock),
    });
    expect(v.tier).toBe("complex");
    expect(v.signals).toContain("llm-fallback-failed");
  });
});

describe("orchestrator routeAndAnswer", () => {
  // A fetch mock that responds differently depending on the prompt payload
  // — the classifier call embeds the routing prompt; the answer call sends
  // the user text directly. So we can tell them apart by the body.
  function dualMockFetch(classifierTier: string, answerText: string): typeof fetch {
    return vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const firstPartText: string = body?.contents?.[0]?.parts?.[0]?.text ?? "";
      // Classifier prompts include the literal "routing classifier" phrase.
      const isClassifier = firstPartText.includes("routing classifier");
      const text = isClassifier ? classifierTier : answerText;
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text }] } }] };
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  function opts(fetchMock: typeof fetch, extra: Record<string, unknown> = {}) {
    return {
      llm: { apiKey: "test-key", fetchImpl: fetchMock } satisfies LLMClassifyOptions,
      ...extra,
    };
  }

  test("trivial → Flash answers, answeredBy=flash", async () => {
    // "hi" is a heuristic hit (ack-or-greeting) → tier trivial → answer via
    // Flash (one fetch call, the classifier call is skipped).
    const fetchMock = dualMockFetch("unused", "hello!");
    const r = await routeAndAnswer("hi", opts(fetchMock));
    expect(r.verdict.tier).toBe("trivial");
    expect(r.answeredBy).toBe("flash");
    expect(r.answer).toBe("hello!");
    expect(r.answerModel).toBe("gemini-2.5-flash");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("contextual → Pro answers, answeredBy=pro", async () => {
    const fetchMock = dualMockFetch(
      "unused",
      "We talked about the peanut allergy and the memory graph.",
    );
    const r = await routeAndAnswer("what did we talk about yesterday?", opts(fetchMock));
    expect(r.verdict.tier).toBe("contextual");
    expect(r.answeredBy).toBe("pro");
    expect(r.answer).toContain("peanut");
    expect(r.answerModel).toBe("gemini-2.5-pro");
  });

  test("complex + callOpus delegate → answeredBy=opus-delegate", async () => {
    // Heuristic hit (engineering-verb) → complex. callOpus is invoked.
    const fetchMock = dualMockFetch("unused", "unused");
    const callOpus = vi.fn(async (t: string) => `opus answer to: ${t.slice(0, 20)}`);
    const r = await routeAndAnswer("refactor the engine to use sync writes", {
      ...opts(fetchMock),
      callOpus,
    });
    expect(r.verdict.tier).toBe("complex");
    expect(r.answeredBy).toBe("opus-delegate");
    expect(r.answer).toContain("opus answer to:");
    expect(callOpus).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("complex without callOpus → answeredBy=opus-absent, answer null", async () => {
    const fetchMock = dualMockFetch("unused", "unused");
    const r = await routeAndAnswer("refactor the engine to use sync writes", opts(fetchMock));
    expect(r.verdict.tier).toBe("complex");
    expect(r.answeredBy).toBe("opus-absent");
    expect(r.answer).toBeNull();
  });

  test("heuristic-miss + LLM classifier → trivial → Flash answers", async () => {
    // Short declarative, heuristic returns null → classifier LLM called →
    // returns "trivial" → then Flash is called for the answer. Two fetches.
    const fetchMock = dualMockFetch("trivial", "The weather is nice.");
    const r = await routeAndAnswer("the weather feels fine today.", opts(fetchMock));
    expect(r.verdict.tier).toBe("trivial");
    expect(r.verdict.viaHeuristic).toBe(false);
    expect(r.answeredBy).toBe("flash");
    expect(r.answer).toBe("The weather is nice.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("answer call fails → answeredBy=error, verdict preserved", async () => {
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      const first = body?.contents?.[0]?.parts?.[0]?.text ?? "";
      // Classifier path succeeds; answer path fails. (But 'hi' is a heuristic
      // hit — classifier isn't called. So first fetch IS the answer call
      // and we fail it.)
      if (first.includes("routing classifier")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { candidates: [{ content: { parts: [{ text: "trivial" }] } }] };
          },
        } as unknown as Response;
      }
      return {
        ok: false,
        status: 503,
        async text() {
          return "busy";
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await routeAndAnswer("hi", opts(fetchMock));
    expect(r.verdict.tier).toBe("trivial");
    expect(r.answeredBy).toBe("error");
    expect(r.answer).toBeNull();
    expect(r.verdict.signals.some((s) => s.startsWith("answer-error:"))).toBe(true);
  });

  test("opus delegate throws → answeredBy=error", async () => {
    const fetchMock = dualMockFetch("unused", "unused");
    const callOpus = vi.fn(async () => {
      throw new Error("subprocess spawn failed");
    });
    const r = await routeAndAnswer("refactor something", { ...opts(fetchMock), callOpus });
    expect(r.verdict.tier).toBe("complex");
    expect(r.answeredBy).toBe("error");
    expect(r.answer).toBeNull();
    expect(r.verdict.signals.some((s) => s.startsWith("opus-delegate-error:"))).toBe(true);
  });

  test("systemPrompt forwarded to Gemini answer call", async () => {
    let capturedSystem: string | undefined;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      capturedSystem = body?.systemInstruction?.parts?.[0]?.text;
      return {
        ok: true,
        status: 200,
        async json() {
          return { candidates: [{ content: { parts: [{ text: "ok" }] } }] };
        },
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await routeAndAnswer("hi", {
      ...opts(fetchMock),
      systemPrompt: "You are terse. Answer in ≤10 words.",
    });
    expect(capturedSystem).toContain("terse");
  });

  test("latencyMs is recorded", async () => {
    const fetchMock = dualMockFetch("unused", "hi back");
    const r = await routeAndAnswer("hi", opts(fetchMock));
    expect(typeof r.latencyMs).toBe("number");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
