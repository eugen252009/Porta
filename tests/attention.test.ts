import { describe, expect, it } from "vitest";
import { attentionFor, attentionTransition } from "../src/attention.js";

describe("attention state", () => {
  it("only marks explicit human attention", () => {
    expect(attentionFor({ status: "blocked", waitingFor: "machine" })).toEqual({ required: false });
    expect(attentionFor({ status: "blocked", waitingFor: "approval" })).toEqual({ required: true, reason: "approval_required" });
    expect(attentionFor({ status: "failed" })).toEqual({ required: true, reason: "execution_failed" });
  });
  it("deduplicates unresolved transitions", () => {
    const attention = { required: true, reason: "approval_required" as const };
    expect(attentionTransition({ required: false }, attention)).toBe(true);
    expect(attentionTransition(attention, attention)).toBe(false);
    expect(attentionTransition({ required: false }, attention)).toBe(true);
  });
});
