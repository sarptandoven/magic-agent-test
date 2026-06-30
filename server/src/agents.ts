import { Agent, run, tool, toolNamespace, toolSearchTool, webSearchTool } from "@openai/agents";
import { z } from "zod";
import { DEFAULT_MAGIC_HOUR_IMAGE_MODEL, DEFAULT_MAGIC_HOUR_VIDEO_MODEL, ENV } from "./config.js";
import type { ProjectContext } from "./context.js";
import { configuredAgentMaxTurns, requestFromProjectState } from "./projectContext.js";
import { updateProjectStatus } from "./projects.js";
import {
  buildGenerationBrief,
  buildYoutubeScriptPrompt,
  normalizeYoutubeScriptPlan,
  youtubeScriptNarration,
} from "./prompts.js";
import { updateProjectState, writeJsonArtifact } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import {
  MAGIC_IMAGE_MODELS,
  MAGIC_IMAGE_RESOLUTIONS,
  MAGIC_IMAGE_STYLE_TOOLS,
  MAGIC_VIDEO_MODELS,
  RESOLUTIONS,
  SceneSchema,
  SceneNarrationRevisionSchema,
  VideoPlanSchema,
  YouTubeClipSectionSchema,
  YouTubeScriptPlanSchema,
  type CreateProjectRequest,
  type VideoPlan,
  type YouTubeScriptPlan,
} from "./schemas.js";
import { INSTRUCTIONS, PLANNING_INSTRUCTIONS } from "./prompts.js";
import { pendingTokenOutput, writeTokenOutput } from "./usageCost.js";
import { reviewYoutubeScriptWithSubagent, youtubeSubagentModel } from "./youtubeSubagents.js";
import {
  animateSceneVideosImpl,
  createYoutubeShortImpl,
  draftVideoPlanImpl,
  generateSceneImagesImpl,
  generateVoiceoverImpl,
  inspectTimelineImpl,
  inspectRenderStatusImpl,
  moveTimelineClipImpl,
  normalizePlan,
  recordProjectDecisionImpl,
  regenerateSceneImpl,
  replaceVoiceoverImpl,
  restitchTimelineImpl,
  restitchVideoImpl,
  retrySceneWithModelsImpl,
  reviseNarrationImpl,
  setFinalHoldImpl,
  stitchFinalVideoImpl,
  trimTimelineClipImpl,
} from "./workflows.js";

const IMAGE_PROMPT_FIELD_DESCRIPTION =
  "Optional replacement still-image prompt. Write a stable keyframe for image-to-video: concrete visible subject, " +
  "action pose, foreground/background, lighting, lens/framing, palette, and continuity. Do not include text/logos/UI " +
  "or anything that must be invented later.";
const VIDEO_PROMPT_FIELD_DESCRIPTION =
  "Optional replacement image-to-video motion prompt. Use one camera move and at most one subject motion; only " +
  "animate what already exists in the still image. No cuts, new objects, scene changes, transformations, or " +
  "ungrounded events.";

export const draftVideoPlan = tool({
  name: "draft_video_plan",
  description:
    "Persist the complete creative plan before making provider calls. " +
    "title: concise title for the finished video. narration: full voiceover script for the complete edit. " +
    "visual_bible: compact continuity notes for subject, palette, lens language, and environment. " +
    "scenes: ordered scene plan with narration, image prompts, motion prompts, and durations. " +
    "Scenes default to on_camera:true — a creator on screen speaking first-person dialogue (rendered as a " +
    "talking video). Set on_camera:false for a detached-voiceover b-roll cutaway.",
  parameters: z.object({
    title: z.string(),
    narration: z.string(),
    scenes: z.array(SceneSchema),
    visual_bible: z.string().default(""),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "planning",
      progress: 15,
      message: "Creative plan drafted by the agent.",
    });
    return draftVideoPlanImpl(ctx, input.title, input.narration, input.scenes, input.visual_bible);
  },
});

export const generateVoiceover = tool({
  name: "generate_voiceover",
  description: "Generate the voiceover audio for the current saved plan.",
  parameters: z.object({}),
  deferLoading: true,
  execute: async (_input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "voiceover",
      progress: 30,
      message: "Generating the voiceover.",
    });
    return generateVoiceoverImpl(ctx);
  },
});

export const generateSceneImages = tool({
  name: "generate_scene_images",
  description:
    "Generate still images for all scenes, or for selected scene ids. " +
    "model: Magic Hour image model. Default to seedream-v4 unless the user explicitly selected a different model or " +
    "the prompt clearly needs a model-specific capability. Do not use Magic Hour's default model unless the user " +
    "explicitly asks for it. image_resolution: Magic Hour image resolution supported by the selected image model: " +
    "640px, 1k, 2k, or 4k. image_style_tool: Magic Hour image style category. Use general unless a specific image " +
    "domain such as ai-photo-generator, ai-character-generator, ai-landscape-generator, or movie-poster-generator " +
    "clearly fits. scene_ids: optional scene ids to generate; pass null to generate every scene in the saved plan.",
  parameters: z.object({
    model: z.enum(MAGIC_IMAGE_MODELS).default(DEFAULT_MAGIC_HOUR_IMAGE_MODEL as any),
    image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).default("1k"),
    image_style_tool: z.enum(MAGIC_IMAGE_STYLE_TOOLS).default("general"),
    scene_ids: z.array(z.string()).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "image_generation",
      progress: 45,
      message: `Generating scene images with ${input.model}.`,
    });
    return generateSceneImagesImpl(ctx, input.scene_ids, {
      model: input.model,
      image_resolution: input.image_resolution,
      image_style_tool: input.image_style_tool,
    });
  },
});

export const animateSceneVideos = tool({
  name: "animate_scene_videos",
  description:
    "Animate scene videos from generated images. " +
    "model: Magic Hour image-to-video model. Default to ltx-2.3 unless the user explicitly selected a different " +
    "model or the prompt clearly needs a model-specific capability. Use seedance-2.0 for consistency, kling-2.5 for " +
    "motion/camera control, kling-3.0 for cinematic storytelling, veo3.1 for realism/prompt adherence, or sora-2 for " +
    "story-first creative motion only when that tradeoff is intentional. resolution: output video resolution " +
    "supported by the selected video model. audio: whether Magic Hour should generate provider audio; usually false " +
    "because the final edit uses Fish Audio voiceover. On-camera (talking) scenes are rendered via AI Talking Photo " +
    "from the scene's keyframe image + a per-scene Fish Audio line (not imageToVideo), so keep audio:false — provider " +
    "audio is not the speech source; b-roll cutaways still use imageToVideo. " +
    "scene_ids: optional scene ids to animate; pass null to animate every scene with an image.",
  parameters: z.object({
    model: z.enum(MAGIC_VIDEO_MODELS).default(DEFAULT_MAGIC_HOUR_VIDEO_MODEL as any),
    resolution: z.enum(RESOLUTIONS).default("720p"),
    audio: z.boolean().default(false),
    scene_ids: z.array(z.string()).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "video_generation",
      progress: 70,
      message: `Animating scene videos with ${input.model}.`,
    });
    return animateSceneVideosImpl(ctx, input.scene_ids, {
      model: input.model,
      resolution: input.resolution,
      audio: input.audio,
    });
  },
});

export const stitchFinalVideo = tool({
  name: "stitch_final_video",
  description: "Stitch completed scene videos with the voiceover into the final MP4.",
  parameters: z.object({}),
  deferLoading: true,
  execute: async (_input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "stitching",
      progress: 90,
      message: "Stitching the final edit.",
    });
    return stitchFinalVideoImpl(ctx, pendingTokenOutput(ctx, ENV.OPENAI_MODEL ?? "gpt-5.5"));
  },
});

export const inspectRenderStatus = tool({
  name: "inspect_render_status",
  description: "Inspect saved plan, project_state.json, media artifacts, failures, and recommended next tools.",
  parameters: z.object({}),
  deferLoading: true,
  execute: async (_input, runContext) => {
    return inspectRenderStatusImpl(runContext!.context as ProjectContext);
  },
});

export const recordProjectDecision = tool({
  name: "record_project_decision",
  description:
    "Persist an important creative, retry, or user-preference decision. decision: short statement of the choice " +
    "being made. rationale: optional reason for the choice. scene_id: optional scene id when the decision is " +
    "scene-specific.",
  parameters: z.object({
    decision: z.string(),
    rationale: z.string().default(""),
    scene_id: z.string().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    return recordProjectDecisionImpl(
      runContext!.context as ProjectContext,
      input.decision,
      input.rationale,
      input.scene_id,
    );
  },
});

export const regenerateScene = tool({
  name: "regenerate_scene",
  description:
    "Patch one scene and regenerate only that scene's media assets. scene_id: saved scene id, such as scene_2. " +
    "narration: optional replacement narration for this scene. duration_seconds: optional replacement scene " +
    "duration. regenerate_image: whether to regenerate the image before animating the scene. image_model / " +
    "image_resolution / image_style_tool: optional Magic Hour image settings for the regenerated keyframe. " +
    "video_model / video_resolution: optional Magic Hour image-to-video settings for the regenerated scene. " +
    "video_audio: optional provider-audio toggle; usually false because final stitching uses Fish Audio.",
  parameters: z.object({
    scene_id: z.string(),
    narration: z.string().nullable().default(null),
    image_prompt: z.string().nullable().default(null).describe(IMAGE_PROMPT_FIELD_DESCRIPTION),
    video_prompt: z.string().nullable().default(null).describe(VIDEO_PROMPT_FIELD_DESCRIPTION),
    duration_seconds: z.number().int().min(1).max(30).nullable().default(null),
    regenerate_image: z.boolean().default(true),
    image_model: z.enum(MAGIC_IMAGE_MODELS).nullable().default(null),
    image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).nullable().default(null),
    image_style_tool: z.enum(MAGIC_IMAGE_STYLE_TOOLS).nullable().default(null),
    video_model: z.enum(MAGIC_VIDEO_MODELS).nullable().default(null),
    video_resolution: z.enum(RESOLUTIONS).nullable().default(null),
    video_audio: z.boolean().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "regenerate_scene",
      progress: 78,
      message: `Regenerating ${input.scene_id}.`,
    });
    return regenerateSceneImpl(ctx, input.scene_id, {
      narration: input.narration,
      image_prompt: input.image_prompt,
      video_prompt: input.video_prompt,
      duration_seconds: input.duration_seconds,
      regenerate_image: input.regenerate_image,
      image_model: input.image_model,
      image_resolution: input.image_resolution,
      image_style_tool: input.image_style_tool,
      video_model: input.video_model,
      video_resolution: input.video_resolution,
      video_audio: input.video_audio,
    });
  },
});

export const reviseNarration = tool({
  name: "revise_narration",
  description:
    "Patch the saved narration and invalidate stale voiceover/final video artifacts. narration: replacement full " +
    "voiceover narration. scene_narration_updates: optional per-scene narration replacements.",
  parameters: z.object({
    narration: z.string(),
    scene_narration_updates: z.array(SceneNarrationRevisionSchema).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "revise_narration",
      progress: 35,
      message: "Revising narration.",
    });
    return reviseNarrationImpl(ctx, input.narration, input.scene_narration_updates);
  },
});

export const replaceVoiceover = tool({
  name: "replace_voiceover",
  description:
    "Replace the voiceover audio from the current saved narration or a new narration. narration: optional full " +
    "narration to save before generating audio.",
  parameters: z.object({
    narration: z.string().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "replace_voiceover",
      progress: 55,
      message: "Replacing voiceover.",
    });
    return replaceVoiceoverImpl(ctx, input.narration);
  },
});

export const restitchVideo = tool({
  name: "restitch_video",
  description:
    "Rebuild the final MP4 from the current scene videos and voiceover. reason: optional reason for restitching " +
    "after a revision.",
  parameters: z.object({
    reason: z.string().default(""),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "restitching",
      progress: 95,
      message: "Restitching the final edit.",
    });
    return restitchVideoImpl(ctx, pendingTokenOutput(ctx, ENV.OPENAI_MODEL ?? "gpt-5.5"), input.reason);
  },
});

export const inspectTimelineTool = tool({
  name: "inspect_timeline",
  description:
    "Inspect the saved editor timeline with video, narration, and ending guard tracks. Use before precise trim, move, " +
    "or ending changes.",
  parameters: z.object({}),
  deferLoading: true,
  execute: async (_input, runContext) => {
    return inspectTimelineImpl(runContext!.context as ProjectContext);
  },
});

export const trimClipTool = tool({
  name: "trim_clip",
  description:
    "Trim one timeline clip by setting exact local source_start/source_end seconds. Use inspect_timeline first to get " +
    "clip ids and current bounds.",
  parameters: z.object({
    clip_id: z.string(),
    source_start: z.number().min(0).nullable().default(null),
    source_end: z.number().min(0).nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    return trimTimelineClipImpl(runContext!.context as ProjectContext, input.clip_id, {
      source_start: input.source_start,
      source_end: input.source_end,
    });
  },
});

export const moveClipTool = tool({
  name: "move_clip",
  description:
    "Move one timeline clip to an exact timeline_start second. Clips are rendered in timeline order on restitch.",
  parameters: z.object({
    clip_id: z.string(),
    timeline_start: z.number().min(0),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    return moveTimelineClipImpl(runContext!.context as ProjectContext, input.clip_id, input.timeline_start);
  },
});

export const setFinalHoldTool = tool({
  name: "set_final_hold",
  description:
    "Set the final freeze/hold guard duration in seconds so the rendered video has an intentional ending instead of " +
    "an abrupt cutoff.",
  parameters: z.object({
    hold_seconds: z.number().min(0).max(5).default(1.5),
    reason: z.string().default("Make the ending deliberate."),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    return setFinalHoldImpl(runContext!.context as ProjectContext, input.hold_seconds, input.reason);
  },
});

export const restitchTimelineTool = tool({
  name: "restitch_timeline",
  description:
    "Render the final MP4 from the saved timeline after trim, move, or final-hold edits. This also records ffprobe " +
    "audio/video duration verification.",
  parameters: z.object({
    reason: z.string().default("Timeline edits are ready to render."),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "restitching",
      progress: 95,
      message: "Rendering the saved timeline.",
    });
    return restitchTimelineImpl(ctx, pendingTokenOutput(ctx, ENV.OPENAI_MODEL ?? "gpt-5.5"), input.reason);
  },
});

export const retryScene = tool({
  name: "retry_scene",
  description:
    "Retry one scene without restarting the whole project. scene_id: saved scene id, such as scene_1. stage: retry " +
    "image, video, or all scene assets. image_model / image_resolution / image_style_tool: optional Magic Hour " +
    "image settings when retrying image/all. video_model / video_resolution: optional Magic Hour image-to-video " +
    "settings when retrying video/all. video_audio: optional provider-audio toggle; usually false because final " +
    "stitching uses Fish Audio.",
  parameters: z.object({
    scene_id: z.string(),
    stage: z.enum(["image", "video", "all"]).default("video"),
    image_model: z.enum(MAGIC_IMAGE_MODELS).nullable().default(null),
    image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).nullable().default(null),
    image_style_tool: z.enum(MAGIC_IMAGE_STYLE_TOOLS).nullable().default(null),
    video_model: z.enum(MAGIC_VIDEO_MODELS).nullable().default(null),
    video_resolution: z.enum(RESOLUTIONS).nullable().default(null),
    video_audio: z.boolean().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "retry_scene",
      progress: 75,
      message: `Retrying ${input.scene_id}.`,
    });
    return retrySceneWithModelsImpl(ctx, input.scene_id, input.stage, {
      image_model: input.image_model,
      image_resolution: input.image_resolution,
      image_style_tool: input.image_style_tool,
      video_model: input.video_model,
      video_resolution: input.video_resolution,
      video_audio: input.video_audio,
    });
  },
});

export const createYoutubeShort = tool({
  name: "create_youtube_short",
  description:
    "Create a short from searched YouTube clips, current Fish voiceover, and ffmpeg stitching. title: concise title " +
    "for the finished short. narration: full spoken script made by joining the section dialogue in order. sections: " +
    "ordered clip plan; each section needs dialogue, a YouTube search hint, and duration. proxy_url: optional proxy " +
    "URL for yt-dlp downloads when needed.",
  parameters: z.object({
    title: z.string(),
    narration: z.string(),
    sections: z.array(YouTubeClipSectionSchema),
    proxy_url: z.string().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "youtube_short",
      progress: 20,
      message: "Creating a YouTube clip short.",
    });
    return createYoutubeShortImpl(ctx, input.title, input.narration, input.sections, {
      token_output: pendingTokenOutput(ctx, ENV.OPENAI_MODEL ?? "gpt-5.5"),
      proxy_url: input.proxy_url,
    });
  },
});

export const createYoutubeShortFromPrompt = tool({
  name: "create_youtube_short_from_prompt",
  description:
    "Create a YouTube clip short from the current project prompt. The tool first drafts a notebook-style YouTube " +
    "script plan with ordered section dialogue, duration_seconds, and search_hint values, then reuses the existing " +
    "YouTube clip downloader, per-section Fish voiceover, and stitcher. proxy_url: optional proxy URL for yt-dlp " +
    "downloads when needed.",
  parameters: z.object({
    proxy_url: z.string().nullable().default(null),
  }),
  deferLoading: true,
  execute: async (input, runContext) => {
    const ctx = runContext!.context as ProjectContext;
    await updateProjectStatus(ctx.project_id, {
      status: "running",
      stage: "youtube_script",
      progress: 15,
      message: "Drafting the YouTube script and search hints.",
    });
    return createYoutubeShortFromPromptImpl(ctx, { proxy_url: input.proxy_url });
  },
});

export const VIDEO_STUDIO_TOOLS = toolNamespace({
  name: "video_studio",
  description: "Professional cinematic video generation and post-production tools.",
  tools: [
    draftVideoPlan,
    generateVoiceover,
    generateSceneImages,
    animateSceneVideos,
    stitchFinalVideo,
    inspectRenderStatus,
    recordProjectDecision,
    regenerateScene,
    reviseNarration,
    replaceVoiceover,
    restitchVideo,
    inspectTimelineTool,
    trimClipTool,
    moveClipTool,
    setFinalHoldTool,
    restitchTimelineTool,
    retryScene,
  ],
});

export const FIRST_RENDER_VIDEO_STUDIO_TOOLS = toolNamespace({
  name: "video_studio",
  description: "First-render video generation tools. Edit and retry tools are intentionally unavailable.",
  tools: [
    draftVideoPlan,
    generateVoiceover,
    generateSceneImages,
    animateSceneVideos,
    stitchFinalVideo,
    inspectRenderStatus,
    recordProjectDecision,
  ],
});

export const YOUTUBE_SHORT_TOOLS = toolNamespace({
  name: "youtube_short",
  description: "Create shorts from searched YouTube clips, current-project voiceover, and ffmpeg stitching.",
  tools: [createYoutubeShortFromPrompt],
});

// Legacy direct planner retained for focused plan/token tests; runProject uses videoAgent.
export const planningAgentModel = ENV.OPENAI_MODEL ?? "gpt-5.5";
export const planningAgent = new Agent<ProjectContext, typeof VideoPlanSchema>({
  name: "Fast Video Planning Agent",
  model: planningAgentModel,
  instructions: PLANNING_INSTRUCTIONS,
  tools: [],
  outputType: VideoPlanSchema,
  modelSettings: {
    reasoning: { effort: (ENV.OPENAI_REASONING_EFFORT ?? "low") as any },
    text: { verbosity: (ENV.OPENAI_VERBOSITY ?? "low") as any },
    parallelToolCalls: false,
  },
});

export function youtubeScriptModel(): string {
  return ENV.YOUTUBE_SCRIPT_MODEL ?? ENV.OPENAI_FAST_MODEL ?? ENV.OPENAI_MODEL ?? "gpt-5.4";
}

export function youtubeScriptInstructionsForRequest(_request: CreateProjectRequest | null): string {
  return [
    "Draft only the structured YouTube script requested by the prompt.",
    "Decide whether WebSearchTool is needed from the user's prompt and current date, not from a fixed topic list.",
    "Use WebSearchTool only when the script needs facts that can drift, such as latest/current/recent news, product releases, public figures, sports, prices, laws, safety guidance, or dated claims.",
    "For stable historical, fictional, evergreen educational, or purely visual prompts, set web_search_needed=false and do not call WebSearchTool.",
    "If web search is needed, call WebSearchTool before naming specific current facts, set web_search_needed=true, and summarize why in web_search_reason.",
    "Never set web_search_needed=true unless you actually called WebSearchTool during this run.",
    "Use quick broad web search, not deep research; prefer fresh reputable or official sources.",
    "Keep source URLs and citations out of dialogue and search_hint fields.",
  ].join(" ");
}

export function youtubeScriptAgentForRequest(request: CreateProjectRequest | null = null) {
  return new Agent<ProjectContext, typeof YouTubeScriptPlanSchema>({
    name: "Notebook-Style YouTube Script Planner",
    model: youtubeScriptModel(),
    instructions: youtubeScriptInstructionsForRequest(request),
    tools: [webSearchTool({ searchContextSize: "low" })],
    outputType: YouTubeScriptPlanSchema,
    modelSettings: {
      reasoning: { effort: (ENV.YOUTUBE_SCRIPT_REASONING_EFFORT ?? "low") as any },
      text: { verbosity: (ENV.YOUTUBE_SCRIPT_VERBOSITY ?? "low") as any },
      parallelToolCalls: false,
    },
  });
}

export const youtubeScriptAgent = youtubeScriptAgentForRequest();

// The production path: the agent owns planning, provider-tool sequencing,
// retries, and stitching. The UI workflow toggle is enforced through the run
// brief, not by swapping to a different orchestrator agent.
export const videoAgentModel = ENV.OPENAI_MODEL ?? "gpt-5.4";
export const videoAgent = new Agent<ProjectContext>({
  name: "Autonomous Video Art Director",
  model: videoAgentModel,
  instructions: INSTRUCTIONS,
  tools: [...VIDEO_STUDIO_TOOLS, ...YOUTUBE_SHORT_TOOLS, toolSearchTool()],
  modelSettings: {
    reasoning: { effort: (ENV.OPENAI_REASONING_EFFORT ?? "low") as any },
    text: { verbosity: (ENV.OPENAI_VERBOSITY ?? "low") as any },
    parallelToolCalls: true,
  },
});

export const firstRenderVideoAgent = new Agent<ProjectContext>({
  name: "First-Render Video Art Director",
  model: videoAgentModel,
  instructions:
    INSTRUCTIONS +
    "\n\nFirst-render constraint: produce the first complete video only. Do not edit, retry, regenerate, trim, " +
    "or restitch as a subjective improvement during the first run. Provider recovery may happen inside " +
    "stitch_final_video using already-submitted job ids, but do not spend on extra scene renders.",
  tools: [...FIRST_RENDER_VIDEO_STUDIO_TOOLS, ...YOUTUBE_SHORT_TOOLS, toolSearchTool()],
  modelSettings: {
    reasoning: { effort: (ENV.OPENAI_REASONING_EFFORT ?? "low") as any },
    text: { verbosity: (ENV.OPENAI_VERBOSITY ?? "low") as any },
    parallelToolCalls: true,
  },
});

export function projectAgentForRequest(_request: CreateProjectRequest) {
  // `workflow` constrains the main orchestrator's brief. `generated` lets it
  // use the normal Magic Hour toolchain; `youtube_clips` forces the YouTube
  // workflow tool first. Auto-routing can be added later as a new workflow
  // mode without introducing a second director.
  return firstRenderVideoAgent;
}

export async function planVideo(
  request: CreateProjectRequest,
  ctx: ProjectContext,
): Promise<[VideoPlan, JsonDict]> {
  const result = await run(planningAgent, buildGenerationBrief(request, ctx), {
    context: ctx,
    maxTurns: configuredAgentMaxTurns(),
  });
  const tokenOutput = writeTokenOutput(ctx, result.runContext.usage, planningAgentModel);
  const plan = VideoPlanSchema.parse(result.finalOutput);
  return [normalizePlan(plan), tokenOutput];
}

export function youtubeScriptResultUsedWebSearch(result: { newItems: any[] }): boolean {
  for (const item of result.newItems ?? []) {
    const rawItem = item?.rawItem;
    let rawType = rawItem?.type ?? "";
    if (rawItem && typeof rawItem === "object" && "type" in rawItem) {
      rawType = rawItem.type ?? rawType;
    }
    const providerData = item?.providerData ?? rawItem?.providerData ?? null;
    const markers = [
      item?.type ?? "",
      item?.name ?? "",
      item?.title ?? "",
      item?.description ?? "",
      rawType,
      rawItem?.name ?? "",
      providerData?.type ?? "",
      providerData?.name ?? "",
      rawItem != null ? rawItem.constructor?.name ?? "" : "",
    ];
    const normalized = markers.map((marker) => String(marker || "").toLowerCase()).join(" ");
    if (normalized.includes("web_search") || normalized.includes("websearch")) {
      return true;
    }
  }
  return false;
}

export async function draftYoutubeScriptImpl(
  ctx: ProjectContext,
  request: CreateProjectRequest,
): Promise<YouTubeScriptPlan> {
  const scriptAgent = youtubeScriptAgentForRequest(request);
  const prompt = buildYoutubeScriptPrompt(request, ctx);
  let result = await run(scriptAgent, prompt, {
    context: ctx,
    maxTurns: configuredAgentMaxTurns(),
  });
  let plan = YouTubeScriptPlanSchema.parse(result.finalOutput);
  plan = normalizeYoutubeScriptPlan(plan);
  let webSearchUsed = youtubeScriptResultUsedWebSearch(result);
  if (plan.web_search_needed && !webSearchUsed) {
    const forcedSearchAgent = scriptAgent.clone({
      modelSettings: {
        ...scriptAgent.modelSettings,
        toolChoice: "web_search",
      },
    });
    result = await run(
      forcedSearchAgent,
      [
        prompt,
        "",
        "The previous script plan set web_search_needed=true without a recorded web_search call.",
        "Call WebSearchTool now, ground the current facts, then return the structured YouTube script plan.",
      ].join("\n"),
      {
        context: ctx,
        maxTurns: configuredAgentMaxTurns(),
      },
    );
    plan = normalizeYoutubeScriptPlan(YouTubeScriptPlanSchema.parse(result.finalOutput));
    webSearchUsed = youtubeScriptResultUsedWebSearch(result);
    if (plan.web_search_needed && !webSearchUsed) {
      throw new Error(
        "YouTube script planner marked web_search_needed=true but did not call WebSearchTool. " +
          "Regenerate so current facts are grounded before script drafting.",
      );
    }
  }
  const scriptReview = await reviewYoutubeScriptWithSubagent(ctx, request, plan);
  plan = scriptReview.plan;
  writeJsonArtifact(ctx, "youtube_script_plan", plan);
  updateProjectState(ctx, {
    decision: {
      tool: "draft_youtube_script",
      decision: "Drafted a notebook-style YouTube script plan from the project prompt.",
      metadata: {
        title: plan.title,
        section_count: plan.sections.length,
        search_hints: plan.sections.map((section) => section.search_hint),
        model: youtubeScriptModel(),
        web_search_available: true,
        web_search_needed: plan.web_search_needed,
        web_search_used: webSearchUsed,
        web_search_reason: plan.web_search_reason,
        web_search_context_size: "low",
        subagent: scriptReview.review,
        subagent_model: youtubeSubagentModel(),
      },
    },
  });
  return plan;
}

export async function createYoutubeShortFromPromptImpl(
  ctx: ProjectContext,
  options: { proxy_url?: string | null } = {},
): Promise<JsonDict> {
  const request = requestFromProjectState(ctx);
  if (request === null) {
    throw new Error("No project request found. Start a project before creating a YouTube short from prompt.");
  }
  if (request.workflow !== "youtube_clips") {
    throw new Error("create_youtube_short_from_prompt is only available for workflow='youtube_clips'.");
  }
  const script = await draftYoutubeScriptImpl(ctx, request);
  return createYoutubeShortImpl(ctx, script.title, youtubeScriptNarration(script), script.sections, {
    token_output: pendingTokenOutput(ctx, youtubeScriptModel()),
    proxy_url: options.proxy_url ?? null,
  });
}
