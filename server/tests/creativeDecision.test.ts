import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import {
  creativeIntentBrief,
  inferCreativeIntent,
  validatePlanForCreativeIntent,
} from "../src/creativeDecision.js";
import { CreateProjectRequestSchema, type CreateProjectRequest, type Scene, type VideoPlan } from "../src/schemas.js";
import { initializeProjectState, readJsonArtifact } from "../src/renderState.js";
import { draftVideoPlanImpl } from "../src/workflows.js";

function request(prompt: string, overrides: Partial<CreateProjectRequest> = {}): CreateProjectRequest {
  return CreateProjectRequestSchema.parse({ prompt, ...overrides });
}

function ctx(projectDir = path.join(tmpdir(), "creative-decision-static")): ProjectContext {
  return {
    project_id: "creative-decision-test",
    project_dir: projectDir,
    aspect_ratio: "9:16",
    resolution: "720p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

function scene(id: string, overrides: Partial<Scene> = {}): Scene {
  return {
    id,
    narration: "I tried it once, and it immediately made the routine easier.",
    image_prompt: "A casual creator at a desk holding the product, natural phone-style UGC framing.",
    video_prompt: "Slow handheld push in.",
    duration_seconds: 8,
    on_camera: true,
    ...overrides,
  };
}

function plan(overrides: Partial<VideoPlan> = {}): VideoPlan {
  return {
    title: "AeroBottle TikTok ad",
    narration: "A creator forgets water, sees the reminder, proves the feature, and ends with a clear CTA.",
    visual_bible: "One casual creator, handheld workday footage, product closeups, realistic desk setup.",
    voice: null,
    scenes: [
      scene("scene_1", {
        narration: "I always forget water until my focus is already gone.",
        image_prompt: "A casual creator at a laptop noticing an untouched AeroBottle on the desk.",
      }),
      scene("scene_2", {
        narration: "The reminder lights up right when I need it.",
        image_prompt: "Close-up product proof of AeroBottle glowing beside the laptop with hydration tracking visible.",
        on_camera: false,
      }),
      scene("scene_3", {
        narration: "Try it today if your workday needs one less thing to remember.",
        image_prompt: "Final clean desk reveal with AeroBottle in the foreground and a creator reaction in the background.",
      }),
    ],
    ...overrides,
  };
}

describe("creative intent inference", () => {
  it("maps a TikTok smart-water-bottle ad to UGC conversion with product proof beats", () => {
    const intent = inferCreativeIntent(
      request(
        "can you make a 60 second tiktok style ad for a smart water bottle called AeroBottle? make it feel like a normal person filming during their workday. include closeups and a strong ending.",
        { duration_seconds: 60 },
      ),
      ctx(),
    );

    expect(intent.format).toBe("ugc");
    expect(intent.platform).toBe("tiktok");
    expect(intent.goal).toBe("conversion");
    expect(intent.speech_mode).toBe("inferred_creator_dialogue");
    expect(intent.required_beats).toEqual(expect.arrayContaining(["hook", "creator_reaction", "product_proof", "payoff_cta"]));
  });

  it("maps a cinematic product commercial without forcing a creator format", () => {
    const intent = inferCreativeIntent(request("Make a cinematic 40 second commercial for Coca-Cola with a final hero reveal."), ctx());

    expect(intent.format).toBe("cinematic_ad");
    expect(intent.required_beats).toEqual(expect.arrayContaining(["product_proof", "payoff_cta"]));
    expect(intent.required_beats).not.toContain("creator_reaction");
  });

  it("keeps quoted user speech as spoken dictation", () => {
    const intent = inferCreativeIntent(request('Make a UGC ad where she says "I forgot water again, then AeroBottle saved me."'), ctx());

    expect(intent.speech_mode).toBe("quoted_user_speech");
  });

  it("treats unquoted closeup/caption requests as visual direction, not dictation", () => {
    const intent = inferCreativeIntent(
      request("Make a cinematic product video for GlowBar. Show closeups of brightness settings and include captions."),
      ctx(),
    );

    expect(intent.speech_mode).toBe("mostly_visual");
  });

  it("maps edit prompts to edit goal without implying a fresh full generation", () => {
    const intent = inferCreativeIntent(request("Change scene 2 so the product closeup is faster and trim the ending."), ctx());

    expect(intent.goal).toBe("edit");
  });

  it("prints a compact brief for the planning prompt", () => {
    const brief = creativeIntentBrief(inferCreativeIntent(request("Make a TikTok UGC ad for a smart bottle."), ctx()));

    expect(brief).toContain("Format intent");
    expect(brief).toContain("Speech interpretation");
    expect(brief).toContain("Required first-run beats");
    expect(brief).toContain("Provider-cost rule");
  });
});

describe("creative intent plan validation", () => {
  it("passes a good UGC plan with hook, creator, product proof, and CTA", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle with closeups and a strong CTA.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());

    expect(validatePlanForCreativeIntent(plan(), intent, req)).toEqual([]);
  });

  it("rejects narration that leaks visual directions or schema words", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({ scenes: [scene("scene_1", { narration: "Close-up shot of the bottle, image_prompt goes here." })] }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("visual directions or schema words");
  });

  it("rejects UGC product plans that have no b-roll or proof beat", () => {
    const req = request("Make a TikTok UGC ad for AeroBottle.", { duration_seconds: 30 });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", { image_prompt: "A creator talking in a bedroom." }),
          scene("scene_2", { image_prompt: "The same creator talking in a bedroom." }),
          scene("scene_3", { image_prompt: "The creator still talking in a bedroom." }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("Product-oriented plans need");
  });

  it("allows cinematic product plans without an on-camera creator when proof and payoff exist", () => {
    const req = request("Make a cinematic commercial for AeroBottle with product closeups and a final reveal.", {
      duration_seconds: 30,
    });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        title: "Cinematic commercial",
        scenes: [
          scene("scene_1", {
            image_prompt: "Macro product close-up of AeroBottle glowing beside a laptop.",
            on_camera: false,
          }),
          scene("scene_2", {
            image_prompt: "Hands using AeroBottle hydration tracking during focused work.",
            on_camera: false,
          }),
          scene("scene_3", {
            image_prompt: "Final product reveal with a clear desk result and CTA composition.",
            on_camera: false,
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues).toEqual([]);
  });

  it("rejects unsupported I2V durations and risky motion prompts before provider calls", () => {
    const req = request("Make a cinematic product demo for AeroBottle.", {
      duration_seconds: 30,
      video_model: "kling-2.5",
    });
    const intent = inferCreativeIntent(req, ctx());
    const issues = validatePlanForCreativeIntent(
      plan({
        scenes: [
          scene("scene_1", {
            duration_seconds: 13,
            on_camera: false,
            video_prompt: "Cut to a new scene where a logo appears.",
          }),
        ],
      }),
      intent,
      req,
    );

    expect(issues.join(" ")).toContain("not supported");
    expect(issues.join(" ")).toContain("ungrounded motion");
  });
});

describe("draftVideoPlanImpl pre-provider repair gate", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns one structured repair result before failing a second invalid draft", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "creative-draft-gate-"));
    dirs.push(dir);
    const projectCtx = ctx(dir);
    initializeProjectState(projectCtx, {
      user_preferences: request("Make a TikTok UGC ad for AeroBottle with closeups.", { duration_seconds: 30 }),
    });

    const invalidScenes = [
      scene("temporary", {
        narration: "Close-up shot of the product, video_prompt should show the logo.",
        video_prompt: "Cut to a new scene where a logo appears.",
      }),
    ];
    const first = await draftVideoPlanImpl(projectCtx, "Bad plan", "Bad narration", invalidScenes, "");

    expect(first.validation_failed).toBe(true);
    expect(first.next_tools).toEqual(["draft_video_plan"]);
    expect(readJsonArtifact(projectCtx, "plan", null)).toBeNull();
    expect(existsSync(path.join(dir, "plan.json"))).toBe(false);

    await expect(draftVideoPlanImpl(projectCtx, "Bad plan", "Bad narration", invalidScenes, "")).rejects.toThrow(
      /first-run production quality checks/,
    );
  });
});
