import { describe, it, expect } from "vitest";
import { YouTubeClipSectionSchema, YouTubeScriptPlanSchema } from "../src/schemas.js";

const baseSection = {
  section: 1,
  dialogue: "Patrick Mahomes drops back and fires a touchdown for the Chiefs.",
  search_hint: "Patrick Mahomes Chiefs touchdown",
};

describe("YouTubeClipSection duration tolerates fractional model output", () => {
  it("accepts a fractional duration_seconds (planner emits runtime+crossfade math)", () => {
    const parsed = YouTubeClipSectionSchema.parse({ ...baseSection, duration_seconds: 7.5 });
    expect(parsed.duration_seconds).toBeCloseTo(7.5, 3);
  });

  it("still accepts integer durations", () => {
    expect(YouTubeClipSectionSchema.parse({ ...baseSection, duration_seconds: 8 }).duration_seconds).toBe(8);
  });

  it("still enforces the 1..30 range", () => {
    expect(() => YouTubeClipSectionSchema.parse({ ...baseSection, duration_seconds: 0 })).toThrow();
    expect(() => YouTubeClipSectionSchema.parse({ ...baseSection, duration_seconds: 45 })).toThrow();
  });

  it("YouTubeScriptPlanSchema accepts a plan with a fractional section duration", () => {
    const plan = YouTubeScriptPlanSchema.parse({
      title: "Mahomes & the Chiefs",
      sections: [{ ...baseSection, duration_seconds: 7.5 }],
    });
    expect(plan.sections[0]!.duration_seconds).toBeCloseTo(7.5, 3);
  });
});
