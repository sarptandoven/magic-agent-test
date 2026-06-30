import { z } from "zod";
import { VOICE_KEYS } from "./voices.js";

export const ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;
export const RESOLUTIONS = ["480p", "720p", "1080p"] as const;
export const WORKFLOW_MODES = ["generated", "youtube_clips"] as const;
export const YOUTUBE_SEARCH_PROVIDERS = ["auto", "youtube_data_api", "yt_dlp"] as const;
export const YOUTUBE_REVIEW_PROVIDERS = ["youtube_data_api", "yt_dlp"] as const;

export const MAGIC_IMAGE_MODELS = [
  "default",
  "flux-schnell",
  "z-image-turbo",
  "seedream-v4",
  "nano-banana",
  "nano-banana-2",
  "nano-banana-pro",
] as const;
export const MAGIC_IMAGE_RESOLUTIONS = ["640px", "1k", "2k", "4k"] as const;
export const MAGIC_IMAGE_STYLE_TOOLS = [
  "general",
  "ai-photo-generator",
  "ai-character-generator",
  "ai-landscape-generator",
  "ai-illustration-generator",
  "ai-art-generator",
  "movie-poster-generator",
  "architecture-generator",
  "ai-background-generator",
] as const;
export const MAGIC_VIDEO_MODELS = [
  "default",
  "ltx-2",
  "ltx-2.3",
  "wan-2.2",
  "seedance",
  "seedance-2.0",
  "kling-2.5",
  "kling-3.0",
  "sora-2",
  "veo3.1",
  "veo3.1-lite",
  "kling-1.6",
] as const;

export type AspectRatio = (typeof ASPECT_RATIOS)[number];
export type Resolution = (typeof RESOLUTIONS)[number];
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];
export type YouTubeSearchProvider = (typeof YOUTUBE_SEARCH_PROVIDERS)[number];
export type YouTubeReviewProvider = (typeof YOUTUBE_REVIEW_PROVIDERS)[number];
export type MagicImageModel = (typeof MAGIC_IMAGE_MODELS)[number];
export type MagicImageResolution = (typeof MAGIC_IMAGE_RESOLUTIONS)[number];
export type MagicImageStyleTool = (typeof MAGIC_IMAGE_STYLE_TOOLS)[number];
export type MagicVideoModel = (typeof MAGIC_VIDEO_MODELS)[number];
export type ProjectStatus = "queued" | "running" | "succeeded" | "failed";

export const MAGIC_IMAGE_MODEL_RESOLUTIONS: Record<string, Set<string>> = {
  "flux-schnell": new Set(["640px", "1k", "2k"]),
  "z-image-turbo": new Set(["640px", "1k", "2k"]),
  "seedream-v4": new Set(["640px", "1k", "2k", "4k"]),
  "nano-banana": new Set(["640px", "1k"]),
  "nano-banana-2": new Set(["640px", "1k", "2k", "4k"]),
  "nano-banana-pro": new Set(["1k", "2k", "4k"]),
};
export const MAGIC_VIDEO_MODEL_RESOLUTIONS: Record<string, Set<string>> = {
  "ltx-2": new Set(["480p", "720p", "1080p"]),
  "ltx-2.3": new Set(["480p", "720p", "1080p"]),
  "wan-2.2": new Set(["480p", "720p", "1080p"]),
  seedance: new Set(["480p", "720p", "1080p"]),
  "seedance-2.0": new Set(["480p", "720p"]),
  "kling-2.5": new Set(["720p", "1080p"]),
  "kling-3.0": new Set(["720p", "1080p"]),
  "sora-2": new Set(["720p"]),
  "veo3.1": new Set(["720p", "1080p"]),
  "veo3.1-lite": new Set(["720p", "1080p"]),
  "kling-1.6": new Set(["720p", "1080p"]),
};
export const MAGIC_VIDEO_MODEL_DURATIONS: Record<string, Set<number>> = {
  "ltx-2": new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30]),
  "ltx-2.3": new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30]),
  "wan-2.2": new Set([3, 4, 5, 6, 7, 8, 9, 10, 15]),
  seedance: new Set([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
  "seedance-2.0": new Set([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
  "kling-2.5": new Set([5, 10]),
  "kling-3.0": new Set([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]),
  "sora-2": new Set([4, 8, 12, 24, 36, 48, 60]),
  "veo3.1": new Set([4, 6, 8, 16, 24, 32, 40, 48, 56]),
  "veo3.1-lite": new Set([8, 16, 24, 32, 40, 48, 56]),
  "kling-1.6": new Set([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]),
};

export const IMAGE_PROMPT_DESCRIPTION =
  "Provider prompt for the still image. Write a stable cinematic keyframe later to be used for image-to-video generations.: " +
  "describe only what is visible in one frame, including subject identity, action pose, foreground/background, " +
  "lighting, lens/framing, texture, palette, and continuity details. Avoid text, logos, UI, captions, " +
  "multi-panel layouts, and anything the later video prompt must invent.";

export const VIDEO_PROMPT_DESCRIPTION =
  "Provider prompt for animating that exact still image. Use one camera move and at most one subject motion; " +
  "only animate what already exists in the image. Use no cuts. Do not add new objects, locations, cuts, scene changes, " +
  "transformations, text, or events that are not grounded in the keyframe.";

// Agent-facing structured output schemas. The Agents SDK uses strict JSON
// schemas, so optional fields are expressed as nullable.
export const SceneSchema = z.object({
  id: z.string(),
  narration: z.string(),
  image_prompt: z.string().describe(IMAGE_PROMPT_DESCRIPTION),
  video_prompt: z.string().describe(VIDEO_PROMPT_DESCRIPTION),
  duration_seconds: z.number().int().min(1).max(30),
  on_camera: z.boolean().default(true).describe("True (default) for UGC: a character on screen speaks this scene's first-person narration, lip-synced onto the clip. Set false ONLY for a deliberate b-roll cutaway whose narration plays as voiceover over the footage."),
});
export type Scene = z.infer<typeof SceneSchema>;

export const VideoPlanSchema = z.object({
  title: z.string(),
  narration: z.string(),
  visual_bible: z.string().max(900).default(""),
  scenes: z.array(SceneSchema).min(1).max(10),
  // Character-matched Fish Audio voice the planner selects from the catalog
  // (see voices.ts). Null defers to gender inference / the env default voice
  // at TTS time. Validated against the catalog keys at runtime.
  voice: z.enum(VOICE_KEYS).nullable().default(null),
});
export type VideoPlan = z.infer<typeof VideoPlanSchema>;

export const YOUTUBE_SEARCH_ORDERS = ["relevance", "date", "viewCount", "rating"] as const;
export const YOUTUBE_VIDEO_DURATIONS = ["short", "medium", "long"] as const;
export const YOUTUBE_VIDEO_CATEGORIES = [
  "film_animation",
  "autos_vehicles",
  "music",
  "pets_animals",
  "sports",
  "travel_events",
  "gaming",
  "people_blogs",
  "comedy",
  "entertainment",
  "news_politics",
  "howto_style",
  "education",
  "science_technology",
] as const;
export type YouTubeSearchOrder = (typeof YOUTUBE_SEARCH_ORDERS)[number];
export type YouTubeVideoDuration = (typeof YOUTUBE_VIDEO_DURATIONS)[number];
export type YouTubeVideoCategory = (typeof YOUTUBE_VIDEO_CATEGORIES)[number];

export const YouTubeClipSectionSchema = z.object({
  section: z.number().int().min(1).max(10),
  dialogue: z.string().min(1).max(600),
  search_hint: z.string().min(2).max(120),
  // Accept fractional seconds: the script planner derives section durations from
  // "target runtime + per-transition crossfade" math (often non-integer), and the
  // Agents SDK hard-rejects the whole plan if this is .int() and the model returns
  // e.g. 7.5. Downstream uses float seconds throughout (window sizing, VO budget,
  // timeline) and rewrites to the actual voiceover length anyway.
  duration_seconds: z.number().min(1).max(30),
  // Optional retrieval-targeting fields mapped directly onto YouTube Data API
  // search.list parameters, so the planner controls recency, category,
  // captions, and clip length per scene instead of backend heuristics.
  search_order: z.enum(YOUTUBE_SEARCH_ORDERS).nullable().default(null),
  published_after: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  published_before: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  video_duration: z.enum(YOUTUBE_VIDEO_DURATIONS).nullable().default(null),
  video_category: z.enum(YOUTUBE_VIDEO_CATEGORIES).nullable().default(null),
  require_captions: z.boolean().default(false),
  channel_hint: z.string().max(80).nullable().default(null),
  // Direct YouTube URLs the planner found via web search; validated and
  // hydrated server-side, they lead the candidate pool ahead of search.
  candidate_video_urls: z.array(z.string()).max(3).default([]),
  // Lowercased dominant-subject tokens attached server-side during
  // normalization (e.g. ["mahomes", "chiefs"]). Drives generic subject-identity
  // enforcement in candidate selection; absent when no confident subject.
  subject_tokens: z.array(z.string()).optional(),
});
export type YouTubeClipSection = z.infer<typeof YouTubeClipSectionSchema>;

export const YouTubeScriptPlanSchema = z.object({
  title: z.string().min(1).max(120),
  web_search_needed: z.boolean().default(false),
  web_search_reason: z.string().max(300).default(""),
  sections: z.array(YouTubeClipSectionSchema).min(1).max(10),
});
export type YouTubeScriptPlan = z.infer<typeof YouTubeScriptPlanSchema>;

export const SceneNarrationRevisionSchema = z.object({
  scene_id: z.string(),
  narration: z.string(),
});
export type SceneNarrationRevision = z.infer<typeof SceneNarrationRevisionSchema>;

export const CreateProjectRequestSchema = z.object({
  prompt: z.string().min(3).max(2_000),
  workflow: z.enum(WORKFLOW_MODES).default("generated"),
  youtube_search_provider: z.enum(YOUTUBE_SEARCH_PROVIDERS).default("youtube_data_api"),
  youtube_allow_provider_fallback: z.boolean().default(false),
  duration_seconds: z.number().int().min(1).max(60).nullish().default(null),
  scene_count: z.number().int().min(1).max(10).nullish().default(null),
  aspect_ratio: z.enum(ASPECT_RATIOS).default("9:16"),
  resolution: z.enum(RESOLUTIONS).default("720p"),
  image_model: z.enum(MAGIC_IMAGE_MODELS).nullish().default(null),
  video_model: z.enum(MAGIC_VIDEO_MODELS).nullish().default(null),
  image_resolution: z.enum(MAGIC_IMAGE_RESOLUTIONS).nullish().default(null),
  video_resolution: z.enum(RESOLUTIONS).nullish().default(null),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;

export const ProjectMessageRequestSchema = z.object({
  message: z.string().min(1).max(4_000),
});
export type ProjectMessageRequest = z.infer<typeof ProjectMessageRequestSchema>;

export const ProjectTimelineEditRequestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("inspect"),
  }),
  z.object({
    operation: z.literal("trim_clip"),
    clip_id: z.string().min(1),
    source_start: z.number().min(0).nullable().default(null),
    source_end: z.number().min(0).nullable().default(null),
  }),
  z.object({
    operation: z.literal("move_clip"),
    clip_id: z.string().min(1),
    timeline_start: z.number().min(0),
  }),
  z.object({
    operation: z.literal("set_final_hold"),
    hold_seconds: z.number().min(0).max(5),
    reason: z.string().max(500).default("Make the ending deliberate."),
  }),
]);
export type ProjectTimelineEditRequest = z.infer<typeof ProjectTimelineEditRequestSchema>;

export const YouTubeReviewSessionRequestSchema = z.object({
  prompt: z.string().min(3).max(2_000),
  duration_seconds: z.number().int().min(1).max(60).nullish().default(null),
  scene_count: z.number().int().min(1).max(10).nullish().default(null),
  aspect_ratio: z.enum(ASPECT_RATIOS).default("9:16"),
  resolution: z.enum(RESOLUTIONS).default("720p"),
});
export type YouTubeReviewSessionRequest = z.infer<typeof YouTubeReviewSessionRequestSchema>;

export const YouTubeReviewCommentRequestSchema = z.object({
  provider: z.enum(YOUTUBE_REVIEW_PROVIDERS),
  comments: z.string().max(8_000).default(""),
});
export type YouTubeReviewCommentRequest = z.infer<typeof YouTubeReviewCommentRequestSchema>;

export interface SpeechBudget {
  words_per_second: number;
  min_words: number;
  max_words: number;
  scene_duration_total_seconds: number;
  final_duration_seconds: number;
}

export type SceneConstraintMode = "exact" | "minimum" | "agent_decides";

export interface GenerationConstraints {
  duration_seconds: number;
  duration_source: "prompt" | "request" | "auto";
  duration_is_upper_bound: boolean;
  scene_mode: SceneConstraintMode;
  scene_count: number | null;
  scene_source: "prompt" | "request" | "auto";
  scene_budget_count: number;
}
