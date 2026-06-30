import { describe, it, expect } from "vitest";
import { SceneSchema, VideoPlanSchema } from "../src/schemas.js";

const baseScene = { id: "s1", narration: "hi", image_prompt: "p", video_prompt: "v", duration_seconds: 4 };

describe("SceneSchema on_camera", () => {
  it("defaults on_camera to true (UGC talking-by-default)", () => {
    expect(SceneSchema.parse(baseScene).on_camera).toBe(true);
  });
  it("round-trips an explicit b-roll opt-out", () => {
    expect(SceneSchema.parse({ ...baseScene, on_camera: false }).on_camera).toBe(false);
  });
  it("preserves per-scene flags through VideoPlanSchema", () => {
    const plan = VideoPlanSchema.parse({
      title: "t",
      narration: "n",
      scenes: [{ ...baseScene, id: "a" }, { ...baseScene, id: "b", on_camera: false }],
    });
    expect(plan.scenes.map((s) => s.on_camera)).toEqual([true, false]);
  });
});

describe("VideoPlanSchema voice", () => {
  const basePlan = { title: "t", narration: "n", scenes: [baseScene] };

  it("defaults voice to null when omitted", () => {
    expect(VideoPlanSchema.parse(basePlan).voice).toBe(null);
  });

  it("accepts a valid catalog voice key", () => {
    expect(VideoPlanSchema.parse({ ...basePlan, voice: "sarah" }).voice).toBe("sarah");
  });

  it("rejects an unknown voice key", () => {
    expect(() => VideoPlanSchema.parse({ ...basePlan, voice: "bogus" })).toThrow();
  });
});
