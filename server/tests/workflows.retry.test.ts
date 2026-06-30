import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
// `withMediaUrl` (called at the end of the recovery impls) rejects asset paths
// outside OUTPUT_DIR, so the temp project dir must live under it.
import { OUTPUT_DIR } from "../src/config.js";
import type { Scene, VideoPlan } from "../src/schemas.js";
import { FISH_AUDIO_VOICES } from "../src/voices.js";

// --- media.ts mock --------------------------------------------------------
// The recovery tools (`retrySceneWithModelsImpl` / `regenerateSceneImpl`) must
// re-render a scene's video through the SAME render mechanism the scene was
// authored with: on-camera scenes via `generateTalkingClip` (image + per-scene
// audio), b-roll via `generateVideoAsset` (silent imageToVideo). We stub those
// three render-boundary functions and keep every other export real.
const generateTalkingClip = vi.fn();
const generateVideoAsset = vi.fn();
const generateSceneVoiceovers = vi.fn();
// `regenerateSceneImpl` regenerates the keyframe image by default, so stub it to
// avoid touching a real image provider.
const generateImageAsset = vi.fn();

vi.mock("../src/media.js", async () => {
  const actual = await vi.importActual<typeof import("../src/media.js")>("../src/media.js");
  return {
    ...actual,
    generateTalkingClip,
    generateVideoAsset,
    generateSceneVoiceovers,
    generateImageAsset,
  };
});

// Imported AFTER vi.mock so the mocked media boundary is wired in.
const { retrySceneWithModelsImpl, regenerateSceneImpl } = await import("../src/workflows.js");
const { readJsonArtifact, writeJsonArtifact } = await import("../src/renderState.js");

function makeScene(overrides: Partial<Scene> & Pick<Scene, "id">): Scene {
  return {
    narration: "",
    image_prompt: "an image",
    video_prompt: "a video",
    duration_seconds: 2,
    on_camera: true,
    ...overrides,
  };
}

function testContext(projectDir: string): ProjectContext {
  return {
    project_id: "workflows-retry-test",
    project_dir: projectDir,
    aspect_ratio: "16:9",
    resolution: "720p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

function seedPlanImagesVideos(
  ctx: ProjectContext,
  scenes: Scene[],
  planOverrides: Partial<Pick<VideoPlan, "voice" | "visual_bible">> = {},
): void {
  const plan: VideoPlan = {
    title: "Test plan",
    narration: "overall narration",
    visual_bible: "",
    scenes,
    voice: null,
    ...planOverrides,
  };
  writeJsonArtifact(ctx, "plan", plan);
  const images = scenes.map((scene) => ({
    scene_id: scene.id,
    path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
    prompt: scene.image_prompt,
    model: ctx.image_model,
    resolution: ctx.image_resolution,
    style_tool: ctx.image_style_tool,
    provider_job_id: null,
    provider_url: null,
  }));
  writeJsonArtifact(ctx, "images", images);
  // Pre-existing silent clips (the broken/transient render we are retrying).
  const videos = scenes.map((scene) => silentClipFor(ctx, scene));
  writeJsonArtifact(ctx, "videos", videos);
}

function silentClipFor(ctx: ProjectContext, scene: Scene) {
  return {
    scene_id: scene.id,
    path: path.join(ctx.project_dir, "videos", `${scene.id}.mp4`),
    prompt: scene.video_prompt,
    model: ctx.video_model,
    resolution: ctx.resolution,
    audio: false,
    duration_seconds: scene.duration_seconds,
    provider_job_id: null,
    provider_url: null,
  };
}

function talkingClipFor(ctx: ProjectContext, scene: Scene, audioPath: string, audioDuration: number) {
  return {
    scene_id: scene.id,
    path: path.join(ctx.project_dir, "videos", scene.id, "talking", "talking.mp4"),
    prompt: scene.video_prompt,
    model: "ai-talking-photo",
    resolution: ctx.resolution,
    audio: true,
    duration_seconds: audioDuration,
    provider_job_id: "talk1",
    provider_url: null,
    has_embedded_audio: true,
    on_camera: true,
    audio_path: audioPath,
    audio_duration_seconds: audioDuration,
  };
}

let projectDir: string;
let ctx: ProjectContext;

beforeEach(() => {
  projectDir = mkdtempSync(path.join(OUTPUT_DIR, "workflows-retry-"));
  ctx = testContext(projectDir);
  generateTalkingClip.mockReset();
  generateVideoAsset.mockReset();
  generateSceneVoiceovers.mockReset();
  generateImageAsset.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectDir, { recursive: true, force: true });
});

describe("retrySceneWithModelsImpl talking-aware video recovery", () => {
  it("retrying an on_camera scene's video re-renders via aiTalkingPhoto with the resolved voice (NOT silent imageToVideo)", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    // Female visual bible → the resolver picks the female-default (sarah) voice id.
    seedPlanImagesVideos(ctx, [talking], {
      visual_bible: "She is a woman, a young female creator.",
    });

    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockImplementation(async (_ctx, scene: Scene, _imagePath, audioPath, audioDuration) =>
      talkingClipFor(ctx, scene, audioPath, audioDuration),
    );

    await retrySceneWithModelsImpl(ctx, "scene_1", "video");

    // Per-scene TTS ran with the resolved (female-default) reference id.
    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    const voScenes = generateSceneVoiceovers.mock.calls[0]![1] as Scene[];
    expect(voScenes.map((s) => s.id)).toEqual(["scene_1"]);
    expect(generateSceneVoiceovers.mock.calls[0]![2]).toBe(FISH_AUDIO_VOICES.sarah!.reference_id);

    // Talking clip rendered from the scene's IMAGE path + its per-scene audio.
    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    const [, talkScene, imagePath, audioPath, audioDuration] = generateTalkingClip.mock.calls[0]!;
    expect((talkScene as Scene).id).toBe("scene_1");
    expect(imagePath).toBe(path.join(ctx.project_dir, "images", "scene_1.png"));
    expect(audioPath).toBe(path.join(ctx.project_dir, "voiceover", "scenes", "scene_1.mp3"));
    expect(audioDuration).toBe(2.5);

    // The talking treatment is preserved — silent imageToVideo is NOT used.
    expect(generateVideoAsset).not.toHaveBeenCalled();

    // Persisted video carries the talking treatment.
    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const persisted = videos.find((v) => v.scene_id === "scene_1");
    expect(persisted.model).toBe("ai-talking-photo");
    expect(persisted.on_camera).toBe(true);
    expect(persisted.has_embedded_audio).toBe(true);
    expect(persisted.path).toBe(path.join(ctx.project_dir, "videos", "scene_1", "talking", "talking.mp4"));
  });

  it("retrying a b-roll scene's video re-renders via silent imageToVideo (NOT aiTalkingPhoto)", async () => {
    const broll = makeScene({ id: "scene_1", narration: "voiceover only", on_camera: false });
    seedPlanImagesVideos(ctx, [broll]);

    generateVideoAsset.mockImplementation(async (_ctx, scene: Scene) => silentClipFor(ctx, scene));

    await retrySceneWithModelsImpl(ctx, "scene_1", "video");

    expect(generateVideoAsset).toHaveBeenCalledTimes(1);
    const [, brollScene] = generateVideoAsset.mock.calls[0]!;
    expect((brollScene as Scene).id).toBe("scene_1");
    expect(generateTalkingClip).not.toHaveBeenCalled();
    expect(generateSceneVoiceovers).not.toHaveBeenCalled();

    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const persisted = videos.find((v) => v.scene_id === "scene_1");
    expect(persisted.has_embedded_audio).toBeUndefined();
    expect(persisted.path).toBe(path.join(ctx.project_dir, "videos", "scene_1.mp4"));
  });

  it("clears a stale prior 'talking' failure after a successful talking re-render", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanImagesVideos(ctx, [talking]);
    // A prior render recorded a soft "talking" failure for this scene.
    writeJsonArtifact(ctx, "failed_scenes", [
      { scene_id: "scene_1", stage: "talking", error: "AI Talking Photo timed out" },
    ]);

    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockImplementation(async (_ctx, scene: Scene, _imagePath, audioPath, audioDuration) =>
      talkingClipFor(ctx, scene, audioPath, audioDuration),
    );

    await retrySceneWithModelsImpl(ctx, "scene_1", "video");

    // The stale talking failure must be gone from the persisted artifact.
    const failures = readJsonArtifact<any[]>(ctx, "failed_scenes", [])!;
    expect(failures.some((f) => f.scene_id === "scene_1" && f.stage === "talking")).toBe(false);
  });

  it("on a hard talking-render failure, retry falls back to a silent imageToVideo clip so the scene still appears", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanImagesVideos(ctx, [talking]);

    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockRejectedValue(new Error("talking boom"));
    generateVideoAsset.mockImplementation(async (_ctx, scene: Scene) => silentClipFor(ctx, scene));

    await retrySceneWithModelsImpl(ctx, "scene_1", "video");

    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    expect(generateVideoAsset).toHaveBeenCalledTimes(1);
    const [, fallbackScene] = generateVideoAsset.mock.calls[0]!;
    expect((fallbackScene as Scene).id).toBe("scene_1");

    // The scene still appears, as the silent fallback clip.
    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const persisted = videos.find((v) => v.scene_id === "scene_1");
    expect(persisted.path).toBe(path.join(ctx.project_dir, "videos", "scene_1.mp4"));
    expect(persisted.has_embedded_audio).toBeUndefined();
  });
});

describe("regenerateSceneImpl talking-aware video recovery", () => {
  it("regenerating an on_camera scene re-renders the video via aiTalkingPhoto (preserves the talking treatment)", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanImagesVideos(ctx, [talking], { voice: "jasphina" });

    generateImageAsset.mockImplementation(async (_ctx, scene: Scene) => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: ctx.image_style_tool,
      provider_job_id: null,
      provider_url: null,
    }));
    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockImplementation(async (_ctx, scene: Scene, _imagePath, audioPath, audioDuration) =>
      talkingClipFor(ctx, scene, audioPath, audioDuration),
    );

    await regenerateSceneImpl(ctx, "scene_1");

    // Resolved to the explicitly chosen catalog voice.
    expect(generateSceneVoiceovers).toHaveBeenCalledTimes(1);
    expect(generateSceneVoiceovers.mock.calls[0]![2]).toBe(FISH_AUDIO_VOICES.jasphina!.reference_id);

    expect(generateTalkingClip).toHaveBeenCalledTimes(1);
    expect(generateVideoAsset).not.toHaveBeenCalled();

    const videos = readJsonArtifact<any[]>(ctx, "videos", [])!;
    const persisted = videos.find((v) => v.scene_id === "scene_1");
    expect(persisted.model).toBe("ai-talking-photo");
    expect(persisted.on_camera).toBe(true);
    expect(persisted.has_embedded_audio).toBe(true);
  });

  it("clears a stale prior 'talking' failure after a successful regenerate", async () => {
    const talking = makeScene({ id: "scene_1", narration: "I am talking", on_camera: true });
    seedPlanImagesVideos(ctx, [talking]);
    writeJsonArtifact(ctx, "failed_scenes", [
      { scene_id: "scene_1", stage: "talking", error: "AI Talking Photo timed out" },
    ]);

    generateImageAsset.mockImplementation(async (_ctx, scene: Scene) => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: ctx.image_style_tool,
      provider_job_id: null,
      provider_url: null,
    }));
    generateSceneVoiceovers.mockImplementation(async (_ctx, scenes: Scene[]) =>
      scenes.map((scene) => ({
        scene_id: scene.id,
        path: path.join(ctx.project_dir, "voiceover", "scenes", `${scene.id}.mp3`),
        duration_seconds: 2.5,
      })),
    );
    generateTalkingClip.mockImplementation(async (_ctx, scene: Scene, _imagePath, audioPath, audioDuration) =>
      talkingClipFor(ctx, scene, audioPath, audioDuration),
    );

    await regenerateSceneImpl(ctx, "scene_1");

    const failures = readJsonArtifact<any[]>(ctx, "failed_scenes", [])!;
    expect(failures.some((f) => f.scene_id === "scene_1" && f.stage === "talking")).toBe(false);
  });

  it("regenerating a b-roll scene re-renders the video via silent imageToVideo (NOT aiTalkingPhoto)", async () => {
    const broll = makeScene({ id: "scene_1", narration: "voiceover only", on_camera: false });
    seedPlanImagesVideos(ctx, [broll]);

    generateImageAsset.mockImplementation(async (_ctx, scene: Scene) => ({
      scene_id: scene.id,
      path: path.join(ctx.project_dir, "images", `${scene.id}.png`),
      prompt: scene.image_prompt,
      model: ctx.image_model,
      resolution: ctx.image_resolution,
      style_tool: ctx.image_style_tool,
      provider_job_id: null,
      provider_url: null,
    }));
    generateVideoAsset.mockImplementation(async (_ctx, scene: Scene) => silentClipFor(ctx, scene));

    await regenerateSceneImpl(ctx, "scene_1");

    expect(generateVideoAsset).toHaveBeenCalledTimes(1);
    expect(generateTalkingClip).not.toHaveBeenCalled();
    expect(generateSceneVoiceovers).not.toHaveBeenCalled();
  });
});
