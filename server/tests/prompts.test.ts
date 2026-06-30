import { describe, expect, it } from "vitest";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import { CreateProjectRequestSchema } from "../src/schemas.js";
import { INSTRUCTIONS, PLANNING_INSTRUCTIONS, buildGenerationBrief, magicHourModelCatalogForAgent } from "../src/prompts.js";

describe("INSTRUCTIONS talking-by-default contract", () => {
  it("documents on_camera and first-person dialogue default", () => {
    expect(INSTRUCTIONS).toContain("on_camera");
    expect(INSTRUCTIONS).toContain("first-person");
  });

  it("keeps the video-prompt camera/subject-motion-only rule (b-roll regression)", () => {
    expect(INSTRUCTIONS).toContain("camera motion and subject motion only");
  });

  it("warns against re-rendering scenes that already succeeded", () => {
    expect(INSTRUCTIONS).toContain("already succeeded");
  });

  it("warns against adding a global voiceover for talking videos", () => {
    expect(INSTRUCTIONS).toContain("replace_voiceover");
    expect(INSTRUCTIONS).toContain("on-camera");
  });

  it("prioritizes first-run quality without broad rerenders", () => {
    expect(INSTRUCTIONS).toContain("First-run quality");
    expect(INSTRUCTIONS).toContain("automatic rerenders");
  });
});

describe("PLANNING_INSTRUCTIONS talking-by-default contract", () => {
  it("documents on_camera", () => {
    expect(PLANNING_INSTRUCTIONS).toContain("on_camera");
  });

  it("documents the voice catalog so the planner picks a character-matched voice", () => {
    expect(PLANNING_INSTRUCTIONS).toContain("voice");
    expect(PLANNING_INSTRUCTIONS).toContain("sarah");
    expect(PLANNING_INSTRUCTIONS).toContain("ethan");
  });

  it("requires format intent, proof beats, and stronger scene pacing in the first plan", () => {
    expect(PLANNING_INSTRUCTIONS).toContain("format intent");
    expect(PLANNING_INSTRUCTIONS).toContain("proof/demo/closeup");
    expect(PLANNING_INSTRUCTIONS).toContain("7-13 second scenes");
  });
});

describe("buildGenerationBrief creative intent profile", () => {
  it("injects the first-run creative intent profile into the planner brief", () => {
    const request = CreateProjectRequestSchema.parse({
      prompt: "Make a TikTok UGC ad for AeroBottle with product closeups and a strong CTA.",
      duration_seconds: 30,
    });
    const brief = buildGenerationBrief(request, {
      project_id: "prompt-test",
      project_dir: "/tmp/prompt-test",
      aspect_ratio: "9:16",
      resolution: "720p",
      ...PROJECT_CONTEXT_DEFAULTS,
    });

    expect(brief).toContain("Creative intent profile");
    expect(brief).toContain("Format intent: ugc");
    expect(brief).toContain("Required first-run beats");
  });
});

describe("ltx-2.3 model catalog blurb", () => {
  it("describes the AI Talking Photo pass", () => {
    expect(magicHourModelCatalogForAgent()).toContain("talking photo");
  });
});
