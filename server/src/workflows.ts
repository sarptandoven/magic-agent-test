import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ENV } from "./config.js";
import type { ProjectContext } from "./context.js";
import { inferCreativeIntent, validatePlanForCreativeIntent } from "./creativeDecision.js";
import {
  anyEmbeddedAudio,
  generateImageAsset,
  generateSceneVoiceovers,
  generateSectionVoiceovers,
  generateTalkingClip,
  generateVideoAsset,
  generateVideoAssetsBatch,
  generateVoiceoverAsset,
  combineSectionVoiceovers,
  providerErrorMessage,
  providerJobFailureMetadata,
  probeMediaStreamDurations,
  recoverVideoAssetFromProviderJob,
  stitchAssets,
  stitchMixedAssets,
  stitchTimelineAssets,
  stitchAssetsPerSection,
  type PerSectionScene,
  type RecoverVideoAssetJob,
  type SectionVoiceover,
  type VideoAsset,
} from "./media.js";
import { boolSetting, inferYoutubeOutputAspectRatio, requestFromProjectState } from "./projectContext.js";
import { exportYoutubeFinalVideo, publicMediaPath, withMediaUrl } from "./projects.js";
import {
  countSpokenWords,
  compactWords,
  explicitTargetFinalDurationSeconds,
  fishAudioExpressionCues,
  normalizeYoutubeSectionsForProject,
} from "./prompts.js";
import {
  appendProjectDecision,
  artifactPath,
  clearSceneFailures,
  orderedSceneAssets,
  readJsonArtifact,
  readProjectState,
  recordSceneFailures,
  removeJsonArtifact,
  updateProjectState,
  upsertSceneAssets,
  writeJsonArtifact,
} from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import {
  MAGIC_IMAGE_MODELS,
  MAGIC_IMAGE_MODEL_RESOLUTIONS,
  MAGIC_IMAGE_RESOLUTIONS,
  MAGIC_IMAGE_STYLE_TOOLS,
  MAGIC_VIDEO_MODELS,
  MAGIC_VIDEO_MODEL_DURATIONS,
  MAGIC_VIDEO_MODEL_RESOLUTIONS,
  VideoPlanSchema,
  type Scene,
  type SceneNarrationRevision,
  type VideoPlan,
  type YouTubeClipSection,
} from "./schemas.js";
import {
  buildTimelineFromProjectState,
  inspectTimeline,
  moveClip,
  normalizeTimeline,
  setFinalHold,
  timelineSummary,
  trimClip,
  type TimelineArtifact,
  type TimelineClip,
} from "./timeline.js";
import { pendingTokenOutput } from "./usageCost.js";
import { resolveVoiceReferenceId } from "./voices.js";
import { downloadYoutubeClipAssets } from "./youtubeShort.js";

export function normalizePlan(plan: VideoPlan): VideoPlan {
  const visualBible = compactWords(plan.visual_bible, 60);
  const scenes = plan.scenes.map((scene, index) => ({
    ...scene,
    id: `scene_${index + 1}`,
    image_prompt: scene.image_prompt.split(/\s+/).filter(Boolean).join(" "),
    video_prompt: scene.video_prompt.split(/\s+/).filter(Boolean).join(" "),
  }));
  return { ...plan, visual_bible: visualBible, scenes };
}

const VISUAL_LEAK_IN_NARRATION =
  /\b(camera|wide shot|close[- ]?up|b[- ]?roll|subtitle|caption|text overlay|scene shows|image prompt|video prompt|cut to)\b/i;
const UNGROUNDED_MOTION_PROMPT =
  /\b(cut to|suddenly|new scene|new location|transforms?|appears|disappears|subtitle|caption|text overlay|logo appears)\b/i;
const PRODUCT_OR_COMMERCIAL_PLAN =
  /\b(ad|commercial|product|demo|launch|app|tool|bottle|lamp|brand)\b/i;
const CREATOR_STYLE_PLAN =
  /\b(ugc|tiktok|reel|testimonial|founder|day[- ]?in[- ]?life|normal person|creator|influencer)\b/i;
const PROOF_BEAT =
  /\b(product|close[- ]?up|demo|use|using|shows?|proof|result|before|after|setting|feature|screen|desk|bottle|lamp|app|tool)\b/i;
const PAYOFF_BEAT =
  /\b(payoff|result|reveal|final|finish|focused|empty|cta|try|download|buy|visit|switch|start|today|now|grab|shop|order|get one|get yours|ending|end)\b/i;

export function validateProductionVideoPlan(plan: VideoPlan): string[] {
  const issues: string[] = [];
  const totalDuration = planDurationSeconds(plan);
  const scenes = plan.scenes;
  const planText = [plan.title, plan.narration, plan.visual_bible, ...scenes.flatMap((scene) => [
    scene.narration,
    scene.image_prompt,
    scene.video_prompt,
  ])].join(" ");

  scenes.forEach((scene) => {
    const words = countSpokenWords(scene.narration);
    const maxWords = Math.max(7, Math.floor(scene.duration_seconds * (scene.on_camera ? 2.7 : 3.0)));
    if (words > maxWords) {
      issues.push(
        `${scene.id} narration is too dense for ${scene.duration_seconds}s (${words} words, max ${maxWords}).`,
      );
    }
    if (VISUAL_LEAK_IN_NARRATION.test(scene.narration)) {
      issues.push(`${scene.id} narration contains visual/camera instructions; move those to image_prompt or video_prompt.`);
    }
    if (UNGROUNDED_MOTION_PROMPT.test(scene.video_prompt)) {
      issues.push(`${scene.id} video_prompt asks for cuts, new objects, text, or ungrounded motion.`);
    }
  });

  if (totalDuration >= 24 && scenes.filter((scene) => scene.duration_seconds < 5).length > 1) {
    issues.push("Longer videos may not use multiple sub-5s scenes; they feel rushed and hurt continuity.");
  }
  if (totalDuration >= 30 && totalDuration / scenes.length < 6) {
    issues.push("Average scene duration is below 6s for a longer video; use fewer, stronger scenes.");
  }

  if (totalDuration >= 20 && PRODUCT_OR_COMMERCIAL_PLAN.test(planText)) {
    if (CREATOR_STYLE_PLAN.test(planText) && !scenes.some((scene) => scene.on_camera === true)) {
      issues.push("Creator-style UGC/testimonial plans need at least one on-camera creator/reaction beat.");
    }
    if (!scenes.some((scene) => PROOF_BEAT.test(`${scene.image_prompt} ${scene.video_prompt}`))) {
      issues.push("Product/commercial plans need visible proof, demo, closeup, before/after, screen, or result action.");
    }
    const endingText = scenes
      .slice(Math.max(0, scenes.length - 2))
      .map((scene) => `${scene.narration} ${scene.image_prompt} ${scene.video_prompt}`)
      .join(" ");
    if (!PAYOFF_BEAT.test(endingText)) {
      issues.push("Product/commercial plans need a clear result, reveal, payoff, or creator-native CTA in the ending.");
    }
  }

  return issues;
}

export function providerImagePrompt(plan: VideoPlan, scene: Scene): string {
  const prompt = scene.image_prompt.split(/\s+/).filter(Boolean).join(" ");
  const visualBible = plan.visual_bible.split(/\s+/).filter(Boolean).join(" ");
  if (!visualBible) return prompt;
  if (prompt.toLowerCase().includes(visualBible.toLowerCase())) return prompt;
  return `Continuity bible for every scene: ${visualBible}. Scene keyframe: ${prompt}`;
}

export function narrationStats(plan: VideoPlan, voiceover: JsonDict): JsonDict {
  const words = countSpokenWords(plan.narration);
  const cues = fishAudioExpressionCues(plan.narration);
  const duration = Number(voiceover.duration_seconds ?? 0);
  return {
    word_count: words,
    expression_cue_count: cues.length,
    expression_cues: cues,
    voiceover_duration_seconds: duration,
    words_per_second: duration > 0 ? Math.round((words / duration) * 1000) / 1000 : null,
  };
}

export function mergeTokenOutputIntoManifest(ctx: ProjectContext, tokenOutput: JsonDict): JsonDict {
  const manifestPath = path.join(ctx.project_dir, "manifest.json");
  if (!existsSync(manifestPath)) {
    const state = readProjectState(ctx);
    const error = (state.status ?? {}).error;
    if (error) throw new Error(String(error));
    throw new Error("Agent finished without producing a video manifest.");
  }
  let manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  manifest.token_output = tokenOutput;
  manifest.token_output_path = tokenOutput.token_output_path;
  manifest.gpt_cost_usd = tokenOutput.cost.total_usd;
  if (manifest.final_video_path && !manifest.final_video_url) {
    manifest.final_video_url = publicMediaPath(manifest.final_video_path);
  }
  manifest = exportYoutubeFinalVideo(ctx, manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
  updateProjectState(ctx, { manifest });
  return manifest;
}

export function loadVideoPlan(ctx: ProjectContext): VideoPlan {
  const payload = readJsonArtifact(ctx, "plan");
  if (!payload) {
    throw new Error("No video plan found. Call draft_video_plan before rendering assets.");
  }
  return VideoPlanSchema.parse(payload);
}

export function planDurationSeconds(plan: VideoPlan): number {
  return plan.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function timelineFromProjectState(state: JsonDict): TimelineArtifact {
  return state.timeline ? normalizeTimeline(state.timeline) : buildTimelineFromProjectState(state);
}

export function currentProjectTimeline(ctx: ProjectContext): TimelineArtifact {
  return timelineFromProjectState(readProjectState(ctx));
}

function timelineTargetDurationSeconds(timeline: TimelineArtifact, explicitTarget: number | null | undefined): number | null {
  const timelineDuration = Number(timeline.duration_seconds ?? 0);
  const requested = Number(explicitTarget ?? 0);
  const target = Math.max(
    Number.isFinite(timelineDuration) ? timelineDuration : 0,
    Number.isFinite(requested) ? requested : 0,
  );
  return target > 0 ? round3(target) : null;
}

function keepEndingGuardAtTimelineEnd(timeline: TimelineArtifact): TimelineArtifact {
  return setFinalHold(timeline, timeline.ending?.hold_seconds ?? 0, timeline.ending?.reason ?? "Adjusted final hold.");
}

function timelineVideoClipsForStitch(timeline: TimelineArtifact): TimelineClip[] {
  return timeline.tracks
    .find((track) => track.kind === "video")
    ?.clips.filter((clip) => clip.source_path)
    .sort((a, b) => a.timeline_start - b.timeline_start) ?? [];
}

function missingPlannedVideoSceneIds(plan: VideoPlan, videos: JsonDict[]): string[] {
  const rendered = new Set(videos.map((video) => String(video.scene_id ?? "")));
  return plan.scenes.map((scene) => scene.id).filter((sceneId) => !rendered.has(sceneId));
}

async function attachTimelineRenderVerification(
  ctx: ProjectContext,
  timeline: TimelineArtifact,
  finalVideoPath: string,
): Promise<TimelineArtifact> {
  const streams = await probeMediaStreamDurations(finalVideoPath);
  const videoDuration = streams.video_duration_seconds ?? streams.format_duration_seconds;
  const audioDuration = streams.audio_duration_seconds ?? streams.format_duration_seconds;
  const delta = videoDuration != null && audioDuration != null ? round3(videoDuration - audioDuration) : null;
  return normalizeTimeline({
    ...timeline,
    ending: {
      ...timeline.ending,
      intentional: (timeline.ending?.hold_seconds ?? 0) > 0,
      verification: {
        checked_at: new Date().toISOString(),
        checked_with: "ffprobe",
        final_video_path: finalVideoPath,
        format_duration_seconds: round3(streams.format_duration_seconds),
        video_duration_seconds: videoDuration != null ? round3(videoDuration) : null,
        audio_duration_seconds: audioDuration != null ? round3(audioDuration) : null,
        audio_video_delta_seconds: delta,
        aligned: delta === null ? null : Math.abs(delta) <= 0.25,
        project_id: ctx.project_id,
      },
    },
  });
}

async function stitchFromTimelineOrFallback(
  ctx: ProjectContext,
  videos: JsonDict[],
  voiceover: JsonDict,
  timeline: TimelineArtifact,
): Promise<string> {
  const targetDuration = timelineTargetDurationSeconds(
    timeline,
    explicitTargetFinalDurationSeconds(requestFromProjectState(ctx)),
  );
  const clips = timelineVideoClipsForStitch(timeline);
  if (clips.length > 0) {
    return stitchTimelineAssets(
      ctx,
      clips.map((clip) => ({
        id: clip.id,
        path: String(clip.source_path),
        source_start: clip.source_start,
        source_end: clip.source_end,
        timeline_start: clip.timeline_start,
        timeline_end: clip.timeline_end,
        duration: clip.duration,
        scene_id: clip.scene_id,
      })),
      voiceover,
      { target_duration_seconds: targetDuration },
    );
  }
  return stitchAssets(ctx, videos, voiceover, { target_duration_seconds: targetDuration });
}

async function persistRenderedTimeline(
  ctx: ProjectContext,
  timeline: TimelineArtifact,
  finalVideoPath: string,
  tool = "timeline",
): Promise<TimelineArtifact> {
  const verified = await attachTimelineRenderVerification(ctx, timeline, finalVideoPath);
  updateProjectState(ctx, {
    timeline: verified,
    decision: {
      tool,
      decision: "Recorded timeline and verified final audio/video duration alignment.",
      metadata: {
        summary: timelineSummary(verified),
        ending: verified.ending,
      },
    },
  });
  return verified;
}

export function sceneIdsFor(plan: VideoPlan, sceneIds: string[] | null = null): Set<string> {
  if (!sceneIds || sceneIds.length === 0) {
    return new Set(plan.scenes.map((scene) => scene.id));
  }
  const known = new Set(plan.scenes.map((scene) => scene.id));
  const requested = new Set(sceneIds);
  const unknown = [...requested].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new Error(`Unknown scene id(s): ${unknown.join(", ")}`);
  }
  return requested;
}

export function saveVideoPlan(ctx: ProjectContext, plan: VideoPlan): VideoPlan {
  writeJsonArtifact(ctx, "plan", plan);
  updateProjectState(ctx, { current_plan: plan });
  return plan;
}

export function patchSceneInPlan(
  plan: VideoPlan,
  sceneId: string,
  updates: {
    narration?: string | null;
    image_prompt?: string | null;
    video_prompt?: string | null;
    duration_seconds?: number | null;
  },
): [VideoPlan, Scene] {
  let patchedScene: Scene | null = null;
  const patchedScenes = plan.scenes.map((scene) => {
    if (scene.id !== sceneId) return scene;
    const next: Scene = { ...scene };
    if (updates.narration != null) next.narration = updates.narration;
    if (updates.image_prompt != null) next.image_prompt = updates.image_prompt.split(/\s+/).filter(Boolean).join(" ");
    if (updates.video_prompt != null) next.video_prompt = updates.video_prompt.split(/\s+/).filter(Boolean).join(" ");
    if (updates.duration_seconds != null) next.duration_seconds = updates.duration_seconds;
    patchedScene = next;
    return next;
  });
  if (patchedScene === null) {
    throw new Error(`Unknown scene id: ${sceneId}`);
  }
  return [{ ...plan, scenes: patchedScenes }, patchedScene];
}

export function reviseSceneNarrations(plan: VideoPlan, revisions: SceneNarrationRevision[]): VideoPlan {
  if (revisions.length === 0) return plan;
  const revisionByScene = new Map(revisions.map((revision) => [revision.scene_id, revision.narration]));
  const known = new Set(plan.scenes.map((scene) => scene.id));
  const unknown = [...revisionByScene.keys()].filter((id) => !known.has(id)).sort();
  if (unknown.length > 0) {
    throw new Error(`Unknown scene id(s): ${unknown.join(", ")}`);
  }
  return {
    ...plan,
    scenes: plan.scenes.map((scene) =>
      revisionByScene.has(scene.id) ? { ...scene, narration: revisionByScene.get(scene.id)! } : scene,
    ),
  };
}

export function invalidateFinalArtifacts(ctx: ProjectContext, options: { voiceover?: boolean } = {}): void {
  removeJsonArtifact(ctx, "manifest");
  if (options.voiceover) removeJsonArtifact(ctx, "voiceover");
  updateProjectState(ctx, {
    final_video_path: null,
    manifest_path: null,
    ...(options.voiceover ? { voiceover: null } : {}),
  });
}

export function clearRenderOutputs(ctx: ProjectContext): void {
  for (const artifact of ["voiceover", "images", "videos", "failed_scenes", "manifest"]) {
    removeJsonArtifact(ctx, artifact);
  }
  for (const directory of ["voiceover", "images", "videos", "youtube_clips"]) {
    rmSync(path.join(ctx.project_dir, directory), { recursive: true, force: true });
  }
  for (const filename of ["final.mp4", "merged.mp4", "merged_timed.mp4"]) {
    try {
      unlinkSync(path.join(ctx.project_dir, filename));
    } catch {
      // missing file is fine
    }
  }
}

export function ensureSupportedImageOptions(model: string, resolution: string): void {
  if (!(MAGIC_IMAGE_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Unsupported Magic Hour image model: ${model}`);
  }
  if (!(MAGIC_IMAGE_RESOLUTIONS as readonly string[]).includes(resolution)) {
    throw new Error(`Unsupported Magic Hour image resolution: ${resolution}`);
  }
  const supported = MAGIC_IMAGE_MODEL_RESOLUTIONS[model];
  if (supported !== undefined && !supported.has(resolution)) {
    throw new Error(`${model} supports image resolutions ${[...supported].sort()}, not ${resolution}.`);
  }
}

export function ensureSupportedVideoOptions(model: string, resolution: string, scenes: Scene[]): void {
  if (!(MAGIC_VIDEO_MODELS as readonly string[]).includes(model)) {
    throw new Error(`Unsupported Magic Hour image-to-video model: ${model}`);
  }
  const supportedResolutions = MAGIC_VIDEO_MODEL_RESOLUTIONS[model];
  if (supportedResolutions !== undefined && !supportedResolutions.has(resolution)) {
    throw new Error(`${model} supports video resolutions ${[...supportedResolutions].sort()}, not ${resolution}.`);
  }
  const supportedDurations = MAGIC_VIDEO_MODEL_DURATIONS[model];
  if (supportedDurations === undefined) return;
  const unsupported = scenes
    .filter((scene) => scene.on_camera !== true)
    .map((scene) => scene.duration_seconds)
    .filter((duration) => !supportedDurations.has(duration));
  if (unsupported.length > 0) {
    throw new Error(
      `${model} does not support scene duration(s) ${[...new Set(unsupported)].sort((a, b) => a - b)}. ` +
        `Supported I2V durations: ${[...supportedDurations].sort((a, b) => a - b)}.`,
    );
  }
}

export function contextWithMagicImageSettings(
  ctx: ProjectContext,
  options: { model: string; image_resolution: string; image_style_tool: string },
): ProjectContext {
  ensureSupportedImageOptions(options.model, options.image_resolution);
  if (!(MAGIC_IMAGE_STYLE_TOOLS as readonly string[]).includes(options.image_style_tool)) {
    throw new Error(`Unsupported Magic Hour image style tool: ${options.image_style_tool}`);
  }
  return {
    ...ctx,
    image_model: options.model,
    image_resolution: options.image_resolution,
    image_style_tool: options.image_style_tool,
  };
}

export function contextWithMagicVideoSettings(
  ctx: ProjectContext,
  options: { model: string; resolution: string; audio: boolean; scenes: Scene[] },
): ProjectContext {
  ensureSupportedVideoOptions(options.model, options.resolution, options.scenes);
  return { ...ctx, video_model: options.model, resolution: options.resolution, video_audio: options.audio };
}

export function buildVideoManifest(
  plan: VideoPlan,
  ctx: ProjectContext,
  options: {
    images: JsonDict[];
    videos: JsonDict[];
    voiceover: JsonDict;
    failed_scenes: JsonDict[];
    token_output: JsonDict;
    final_video: string;
  },
): JsonDict {
  const planPayload: JsonDict = { ...plan, aspect_ratio: ctx.aspect_ratio, resolution: ctx.resolution };
  const providerSettings = readProjectState(ctx).provider_settings ?? {};

  const manifest: JsonDict = {
    project_id: ctx.project_id,
    title: plan.title,
    created_at: new Date().toISOString(),
    workflow: providerSettings.workflow ?? "generated",
    aspect_ratio: ctx.aspect_ratio,
    resolution: ctx.resolution,
    image_model: providerSettings.image_model ?? ctx.image_model,
    image_resolution: providerSettings.image_resolution ?? ctx.image_resolution,
    image_style_tool: providerSettings.image_style_tool ?? ctx.image_style_tool,
    video_model: providerSettings.video_model ?? ctx.video_model,
    video_resolution: providerSettings.video_resolution ?? ctx.resolution,
    video_audio: providerSettings.video_audio ?? ctx.video_audio,
    audio_model: ctx.audio_model,
    render_status: options.failed_scenes.length > 0 ? "partial" : "complete",
    completed_scene_count: options.videos.length,
    failed_scene_count: options.failed_scenes.length,
    failed_scenes: options.failed_scenes,
    plan: planPayload,
    images: options.images.map((image) => withMediaUrl(image)),
    videos: options.videos.map((video) => withMediaUrl(video)),
    voiceover: withMediaUrl(options.voiceover),
    narration_stats: narrationStats(plan, options.voiceover),
    token_output: options.token_output,
    token_output_path: options.token_output.token_output_path,
    gpt_cost_usd: options.token_output.cost.total_usd,
    final_video_path: options.final_video,
    final_video_url: publicMediaPath(options.final_video),
    manifest_path: path.join(ctx.project_dir, "manifest.json"),
  };
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, {
    manifest,
    failures: options.failed_scenes,
    final_video_path: options.final_video,
    manifest_path: manifest.manifest_path,
  });
  return manifest;
}

export async function draftVideoPlanImpl(
  ctx: ProjectContext,
  title: string,
  narration: string,
  scenes: Scene[],
  visualBible = "",
  normalizeSceneIds = true,
): Promise<JsonDict> {
  let plan: VideoPlan = VideoPlanSchema.parse({ title, narration, visual_bible: visualBible, scenes });
  if (normalizeSceneIds) plan = normalizePlan(plan);
  const request = requestFromProjectState(ctx);
  const creativeIntent = request ? inferCreativeIntent(request, ctx) : null;
  if (normalizeSceneIds) {
    const qualityIssues = [
      ...validateProductionVideoPlan(plan),
      ...(request && creativeIntent ? validatePlanForCreativeIntent(plan, creativeIntent, request) : []),
    ];
    if (qualityIssues.length > 0) {
      const state = readProjectState(ctx);
      const previousFailures = (state.decisions ?? []).filter(
        (decision: JsonDict) => decision.tool === "draft_video_plan" && decision.metadata?.validation_failed === true,
      ).length;
      updateProjectState(ctx, {
        status: {
          stage: "plan_validation_failed",
          progress: 12,
          message: "Creative plan needs one pre-provider repair.",
        },
        decision: {
          tool: "draft_video_plan",
          decision: "Rejected draft plan before provider calls.",
          metadata: {
            validation_failed: true,
            repair_attempt: previousFailures + 1,
            issues: qualityIssues,
            creative_intent: creativeIntent,
          },
        },
      });
      const message =
        "Draft plan failed first-run production quality checks before provider calls: " + qualityIssues.join(" ");
      if (previousFailures >= 1) throw new Error(message);
      return {
        project_id: ctx.project_id,
        stage: "plan_validation_failed",
        validation_failed: true,
        issues: qualityIssues,
        creative_intent: creativeIntent,
        message: "Revise the plan to fix these objective issues, then call draft_video_plan one more time.",
        next_tools: ["draft_video_plan"],
      };
    }
  }
  mkdirSync(ctx.project_dir, { recursive: true });
  clearRenderOutputs(ctx);
  writeJsonArtifact(ctx, "plan", plan);
  writeJsonArtifact(ctx, "failed_scenes", []);
  updateProjectState(ctx, {
    current_plan: plan,
    voiceover: null,
    images: [],
    videos: [],
    failures: [],
    final_video_path: null,
    manifest_path: null,
    status: { stage: "plan_drafted", progress: 15, message: "Creative plan drafted." },
    decision: {
      tool: "draft_video_plan",
      decision: `Drafted plan '${plan.title}' with ${plan.scenes.length} scene(s).`,
      metadata: { scene_ids: plan.scenes.map((scene) => scene.id), creative_intent: creativeIntent },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "plan_drafted",
    plan,
    next_tools: ["generate_voiceover", "generate_scene_images"],
  };
}

export async function generateVoiceoverImpl(ctx: ProjectContext): Promise<JsonDict> {
  const plan = loadVideoPlan(ctx);
  if (plan.scenes.some((s) => s.on_camera === true)) {
    // Talking-photo and mixed UGC renders use per-scene audio: on-camera clips
    // need lip-sync audio, and b-roll gets its own per-scene VO during stitching.
    // The single global narration mp3 would be unused dead weight. Skip rendering
    // and persisting the `voiceover` artifact while preserving the normal result
    // shape so the agent proceeds to scene image generation as usual.
    updateProjectState(ctx, {
      status: { stage: "voiceover_generated", progress: 30, message: "Voiceover skipped (per-scene audio plan)." },
      decision: {
        tool: "generate_voiceover",
        decision: "Skipped global voiceover: the final edit will use per-scene audio for talking/mixed scenes.",
        metadata: { skipped: true, reason: "per_scene_audio" },
      },
    });
    return {
      project_id: ctx.project_id,
      stage: "voiceover_generated",
      voiceover: null,
      voiceover_skipped: true,
      next_tools: ["generate_scene_images", "animate_scene_videos"],
    };
  }
  const voiceReferenceId = resolveVoiceReferenceId(plan, ctx);
  const voiceover = await generateVoiceoverAsset(ctx, plan.narration, planDurationSeconds(plan), voiceReferenceId);
  writeJsonArtifact(ctx, "voiceover", voiceover);
  updateProjectState(ctx, {
    voiceover,
    status: { stage: "voiceover_generated", progress: 30, message: "Voiceover generated." },
    decision: {
      tool: "generate_voiceover",
      decision: "Generated voiceover for the saved narration.",
      metadata: { target_duration_seconds: voiceover.target_duration_seconds },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "voiceover_generated",
    voiceover: withMediaUrl(voiceover),
    next_tools: ["generate_scene_images", "animate_scene_videos"],
  };
}

export async function generateSceneImagesImpl(
  ctx: ProjectContext,
  sceneIds: string[] | null = null,
  options: { model?: string | null; image_resolution?: string | null; image_style_tool?: string | null } = {},
): Promise<JsonDict> {
  const plan = loadVideoPlan(ctx);
  const selectedIds = sceneIdsFor(plan, sceneIds);
  const scenes = plan.scenes
    .filter((scene) => selectedIds.has(scene.id))
    .map((scene) => ({ ...scene, image_prompt: providerImagePrompt(plan, scene) }));
  const imageCtx = contextWithMagicImageSettings(ctx, {
    model: options.model || ctx.image_model,
    image_resolution: options.image_resolution || ctx.image_resolution,
    image_style_tool: options.image_style_tool || ctx.image_style_tool,
  });
  const imageResults = await Promise.allSettled(scenes.map((scene) => generateImageAsset(imageCtx, scene)));
  const existingImages = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const existingFailures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const images: JsonDict[] = [];
  const failures: JsonDict[] = [];

  scenes.forEach((scene, index) => {
    const result = imageResults[index]!;
    if (result.status === "rejected") {
      console.warn(`Scene image generation failed for ${scene.id}`, result.reason);
      failures.push({ scene_id: scene.id, stage: "image_generation", error: String(result.reason?.message ?? result.reason) });
    } else {
      images.push(result.value);
    }
  });

  const mergedImages = orderedSceneAssets(plan, upsertSceneAssets(existingImages, images));
  const failureFreeImages = new Set(images.map((image) => String(image.scene_id)));
  let updatedFailures = clearSceneFailures(existingFailures, failureFreeImages, new Set(["image_generation"]));
  updatedFailures = recordSceneFailures(updatedFailures, failures);
  writeJsonArtifact(ctx, "images", mergedImages);
  writeJsonArtifact(ctx, "failed_scenes", updatedFailures);
  updateProjectState(ctx, {
    provider_settings: {
      image_model: imageCtx.image_model,
      image_resolution: imageCtx.image_resolution,
      image_style_tool: imageCtx.image_style_tool,
    },
    images: mergedImages,
    failures: updatedFailures,
    status: { stage: "images_generated", progress: 45, message: "Scene images generated." },
    decision: {
      tool: "generate_scene_images",
      decision: `Generated ${images.length} scene image(s).`,
      metadata: {
        requested_scene_ids: scenes.map((scene) => scene.id),
        failed_scene_ids: failures.map((failure) => failure.scene_id),
      },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "images_generated",
    images: mergedImages.map((image) => withMediaUrl(image)),
    failed_scenes: updatedFailures,
    next_tools: ["animate_scene_videos"],
  };
}

// Render the on-camera (UGC) talking scenes. Each pair feeds its KEYFRAME IMAGE +
// per-scene audio into AI Talking Photo (one submitted provider job). A talking
// failure is recorded with its provider job id when available; stitch then tries
// to recover that same job before any user-triggered retry spends more credits.
//
// All failures are recorded INLINE here with distinct stages, so the caller must NOT
// re-record them — it only pushes the non-null VideoAssets into `videos`.
async function renderTalkingPairs(
  videoCtx: ProjectContext,
  talkingPairs: Array<[Scene, any]>,
  sceneAudioPromise: Promise<Array<{ scene_id: string; path: string; duration_seconds: number }>>,
  failures: JsonDict[],
): Promise<Array<VideoAsset | null>> {
  const sceneAudios = await sceneAudioPromise;
  const audioByScene = new Map(sceneAudios.map((audio) => [audio.scene_id, audio]));
  return Promise.all(
    talkingPairs.map(async ([scene, image]): Promise<VideoAsset | null> => {
      const audio = audioByScene.get(scene.id);
      if (!audio) {
        failures.push({
          scene_id: scene.id,
          stage: "talking",
          error: `No scene audio for talking scene ${scene.id}`,
        });
        return null;
      }
      try {
        return await generateTalkingClip(videoCtx, scene, String(image.path), audio.path, audio.duration_seconds);
      } catch (err) {
        console.warn(`AI Talking Photo failed for ${scene.id}; preserving recoverable job metadata`, err);
        failures.push({
          scene_id: scene.id,
          stage: "talking",
          error: providerErrorMessage(err),
          ...providerJobFailureMetadata(err),
        });
        return null;
      }
    }),
  );
}

// Re-render a SINGLE scene's video through the same mechanism the scene was
// authored with, so the agent's recovery tools (retry/regenerate) don't destroy
// the talking treatment. On-camera scenes go through AI Talking Photo (keyframe
// image + a per-scene voiceover rendered with the plan's resolved voice). A HARD
// talking-render failure falls back to a silent imageToVideo clip in this explicit
// recovery path so the user-requested edit still produces something. B-roll scenes
// always use silent imageToVideo.
//
// NOTE: unlike `renderTalkingPairs` (batch path, which records soft "talking"
// failures inline and returns null), this helper records NOTHING. A hard
// double-failure (talking AND the silent fallback both throw) propagates to the
// caller, because the recovery tools (retry/regenerate) own their own failure
// bookkeeping and should surface the error to the agent.
async function renderSingleSceneVideo(
  videoCtx: ProjectContext,
  plan: VideoPlan,
  scene: Scene,
  image: JsonDict,
): Promise<VideoAsset> {
  if (scene.on_camera === true) {
    const voiceReferenceId = resolveVoiceReferenceId(plan, videoCtx);
    const [vo] = await generateSceneVoiceovers(videoCtx, [scene], voiceReferenceId);
    if (!vo) throw new Error(`No scene voiceover generated for ${scene.id}`);
    try {
      return await generateTalkingClip(videoCtx, scene, String(image.path), vo.path, vo.duration_seconds);
    } catch (err) {
      console.warn(`Talking re-render failed for ${scene.id}; falling back to silent clip`, err);
      return await generateVideoAsset(videoCtx, scene, image as any);
    }
  }
  return await generateVideoAsset(videoCtx, scene, image as any);
}

export async function animateSceneVideosImpl(
  ctx: ProjectContext,
  sceneIds: string[] | null = null,
  options: { model?: string | null; resolution?: string | null; audio?: boolean | null } = {},
): Promise<JsonDict> {
  const plan = loadVideoPlan(ctx);
  const existingVideos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  const isFirstFullRender = existingVideos.length === 0 && !existsSync(artifactPath(ctx, "manifest"));
  const selectedIds = sceneIdsFor(plan, isFirstFullRender ? null : sceneIds);
  const selectedScenes = plan.scenes.filter((scene) => selectedIds.has(scene.id));
  const videoCtx = contextWithMagicVideoSettings(ctx, {
    model: options.model || ctx.video_model,
    resolution: options.resolution || ctx.resolution,
    audio: options.audio == null ? ctx.video_audio : options.audio,
    scenes: selectedScenes,
  });
  const existingImages = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const imageByScene = new Map(existingImages.map((image) => [String(image.scene_id), image]));
  const videoScenePairs = selectedScenes
    .filter((scene) => imageByScene.has(scene.id))
    .map((scene) => [scene, imageByScene.get(scene.id)!] as [Scene, JsonDict]);
  const missingImageFailures = selectedScenes
    .filter((scene) => !imageByScene.has(scene.id))
    .map((scene) => ({
      scene_id: scene.id,
      stage: "video_generation",
      error: "No image asset exists for this scene.",
    }));
  if (videoScenePairs.length === 0) {
    const existingFailures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
    const updatedFailures = recordSceneFailures(existingFailures, missingImageFailures);
    writeJsonArtifact(ctx, "failed_scenes", updatedFailures);
    updateProjectState(ctx, {
      failures: updatedFailures,
      status: { stage: "video_generation_blocked", progress: 65, message: "No scene images are ready for animation." },
    });
    throw new Error("No scene images completed, so no videos can be animated.");
  }

  const existingFailures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const videos: JsonDict[] = [];
  const failures: JsonDict[] = [...missingImageFailures];

  // Partition by render mechanism. On-camera (UGC) talking scenes feed their
  // KEYFRAME IMAGE + per-scene audio straight into AI Talking Photo (one submitted job,
  // NO silent imageToVideo pass — that's the latency win). B-roll cutaways still
  // render a silent imageToVideo clip and get their own VO at stitch time.
  const talkingPairs = videoScenePairs.filter(([scene]) => scene.on_camera === true);
  const brollPairs = videoScenePairs.filter(([scene]) => scene.on_camera !== true);

  // Per-scene TTS only needs scene.narration, not any clip, so kick it off
  // CONCURRENTLY with both render batches (overlapping latency) and await it
  // inside the talking branch.
  const voiceReferenceId = resolveVoiceReferenceId(plan, videoCtx);
  const sceneAudioPromise: Promise<Array<{ scene_id: string; path: string; duration_seconds: number }>> =
    talkingPairs.length > 0
      ? generateSceneVoiceovers(videoCtx, talkingPairs.map(([scene]) => scene), voiceReferenceId)
      : Promise.resolve([]);

  const [brollResults, talkingResults] = await Promise.all([
    generateVideoAssetsBatch(videoCtx, brollPairs as Array<[Scene, any]>),
    renderTalkingPairs(videoCtx, talkingPairs as Array<[Scene, any]>, sceneAudioPromise, failures),
  ]);

  brollPairs.forEach(([scene], index) => {
    const result = brollResults[index]!;
    if (result instanceof Error) {
      console.warn(`Scene video generation failed for ${scene.id}`, result);
      failures.push({
        scene_id: scene.id,
        stage: "video_generation",
        error: result.message,
        ...providerJobFailureMetadata(result),
      });
    } else {
      videos.push(result);
    }
  });
  // renderTalkingPairs records all of its own failures inline (with distinct stages),
  // so we only collect the produced clips here. null = scene produced no clip.
  talkingResults.forEach((result) => {
    if (result) videos.push(result);
  });

  const mergedVideos = orderedSceneAssets(plan, upsertSceneAssets(existingVideos, videos));
  const successfulVideoIds = new Set(videos.map((video) => String(video.scene_id)));
  let updatedFailures = clearSceneFailures(existingFailures, successfulVideoIds, new Set(["video_generation", "talking"]));
  updatedFailures = recordSceneFailures(updatedFailures, failures);
  const recoverableFailures = updatedFailures.filter((failure) => providerJobFailureMetadata(failure));
  writeJsonArtifact(ctx, "videos", mergedVideos);
  writeJsonArtifact(ctx, "failed_scenes", updatedFailures);
  updateProjectState(ctx, {
    provider_settings: {
      video_model: videoCtx.video_model,
      video_resolution: videoCtx.resolution,
      video_audio: videoCtx.video_audio,
    },
    videos: mergedVideos,
    failures: updatedFailures,
    status: {
      stage: recoverableFailures.length > 0 ? "videos_provider_recoverable" : "videos_animated",
      progress: 70,
      message:
        recoverableFailures.length > 0
          ? "Some provider jobs are still recoverable; stitching will check those job ids before regenerating."
          : "Scene videos animated.",
    },
    decision: {
      tool: "animate_scene_videos",
      decision: `Animated ${videos.length} scene video(s).`,
      metadata: {
        requested_scene_ids: videoScenePairs.map(([scene]) => scene.id),
        failed_scene_ids: failures.map((failure) => failure.scene_id),
      },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: recoverableFailures.length > 0 ? "videos_provider_recoverable" : "videos_animated",
    videos: mergedVideos.map((video) => withMediaUrl(video)),
    failed_scenes: updatedFailures,
    next_tools: ["stitch_final_video", "retry_scene"],
  };
}

async function recoverProviderFailuresBeforeStitch(
  ctx: ProjectContext,
  plan: VideoPlan,
  videos: JsonDict[],
  failedScenes: JsonDict[],
): Promise<{
  videos: JsonDict[];
  failedScenes: JsonDict[];
  recovered: VideoAsset[];
  attempted: number;
}> {
  const videoIds = new Set(videos.map((video) => String(video.scene_id)));
  const sceneById = new Map(plan.scenes.map((scene) => [scene.id, scene]));
  const recovered: VideoAsset[] = [];
  const remainingFailures: JsonDict[] = [];
  let attempted = 0;

  for (const failure of failedScenes) {
    const sceneId = String(failure.scene_id ?? "");
    if (videoIds.has(sceneId)) continue;
    const metadata = providerJobFailureMetadata(failure);
    const scene = sceneById.get(sceneId);
    if (!metadata || !scene) {
      remainingFailures.push(failure);
      continue;
    }

    attempted += 1;
    try {
      const asset = await recoverVideoAssetFromProviderJob(ctx, { ...metadata, scene } as RecoverVideoAssetJob);
      recovered.push(asset);
      videoIds.add(asset.scene_id);
    } catch (err) {
      remainingFailures.push({
        ...failure,
        recovery_error: providerErrorMessage(err),
        recovery_checked_at: new Date().toISOString(),
      });
    }
  }

  const mergedVideos = orderedSceneAssets(plan, upsertSceneAssets(videos, recovered));
  return { videos: mergedVideos, failedScenes: remainingFailures, recovered, attempted };
}

/**
 * Build the per-scene stitch inputs for the audio-preserving assembler.
 *
 * Talking scenes (on-camera / embedded audio) reuse their own lip-sync mp3 that
 * Task 5 attached to the video entry. B-roll cutaways carry no audio, so each
 * gets a per-scene VO take generated on demand so the section is never silent.
 */
async function buildPerSceneStitchInputs(
  ctx: ProjectContext,
  plan: VideoPlan,
  videos: JsonDict[],
): Promise<PerSectionScene[]> {
  const result: PerSectionScene[] = [];
  const voiceReferenceId = resolveVoiceReferenceId(plan, ctx);
  for (const v of videos) {
    if (v.on_camera === true || v.has_embedded_audio === true) {
      const persistedAudio =
        typeof v.audio_path === "string" && existsSync(v.audio_path) ? v.audio_path : null;
      const duration = Number(v.audio_duration_seconds ?? v.duration_seconds);
      result.push({
        video_path: String(v.path),
        audio_path: persistedAudio ?? String(v.path),
        audio_duration_seconds: Number.isFinite(duration) && duration > 0 ? duration : Number(v.duration_seconds),
      });
    } else {
      const scene = plan.scenes.find((s) => s.id === String(v.scene_id));
      if (!scene) {
        throw new Error(`No plan scene matched video entry ${String(v.scene_id)} while building stitch inputs.`);
      }
      const [vo] = await generateSceneVoiceovers(ctx, [scene], voiceReferenceId);
      if (!vo) {
        throw new Error(`Per-scene voiceover generation returned no take for scene ${scene.id}.`);
      }
      result.push({
        video_path: String(v.path),
        audio_path: vo.path,
        audio_duration_seconds: vo.duration_seconds,
      });
    }
  }
  return result;
}

export async function stitchFinalVideoImpl(ctx: ProjectContext, tokenOutput: JsonDict | null = null): Promise<JsonDict> {
  const plan = loadVideoPlan(ctx);
  const images = orderedSceneAssets(plan, readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? []);
  let videos = orderedSceneAssets(plan, readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? []);
  const voiceover = readJsonArtifact<JsonDict>(ctx, "voiceover");
  let failedScenes = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const recovery = await recoverProviderFailuresBeforeStitch(ctx, plan, videos, failedScenes);
  if (recovery.attempted > 0) {
    videos = recovery.videos;
    failedScenes = recovery.failedScenes;
    writeJsonArtifact(ctx, "videos", videos);
    writeJsonArtifact(ctx, "failed_scenes", failedScenes);
    updateProjectState(ctx, {
      videos,
      failures: failedScenes,
      status: {
        stage:
          recovery.recovered.length > 0
            ? failedScenes.length > 0
              ? "provider_recovery_partial"
              : "provider_recovered"
            : "provider_stalled",
        progress: 82,
        message:
          recovery.recovered.length > 0
            ? `Recovered ${recovery.recovered.length} provider job(s) before stitching.`
            : "Provider recovery checked existing job ids but no new scene video was ready.",
      },
      decision: {
        tool: "stitch_final_video",
        decision: `Checked ${recovery.attempted} recoverable provider job(s) before stitching.`,
        metadata: {
          recovered_scene_ids: recovery.recovered.map((asset) => asset.scene_id),
          remaining_failed_scene_ids: failedScenes.map((failure) => failure.scene_id),
        },
      },
    });
  }
  const missingSceneIds = missingPlannedVideoSceneIds(plan, videos);
  if (missingSceneIds.length > 0) {
    const failuresText = failedScenes
      .map((failure) => `${failure.scene_id} ${failure.stage}: ${failure.error}`)
      .join("; ");
    const detail = failuresText ? ` Remaining failures: ${failuresText}` : "";
    throw new Error(
      `Cannot stitch final MP4 until every planned scene has a rendered video. Missing scene videos: ${missingSceneIds.join(", ")}.${detail}`,
    );
  }
  if (videos.length === 0) {
    const failuresText = failedScenes
      .map((failure) => `${failure.scene_id} ${failure.stage}: ${failure.error}`)
      .join("; ");
    const detail = failuresText ? ` Failures: ${failuresText}` : "";
    throw new Error(`No scene videos completed, so no final MP4 can be stitched.${detail}`);
  }
  const hasTalking = anyEmbeddedAudio(videos as any[]);
  // Talking projects carry per-scene audio, so a global voiceover is optional;
  // pure b-roll projects still require one.
  if (!voiceover && !hasTalking) {
    throw new Error("No voiceover asset found. Call generate_voiceover before stitching.");
  }

  const stateForTimeline = readProjectState(ctx);
  const timeline = stateForTimeline.timeline
    ? normalizeTimeline(stateForTimeline.timeline)
    : buildTimelineFromProjectState({
        ...stateForTimeline,
        current_plan: plan,
        scene_assets: { ...(stateForTimeline.scene_assets ?? {}), videos, voiceover },
      });

  let finalVideo: string;
  if (hasTalking) {
    const perScene = await buildPerSceneStitchInputs(ctx, plan, videos);
    const target = timelineTargetDurationSeconds(
      timeline,
      explicitTargetFinalDurationSeconds(requestFromProjectState(ctx)),
    );
    finalVideo = await stitchMixedAssets(ctx, perScene, { target_duration_seconds: target });
  } else {
    finalVideo = await stitchFromTimelineOrFallback(ctx, videos, voiceover!, timeline);
  }
  const manifest = buildVideoManifest(plan, ctx, {
    images,
    videos,
    voiceover: voiceover ?? {},
    failed_scenes: failedScenes,
    token_output: tokenOutput ?? pendingTokenOutput(ctx, ENV.OPENAI_MODEL ?? "gpt-5.5"),
    final_video: finalVideo,
  });
  const verifiedTimeline = await persistRenderedTimeline(ctx, timeline, finalVideo, "stitch_final_video");
  manifest.timeline = verifiedTimeline;
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, { manifest, timeline: verifiedTimeline });
  return manifest;
}

export function youtubeSectionsToVideoPlan(title: string, narration: string, sections: YouTubeClipSection[]): VideoPlan {
  const scenes: Scene[] = sections.map((section) => ({
    id: `scene_${section.section}`,
    narration: section.dialogue,
    image_prompt: section.search_hint,
    video_prompt: `YouTube clip search: ${section.search_hint}`,
    duration_seconds: section.duration_seconds,
    on_camera: false,
  }));
  return normalizePlan(
    VideoPlanSchema.parse({
      title,
      narration,
      visual_bible: "YouTube-sourced b-roll and real footage.",
      scenes,
    }),
  );
}

export function existingYoutubeManifest(ctx: ProjectContext): JsonDict | null {
  const manifest = readJsonArtifact<JsonDict>(ctx, "manifest", null);
  if (typeof manifest !== "object" || manifest === null || manifest.workflow !== "youtube_clips") return null;
  const finalPath = manifest.final_video_path;
  if (!finalPath || !existsSync(String(finalPath))) return null;
  if (!manifest.videos || manifest.videos.length === 0) return null;
  return manifest;
}

export function shouldReuseExistingYoutubeManifest(
  options: { reuse_existing_manifest?: boolean } = {},
): boolean {
  return options.reuse_existing_manifest === true;
}

export async function createYoutubeShortImpl(
  ctx: ProjectContext,
  title: string,
  narration: string,
  sections: YouTubeClipSection[],
  options: { token_output?: JsonDict | null; proxy_url?: string | null; reuse_existing_manifest?: boolean } = {},
): Promise<JsonDict> {
  if (sections.length === 0) {
    throw new Error("At least one YouTube clip section is required.");
  }

  if (shouldReuseExistingYoutubeManifest(options)) {
    const existingManifest = existingYoutubeManifest(ctx);
    if (existingManifest !== null) {
      updateProjectState(ctx, {
        decision: {
          tool: "create_youtube_short",
          decision: "Reused existing YouTube short manifest; skipped duplicate generation and downloads.",
          metadata: { manifest_path: existingManifest.manifest_path },
        },
      });
      return existingManifest;
    }
  }

  let normalizedSections = normalizeYoutubeSectionsForProject(ctx, sections);
  const state = readProjectState(ctx);
  const providerSettings = state.provider_settings ?? {};
  const userPreferences = state.user_preferences ?? {};
  const youtubeSearchProvider = String(
    providerSettings.youtube_search_provider || userPreferences.youtube_search_provider || "youtube_data_api",
  );
  const youtubeAllowProviderFallback = boolSetting(
    providerSettings.youtube_allow_provider_fallback ?? userPreferences.youtube_allow_provider_fallback ?? false,
    { default: false },
  );
  let plan = youtubeSectionsToVideoPlan(title, narration, normalizedSections);
  await draftVideoPlanImpl(ctx, plan.title, plan.narration, plan.scenes, plan.visual_bible, false);

  updateProjectState(ctx, {
    provider_settings: {
      workflow: "youtube_clips",
      image_model: "none",
      image_resolution: "none",
      image_style_tool: "none",
      video_model: "youtube-clips",
      video_resolution: ctx.resolution,
      video_audio: false,
      youtube_search_provider: youtubeSearchProvider,
      youtube_allow_provider_fallback: youtubeAllowProviderFallback,
    },
    decision: {
      tool: "create_youtube_short",
      decision: `Using YouTube clip workflow with ${normalizedSections.length} section(s).`,
      metadata: {
        search_hints: normalizedSections.map((section) => section.search_hint),
        youtube_search_provider: youtubeSearchProvider,
        youtube_allow_provider_fallback: youtubeAllowProviderFallback,
      },
    },
    status: {
      stage: "youtube_script_ready",
      progress: 30,
      message: "YouTube script ready; finding source clips before voiceover.",
    },
  });

  const clipResults = await downloadYoutubeClipAssets(ctx, normalizedSections, {
    proxy_url: options.proxy_url ?? null,
    search_provider: youtubeSearchProvider,
  });
  let videos: JsonDict[] = [];
  let failures: JsonDict[] = [];
  normalizedSections.forEach((section, index) => {
    const result = clipResults[index]!;
    const sceneId = `scene_${section.section}`;
    if (result instanceof Error) {
      failures.push({ scene_id: sceneId, stage: "youtube_clip_download", error: result.message });
    } else {
      videos.push({
        ...result,
        // downloadSectionClip ffprobes the real downloaded clip and records its true length
        // on source_duration_seconds. Keep that probed value (it is what timeline.ts reads to
        // decide cut vs freeze); only fall back to the planned estimate if it is absent.
        source_duration_seconds: result.source_duration_seconds ?? result.duration_seconds,
      });
    }
  });

  videos = orderedSceneAssets(plan, videos);
  writeJsonArtifact(ctx, "videos", videos);
  writeJsonArtifact(ctx, "images", []);
  writeJsonArtifact(ctx, "failed_scenes", failures);
  updateProjectState(ctx, {
    images: [],
    videos,
    failures,
    status: { stage: "youtube_clips_downloaded", progress: 70, message: "YouTube clips downloaded." },
  });
  if (videos.length === 0) {
    const detail = failures.map((failure) => `${failure.scene_id}: ${failure.error}`).join("; ");
    const error = `No YouTube clips downloaded, so no final MP4 can be stitched. ${detail}`.trim();
    updateProjectState(ctx, {
      failures,
      status: { stage: "youtube_short_failed", progress: 70, message: "YouTube clip sourcing failed.", error },
    });
    throw new Error(error);
  }

  // Generate narration after clip selection so failed/dirty candidates do not
  // consume TTS and the final plan can align to the clips that actually exist.
  const sectionByScene = new Map(normalizedSections.map((section) => [`scene_${section.section}`, section]));
  const sectionsForVoiceover = videos.map((video) => sectionByScene.get(String(video.scene_id))).filter(Boolean) as YouTubeClipSection[];
  let sectionVoiceovers: SectionVoiceover[];
  let voByScene: Map<string, SectionVoiceover>;
  try {
    sectionVoiceovers = await generateSectionVoiceovers(ctx, sectionsForVoiceover);
    voByScene = new Map(sectionVoiceovers.map((item) => [String(item.scene_id), item]));
  } catch (exc: any) {
    const error = `Failed to generate per-section voiceovers after clip selection: ${exc?.message ?? exc}`;
    const audioFailure = { scene_id: "final", stage: "voiceover_sections", error };
    failures = [...failures, audioFailure];
    writeJsonArtifact(ctx, "failed_scenes", failures);
    updateProjectState(ctx, {
      failures,
      status: { stage: "youtube_short_failed", progress: 70, message: "YouTube short voiceover failed.", error },
    });
    throw new Error(error);
  }
  writeJsonArtifact(ctx, "section_voiceovers", sectionVoiceovers);
  normalizedSections = normalizedSections.map((section) => {
    const voiceover = voByScene.get(`scene_${section.section}`);
    if (!voiceover) return section;
    return {
      ...section,
      duration_seconds: Math.max(1, Math.min(30, Math.round(Number(voiceover.duration_seconds)))),
    };
  });
  plan = saveVideoPlan(ctx, youtubeSectionsToVideoPlan(title, narration, normalizedSections));
  videos = orderedSceneAssets(
    plan,
    videos.map((video) => {
      const audioDuration = voByScene.get(String(video.scene_id))?.duration_seconds ?? video.duration_seconds;
      return {
        ...video,
        audio_duration_seconds: audioDuration,
        duration_seconds: audioDuration,
      };
    }),
  );
  writeJsonArtifact(ctx, "videos", videos);
  updateProjectState(ctx, {
    current_plan: plan,
    videos,
    status: {
      stage: "youtube_voiceover_generated",
      progress: 78,
      message: "Per-section voiceovers generated for selected YouTube clips.",
    },
  });

  const youtubeOutputAspectRatio = await inferYoutubeOutputAspectRatio(videos, {
    default_aspect_ratio: ctx.aspect_ratio,
  });
  const renderCtx: ProjectContext = { ...ctx, aspect_ratio: youtubeOutputAspectRatio };
  updateProjectState(ctx, {
    provider_settings: {
      aspect_ratio: renderCtx.aspect_ratio,
      resolution: renderCtx.resolution,
    },
    decision: {
      tool: "create_youtube_short",
      decision: `Using ${renderCtx.aspect_ratio} output aspect from downloaded YouTube clips.`,
      metadata: {
        requested_aspect_ratio: ctx.aspect_ratio,
        output_aspect_ratio: renderCtx.aspect_ratio,
      },
    },
  });

  // Combine only the surviving sections' audio so the manifest voiceover
  // matches the final video. The per-section files remain the alignment
  // source of truth; dropping a failed scene cannot desync the survivors.
  const orderedSectionVo = videos
    .filter((video) => voByScene.has(String(video.scene_id)))
    .map((video) => voByScene.get(String(video.scene_id))!);
  const missingAudio = orderedSectionVo.filter((item) => !existsSync(String(item.path))).map((item) => item.path);
  if (missingAudio.length > 0) {
    const detail = missingAudio.join("; ");
    const error = `Per-section voiceover files missing before combine: ${detail}`;
    const audioFailure = { scene_id: "final", stage: "voiceover_combine", error };
    failures = [...failures, audioFailure];
    writeJsonArtifact(ctx, "failed_scenes", failures);
    updateProjectState(ctx, {
      failures,
      status: { stage: "youtube_short_failed", progress: 70, message: "YouTube short voiceover combine failed.", error },
    });
    throw new Error(error);
  }
  let voiceover: JsonDict;
  try {
    voiceover = await combineSectionVoiceovers(ctx, orderedSectionVo);
  } catch (exc: any) {
    const audioPaths = orderedSectionVo.map((item) => String(item.path ?? ""));
    const error = `Failed to combine per-section voiceovers: ${exc?.message ?? exc}. Section audio paths: ${JSON.stringify(audioPaths)}`;
    const audioFailure = { scene_id: "final", stage: "voiceover_combine", error };
    failures = [...failures, audioFailure];
    writeJsonArtifact(ctx, "failed_scenes", failures);
    updateProjectState(ctx, {
      failures,
      status: { stage: "youtube_short_failed", progress: 70, message: "YouTube short voiceover combine failed.", error },
    });
    throw new Error(error);
  }
  writeJsonArtifact(ctx, "voiceover", voiceover);
  updateProjectState(ctx, { voiceover });

  const scenesForStitch = videos
    .filter((video) => voByScene.has(String(video.scene_id)))
    .map((video) => ({
      video_path: String(video.path),
      audio_path: voByScene.get(String(video.scene_id))!.path,
      audio_duration_seconds: voByScene.get(String(video.scene_id))!.duration_seconds,
    }));
  const stateForTimeline = readProjectState(ctx);
  const timeline = stateForTimeline.timeline
    ? normalizeTimeline(stateForTimeline.timeline)
    : buildTimelineFromProjectState(
        {
          ...stateForTimeline,
          current_plan: plan,
          scene_assets: { ...(stateForTimeline.scene_assets ?? {}), videos, voiceover },
        },
        // Scope a short static end-hold to the YouTube clips path only; other workflows keep
        // the global DEFAULT_FINAL_HOLD_SECONDS (1.5s). 0.25s avoids both an abrupt cutoff and
        // the long frozen tail.
        { final_hold_seconds: 0.25 },
      );

  let finalVideo: string;
  try {
    if (timelineVideoClipsForStitch(timeline).length > 0) {
      finalVideo = await stitchFromTimelineOrFallback(renderCtx, videos, voiceover, timeline);
    } else {
      finalVideo = await stitchAssetsPerSection(renderCtx, scenesForStitch, {
        target_duration_seconds: timelineTargetDurationSeconds(
          timeline,
          explicitTargetFinalDurationSeconds(requestFromProjectState(ctx)),
        ),
      });
    }
  } catch (exc: any) {
    const stitchFailure = { scene_id: "final", stage: "stitching", error: String(exc?.message ?? exc) };
    failures = [...failures, stitchFailure];
    writeJsonArtifact(ctx, "failed_scenes", failures);
    updateProjectState(ctx, {
      failures,
      status: {
        stage: "youtube_short_failed",
        progress: 70,
        message: "YouTube short stitching failed.",
        error: String(exc?.message ?? exc),
      },
    });
    throw exc;
  }

  const manifest = buildVideoManifest(plan, renderCtx, {
    images: [],
    videos,
    voiceover,
    failed_scenes: failures,
    token_output: options.token_output ?? pendingTokenOutput(ctx, ENV.OPENAI_MODEL ?? "gpt-5.5"),
    final_video: finalVideo,
  });
  manifest.workflow = "youtube_clips";
  manifest.image_model = "none";
  manifest.video_model = "youtube-clips";
  manifest.youtube_search_provider = youtubeSearchProvider;
  manifest.youtube_allow_provider_fallback = youtubeAllowProviderFallback;
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, {
    manifest,
    final_video_path: finalVideo,
    manifest_path: manifest.manifest_path,
    status: { stage: "youtube_short_stitched", progress: 95, message: "YouTube short stitched." },
  });
  const verifiedTimeline = await persistRenderedTimeline(ctx, timeline, finalVideo, "create_youtube_short");
  manifest.timeline = verifiedTimeline;
  writeJsonArtifact(ctx, "manifest", manifest);
  updateProjectState(ctx, { manifest, timeline: verifiedTimeline });
  return manifest;
}

export async function inspectRenderStatusImpl(ctx: ProjectContext): Promise<JsonDict> {
  const artifacts: Record<string, boolean> = {};
  for (const name of ["plan", "voiceover", "images", "videos", "manifest"]) {
    artifacts[name] = existsSync(artifactPath(ctx, name));
  }
  const planPayload = readJsonArtifact(ctx, "plan");
  const images = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const videos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  const failedScenes = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const recoverableFailedScenes = failedScenes.filter((failure) => providerJobFailureMetadata(failure));
  let sceneIds: string[] = [];
  let missingImages: string[] = [];
  let missingVideos: string[] = [];

  if (planPayload) {
    const plan = VideoPlanSchema.parse(planPayload);
    sceneIds = plan.scenes.map((scene) => scene.id);
    const imageIds = new Set(images.map((image) => String(image.scene_id)));
    const videoIds = new Set(videos.map((video) => String(video.scene_id)));
    missingImages = sceneIds.filter((sceneId) => !imageIds.has(sceneId));
    missingVideos = sceneIds.filter((sceneId) => !videoIds.has(sceneId));
  }

  const nextTools: string[] = [];
  if (!artifacts.plan) {
    nextTools.push("draft_video_plan");
  } else {
    if (!artifacts.voiceover) nextTools.push("generate_voiceover");
    if (missingImages.length > 0) nextTools.push("generate_scene_images");
    if (recoverableFailedScenes.length > 0 && !artifacts.manifest) nextTools.push("stitch_final_video");
    if (missingVideos.length > 0 && missingImages.length === 0 && recoverableFailedScenes.length === 0) {
      nextTools.push("animate_scene_videos");
    }
    if (videos.length > 0 && artifacts.voiceover && !artifacts.manifest) nextTools.push("stitch_final_video");
    if (failedScenes.length > 0) nextTools.push("retry_scene");
  }

  return {
    project_id: ctx.project_id,
    project_state: readProjectState(ctx),
    artifacts,
    scene_ids: sceneIds,
    completed_scene_count: videos.length,
    failed_scene_count: failedScenes.length,
    recoverable_failed_scene_count: recoverableFailedScenes.length,
    missing_images: missingImages,
    missing_videos: missingVideos,
    failed_scenes: failedScenes,
    recoverable_failed_scenes: recoverableFailedScenes,
    next_tools: [...new Set(nextTools)],
  };
}

export async function retrySceneWithModelsImpl(
  ctx: ProjectContext,
  sceneId: string,
  stage: string = "video",
  options: {
    image_model?: string | null;
    image_resolution?: string | null;
    image_style_tool?: string | null;
    video_model?: string | null;
    video_resolution?: string | null;
    video_audio?: boolean | null;
  } = {},
): Promise<JsonDict> {
  if (!["image", "video", "all"].includes(stage)) {
    throw new Error("stage must be one of: image, video, all");
  }
  const plan = loadVideoPlan(ctx);
  const scene = plan.scenes.find((candidate) => candidate.id === sceneId);
  if (!scene) {
    throw new Error(`Unknown scene id: ${sceneId}`);
  }
  const imageCtx = contextWithMagicImageSettings(ctx, {
    model: options.image_model || ctx.image_model,
    image_resolution: options.image_resolution || ctx.image_resolution,
    image_style_tool: options.image_style_tool || ctx.image_style_tool,
  });
  const videoCtx = contextWithMagicVideoSettings(ctx, {
    model: options.video_model || ctx.video_model,
    resolution: options.video_resolution || ctx.resolution,
    audio: options.video_audio == null ? ctx.video_audio : options.video_audio,
    scenes: [scene],
  });

  const images = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const videos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  let failures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const imageByScene = new Map(images.map((image) => [String(image.scene_id), image]));
  const newImages: JsonDict[] = [];
  const newVideos: JsonDict[] = [];

  if (["image", "all"].includes(stage) || !imageByScene.has(sceneId)) {
    const image = await generateImageAsset(imageCtx, scene);
    newImages.push(image);
    imageByScene.set(sceneId, image);
    failures = clearSceneFailures(failures, new Set([sceneId]), new Set(["image_generation"]));
  }

  if (["video", "all"].includes(stage)) {
    const image = imageByScene.get(sceneId);
    if (!image) {
      throw new Error(`No image asset exists for ${sceneId}; retry with stage='all'.`);
    }
    const video = await renderSingleSceneVideo(videoCtx, plan, scene, image);
    newVideos.push(video);
    // Also clear any stale "talking" failure recorded by an earlier render
    // (renderTalkingPairs), so a now-successful re-render leaves no phantom failure.
    failures = clearSceneFailures(failures, new Set([sceneId]), new Set(["video_generation", "talking"]));
  }

  const mergedImages = orderedSceneAssets(plan, upsertSceneAssets(images, newImages));
  const mergedVideos = orderedSceneAssets(plan, upsertSceneAssets(videos, newVideos));
  writeJsonArtifact(ctx, "images", mergedImages);
  writeJsonArtifact(ctx, "videos", mergedVideos);
  writeJsonArtifact(ctx, "failed_scenes", failures);
  updateProjectState(ctx, {
    provider_settings: {
      image_model: imageCtx.image_model,
      image_resolution: imageCtx.image_resolution,
      image_style_tool: imageCtx.image_style_tool,
      video_model: videoCtx.video_model,
      video_resolution: videoCtx.resolution,
      video_audio: videoCtx.video_audio,
    },
    images: mergedImages,
    videos: mergedVideos,
    failures,
    status: { stage: "scene_retried", progress: 75, message: `Retried ${sceneId}.` },
    decision: {
      tool: "retry_scene",
      decision: `Retried ${stage} asset(s) for ${sceneId}.`,
      scene_id: sceneId,
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "scene_retried",
    retried_scene_id: sceneId,
    images: mergedImages.map((image) => withMediaUrl(image)),
    videos: mergedVideos.map((video) => withMediaUrl(video)),
    failed_scenes: failures,
    next_tools: ["stitch_final_video", "inspect_render_status"],
  };
}

export async function recordProjectDecisionImpl(
  ctx: ProjectContext,
  decision: string,
  rationale = "",
  sceneId: string | null = null,
): Promise<JsonDict> {
  const entry = appendProjectDecision(ctx, {
    decision,
    rationale,
    scene_id: sceneId,
    tool: "record_project_decision",
  });
  return {
    project_id: ctx.project_id,
    stage: "decision_recorded",
    decision: entry,
    decision_count: readProjectState(ctx).decisions.length,
  };
}

export async function regenerateSceneImpl(
  ctx: ProjectContext,
  sceneId: string,
  options: {
    narration?: string | null;
    image_prompt?: string | null;
    video_prompt?: string | null;
    duration_seconds?: number | null;
    regenerate_image?: boolean;
    image_model?: string | null;
    image_resolution?: string | null;
    image_style_tool?: string | null;
    video_model?: string | null;
    video_resolution?: string | null;
    video_audio?: boolean | null;
  } = {},
): Promise<JsonDict> {
  const regenerateImage = options.regenerate_image ?? true;
  let plan = loadVideoPlan(ctx);
  let scene: Scene;
  [plan, scene] = patchSceneInPlan(plan, sceneId, {
    narration: options.narration,
    image_prompt: options.image_prompt,
    video_prompt: options.video_prompt,
    duration_seconds: options.duration_seconds,
  });
  saveVideoPlan(ctx, plan);
  invalidateFinalArtifacts(ctx);

  const images = readJsonArtifact<JsonDict[]>(ctx, "images", []) ?? [];
  const videos = readJsonArtifact<JsonDict[]>(ctx, "videos", []) ?? [];
  let failures = readJsonArtifact<JsonDict[]>(ctx, "failed_scenes", []) ?? [];
  const imageByScene = new Map(images.map((image) => [String(image.scene_id), image]));
  const imageCtx = contextWithMagicImageSettings(ctx, {
    model: options.image_model || ctx.image_model,
    image_resolution: options.image_resolution || ctx.image_resolution,
    image_style_tool: options.image_style_tool || ctx.image_style_tool,
  });
  const videoCtx = contextWithMagicVideoSettings(ctx, {
    model: options.video_model || ctx.video_model,
    resolution: options.video_resolution || ctx.resolution,
    audio: options.video_audio == null ? ctx.video_audio : options.video_audio,
    scenes: [scene],
  });

  let image: JsonDict;
  if (regenerateImage || !imageByScene.has(sceneId)) {
    image = await generateImageAsset(imageCtx, scene);
  } else {
    image = imageByScene.get(sceneId)!;
  }
  const video = await renderSingleSceneVideo(videoCtx, plan, scene, image);

  const mergedImages = orderedSceneAssets(plan, upsertSceneAssets(images, [image]));
  const mergedVideos = orderedSceneAssets(plan, upsertSceneAssets(videos, [video]));
  // Include "talking" so a stale soft talking failure from an earlier render
  // (renderTalkingPairs) doesn't survive a now-successful regenerate.
  failures = clearSceneFailures(failures, new Set([sceneId]), new Set(["image_generation", "video_generation", "talking"]));
  writeJsonArtifact(ctx, "images", mergedImages);
  writeJsonArtifact(ctx, "videos", mergedVideos);
  writeJsonArtifact(ctx, "failed_scenes", failures);
  updateProjectState(ctx, {
    current_plan: plan,
    provider_settings: {
      image_model: imageCtx.image_model,
      image_resolution: imageCtx.image_resolution,
      image_style_tool: imageCtx.image_style_tool,
      video_model: videoCtx.video_model,
      video_resolution: videoCtx.resolution,
      video_audio: videoCtx.video_audio,
    },
    images: mergedImages,
    videos: mergedVideos,
    failures,
    final_video_path: null,
    manifest_path: null,
    status: { stage: "scene_regenerated", progress: 78, message: `Regenerated ${sceneId}.` },
    decision: {
      tool: "regenerate_scene",
      decision: `Regenerated assets for ${sceneId}.`,
      scene_id: sceneId,
      metadata: {
        regenerated_image: regenerateImage || !imageByScene.has(sceneId),
        patched_fields: Object.entries({
          narration: options.narration,
          image_prompt: options.image_prompt,
          video_prompt: options.video_prompt,
          duration_seconds: options.duration_seconds,
        })
          .filter(([, value]) => value != null)
          .map(([field]) => field),
      },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "scene_regenerated",
    scene,
    images: mergedImages.map((asset) => withMediaUrl(asset)),
    videos: mergedVideos.map((asset) => withMediaUrl(asset)),
    failed_scenes: failures,
    next_tools: ["inspect_render_status", "restitch_video"],
  };
}

export async function reviseNarrationImpl(
  ctx: ProjectContext,
  narration: string,
  sceneNarrationUpdates: SceneNarrationRevision[] | null = null,
): Promise<JsonDict> {
  let plan = loadVideoPlan(ctx);
  plan = { ...plan, narration };
  plan = reviseSceneNarrations(plan, sceneNarrationUpdates ?? []);
  saveVideoPlan(ctx, plan);
  invalidateFinalArtifacts(ctx, { voiceover: true });
  updateProjectState(ctx, {
    current_plan: plan,
    status: { stage: "narration_revised", progress: 35, message: "Narration revised; voiceover is stale." },
    decision: {
      tool: "revise_narration",
      decision: "Revised narration and invalidated the previous voiceover.",
      metadata: { scene_ids: (sceneNarrationUpdates ?? []).map((revision) => revision.scene_id) },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "narration_revised",
    plan,
    next_tools: ["replace_voiceover", "restitch_video"],
  };
}

export async function replaceVoiceoverImpl(ctx: ProjectContext, narration: string | null = null): Promise<JsonDict> {
  let plan = loadVideoPlan(ctx);
  if (narration !== null) {
    plan = { ...plan, narration };
    saveVideoPlan(ctx, plan);
  }
  invalidateFinalArtifacts(ctx, { voiceover: true });
  const voiceover = await generateVoiceoverAsset(
    ctx,
    plan.narration,
    planDurationSeconds(plan),
    resolveVoiceReferenceId(plan, ctx),
  );
  writeJsonArtifact(ctx, "voiceover", voiceover);
  updateProjectState(ctx, {
    current_plan: plan,
    voiceover,
    final_video_path: null,
    manifest_path: null,
    status: { stage: "voiceover_replaced", progress: 55, message: "Voiceover replaced." },
    decision: {
      tool: "replace_voiceover",
      decision: "Replaced the voiceover audio from the current narration.",
      metadata: { target_duration_seconds: voiceover.target_duration_seconds },
    },
  });
  return {
    project_id: ctx.project_id,
    stage: "voiceover_replaced",
    voiceover: withMediaUrl(voiceover),
    next_tools: ["restitch_video"],
  };
}

export function inspectTimelineImpl(ctx: ProjectContext): JsonDict {
  const timeline = currentProjectTimeline(ctx);
  updateProjectState(ctx, { timeline });
  return inspectTimeline(timeline);
}

export function trimTimelineClipImpl(
  ctx: ProjectContext,
  clipId: string,
  trim: { source_start?: number | null; source_end?: number | null },
): JsonDict {
  const timeline = currentProjectTimeline(ctx);
  const updated = keepEndingGuardAtTimelineEnd(
    trimClip(timeline, clipId, {
      ...(trim.source_start != null ? { source_start: trim.source_start } : {}),
      ...(trim.source_end != null ? { source_end: trim.source_end } : {}),
    }),
  );
  updateProjectState(ctx, {
    timeline: updated,
    decision: {
      tool: "trim_clip",
      decision: `Trimmed timeline clip ${clipId}.`,
      metadata: { clip_id: clipId, source_start: trim.source_start ?? null, source_end: trim.source_end ?? null },
    },
  });
  return inspectTimeline(updated);
}

export function moveTimelineClipImpl(ctx: ProjectContext, clipId: string, timelineStart: number): JsonDict {
  const timeline = currentProjectTimeline(ctx);
  const updated = keepEndingGuardAtTimelineEnd(moveClip(timeline, clipId, timelineStart));
  updateProjectState(ctx, {
    timeline: updated,
    decision: {
      tool: "move_clip",
      decision: `Moved timeline clip ${clipId}.`,
      metadata: { clip_id: clipId, timeline_start: timelineStart },
    },
  });
  return inspectTimeline(updated);
}

export function setFinalHoldImpl(ctx: ProjectContext, holdSeconds: number, reason = "Adjusted final hold."): JsonDict {
  const timeline = currentProjectTimeline(ctx);
  const updated = setFinalHold(timeline, holdSeconds, reason);
  updateProjectState(ctx, {
    timeline: updated,
    decision: {
      tool: "set_final_hold",
      decision: `Set final timeline hold to ${updated.ending.hold_seconds}s.`,
      rationale: reason,
      metadata: { hold_seconds: updated.ending.hold_seconds },
    },
  });
  return inspectTimeline(updated);
}

export async function restitchVideoImpl(
  ctx: ProjectContext,
  tokenOutput: JsonDict | null = null,
  reason = "",
): Promise<JsonDict> {
  const manifest = await stitchFinalVideoImpl(ctx, tokenOutput);
  updateProjectState(ctx, {
    status: { stage: "video_restitched", progress: 95, message: "Final video restitched." },
    decision: {
      tool: "restitch_video",
      decision: "Restitched the final video from current scene videos and voiceover.",
      ...(reason ? { rationale: reason } : {}),
    },
  });
  return manifest;
}

export async function restitchTimelineImpl(
  ctx: ProjectContext,
  tokenOutput: JsonDict | null = null,
  reason = "Restitched after timeline edits.",
): Promise<JsonDict> {
  const manifest = await restitchVideoImpl(ctx, tokenOutput, reason);
  updateProjectState(ctx, {
    decision: {
      tool: "restitch_timeline",
      decision: "Restitched the final video from the saved timeline.",
      ...(reason ? { rationale: reason } : {}),
    },
  });
  return manifest;
}
