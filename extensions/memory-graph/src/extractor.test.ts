import { describe, expect, test } from "vitest";
import { extractClaims } from "./extractor.js";

describe("extractClaims", () => {
  test("direct remember becomes a high-confidence fact", () => {
    const claims = extractClaims("Please remember that I'm allergic to peanuts.");
    const fact = claims.find((c) => c.kind === "fact");
    expect(fact).toBeDefined();
    expect(fact?.summary.toLowerCase()).toContain("allergic to peanuts");
    expect(fact!.confidence).toBeGreaterThanOrEqual(0.95);
  });

  test("identity fact is captured", () => {
    const claims = extractClaims("I'm from Kampala.");
    const fact = claims.find((c) => c.kind === "fact");
    expect(fact?.summary.toLowerCase()).toContain("from kampala");
  });

  test("possessive identity", () => {
    const claims = extractClaims("My wife is Sarah and my birthday is April 2.");
    const summaries = claims.filter((c) => c.kind === "fact").map((c) => c.summary.toLowerCase());
    expect(summaries.some((s) => s.includes("wife is sarah"))).toBe(true);
    expect(summaries.some((s) => s.includes("birthday is april 2"))).toBe(true);
  });

  test("favorite preferences", () => {
    const claims = extractClaims("My favorite color is cobalt blue.");
    const pref = claims.find((c) => c.kind === "preference");
    expect(pref?.summary.toLowerCase()).toContain("color");
    expect(pref?.summary.toLowerCase()).toContain("cobalt blue");
    expect(pref!.confidence).toBeGreaterThanOrEqual(0.85);
  });

  test("generic like is a lower-confidence preference", () => {
    const claims = extractClaims("I love oat milk.");
    const pref = claims.find((c) => c.kind === "preference");
    expect(pref?.summary.toLowerCase()).toContain("love");
    expect(pref!.confidence).toBeLessThanOrEqual(0.8);
  });

  test("open-loop from 'remind me to'", () => {
    const claims = extractClaims("Remind me to follow up with Ryan about the eBook.");
    const loop = claims.find((c) => c.kind === "open-loop");
    expect(loop?.summary.toLowerCase()).toContain("follow up with ryan");
  });

  test("open-loop from 'I need to'", () => {
    const claims = extractClaims("I need to finish Chapter 4 before Friday.");
    const loop = claims.find((c) => c.kind === "open-loop");
    expect(loop?.summary.toLowerCase()).toContain("chapter 4");
  });

  test("constraint from 'I can't'", () => {
    const claims = extractClaims("I can't work past 6pm on weekdays.");
    const c = claims.find((c) => c.kind === "constraint");
    expect(c?.summary.toLowerCase()).toContain("work past 6pm");
  });

  test("constraint from 'never'", () => {
    const claims = extractClaims("Please never book flights through that airline.");
    const c = claims.find((c) => c.kind === "constraint");
    expect(c?.summary.toLowerCase()).toContain("book flights");
  });

  test("empty input returns empty array", () => {
    expect(extractClaims("")).toEqual([]);
    expect(extractClaims("   ")).toEqual([]);
  });

  test("dedupes identical claims", () => {
    const claims = extractClaims("I'm allergic to peanuts. Also, I'm allergic to peanuts.");
    const peanutClaims = claims.filter((c) =>
      c.summary.toLowerCase().includes("allergic to peanuts"),
    );
    expect(peanutClaims).toHaveLength(1);
  });

  test("captures multiple distinct claims in one sentence", () => {
    const claims = extractClaims("My favorite color is cobalt blue and I'm allergic to peanuts.");
    const kinds = new Set(claims.map((c) => c.kind));
    expect(kinds.has("fact")).toBe(true);
    expect(kinds.has("preference")).toBe(true);
  });

  test("ignores claims that would produce empty summaries", () => {
    expect(extractClaims("remember.")).toEqual([]);
    expect(extractClaims("I like.")).toEqual([]);
  });
});
