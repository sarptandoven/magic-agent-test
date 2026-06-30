import { existsSync } from "node:fs";
import path from "node:path";
import { execa } from "execa";
import {
  DEFAULT_AGENT_MAX_TURNS,
  DEFAULT_MAGIC_HOUR_IMAGE_MODEL,
  DEFAULT_MAGIC_HOUR_VIDEO_MODEL,
  ENV,
} from "./config.js";
import type { ProjectContext } from "./context.js";
import { projectDirFor } from "./projects.js";
import { initializeProjectState as writeInitialProjectState, readProjectState, artifactPath } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import type { AspectRatio, CreateProjectRequest, MagicImageResolution } from "./schemas.js";
import { CreateProjectRequestSchema } from "./schemas.js";

export function defaultImageResolution(videoResolution: string): MagicImageResolution {
  return ({ "480p": "640px", "720p": "1k", "1080p": "2k" } as Record<string, MagicImageResolution>)[videoResolution] ?? "1k";
}

export function explicitMagicHourDefault(value: string | undefined, fallback: string): string {
  const configured = (value ?? "").trim();
  if (!configured || configured === "default") return fallback;
  return configured;
}

export function defaultMagicHourImageModel(): string {
  return explicitMagicHourDefault(ENV.MAGIC_HOUR_IMAGE_MODEL, DEFAULT_MAGIC_HOUR_IMAGE_MODEL);
}

export function defaultMagicHourVideoModel(): string {
  return explicitMagicHourDefault(ENV.MAGIC_HOUR_VIDEO_MODEL, DEFAULT_MAGIC_HOUR_VIDEO_MODEL);
}

export function configuredAgentMaxTurns(): number {
  const raw = ENV.OPENAI_AGENT_MAX_TURNS;
  if (!raw) return DEFAULT_AGENT_MAX_TURNS;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(`Ignoring invalid OPENAI_AGENT_MAX_TURNS override: ${raw}`);
    return DEFAULT_AGENT_MAX_TURNS;
  }
  return Math.max(11, Math.min(parsed, 80));
}

const TRUTHY = new Set(["1", "true", "yes"]);

function envBool(value: string | undefined): boolean {
  return TRUTHY.has((value ?? "false").toLowerCase());
}

export function boolSetting(value: unknown, options: { default: boolean }): boolean {
  if (value === null || value === undefined) return options.default;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  return Boolean(value);
}

export function context(projectId: string, request: CreateProjectRequest): ProjectContext {
  return {
    project_id: projectId,
    project_dir: projectDirFor(projectId),
    aspect_ratio: request.aspect_ratio,
    resolution: request.video_resolution ?? request.resolution,
    magic_hour_api_key: ENV.MAGIC_HOUR_API_KEY ?? "",
    fish_audio_api_key: ENV.FISH_AUDIO_API_KEY ?? "",
    fish_audio_reference_id: ENV.FISH_AUDIO_REFERENCE_ID ?? "",
    image_model: request.image_model ?? defaultMagicHourImageModel(),
    image_resolution:
      request.image_resolution ?? ENV.MAGIC_HOUR_IMAGE_RESOLUTION ?? defaultImageResolution(request.resolution),
    image_style_tool: ENV.MAGIC_HOUR_IMAGE_STYLE_TOOL ?? "general",
    video_model: request.video_model ?? defaultMagicHourVideoModel(),
    video_audio: envBool(ENV.MAGIC_HOUR_VIDEO_AUDIO),
    audio_model: ENV.FISH_AUDIO_MODEL ?? "s2-pro",
    audio_format: ENV.FISH_AUDIO_FORMAT ?? "mp3",
  };
}

export function contextForExistingProject(projectId: string): ProjectContext {
  const projectDir = projectDirFor(projectId);
  const stateCtx: ProjectContext = {
    project_id: projectId,
    project_dir: projectDir,
    aspect_ratio: "",
    resolution: "",
    magic_hour_api_key: "",
    fish_audio_api_key: "",
    fish_audio_reference_id: "",
    image_model: "seedream-v4",
    image_resolution: "1k",
    image_style_tool: "general",
    video_model: "ltx-2.3",
    video_audio: false,
    audio_model: "s2-pro",
    audio_format: "mp3",
  };
  const state = readProjectState(stateCtx);
  const preferences = state.user_preferences ?? {};
  const providers = state.provider_settings ?? {};
  const resolution = String(providers.resolution || preferences.resolution || "720p");
  return {
    project_id: projectId,
    project_dir: projectDir,
    aspect_ratio: String(providers.aspect_ratio || preferences.aspect_ratio || "9:16"),
    resolution,
    magic_hour_api_key: ENV.MAGIC_HOUR_API_KEY ?? "",
    fish_audio_api_key: ENV.FISH_AUDIO_API_KEY ?? "",
    fish_audio_reference_id: ENV.FISH_AUDIO_REFERENCE_ID ?? "",
    image_model: String(providers.image_model || defaultMagicHourImageModel()),
    image_resolution: String(
      providers.image_resolution || ENV.MAGIC_HOUR_IMAGE_RESOLUTION || defaultImageResolution(resolution),
    ),
    image_style_tool: String(providers.image_style_tool || ENV.MAGIC_HOUR_IMAGE_STYLE_TOOL || "general"),
    video_model: String(providers.video_model || defaultMagicHourVideoModel()),
    video_audio: Boolean(providers.video_audio || envBool(ENV.MAGIC_HOUR_VIDEO_AUDIO)),
    audio_model: String(providers.audio_model || ENV.FISH_AUDIO_MODEL || "s2-pro"),
    audio_format: String(providers.audio_format || ENV.FISH_AUDIO_FORMAT || "mp3"),
  };
}

export function userPreferencesForRequest(request: CreateProjectRequest): JsonDict {
  return { ...request };
}

export function providerSettingsForContext(ctx: ProjectContext): JsonDict {
  return {
    image_model: ctx.image_model,
    image_resolution: ctx.image_resolution,
    image_style_tool: ctx.image_style_tool,
    video_model: ctx.video_model,
    video_resolution: ctx.resolution,
    video_audio: ctx.video_audio,
    audio_model: ctx.audio_model,
    audio_format: ctx.audio_format,
    aspect_ratio: ctx.aspect_ratio,
    resolution: ctx.resolution,
  };
}

export function initializeProjectState(ctx: ProjectContext, request: CreateProjectRequest): JsonDict {
  return writeInitialProjectState(ctx, {
    user_preferences: userPreferencesForRequest(request),
    provider_settings: {
      ...providerSettingsForContext(ctx),
      workflow: request.workflow,
      youtube_search_provider: request.youtube_search_provider,
      youtube_allow_provider_fallback: request.youtube_allow_provider_fallback,
    },
  });
}

export function ensureProjectState(ctx: ProjectContext, request: CreateProjectRequest): JsonDict {
  if (existsSync(artifactPath(ctx, "project_state"))) {
    return readProjectState(ctx);
  }
  return initializeProjectState(ctx, request);
}

export function requestFromProjectState(ctx: ProjectContext): CreateProjectRequest | null {
  const preferences = readProjectState(ctx).user_preferences ?? {};
  if (Object.keys(preferences).length === 0) return null;
  const parsed = CreateProjectRequestSchema.safeParse(preferences);
  if (!parsed.success) {
    console.warn(`Ignoring invalid saved request preferences for ${ctx.project_id}`);
    return null;
  }
  return parsed.data;
}

function positiveInt(value: unknown): number | null {
  const parsed = Math.trunc(Number(value));
  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) return null;
  return parsed > 0 ? parsed : null;
}

async function probeVideoDimensions(videoPath: string): Promise<[number, number] | null> {
  if (!existsSync(videoPath)) return null;
  let stdout: string;
  try {
    const result = await execa(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", videoPath],
      { reject: false, timeout: 10_000 },
    );
    if (result.exitCode !== 0) return null;
    stdout = result.stdout;
  } catch {
    return null;
  }
  let payload: any;
  try {
    payload = JSON.parse(stdout || "{}");
  } catch {
    return null;
  }
  const streams = payload.streams;
  if (!Array.isArray(streams) || streams.length === 0) return null;
  const stream = typeof streams[0] === "object" && streams[0] !== null ? streams[0] : {};
  const width = positiveInt(stream.width);
  const height = positiveInt(stream.height);
  if (width === null || height === null) return null;
  return [width, height];
}

async function videoAssetDimensions(video: JsonDict): Promise<[number, number] | null> {
  const width = positiveInt(video.source_width ?? video.width);
  const height = positiveInt(video.source_height ?? video.height);
  if (width !== null && height !== null) return [width, height];
  const videoPath = video.path;
  if (!videoPath) return null;
  return probeVideoDimensions(String(videoPath));
}

function aspectRatioForDimensions(width: number, height: number): AspectRatio {
  if (Math.abs(width - height) <= Math.max(width, height) * 0.05) return "1:1";
  if (height > width) return "9:16";
  return "16:9";
}

export async function inferYoutubeOutputAspectRatio(
  videos: JsonDict[],
  options: { default_aspect_ratio: string },
): Promise<string> {
  const votes: Record<AspectRatio, number> = { "9:16": 0, "16:9": 0, "1:1": 0 };
  let firstDetected: AspectRatio | null = null;
  for (const video of videos) {
    const dimensions = await videoAssetDimensions(video);
    if (dimensions === null) continue;
    const aspectRatio = aspectRatioForDimensions(dimensions[0], dimensions[1]);
    if (firstDetected === null) firstDetected = aspectRatio;
    votes[aspectRatio] += 1;
  }
  if (firstDetected === null) return options.default_aspect_ratio;
  const maxVotes = Math.max(...Object.values(votes));
  const winners = (Object.entries(votes) as Array<[AspectRatio, number]>)
    .filter(([, count]) => count === maxVotes)
    .map(([aspectRatio]) => aspectRatio);
  if (winners.length === 1) return winners[0]!;
  return firstDetected;
}
