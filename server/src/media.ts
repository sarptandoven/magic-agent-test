import { copyFileSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { encode as msgpackEncode } from "@msgpack/msgpack";
import { execa } from "execa";
import { Client as MagicHourClient } from "magic-hour";
import type { ProjectContext } from "./context.js";
import type { Scene, YouTubeClipSection } from "./schemas.js";

export interface ImageAsset {
  scene_id: string;
  path: string;
  prompt: string;
  model: string;
  resolution: string;
  style_tool: string;
  provider_job_id: string | null;
  provider_url: string | null;
  [key: string]: any;
}

export interface VideoAsset {
  scene_id: string;
  path: string;
  prompt: string;
  model: string;
  resolution: string;
  audio: boolean;
  duration_seconds: number;
  provider_job_id: string | null;
  provider_url: string | null;
  provider_status?: string | null;
  [key: string]: any;
}

export interface VoiceoverAsset {
  path: string;
  model: string;
  duration_seconds: number;
  target_duration_seconds: number;
  sections?: SectionVoiceover[];
  [key: string]: any;
}

export interface SectionVoiceover {
  section: number;
  scene_id: string;
  path: string;
  duration_seconds: number;
}

export interface VideoAssetJob {
  scene: Scene;
  image: ImageAsset;
  out_dir: string;
  provider_job_id: string;
  prompt: string;
  model: string;
  resolution: string;
  audio: boolean;
  duration_seconds: number;
  submitted_status: string | null;
}

export interface ProviderJobFailureMetadata {
  provider_job_id: string;
  provider_kind: "i2v" | "talking-photo";
  provider_stage: "video_generation" | "talking";
  provider_submitted_status?: string | null;
  provider_model?: string | null;
  provider_resolution?: string | null;
  prompt?: string | null;
  audio?: boolean;
  duration_seconds?: number;
  audio_path?: string;
  audio_duration_seconds?: number;
  on_camera?: boolean;
}

export interface RecoverVideoAssetJob extends ProviderJobFailureMetadata {
  scene: Scene;
}

function magicHourClient(ctx: ProjectContext): MagicHourClient {
  return new MagicHourClient({ token: ctx.magic_hour_api_key });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is `err` a transient provider failure worth retrying?
 *
 * True for HTTP statuses {408, 425, 429, 500, 502, 503, 504}. The SDK throws an
 * ApiError-like object whose status may live on `err.status` or `err.statusCode`,
 * and/or be embedded in the message (e.g. "502 was returned from ..."). Check the
 * numeric fields first, then fall back to a word-boundary match on the message.
 */
export function isTransientProviderError(err: any): boolean {
  const transient = new Set([408, 425, 429, 500, 502, 503, 504]);
  const status = typeof err?.status === "number" ? err.status : err?.statusCode;
  if (typeof status === "number" && transient.has(status)) return true;
  const text = String(err?.code ?? "") + " " + String(err?.name ?? "") + " " + String(err?.message ?? "");
  return (
    /\b(408|425|429|500|502|503|504)\b/.test(text) ||
    /\b(ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|AbortError|TimeoutError)\b/i.test(
      text,
    )
  );
}

export function providerErrorMessage(err: any): string {
  return err instanceof Error ? err.message : String(err);
}

export function attachProviderJobFailureMetadata<T extends Error>(
  err: T,
  metadata: ProviderJobFailureMetadata,
): T {
  Object.assign(err, metadata);
  return err;
}

export function providerJobFailureMetadata(err: any): ProviderJobFailureMetadata | null {
  const providerJobId = err?.provider_job_id;
  const providerKind = err?.provider_kind;
  const providerStage = err?.provider_stage;
  if (typeof providerJobId !== "string" || providerJobId.trim().length === 0) return null;
  if (providerKind !== "i2v" && providerKind !== "talking-photo") return null;
  if (providerStage !== "video_generation" && providerStage !== "talking") return null;
  return {
    provider_job_id: providerJobId,
    provider_kind: providerKind,
    provider_stage: providerStage,
    provider_submitted_status:
      typeof err?.provider_submitted_status === "string" ? err.provider_submitted_status : null,
    provider_model: typeof err?.provider_model === "string" ? err.provider_model : null,
    provider_resolution: typeof err?.provider_resolution === "string" ? err.provider_resolution : null,
    prompt: typeof err?.prompt === "string" ? err.prompt : null,
    audio: typeof err?.audio === "boolean" ? err.audio : undefined,
    duration_seconds: Number.isFinite(Number(err?.duration_seconds)) ? Number(err.duration_seconds) : undefined,
    audio_path: typeof err?.audio_path === "string" ? err.audio_path : undefined,
    audio_duration_seconds: Number.isFinite(Number(err?.audio_duration_seconds))
      ? Number(err.audio_duration_seconds)
      : undefined,
    on_camera: typeof err?.on_camera === "boolean" ? err.on_camera : undefined,
  };
}

export function magicHourPollRequestTimeoutMs(): number {
  return Math.max(5000, Number(process.env.MAGIC_HOUR_POLL_REQUEST_TIMEOUT_MS ?? "30000"));
}

export function magicHourPollRequestAttempts(): number {
  return Math.max(1, Math.trunc(Number(process.env.MAGIC_HOUR_POLL_REQUEST_ATTEMPTS ?? "3")));
}

export function videoPollIntervalSeconds(): number {
  return Math.max(0.5, Number(process.env.MAGIC_HOUR_POLL_INTERVAL ?? "2.0"));
}

export function videoPollTimeoutSeconds(): number {
  return Math.max(30.0, Number(process.env.MAGIC_HOUR_VIDEO_TIMEOUT_SECONDS ?? "900"));
}

export function talkingPhotoPollTimeoutSeconds(): number {
  return Math.max(30.0, Number(process.env.MAGIC_HOUR_TALKING_PHOTO_TIMEOUT_SECONDS ?? "900"));
}

export function providerRecoveryPollTimeoutSeconds(): number {
  return Math.max(30.0, Number(process.env.MAGIC_HOUR_PROVIDER_RECOVERY_TIMEOUT_SECONDS ?? "180"));
}

async function withRequestTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => {
          const err: NodeJS.ErrnoException = new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s.`);
          err.code = "ETIMEDOUT";
          reject(err);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function pickDownload(result: any, directory: string): string {
  for (const rawPath of result?.downloadedPaths ?? []) {
    try {
      if (statSync(rawPath).isFile()) return rawPath;
    } catch {
      // skip missing entries
    }
  }
  let diskFiles: string[] = [];
  try {
    diskFiles = readdirSync(directory)
      .map((name) => path.join(directory, name))
      .filter((file) => {
        try {
          return statSync(file).isFile();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    diskFiles = [];
  }
  if (diskFiles.length > 0) return diskFiles[0]!;
  throw new Error(`No downloaded files in ${directory}`);
}

export function firstDownloadUrl(result: any): string | null {
  const downloads = result?.downloads ?? [];
  return downloads.length > 0 ? (downloads[0]?.url ?? null) : null;
}

export async function ensureProviderOutputDownloaded(result: any, directory: string, label: string): Promise<string> {
  try {
    return pickDownload(result, directory);
  } catch {
    // fall through to provider URL download
  }

  const url = firstDownloadUrl(result);
  if (!url) {
    throw new Error(
      `No local file or provider download URL for ${label} output in ${directory}. ` +
        `provider_job_id=${JSON.stringify(result?.id ?? null)} status=${JSON.stringify(result?.status ?? null)} ` +
        `error=${JSON.stringify(result?.error ?? null)}`,
    );
  }

  mkdirSync(directory, { recursive: true });
  const filename = path.basename(new URL(url).pathname) || `${label}-output`;
  const downloadPath = path.join(directory, filename);
  let response: Response | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (response.ok) break;
      if (!isTransientProviderError({ status: response.status }) || attempt === 4) {
        throw new Error(`Failed to download ${label} output from provider URL: HTTP ${response.status}`);
      }
    } catch (err) {
      if (attempt === 4 || !isTransientProviderError(err)) throw err;
    }
    await sleep(1000 * attempt);
  }
  if (!response || !response.ok) throw new Error(`Failed to download ${label} output from provider URL.`);
  const buffer = Buffer.from(await response.arrayBuffer());
  writeFileSync(downloadPath, buffer);

  if (statSync(downloadPath).size <= 0) {
    throw new Error(`Downloaded empty ${label} output: ${downloadPath}`);
  }
  console.info(`Downloaded ${label} output saved as: ${downloadPath}`);
  return downloadPath;
}

export function resetProviderOutputDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

export async function generateImageAsset(ctx: ProjectContext, scene: Scene): Promise<ImageAsset> {
  const outDir = path.join(ctx.project_dir, "images", scene.id);
  resetProviderOutputDir(outDir);
  const result: any = await magicHourClient(ctx).v1.aiImageGenerator.generate(
    {
      imageCount: 1,
      style: { prompt: scene.image_prompt, tool: ctx.image_style_tool as any },
      aspectRatio: ctx.aspect_ratio as any,
      model: ctx.image_model as any,
      name: `${ctx.project_id}-${scene.id}`,
      resolution: ctx.image_resolution as any,
    },
    { waitForCompletion: true, downloadOutputs: false, downloadDirectory: outDir },
  );
  const downloaded = await ensureProviderOutputDownloaded(result, outDir, "image");
  return {
    scene_id: scene.id,
    path: downloaded,
    prompt: scene.image_prompt,
    model: ctx.image_model,
    resolution: ctx.image_resolution,
    style_tool: ctx.image_style_tool,
    provider_job_id: result?.id ?? null,
    provider_url: firstDownloadUrl(result),
  };
}

export async function generateVideoAsset(ctx: ProjectContext, scene: Scene, image: ImageAsset): Promise<VideoAsset> {
  const job = await submitVideoAssetJob(ctx, scene, image);
  return pollVideoAssetJob(ctx, job);
}

/**
 * Render a talking clip in one shot via Magic Hour's AI Talking Photo.
 *
 * Feeds the scene KEYFRAME IMAGE + scene audio straight into
 * `v1.aiTalkingPhoto.generate`, producing a talking clip with no intermediate
 * silent video. Synced over the full audio span (`startSeconds=0`,
 * `endSeconds=audioDuration`) in `realistic` mode (best likeness, ≤180s).
 * No resolution/maxResolution is sent. The assets are image+audio (NOT the
 * video+audio pair lip-sync uses).
 *
 * `has_embedded_audio: true` is a LABEL: a later step re-muxes the known mp3
 * onto the result, so callers treat the clip as already carrying its audio.
 */
export async function generateTalkingClip(
  ctx: ProjectContext,
  scene: Scene,
  imageFilePath: string,
  audioPath: string,
  audioDuration: number,
): Promise<
  VideoAsset & { has_embedded_audio: boolean; audio_path: string; audio_duration_seconds: number; on_camera: boolean }
> {
  const outDir = path.join(ctx.project_dir, "videos", scene.id, "talking");
  resetProviderOutputDir(outDir);

  const submitted: any = await magicHourClient(ctx).v1.aiTalkingPhoto.generate(
    {
      assets: { audioFilePath: path.resolve(audioPath), imageFilePath: path.resolve(imageFilePath) },
      startSeconds: 0,
      endSeconds: audioDuration,
      name: `${ctx.project_id}-${scene.id}-talking`,
      style: { generationMode: "realistic" },
    },
    { waitForCompletion: false, downloadOutputs: false, downloadDirectory: outDir },
  );
  const providerJobId = submitted?.id;
  if (!providerJobId) {
    throw new Error(`Magic Hour did not return a talking-photo project id for ${scene.id}.`);
  }
  if (submitted?.status === "error" || submitted?.status === "canceled") {
    throw new Error(`Magic Hour rejected talking-photo job for ${scene.id}: ${videoStatusError(submitted)}`);
  }

  let result: any = submitted;
  if (submitted?.status !== "complete") {
    try {
      result = await pollProviderVideoProject(ctx, String(providerJobId), scene.id, {
        kind: "talking-photo",
        timeoutSeconds: talkingPhotoPollTimeoutSeconds(),
      });
    } catch (err) {
      throw attachProviderJobFailureMetadata(new Error(providerErrorMessage(err)), {
        provider_job_id: String(providerJobId),
        provider_kind: "talking-photo",
        provider_stage: "talking",
        provider_submitted_status: submitted?.status ? String(submitted.status) : null,
        provider_model: "ai-talking-photo",
        provider_resolution: ctx.resolution,
        prompt: scene.video_prompt,
        audio: true,
        duration_seconds: Math.round(audioDuration * 1000) / 1000,
        audio_path: path.resolve(audioPath),
        audio_duration_seconds: Math.round(audioDuration * 1000) / 1000,
        on_camera: true,
      });
    }
  }

  const downloaded = await ensureProviderOutputDownloaded(result, outDir, "talking");
  return {
    scene_id: scene.id,
    path: downloaded,
    prompt: scene.video_prompt,
    model: "ai-talking-photo",
    resolution: ctx.resolution,
    audio: true,
    duration_seconds: Math.round(audioDuration * 1000) / 1000,
    provider_job_id: result?.id ?? null,
    provider_url: firstDownloadUrl(result),
    has_embedded_audio: true,
    audio_path: path.resolve(audioPath),
    audio_duration_seconds: Math.round(audioDuration * 1000) / 1000,
    on_camera: true,
  };
}

function videoStatusError(result: any): string {
  return (
    `provider_job_id=${JSON.stringify(result?.id ?? null)} ` +
    `status=${JSON.stringify(result?.status ?? null)} error=${JSON.stringify(result?.error ?? null)}`
  );
}

/** Upload the scene image and submit an image-to-video job without blocking for completion. */
export async function submitVideoAssetJob(ctx: ProjectContext, scene: Scene, image: ImageAsset): Promise<VideoAssetJob> {
  const outDir = path.join(ctx.project_dir, "videos", scene.id);
  resetProviderOutputDir(outDir);
  const result: any = await magicHourClient(ctx).v1.imageToVideo.generate(
    {
      assets: { imageFilePath: image.path },
      endSeconds: scene.duration_seconds,
      model: ctx.video_model as any,
      name: `${ctx.project_id}-${scene.id}`,
      resolution: ctx.resolution as any,
      style: { prompt: scene.video_prompt },
      audio: ctx.video_audio,
    },
    { waitForCompletion: false, downloadOutputs: false, downloadDirectory: outDir },
  );
  const providerJobId = result?.id;
  if (!providerJobId) {
    throw new Error(`Magic Hour did not return a video project id for ${scene.id}.`);
  }
  const status = result?.status;
  if (status === "error" || status === "canceled") {
    throw new Error(`Magic Hour rejected video job for ${scene.id}: ${videoStatusError(result)}`);
  }
  console.info(`Submitted Magic Hour video job ${providerJobId} for scene ${scene.id} with status ${status}`);
  return {
    scene,
    image,
    out_dir: outDir,
    provider_job_id: String(providerJobId),
    prompt: scene.video_prompt,
    model: ctx.video_model,
    resolution: ctx.resolution,
    audio: ctx.video_audio,
    duration_seconds: scene.duration_seconds,
    submitted_status: status ? String(status) : null,
  };
}

async function pollProviderVideoProject(
  ctx: ProjectContext,
  providerJobId: string,
  sceneId: string,
  options: { kind: string; timeoutSeconds: number },
): Promise<any> {
  const client = magicHourClient(ctx);
  const intervalMs = videoPollIntervalSeconds() * 1000;
  const timeoutMs = options.timeoutSeconds * 1000;
  const requestTimeoutMs = magicHourPollRequestTimeoutMs();
  const maxRequestFailures = magicHourPollRequestAttempts();
  const start = Date.now();
  let requestFailures = 0;
  let lastStatus: string | null = null;

  for (;;) {
    let result: any;
    try {
      result = await withRequestTimeout(
        client.v1.videoProjects.get({ id: providerJobId }),
        requestTimeoutMs,
        `Magic Hour ${options.kind} status request ${providerJobId}`,
      );
      requestFailures = 0;
    } catch (err) {
      requestFailures += 1;
      if (!isTransientProviderError(err) || requestFailures >= maxRequestFailures || Date.now() - start > timeoutMs) {
        throw new Error(
          `Magic Hour ${options.kind} polling stalled for ${sceneId} (${providerJobId}) ` +
            `after ${requestFailures} failed status request(s): ${providerErrorMessage(err)}`,
        );
      }
      console.warn(
        `Transient Magic Hour ${options.kind} status error for ${sceneId} (${providerJobId}); ` +
          `request ${requestFailures}/${maxRequestFailures}: ${providerErrorMessage(err)}`,
      );
      await sleep(intervalMs);
      continue;
    }

    const status = result?.status;
    lastStatus = status ? String(status) : null;
    if (status === "complete") return result;
    if (status === "error" || status === "canceled") {
      throw new Error(`Magic Hour ${options.kind} job failed for ${sceneId}: ${videoStatusError(result)}`);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `Timed out waiting for Magic Hour ${options.kind} job ${providerJobId} for ${sceneId} ` +
          `after ${Math.round(timeoutMs / 1000)}s. Last status: ${JSON.stringify(lastStatus)}`,
      );
    }
    await sleep(intervalMs);
  }
}

/** Poll a submitted image-to-video job and download its provider output. */
export async function pollVideoAssetJob(ctx: ProjectContext, job: VideoAssetJob): Promise<VideoAsset> {
  let result: any;
  try {
    result = await pollProviderVideoProject(ctx, job.provider_job_id, job.scene.id, {
      kind: "image-to-video",
      timeoutSeconds: videoPollTimeoutSeconds(),
    });
  } catch (err) {
    throw attachProviderJobFailureMetadata(new Error(providerErrorMessage(err)), {
      provider_job_id: job.provider_job_id,
      provider_kind: "i2v",
      provider_stage: "video_generation",
      provider_submitted_status: job.submitted_status,
      provider_model: job.model,
      provider_resolution: job.resolution,
      prompt: job.prompt,
      audio: job.audio,
      duration_seconds: job.duration_seconds,
    });
  }

  const downloaded = await ensureProviderOutputDownloaded(result, job.out_dir, "video");
  return {
    scene_id: job.scene.id,
    path: downloaded,
    prompt: job.prompt,
    model: job.model,
    resolution: job.resolution,
    audio: job.audio,
    duration_seconds: job.duration_seconds,
    provider_job_id: job.provider_job_id,
    provider_url: firstDownloadUrl(result),
    provider_status: result?.status ?? null,
  };
}

export async function recoverVideoAssetFromProviderJob(
  ctx: ProjectContext,
  job: RecoverVideoAssetJob,
): Promise<VideoAsset> {
  const isTalking = job.provider_kind === "talking-photo";
  const outDir = isTalking
    ? path.join(ctx.project_dir, "videos", job.scene.id, "talking")
    : path.join(ctx.project_dir, "videos", job.scene.id);
  mkdirSync(outDir, { recursive: true });
  const result = await pollProviderVideoProject(ctx, job.provider_job_id, job.scene.id, {
    kind: `${job.provider_kind}-recovery`,
    timeoutSeconds: providerRecoveryPollTimeoutSeconds(),
  });
  const downloaded = await ensureProviderOutputDownloaded(result, outDir, isTalking ? "talking" : "video");
  const duration = Math.round(Number(job.audio_duration_seconds ?? job.duration_seconds ?? job.scene.duration_seconds) * 1000) / 1000;
  const base: VideoAsset = {
    scene_id: job.scene.id,
    path: downloaded,
    prompt: job.prompt ?? job.scene.video_prompt,
    model: job.provider_model ?? (isTalking ? "ai-talking-photo" : ctx.video_model),
    resolution: job.provider_resolution ?? ctx.resolution,
    audio: isTalking || job.audio === true,
    duration_seconds: duration,
    provider_job_id: job.provider_job_id,
    provider_url: firstDownloadUrl(result),
    provider_status: result?.status ?? null,
  };
  if (!isTalking) return base;
  if (!job.audio_path || !(Number(job.audio_duration_seconds) > 0)) {
    throw new Error(`Recovered talking-photo job ${job.provider_job_id} is missing its scene audio metadata.`);
  }
  return {
    ...base,
    has_embedded_audio: true,
    audio_path: path.resolve(job.audio_path),
    audio_duration_seconds: Math.round(Number(job.audio_duration_seconds) * 1000) / 1000,
    on_camera: true,
  };
}

/** Submit all video jobs first, then poll/download all submitted jobs concurrently. */
export async function generateVideoAssetsBatch(
  ctx: ProjectContext,
  sceneImagePairs: Array<[Scene, ImageAsset]>,
): Promise<Array<VideoAsset | Error>> {
  if (sceneImagePairs.length === 0) return [];

  const submitResults = await Promise.allSettled(
    sceneImagePairs.map(([scene, image]) => submitVideoAssetJob(ctx, scene, image)),
  );
  const results: Array<VideoAsset | Error | null> = submitResults.map(() => null);
  const pollIndexes: number[] = [];
  const pollPromises: Promise<VideoAsset>[] = [];

  submitResults.forEach((submitResult, index) => {
    if (submitResult.status === "rejected") {
      results[index] = submitResult.reason instanceof Error ? submitResult.reason : new Error(String(submitResult.reason));
      return;
    }
    pollIndexes.push(index);
    pollPromises.push(pollVideoAssetJob(ctx, submitResult.value));
  });

  if (pollPromises.length > 0) {
    const pollResults = await Promise.allSettled(pollPromises);
    pollResults.forEach((pollResult, pollIndex) => {
      const index = pollIndexes[pollIndex]!;
      results[index] =
        pollResult.status === "fulfilled"
          ? pollResult.value
          : pollResult.reason instanceof Error
            ? pollResult.reason
            : new Error(String(pollResult.reason));
    });
  }

  return results.map((result) => result ?? new Error("Video job did not produce a result."));
}

/**
 * POST text to Fish Audio TTS, write the audio to `output`, return measured duration.
 * Shared by the single-narration voiceover and the per-section voiceover generators.
 */
async function fishAudioTts(
  ctx: ProjectContext,
  text: string,
  output: string,
  referenceId: string = ctx.fish_audio_reference_id,
): Promise<number> {
  const body = msgpackEncode({
    text,
    reference_id: referenceId,
    format: ctx.audio_format,
    chunk_length: 200,
    latency: "normal",
    normalize: true,
  });
  mkdirSync(path.dirname(output), { recursive: true });

  // Parallel per-section requests can trip Fish Audio's rate limit; back off
  // and retry 429s instead of failing the whole generation run.
  let response: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    response = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        authorization: `Bearer ${ctx.fish_audio_api_key}`,
        "content-type": "application/msgpack",
        model: ctx.audio_model,
      },
      body: Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      signal: AbortSignal.timeout(180_000),
    });
    if (response.status === 429 && attempt < 3) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    break;
  }
  if (!response || !response.ok) {
    throw new Error(`Fish Audio TTS failed with status ${response?.status ?? "unknown"}`);
  }

  const content = Buffer.from(await response.arrayBuffer());
  if (content.length < 1024) {
    throw new Error(
      `Fish Audio returned suspiciously small response (${content.length} bytes). Status: ${response.status}`,
    );
  }
  writeFileSync(output, content);
  const actualDuration = await probeMediaDuration(output);
  if (actualDuration < 0.5) {
    throw new Error(`Fish Audio returned a voiceover with invalid duration ${actualDuration.toFixed(3)}s.`);
  }
  return actualDuration;
}

/** Generate a voiceover audio file from narration text via Fish Audio TTS. */
export async function generateVoiceoverAsset(
  ctx: ProjectContext,
  narration: string,
  durationSeconds: number,
  referenceId?: string,
): Promise<VoiceoverAsset> {
  const output = path.join(ctx.project_dir, "voiceover", `voiceover.${ctx.audio_format}`);
  console.info(
    `Generating voiceover - narration length ${narration.length} chars, ` +
      `reference_id=${referenceId ?? ctx.fish_audio_reference_id}, model=${ctx.audio_model}`,
  );
  const actualDuration = await fishAudioTts(ctx, narration, output, referenceId);
  console.info(`Voiceover saved: ${output} (${actualDuration.toFixed(2)}s)`);
  return {
    path: output,
    model: ctx.audio_model,
    duration_seconds: Math.round(actualDuration * 1000) / 1000,
    target_duration_seconds: durationSeconds,
  };
}

/**
 * Generate one Fish Audio voiceover per section, concurrently.
 *
 * Per-section audio is the source of truth for video alignment: each scene's
 * video length is later set to its measured audio duration, so a dropped or
 * mis-estimated section can never shift the alignment of the others.
 */
export async function generateSectionVoiceovers(
  ctx: ProjectContext,
  sections: YouTubeClipSection[],
): Promise<SectionVoiceover[]> {
  const voiceoverDir = path.join(ctx.project_dir, "voiceover", "sections");
  resetProviderOutputDir(voiceoverDir);

  return Promise.all(
    sections.map(async (section) => {
      const sectionNum = Math.trunc(section.section);
      const text = String(section.dialogue ?? "").trim();
      if (!text) {
        throw new Error(`No dialogue for section ${sectionNum}; cannot generate voiceover.`);
      }
      const output = path.join(voiceoverDir, `section_${sectionNum}.${ctx.audio_format}`);
      const duration = await fishAudioTts(ctx, text, output);
      return {
        section: sectionNum,
        scene_id: `scene_${sectionNum}`,
        path: path.resolve(output),
        duration_seconds: Math.round(duration * 1000) / 1000,
      };
    }),
  );
}

/**
 * Generate one Fish Audio voiceover per scene, keyed by the scene's real id.
 *
 * Unlike {@link generateSectionVoiceovers} (which synthesizes a `scene_<N>`
 * key from the section number), this keys each file by `scene.id` so a talking
 * scene's clip can later be lip-synced to its own line. Reuses the single
 * global voice via {@link fishAudioTts}.
 */
export async function generateSceneVoiceovers(
  ctx: ProjectContext,
  scenes: Scene[],
  referenceId?: string,
): Promise<Array<{ scene_id: string; path: string; duration_seconds: number }>> {
  const dir = path.join(ctx.project_dir, "voiceover", "scenes");
  resetProviderOutputDir(dir);
  return Promise.all(
    scenes.map(async (scene) => {
      const text = String(scene.narration ?? "").trim();
      if (!text) {
        throw new Error(`No narration for scene ${scene.id}; cannot generate scene voiceover.`);
      }
      const output = path.join(dir, `${scene.id}.${ctx.audio_format}`);
      const duration = await fishAudioTts(ctx, text, output, referenceId);
      return {
        scene_id: scene.id,
        path: path.resolve(output),
        duration_seconds: Math.round(duration * 1000) / 1000,
      };
    }),
  );
}

/**
 * Concatenate per-section voiceover audio into one file. Preserves the
 * single-voiceover manifest contract (path + duration) while the per-section
 * files remain the source of truth for video alignment.
 */
export async function combineSectionVoiceovers(
  ctx: ProjectContext,
  sectionVoiceovers: SectionVoiceover[],
): Promise<VoiceoverAsset> {
  if (sectionVoiceovers.length === 0) throw new Error("No section voiceovers to combine");
  const output = path.join(ctx.project_dir, "voiceover", `voiceover.${ctx.audio_format}`);
  mkdirSync(path.dirname(output), { recursive: true });
  const paths = sectionVoiceovers.map((item) => item.path);

  if (paths.length === 1) {
    copyFileSync(paths[0]!, output);
  } else {
    const concatList = path.join(path.dirname(output), "voiceover_concat.txt");
    writeFileSync(concatList, paths.map((p) => `file '${path.resolve(p)}'\n`).join(""), "utf-8");
    try {
      await runFfmpeg(
        ["-y", "-f", "concat", "-safe", "0", "-i", path.resolve(concatList), "-c", "copy", output],
        "combine section voiceovers ffmpeg",
      );
    } finally {
      try {
        unlinkSync(concatList);
      } catch {
        // best-effort cleanup
      }
    }
  }

  const duration = await probeMediaDuration(output);
  return {
    path: output,
    model: ctx.audio_model,
    duration_seconds: Math.round(duration * 1000) / 1000,
    target_duration_seconds:
      Math.round(sectionVoiceovers.reduce((sum, item) => sum + item.duration_seconds, 0) * 1000) / 1000,
    sections: sectionVoiceovers,
  };
}

async function runFfmpeg(args: string[], label: string): Promise<void> {
  const result = await execa("ffmpeg", args, { reject: false });
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "no command output";
    throw new Error(`${label} failed:\n${detail}`);
  }
}

export async function probeMediaDuration(filePath: string): Promise<number> {
  const result = await execa(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "no command output";
    throw new Error(`ffprobe duration failed for ${filePath}:\n${detail}`);
  }
  const duration = Number.parseFloat(result.stdout.trim());
  if (!(duration > 0)) {
    throw new Error(`Media has invalid duration ${duration}: ${filePath}`);
  }
  return duration;
}

export interface MediaStreamDurations {
  format_duration_seconds: number;
  video_duration_seconds: number | null;
  audio_duration_seconds: number | null;
}

export async function probeMediaStreamDurations(filePath: string): Promise<MediaStreamDurations> {
  const result = await execa(
    "ffprobe",
    [
      "-v", "error",
      "-show_entries", "format=duration:stream=codec_type,duration",
      "-of", "json",
      filePath,
    ],
    { reject: false },
  );
  if (result.exitCode !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || "no command output";
    throw new Error(`ffprobe stream duration failed for ${filePath}:\n${detail}`);
  }
  const payload = JSON.parse(result.stdout);
  const streamDuration = (kind: string) => {
    const stream = (payload.streams ?? []).find((item: any) => item.codec_type === kind && Number(item.duration) > 0);
    return stream ? Number(stream.duration) : null;
  };
  return {
    format_duration_seconds: Number(payload.format?.duration ?? 0),
    video_duration_seconds: streamDuration("video"),
    audio_duration_seconds: streamDuration("audio"),
  };
}

// ---------------------------------------------------------------------------
// Crossfade duration in seconds for blending between scenes
// ---------------------------------------------------------------------------
export const CROSSFADE_DURATION = 0.5;
const MAX_AUDIO_OVERRUN_EXTENSION_SECONDS = 1.0;
const AUDIO_TRIM_FADE_SECONDS = 0.35;

const formatSeconds = (seconds: number) => seconds.toFixed(3);

export function plannedFinalDurationSeconds(videos: Array<Record<string, any>>): number | null {
  const requested: number[] = [];
  for (const video of videos) {
    const duration = Number(video.duration_seconds);
    if (!Number.isFinite(duration) || duration <= 0) return null;
    requested.push(duration);
  }
  if (requested.length === 0) return null;
  const crossfade = requested.length > 1 ? Math.min(CROSSFADE_DURATION, Math.min(...requested) * 0.4) : 0.0;
  return Math.max(0.1, requested.reduce((a, b) => a + b, 0) - crossfade * Math.max(requested.length - 1, 0));
}

/**
 * Build ffmpeg xfade + acrossfade filter graphs for N videos.
 * Returns [videoFilter, audioFilter].
 */
function buildXfadeFilter(durations: number[], crossfade: number): [string, string] {
  const n = durations.length;
  if (n < 2) throw new Error("Need at least 2 videos for crossfade");

  const vParts: string[] = [];
  const aParts: string[] = [];

  // Track the cumulative offset where each transition starts. The first
  // transition happens at (duration_0 - crossfade); each subsequent one
  // accounts for previous crossfades shrinking the timeline.
  let offset = durations[0]! - crossfade;

  for (let i = 1; i < n; i++) {
    const vIn1 = i === 1 ? "[0:v]" : `[vfade${i - 1}]`;
    const aIn1 = i === 1 ? "[0:a]" : `[afade${i - 1}]`;
    const vIn2 = `[${i}:v]`;
    const aIn2 = `[${i}:a]`;
    const vOut = i === n - 1 ? "[vout]" : `[vfade${i}]`;
    const aOut = i === n - 1 ? "[aout]" : `[afade${i}]`;

    vParts.push(`${vIn1}${vIn2}xfade=transition=fade:duration=${crossfade}:offset=${offset.toFixed(4)}${vOut}`);
    aParts.push(`${aIn1}${aIn2}acrossfade=d=${crossfade}:c1=tri:c2=tri${aOut}`);

    offset += durations[i]! - crossfade;
  }

  return [vParts.join(";"), aParts.join(";")];
}

const even = (value: number) => (value % 2 === 0 ? value : value + 1);

export function targetFrameSize(ctx: ProjectContext): [number, number] {
  const base = Number.parseInt(String(ctx.resolution || "720p").replace(/p$/, ""), 10) || 720;
  if (ctx.aspect_ratio === "9:16") return [even(base), even(Math.round((base * 16) / 9))];
  if (ctx.aspect_ratio === "1:1") return [even(base), even(base)];
  return [even(Math.round((base * 16) / 9)), even(base)];
}

export async function normalizeSceneVideoForStitch(
  ctx: ProjectContext,
  source: string,
  output: string,
  options: { source_start?: number | null; source_end?: number | null; target_duration_seconds?: number | null } = {},
): Promise<string> {
  const [width, height] = targetFrameSize(ctx);
  const sourceStart = Number(options.source_start ?? 0);
  const sourceEnd = Number(options.source_end ?? 0);
  const targetDuration = Number(options.target_duration_seconds ?? 0);
  const trimDuration =
    Number.isFinite(sourceStart) && Number.isFinite(sourceEnd) && sourceEnd > sourceStart
      ? sourceEnd - Math.max(0, sourceStart)
      : null;
  const timingFilter =
    Number.isFinite(targetDuration) && targetDuration > 0
      ? `,tpad=stop_mode=clone:stop_duration=${formatSeconds(targetDuration)},` +
        `trim=duration=${formatSeconds(targetDuration)},setpts=PTS-STARTPTS`
      : ",setpts=PTS-STARTPTS";
  mkdirSync(path.dirname(output), { recursive: true });
  await runFfmpeg(
    [
      "-y",
      ...(Number.isFinite(sourceStart) && sourceStart > 0 ? ["-ss", formatSeconds(sourceStart)] : []),
      "-i", path.resolve(source),
      ...(trimDuration !== null ? ["-t", formatSeconds(trimDuration)] : []),
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=increase,` +
        `crop=${width}:${height},` +
        `fps=30,settb=AVTB${timingFilter},format=yuv420p`,
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      output,
    ],
    "normalize scene video for stitch",
  );
  await probeMediaDuration(output);
  return output;
}

/**
 * Stitch scene videos together with smooth crossfade transitions, then overlay voiceover.
 * Uses ffmpeg xfade filter for seamless visual blending between scenes
 * instead of hard cuts from the concat demuxer.
 */
export async function stitchAssets(
  ctx: ProjectContext,
  videos: Array<Record<string, any>>,
  voiceover: Record<string, any>,
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  const final = path.join(ctx.project_dir, "final.mp4");
  const n = videos.length;
  let plannedDuration = plannedFinalDurationSeconds(videos);

  if (n === 0) throw new Error("No videos to stitch");

  const normalizedDir = path.join(ctx.project_dir, "normalized");
  resetProviderOutputDir(normalizedDir);
  const normalizedPaths: string[] = [];
  for (let index = 0; index < videos.length; index++) {
    normalizedPaths.push(
      await normalizeSceneVideoForStitch(
        ctx,
        videos[index]!.path,
        path.join(normalizedDir, `scene_${String(index + 1).padStart(2, "0")}.mp4`),
      ),
    );
  }

  // --- Step 1: Crossfade the scene videos into one seamless clip ---
  const merged = path.join(ctx.project_dir, "merged.mp4");

  if (n === 1) {
    copyFileSync(normalizedPaths[0]!, merged);
  } else {
    // Probe actual durations for accurate xfade offsets
    const durations: number[] = [];
    for (const normalizedPath of normalizedPaths) durations.push(await probeMediaDuration(normalizedPath));
    console.info(`Scene durations for crossfade: ${JSON.stringify(durations)}`);

    const inputArgs = normalizedPaths.flatMap((p) => ["-i", path.resolve(p)]);
    const crossfade = Math.min(CROSSFADE_DURATION, Math.min(...durations) * 0.4);
    const [videoFilter] = buildXfadeFilter(durations, crossfade);

    // Scenes have no audio, so only the xfaded video is mapped.
    const cmd = [
      "-y",
      ...inputArgs,
      "-filter_complex", videoFilter,
      "-map", "[vout]",
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      merged,
    ];
    console.info(`Crossfade ffmpeg command: ffmpeg ${cmd.join(" ")}`);
    await runFfmpeg(cmd, "crossfade ffmpeg stitch");
  }

  const mergedDuration = await probeMediaDuration(merged);
  const voiceoverDuration = await probeMediaDuration(voiceover.path);
  if (plannedDuration === null) plannedDuration = mergedDuration;

  let outputDuration: number;
  if (options.target_duration_seconds != null) {
    outputDuration = Number(options.target_duration_seconds);
  } else if (
    voiceoverDuration > plannedDuration &&
    voiceoverDuration - plannedDuration <= MAX_AUDIO_OVERRUN_EXTENSION_SECONDS
  ) {
    outputDuration = voiceoverDuration;
  } else {
    outputDuration = plannedDuration;
  }
  outputDuration = Math.max(0.1, outputDuration);
  const padDuration = Math.max(0.0, outputDuration - mergedDuration);

  let audioFilter = "apad";
  if (voiceoverDuration > outputDuration) {
    const fadeDuration = Math.min(AUDIO_TRIM_FADE_SECONDS, outputDuration / 2);
    const fadeStart = Math.max(0.0, outputDuration - fadeDuration);
    audioFilter =
      `atrim=0:${formatSeconds(outputDuration)},` +
      "asetpts=PTS-STARTPTS," +
      `afade=t=out:st=${formatSeconds(fadeStart)}:d=${formatSeconds(fadeDuration)},` +
      "apad";
    console.info(
      `Trimming voiceover ${voiceoverDuration.toFixed(3)}s to stitched video target ` +
        `${outputDuration.toFixed(3)}s with fade-out for ${ctx.project_id}`,
    );
  }

  const timed = path.join(ctx.project_dir, "merged_timed.mp4");
  await runFfmpeg(
    [
      "-y",
      "-i", merged,
      "-vf",
      "tpad=stop_mode=clone:" +
        `stop_duration=${formatSeconds(padDuration)},` +
        `trim=duration=${formatSeconds(outputDuration)},setpts=PTS-STARTPTS`,
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      timed,
    ],
    "target-duration ffmpeg normalize",
  );

  // --- Step 2: Overlay voiceover audio onto the merged video ---
  await runFfmpeg(
    [
      "-y",
      "-i", timed,
      "-i", voiceover.path,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-af", audioFilter,
      "-c:a", "aac", "-b:a", "192k",
      "-t", formatSeconds(outputDuration),
      "-movflags", "+faststart",
      final,
    ],
    "voiceover mux ffmpeg",
  );

  for (const intermediate of [merged, timed]) {
    try {
      unlinkSync(intermediate);
    } catch {
      // best-effort cleanup
    }
  }

  console.info(`Final video saved: ${final}`);
  return final;
}

export interface TimelineStitchClip {
  id: string;
  path: string;
  source_start: number;
  source_end: number;
  timeline_start: number;
  timeline_end: number;
  duration: number;
  [key: string]: any;
}

export async function stitchTimelineAssets(
  ctx: ProjectContext,
  clips: TimelineStitchClip[],
  voiceover: Record<string, any>,
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  if (clips.length === 0) throw new Error("No timeline clips to stitch");
  if (!voiceover?.path) throw new Error("No voiceover asset found for timeline stitch");

  const final = path.join(ctx.project_dir, "final.mp4");
  const timelineDir = path.join(ctx.project_dir, "timeline_clips");
  resetProviderOutputDir(timelineDir);

  const ordered = [...clips].sort((a, b) => a.timeline_start - b.timeline_start);
  const normalizedPaths: string[] = [];
  for (let index = 0; index < ordered.length; index++) {
    const clip = ordered[index]!;
    const label = `clip_${String(index + 1).padStart(2, "0")}.mp4`;
    normalizedPaths.push(
      await normalizeSceneVideoForStitch(ctx, clip.path, path.join(timelineDir, label), {
        source_start: clip.source_start,
        source_end: clip.source_end,
        target_duration_seconds: clip.duration,
      }),
    );
  }

  const merged = path.join(ctx.project_dir, "timeline_merged.mp4");
  if (normalizedPaths.length === 1) {
    copyFileSync(normalizedPaths[0]!, merged);
  } else {
    const concatList = path.join(ctx.project_dir, "timeline_concat.txt");
    writeFileSync(concatList, normalizedPaths.map((p) => `file '${path.resolve(p)}'\n`).join(""), "utf-8");
    try {
      await runFfmpeg(
        [
          "-y",
          "-f", "concat", "-safe", "0",
          "-i", path.resolve(concatList),
          "-c:v", "libx264", "-preset", "fast",
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-r", "30",
          "-an",
          "-movflags", "+faststart",
          merged,
        ],
        "timeline concat ffmpeg",
      );
    } finally {
      try {
        unlinkSync(concatList);
      } catch {
        // best-effort cleanup
      }
    }
  }

  const mergedDuration = await probeMediaDuration(merged);
  const voiceoverDuration = await probeMediaDuration(voiceover.path);
  const requestedTarget = Number(options.target_duration_seconds ?? 0);
  const outputDuration = Math.max(
    0.1,
    Number.isFinite(requestedTarget) && requestedTarget > 0
      ? requestedTarget
      : Math.max(mergedDuration, voiceoverDuration),
  );
  const padDuration = Math.max(0.0, outputDuration - mergedDuration);

  let audioFilter = "apad";
  if (voiceoverDuration > outputDuration) {
    const fadeDuration = Math.min(AUDIO_TRIM_FADE_SECONDS, outputDuration / 2);
    const fadeStart = Math.max(0.0, outputDuration - fadeDuration);
    audioFilter =
      `atrim=0:${formatSeconds(outputDuration)},` +
      "asetpts=PTS-STARTPTS," +
      `afade=t=out:st=${formatSeconds(fadeStart)}:d=${formatSeconds(fadeDuration)},` +
      "apad";
  }

  const timed = path.join(ctx.project_dir, "timeline_timed.mp4");
  await runFfmpeg(
    [
      "-y",
      "-i", merged,
      "-vf",
      "tpad=stop_mode=clone:" +
        `stop_duration=${formatSeconds(padDuration)},` +
        `trim=duration=${formatSeconds(outputDuration)},setpts=PTS-STARTPTS`,
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      "-an",
      timed,
    ],
    "timeline target-duration ffmpeg normalize",
  );

  await runFfmpeg(
    [
      "-y",
      "-i", timed,
      "-i", voiceover.path,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "copy",
      "-af", audioFilter,
      "-c:a", "aac", "-b:a", "192k",
      "-t", formatSeconds(outputDuration),
      "-movflags", "+faststart",
      final,
    ],
    "timeline voiceover mux ffmpeg",
  );

  for (const intermediate of [merged, timed]) {
    try {
      unlinkSync(intermediate);
    } catch {
      // best-effort cleanup
    }
  }

  console.info(`Final video saved from timeline: ${final}`);
  return final;
}

/**
 * Mux one normalized (silent) scene video with its section audio.
 *
 * The output is clamped to exactly `audioDuration`: if the video is shorter
 * the last frame is frozen (tpad=stop_mode=clone); if longer it is trimmed.
 * This makes each section self-contained so section boundaries are exact and
 * concatenation can never drift audio out of sync with footage.
 */
async function muxSection(
  ctx: ProjectContext,
  normalizedVideo: string,
  audioPath: string,
  audioDuration: number,
  output: string,
): Promise<string> {
  const videoDuration = await probeMediaDuration(normalizedVideo);
  const padDuration = Math.max(0.0, audioDuration - videoDuration);
  await runFfmpeg(
    [
      "-y",
      "-i", path.resolve(normalizedVideo),
      "-i", path.resolve(audioPath),
      "-vf",
      "tpad=stop_mode=clone:" +
        `stop_duration=${formatSeconds(padDuration)},` +
        `trim=duration=${formatSeconds(audioDuration)},setpts=PTS-STARTPTS`,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-t", formatSeconds(audioDuration),
      "-movflags", "+faststart",
      output,
    ],
    "per-section mux ffmpeg",
  );
  return output;
}

export interface PerSectionScene {
  video_path: string;
  audio_path: string;
  audio_duration_seconds: number;
  [key: string]: any;
}

async function normalizeFinalDuration(input: string, output: string, targetDuration: number): Promise<string> {
  const sourceDuration = await probeMediaDuration(input);
  const padDuration = Math.max(0.0, targetDuration - sourceDuration);
  await runFfmpeg(
    [
      "-y",
      "-i", path.resolve(input),
      "-vf",
      "tpad=stop_mode=clone:" +
        `stop_duration=${formatSeconds(padDuration)},` +
        `trim=duration=${formatSeconds(targetDuration)},setpts=PTS-STARTPTS`,
      "-af",
      `apad,atrim=duration=${formatSeconds(targetDuration)},asetpts=PTS-STARTPTS`,
      "-c:v", "libx264", "-preset", "fast",
      "-crf", "18",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-t", formatSeconds(targetDuration),
      "-movflags", "+faststart",
      output,
    ],
    "target-duration per-section ffmpeg normalize",
  );
  await probeMediaDuration(output);
  return output;
}

/**
 * Stitch scenes where each carries its own audio, then hard-cut concat.
 *
 * Each scene's video is normalized, muxed with its own section audio and
 * clamped to that audio's duration, then the per-section MP4s are concatenated
 * with the concat demuxer (hard cuts). Audio and video stay locked together
 * regardless of duration estimates or dropped sections.
 */
export async function stitchAssetsPerSection(
  ctx: ProjectContext,
  scenes: PerSectionScene[],
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  const n = scenes.length;
  if (n === 0) throw new Error("No scenes to stitch");

  const final = path.join(ctx.project_dir, "final.mp4");
  const normalizedDir = path.join(ctx.project_dir, "normalized");
  resetProviderOutputDir(normalizedDir);
  const sectionsDir = path.join(ctx.project_dir, "muxed_sections");
  resetProviderOutputDir(sectionsDir);

  const muxedPaths: string[] = [];
  for (let index = 0; index < scenes.length; index++) {
    const scene = scenes[index]!;
    const label = `scene_${String(index + 1).padStart(2, "0")}.mp4`;
    const normalized = await normalizeSceneVideoForStitch(ctx, scene.video_path, path.join(normalizedDir, label));
    const muxed = await muxSection(
      ctx,
      normalized,
      scene.audio_path,
      Number(scene.audio_duration_seconds),
      path.join(sectionsDir, label),
    );
    muxedPaths.push(muxed);
  }

  if (n === 1) {
    copyFileSync(muxedPaths[0]!, final);
  } else {
    const concatList = path.join(ctx.project_dir, "sections_concat.txt");
    writeFileSync(concatList, muxedPaths.map((p) => `file '${path.resolve(p)}'\n`).join(""), "utf-8");
    try {
      await runFfmpeg(
        [
          "-y",
          "-f", "concat", "-safe", "0",
          "-i", path.resolve(concatList),
          "-c:v", "libx264", "-preset", "fast",
          "-crf", "18",
          "-pix_fmt", "yuv420p",
          "-r", "30",
          "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
          "-movflags", "+faststart",
          final,
        ],
        "per-section concat ffmpeg",
      );
    } finally {
      try {
        unlinkSync(concatList);
      } catch {
        // best-effort cleanup
      }
    }
  }

  if (options.target_duration_seconds != null) {
    const targetDuration = Number(options.target_duration_seconds);
    if (Number.isFinite(targetDuration) && targetDuration > 0) {
      const timed = path.join(ctx.project_dir, "final_timed.mp4");
      await normalizeFinalDuration(final, timed, targetDuration);
      renameSync(timed, final);
    }
  }

  console.info(`Final video saved (per-section): ${final}`);
  return final;
}

/**
 * Decide whether any scene carries its own (embedded or on-camera) audio.
 *
 * Used by the final stitch step to branch: if false, the all-b-roll global-VO
 * overlay path is taken unchanged; if true, every scene is routed through the
 * audio-preserving per-section assembler so each scene keeps its own mp3.
 */
export function anyEmbeddedAudio(videos: Array<Record<string, any>>): boolean {
  return videos.some((v) => v.has_embedded_audio === true || v.on_camera === true);
}

/**
 * Mixed-mode stitch entry point: a thin named wrapper around
 * {@link stitchAssetsPerSection} so the workflow has one dispatcher for
 * projects that contain at least one talking (audio-bearing) scene. Passes
 * through faithfully; the per-section assembler keeps each scene's own audio.
 */
export async function stitchMixedAssets(
  ctx: ProjectContext,
  scenes: PerSectionScene[],
  options: { target_duration_seconds?: number | null } = {},
): Promise<string> {
  return stitchAssetsPerSection(ctx, scenes, options);
}
