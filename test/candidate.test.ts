import { describe, expect, it } from "vitest";
import { isDutyCandidate } from "../src/parser/candidate.js";
import { CANONICAL_LOG } from "./sample.js";

describe("candidate gate", () => {
  it("accepts the canonical log", () => {
    expect(isDutyCandidate(CANONICAL_LOG)).toBe(true);
  });

  it("accepts start and finish without a site line", () => {
    expect(isDutyCandidate("Start duty: 6.53\nFinish duty: 5.00pm")).toBe(true);
  });

  it("rejects chat that only mentions a site or a technician", () => {
    expect(isDutyCandidate("what site is the technician at today?")).toBe(false);
    expect(isDutyCandidate("Site: Al barsha NS147")).toBe(false);
  });
});
