import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { run } from "@openai/agents";
import { ENV } from "./config.js";
import type { ProjectContext } from "./context.js";
import { projectEvents } from "./events.js";
import {
  context,
  contextForExistingProject,
  configuredAgentMaxTurns,
  ensureProjectState,
  initializeProjectState,
} from "./projectContext.js";
import {
  PROJECTS,
  RUNNING_YOUTUBE_REVIEW_BATCHES,
  YOUTUBE_REVIEW_PROVIDERS_ACTIVE,
  readProjectStatus,
  readYoutubeReviewBatch,
  readYoutubeReviewSession,
  terminalYoutubeStatusFromManifest,
  updateProjectStatus,
  writeYoutubeReviewSession,
  youtubeReviewProjectRequest,
} from "./projects.js";
import { agentResponseContent, buildProjectMessageBrief, buildProjectRunBrief } from "./prompts.js";
import { appendProjectMessage, artifactPath, readJsonArtifact, updateProjectState } from "./renderState.js";
import type { JsonDict } from "./renderState.js";
import {
  YouTubeReviewSessionRequestSchema,
  type CreateProjectRequest,
  type YouTubeReviewSessionRequest,
} from "./schemas.js";
import { writeTokenOutput } from "./usageCost.js";
import { mergeTokenOutputIntoManifest, stitchFinalVideoImpl } from "./workflows.js";
import { projectAgentForRequest, videoAgent, videoAgentModel } from "./agents.js";

function newId(): string {
  return randomUUID().replaceAll("-", "");
}

function describeRunItem(item: any): JsonDict | null {
  const rawItem = item?.rawItem ?? {};
  const base: JsonDict = { item_type: item?.type ?? "unknown" };
  switch (item?.type) {
    case "tool_call_item": {
      base.tool_name = rawItem?.name ?? rawItem?.action?.type ?? rawItem?.type ?? "tool";
      const args = typeof rawItem?.arguments === "string" ? rawItem.arguments : JSON.stringify(rawItem?.arguments ?? null);
      base.arguments_preview = args ? String(args).slice(0, 400) : null;
      return base;
    }
    case "tool_call_output_item": {
      base.tool_name = rawItem?.name ?? "tool";
      const output = typeof item?.output === "string" ? item.output : JSON.stringify(item?.output ?? null);
      base.output_preview = output ? String(output).slice(0, 400) : null;
      return base;
    }
    case "message_output_item": {
      const content = (rawItem?.content ?? [])
        .map((part: any) => part?.text ?? "")
        .filter(Boolean)
        .join(" ");
      base.text = String(content).slice(0, 600);
      return base;
    }
    case "reasoning_item": {
      const summary = (rawItem?.content ?? rawItem?.summary ?? [])
        .map((part: any) => part?.text ?? "")
        .filter(Boolean)
        .join(" ");
      base.text = String(summary).slice(0, 400);
      return base;
    }
    default:
      return base;
  }
}

async function runAgentStreamed(
  agent: any,
  input: string,
  ctx: ProjectContext,
): Promise<{ finalOutput: unknown; usage: any }> {
  const streamed = await run(agent, input, {
    stream: true,
    context: ctx,
    maxTurns: configuredAgentMaxTurns(),
  });
  let planValidationFailures = 0;
  for await (const event of streamed) {
    if (event.type === "run_item_stream_event") {
      const detail = describeRunItem(event.item);
      if (detail) {
        projectEvents.emitProjectEvent(ctx.project_id, {
          type: "agent_event",
          event_name: event.name,
          ...detail,
        });
        if (
          detail.tool_name === "draft_video_plan" &&
          typeof detail.output_preview === "string" &&
          (detail.output_preview.includes("validation_failed") ||
            detail.output_preview.includes("Draft plan failed first-run production quality checks"))
        ) {
          planValidationFailures += 1;
          if (planValidationFailures > 1) {
            throw new Error(
              "Draft plan failed production checks after the allowed single pre-provider repair. " +
                "Stopping before paid provider calls.",
            );
          }
        }
      }
    } else if (event.type === "agent_updated_stream_event") {
      projectEvents.emitProjectEvent(ctx.project_id, {
        type: "agent_event",
        event_name: "agent_updated",
        agent_name: event.agent?.name ?? "agent",
      });
    }
  }
  await streamed.completed;
  return { finalOutput: streamed.finalOutput, usage: streamed.runContext.usage };
}

// Default to one outer agent pass. A full re-run can duplicate provider jobs, so
// production should opt into AGENT_MANIFEST_ATTEMPTS only for non-render dry runs
// or controlled debugging.
const MAX_MANIFEST_ATTEMPTS = Math.max(1, Math.trunc(Number(ENV.AGENT_MANIFEST_ATTEMPTS ?? 1)));

export async function runAgentUntilManifest(
  agent: any,
  brief: string,
  ctx: ProjectContext,
  runFn: (agent: any, input: string, ctx: ProjectContext) => Promise<{ finalOutput: unknown; usage: any }> =
    runAgentStreamed,
  opts: { maxAttempts?: number; onRetry?: (nextAttempt: number) => void | Promise<void> } = {},
): Promise<{ usage: any; attempts: number; manifestExists: boolean }> {
  const maxAttempts = opts.maxAttempts ?? MAX_MANIFEST_ATTEMPTS;
  const manifestPath = path.join(ctx.project_dir, "manifest.json");
  let usage: any;
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    ({ usage } = await runFn(agent, brief, ctx));
    if (existsSync(manifestPath)) {
      return { usage, attempts, manifestExists: true };
    }
    if (attempt < maxAttempts && opts.onRetry) {
      await opts.onRetry(attempt + 1);
    }
  }
  return { usage, attempts, manifestExists: false };
}

export async function runProject(projectId: string, request: CreateProjectRequest): Promise<void> {
  const ctx = context(projectId, request);
  ensureProjectState(ctx, request);

  try {
    await updateProjectStatus(projectId, {
      status: "running",
      stage: "planning",
      progress: 10,
      message: "Planning the timed script and scene continuity.",
    });

    const agent = projectAgentForRequest(request);
    const brief = buildProjectRunBrief(request, ctx);
    const { usage, manifestExists } = await runAgentUntilManifest(agent, brief, ctx, runAgentStreamed, {
      maxAttempts: MAX_MANIFEST_ATTEMPTS,
      onRetry: async (nextAttempt) => {
        await updateProjectStatus(projectId, {
          status: "running",
          stage: "planning",
          progress: 10,
          message: `Agent produced no video yet; retrying (attempt ${nextAttempt}).`,
        });
      },
    });
    const tokenOutput = writeTokenOutput(ctx, usage, videoAgentModel);
    if (!manifestExists) {
      updateProjectState(ctx, {
        decision: {
          tool: "run_project",
          decision: "Agent ended after rendered scene videos without stitching; running deterministic final stitch.",
          metadata: { provider_rerendered: false },
        },
      });
      await stitchFinalVideoImpl(ctx, tokenOutput);
    }
    const manifest = mergeTokenOutputIntoManifest(ctx, tokenOutput);
    const failedCount = Number(manifest.failed_scene_count ?? 0);
    await updateProjectStatus(projectId, {
      status: "succeeded",
      stage: "complete",
      progress: 100,
      message:
        failedCount === 0 ? "Video is ready." : `Partial video is ready with ${failedCount} failed scene(s).`,
      manifest,
    });
  } catch (exc: any) {
    console.error("Project generation failed", exc);
    const manifest = readJsonArtifact<JsonDict>(ctx, "manifest", null);
    if (typeof manifest === "object" && manifest !== null) {
      const repaired = terminalYoutubeStatusFromManifest(projectId, manifest);
      if (repaired !== null) {
        updateProjectState(ctx, {
          decision: {
            tool: "run_project",
            decision: "Preserved completed YouTube manifest after the outer agent errored.",
            metadata: { error: String(exc?.message ?? exc) },
          },
        });
        await updateProjectStatus(projectId, {
          status: "succeeded",
          stage: "complete",
          progress: 100,
          message: repaired.message,
          manifest,
        });
        return;
      }
    }
    const current = PROJECTS.get(projectId) ?? {};
    await updateProjectStatus(projectId, {
      status: "failed",
      stage: "failed",
      progress: Number(current.progress ?? 0),
      message: "Generation failed.",
      error: String(exc?.message ?? exc),
    });
  }
}

export async function runProjectMessage(projectId: string, message: string): Promise<void> {
  const ctx = contextForExistingProject(projectId);
  const previousStatus = readProjectStatus(projectId) ?? {};
  const previousManifest = previousStatus.manifest;

  try {
    await updateProjectStatus(projectId, {
      status: "running",
      stage: "message_running",
      progress: 25,
      message: "Agent is handling the project message.",
      manifest: previousManifest,
    });
    const brief = buildProjectMessageBrief(projectId, message, ctx, readProjectStatus(projectId));
    const { finalOutput, usage } = await runAgentStreamed(videoAgent, brief, ctx);
    const tokenOutput = writeTokenOutput(ctx, usage, videoAgentModel);
    const manifest = existsSync(artifactPath(ctx, "manifest"))
      ? mergeTokenOutputIntoManifest(ctx, tokenOutput)
      : null;
    const responseText = agentResponseContent(finalOutput);
    appendProjectMessage(ctx, {
      role: "assistant",
      content: responseText,
      metadata: {
        model: videoAgentModel,
        token_output_path: tokenOutput.token_output_path,
      },
    });
    await updateProjectStatus(projectId, {
      status: "succeeded",
      stage: "message_complete",
      progress: 100,
      message: responseText.slice(0, 240),
      manifest,
    });
  } catch (exc: any) {
    console.error("Project message handling failed", exc);
    appendProjectMessage(ctx, {
      role: "assistant",
      content: `Agent turn failed: ${exc?.message ?? exc}`,
      metadata: { error: String(exc?.message ?? exc) },
    });
    const current = PROJECTS.get(projectId) ?? {};
    await updateProjectStatus(projectId, {
      status: "failed",
      stage: "message_failed",
      progress: Number(current.progress ?? 0),
      message: "Project message failed.",
      error: String(exc?.message ?? exc),
      manifest: previousManifest,
    });
  }
}

export async function queueProject(
  request: CreateProjectRequest,
  options: { start?: boolean } = {},
): Promise<JsonDict> {
  const { start = true } = options;
  const projectId = newId();
  initializeProjectState(context(projectId, request), request);
  const payload = await updateProjectStatus(projectId, {
    status: "queued",
    stage: "queued",
    progress: 0,
    message: "Project queued locally.",
  });
  if (start) {
    void runProject(projectId, request);
  }
  return payload;
}

export async function queueYoutubeReviewSession(
  request: YouTubeReviewSessionRequest,
  options: { metadata?: JsonDict | null; start_projects?: boolean } = {},
): Promise<JsonDict> {
  const { metadata = null, start_projects: startProjects = true } = options;
  const reviewId = newId();
  const now = new Date().toISOString();
  const providers: JsonDict = {};

  for (const provider of YOUTUBE_REVIEW_PROVIDERS_ACTIVE) {
    const projectRequest = youtubeReviewProjectRequest(request, provider);
    const projectPayload = await queueProject(projectRequest, { start: startProjects });
    providers[provider] = {
      provider,
      project_id: projectPayload.project_id,
      status_url: projectPayload.status_url,
      started_at: now,
      comments: "",
      comments_updated_at: null,
    };
  }

  const payload: JsonDict = {
    review_id: reviewId,
    prompt: request.prompt,
    created_at: now,
    updated_at: now,
    settings: {
      duration_seconds: request.duration_seconds ?? null,
      scene_count: request.scene_count ?? null,
      aspect_ratio: request.aspect_ratio,
      resolution: request.resolution,
    },
    metadata: metadata ?? {},
    providers,
  };
  writeYoutubeReviewSession(payload);
  return payload;
}

export async function runYoutubeReviewBatch(batchId: string): Promise<void> {
  try {
    const payload = readYoutubeReviewBatch(batchId);
    if (payload === null) {
      console.warn(`Review batch disappeared before it could run: ${batchId}`);
      return;
    }

    for (const item of (payload.items ?? []) as JsonDict[]) {
      const reviewPayload = readYoutubeReviewSession(String(item.review_id));
      if (reviewPayload === null) {
        console.warn(`Review session disappeared before batch run: ${item.review_id}`);
        continue;
      }
      const settings = reviewPayload.settings ?? {};
      const request = YouTubeReviewSessionRequestSchema.parse({
        prompt: String(reviewPayload.prompt),
        duration_seconds: settings.duration_seconds ?? null,
        scene_count: settings.scene_count ?? null,
        aspect_ratio: settings.aspect_ratio ?? "9:16",
        resolution: settings.resolution ?? "720p",
      });
      for (const provider of YOUTUBE_REVIEW_PROVIDERS_ACTIVE) {
        const providerPayload = (reviewPayload.providers ?? {})[provider];
        if (typeof providerPayload !== "object" || providerPayload === null) continue;
        const projectId = String(providerPayload.project_id);
        const currentStatus = readProjectStatus(projectId);
        if (currentStatus !== null && ["running", "succeeded", "failed"].includes(currentStatus.status)) {
          continue;
        }
        await runProject(projectId, youtubeReviewProjectRequest(request, provider));
      }
    }
  } finally {
    RUNNING_YOUTUBE_REVIEW_BATCHES.delete(batchId);
  }
}

export function reviewBatchHasQueuedProjects(payload: JsonDict): boolean {
  for (const item of (payload.items ?? []) as JsonDict[]) {
    const reviewPayload = readYoutubeReviewSession(String(item.review_id));
    if (reviewPayload === null) continue;
    for (const providerPayload of Object.values((reviewPayload.providers ?? {}) as JsonDict)) {
      if (typeof providerPayload !== "object" || providerPayload === null) continue;
      const status = readProjectStatus(String((providerPayload as JsonDict).project_id));
      if (status !== null && status.status === "queued") return true;
    }
  }
  return false;
}

export function startYoutubeReviewBatchWorker(batchId: string): void {
  if (RUNNING_YOUTUBE_REVIEW_BATCHES.has(batchId)) return;
  RUNNING_YOUTUBE_REVIEW_BATCHES.add(batchId);
  void runYoutubeReviewBatch(batchId);
}

export { newId };
