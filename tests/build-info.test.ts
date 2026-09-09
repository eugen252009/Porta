import { describe, expect, it } from "vitest";
import { buildInfo } from "../src/build-info.js";
describe("build metadata", () => {
  it("returns injected identity without unrelated environment data", () => {
    expect(buildInfo({ PORTA_VERSION: "0.1.0", PORTA_GIT_COMMIT: "abc", PORTA_BUILD_ID: "abc-dirty-x", PORTA_BUILD_DIRTY: "true", PORTA_BUILT_AT: "2026-01-01T00:00:00Z", SECRET: "hidden" })).toEqual({ version: "0.1.0", commit: "abc", buildId: "abc-dirty-x", dirty: true, builtAt: "2026-01-01T00:00:00Z" });
  });
  it("uses safe development fallbacks", () => expect(buildInfo({})).toEqual({ version: "0.1.0", commit: "unknown", buildId: "development", dirty: null }));
});
