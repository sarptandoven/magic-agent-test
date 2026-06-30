import { describe, expect, it } from "vitest";
import { validateProductionVideoPlan } from "../src/workflows.js";
import type { VideoPlan } from "../src/schemas.js";

function scene(id: string, overrides: Partial<VideoPlan["scenes"][number]> = {}): VideoPlan["scenes"][number] {
  return {
    id,
    narration: "I use it once, and the difference is obvious.",
    image_prompt: "A creator at a bright desk holding the product near the camera, natural daylight, handheld UGC framing.",
    video_prompt: "Slow handheld push in while the creator smiles.",
    duration_seconds: 8,
    on_camera: true,
    ...overrides,
  };
}

function plan(overrides: Partial<VideoPlan> = {}): VideoPlan {
  return {
    title: "AeroBottle UGC product ad",
    narration: "A creator forgets water, tries AeroBottle, shows the reminder, and ends with a clear payoff.",
    visual_bible: "One relatable creator, natural workday desk, handheld phone-style footage, clean product closeups.",
    voice: null,
    scenes: [
      scene("scene_1", {
        narration: "I kept forgetting to drink water halfway through my workday.",
        image_prompt: "A creator at a cluttered desk noticing a dry water bottle beside a laptop.",
      }),
      scene("scene_2", {
        narration: "Then AeroBottle reminded me before I even felt tired.",
        image_prompt: "Close-up of AeroBottle glowing gently beside the laptop, creator reacting in the background.",
        on_camera: false,
      }),
      scene("scene_3", {
        narration: "Now I actually finish the day hydrated, without thinking about it.",
        image_prompt: "Final clean desk reveal with AeroBottle in the foreground and the creator giving a relaxed thumbs up.",
        video_prompt: "Slow push toward the product and final desk reveal.",
      }),
    ],
    ...overrides,
  };
}

describe("validateProductionVideoPlan", () => {
  it("passes a compact UGC plan with creator, proof, and payoff beats", () => {
    expect(validateProductionVideoPlan(plan())).toEqual([]);
  });

  it("rejects narration that leaks camera or visual directions into spoken copy", () => {
    const issues = validateProductionVideoPlan(
      plan({
        scenes: [
          scene("scene_1", {
            narration: "Close-up of the bottle on the desk while the camera pans.",
          }),
          scene("scene_2"),
          scene("scene_3"),
        ],
      }),
    );

    expect(issues.join(" ")).toContain("visual/camera instructions");
  });

  it("rejects longer videos made from too many tiny scenes", () => {
    const issues = validateProductionVideoPlan(
      plan({
        scenes: Array.from({ length: 8 }, (_, index) =>
          scene(`scene_${index + 1}`, {
            duration_seconds: 4,
            narration: "This moment moves fast.",
          }),
        ),
      }),
    );

    expect(issues.join(" ")).toContain("sub-5s scenes");
  });

  it("rejects UGC/product plans without visible proof or payoff beats", () => {
    const issues = validateProductionVideoPlan(
      plan({
        scenes: [
          scene("scene_1", { image_prompt: "A creator talking in a bedroom." }),
          scene("scene_2", { image_prompt: "The creator keeps talking in the same bedroom." }),
          scene("scene_3", { image_prompt: "The creator continues talking in the same bedroom." }),
        ],
      }),
    );

    expect(issues.join(" ")).toContain("visible proof");
    expect(issues.join(" ")).toContain("payoff");
  });

  it("does not force an on-camera creator for cinematic commercial plans", () => {
    const issues = validateProductionVideoPlan(
      plan({
        title: "Cinematic brand commercial",
        narration: "A polished product film shows the bottle solving a real desk problem.",
        visual_bible: "Moody practical light, product macro shots, clean desk reveal, no presenter.",
        scenes: [
          scene("scene_1", {
            narration: "The reminder arrives before the day gets away.",
            image_prompt: "Macro product close-up of AeroBottle glowing beside a laptop, premium commercial lighting.",
            video_prompt: "Slow macro push toward the glowing bottle.",
            on_camera: false,
          }),
          scene("scene_2", {
            narration: "A simple rhythm turns scattered focus into a better workday.",
            image_prompt: "Hands using the bottle during focused work, visible hydration tracking on the bottle.",
            video_prompt: "Gentle handheld slide across the desk setup.",
            on_camera: false,
          }),
          scene("scene_3", {
            narration: "End the day clear, steady, and hydrated.",
            image_prompt: "Final product reveal on a clean desk with a clear result and polished CTA composition.",
            video_prompt: "Slow push toward the product and final result reveal.",
            on_camera: false,
          }),
        ],
      }),
    );

    expect(issues).toEqual([]);
  });

  it("rejects creator-style plans that never show the creator on camera", () => {
    const issues = validateProductionVideoPlan(
      plan({
        title: "AeroBottle TikTok UGC ad",
        scenes: [
          scene("scene_1", { on_camera: false }),
          scene("scene_2", { on_camera: false }),
          scene("scene_3", { on_camera: false }),
        ],
      }),
    );

    expect(issues.join(" ")).toContain("creator/reaction beat");
  });
});
