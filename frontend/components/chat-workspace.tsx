"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Check,
  ChevronDown,
  Clock,
  Database,
  FileText,
  ImageIcon,
  Loader2,
  Music,
  Plus,
  Send,
  Settings2,
  Sparkles,
  Terminal,
  Video,
  WandSparkles,
  Youtube,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { mediaUrl } from "@/lib/api";
import type {
  CreateProjectPayload,
  GeneratedImage,
  MagicImageModel,
  MagicImageResolution,
  MagicVideoModel,
  ProjectStatusResponse,
  WorkflowMode,
  YouTubeSearchProvider,
} from "@/lib/types";

export type ChatSubmitValues = CreateProjectPayload;

type AutoNumber = number | "auto";
type AppMode = "review" | "compose";
type ImageModelSelection = MagicImageModel | "auto";
type VideoModelSelection = MagicVideoModel | "auto";
type ArtifactKind = "image" | "video" | "audio" | "file";
type WorkflowStepStatus = "planned" | "running" | "succeeded" | "failed" | "skipped";

type CreativeArtifact = {
  id: string;
  kind: ArtifactKind;
  label: string;
  path: string;
  url?: string | null;
  tool_id?: string | null;
  provider_job_id?: string | null;
  metadata?: Record<string, unknown>;
};

type WorkflowStep = {
  id: string;
  tool_id: string;
  status: WorkflowStepStatus;
  summary: string;
  error?: string | null;
};

type CreativeState = {
  messages: Array<{
    created_at: string;
    role: "user" | "assistant" | string;
    content: string;
  }>;
  artifacts: CreativeArtifact[];
  workflow_steps: WorkflowStep[];
  status: { stage: string; message: string; progress: number };
};

type PlanScene = {
  id?: string;
  narration?: string;
  image_prompt?: string;
  video_prompt?: string;
  duration_seconds?: number;
};

type PlanView = {
  title?: string;
  narration?: string;
  visual_bible?: string;
  scenes?: PlanScene[];
};

const IMAGE_MODELS: Array<{ value: ImageModelSelection; label: string }> = [
  { value: "auto", label: "Agent chooses" },
  { value: "default", label: "Magic default" },
  { value: "seedream-v4", label: "Seedream v4" },
  { value: "z-image-turbo", label: "Z Image Turbo" },
  { value: "flux-schnell", label: "Flux Schnell" },
  { value: "nano-banana", label: "Nano Banana" },
  { value: "nano-banana-2", label: "Nano Banana 2" },
  { value: "nano-banana-pro", label: "Nano Banana Pro" },
];

const IMAGE_RESOLUTIONS: MagicImageResolution[] = ["640px", "1k", "2k", "4k"];

const VIDEO_MODELS: Array<{ value: VideoModelSelection; label: string }> = [
  { value: "auto", label: "Agent chooses" },
  { value: "default", label: "Magic default" },
  { value: "ltx-2.3", label: "LTX 2.3" },
  { value: "ltx-2", label: "LTX 2" },
  { value: "seedance", label: "Seedance" },
  { value: "seedance-2.0", label: "Seedance 2.0" },
  { value: "kling-2.5", label: "Kling 2.5" },
  { value: "kling-3.0", label: "Kling 3.0" },
  { value: "veo3.1", label: "Veo 3.1" },
  { value: "veo3.1-lite", label: "Veo 3.1 Lite" },
  { value: "sora-2", label: "Sora 2" },
  { value: "wan-2.2", label: "Wan 2.2" },
];

const VIDEO_RESOLUTIONS = ["480p", "720p", "1080p"] as const;
const ASPECT_RATIOS = ["9:16", "16:9", "1:1"] as const;

const WORKFLOWS: Array<{
  value: WorkflowMode;
  label: string;
  summary: string;
}> = [
  {
    value: "generated",
    label: "Generated",
    summary: "Script, voiceover, generated scenes, and final stitch.",
  },
  {
    value: "youtube_clips",
    label: "YouTube clips",
    summary: "Script, voiceover, source clips, and final stitch.",
  },
];

const YOUTUBE_SEARCH_PROVIDERS: Array<{
  value: YouTubeSearchProvider;
  label: string;
  summary: string;
}> = [
  {
    value: "auto",
    label: "Auto",
    summary: "yt-dlp for relevance; Data API only for recent news.",
  },
  {
    value: "youtube_data_api",
    label: "Data API",
    summary: "Explicit API search for date-sensitive coverage.",
  },
  {
    value: "yt_dlp",
    label: "yt-dlp",
    summary: "Quota-free relevance search.",
  },
];

function workflowLabel(workflow: WorkflowMode) {
  return WORKFLOWS.find((option) => option.value === workflow)?.label ?? "Generated";
}

function workflowFromJob(job: ProjectStatusResponse | null): WorkflowMode | null {
  const raw = job?.manifest?.workflow ?? job?.project_state?.user_preferences?.workflow;
  return raw === "youtube_clips" || raw === "generated" ? raw : null;
}

function messagesForJob(job: ProjectStatusResponse | null, localPrompt: string | null) {
  const messages = [...(job?.project_state?.messages ?? [])];
  if (messages.length === 0 && localPrompt) {
    messages.push({
      role: "user",
      content: localPrompt,
      created_at: job?.updated_at ?? new Date().toISOString(),
    });
  }
  if (job && messages.length === 1 && job.status !== "queued") {
    messages.push({
      role: "assistant",
      content: job.manifest?.title ? `I drafted and rendered "${job.manifest.title}".` : job.message,
      created_at: job.updated_at,
    });
  }
  return messages;
}

function planFromArtifact(artifact: CreativeArtifact | null): PlanView | null {
  const plan = artifact?.metadata?.plan;
  if (!plan || typeof plan !== "object") return null;
  return plan as PlanView;
}

function workflowStepsForJob(job: ProjectStatusResponse | null, workflow: WorkflowMode): WorkflowStep[] {
  if (!job) return [];

  const complete = job.status === "succeeded";
  const failed = job.status === "failed";
  const runningStage = job.stage;
  const steps =
    workflow === "youtube_clips"
      ? [
          {
            id: "plan",
            tool_id: "create_youtube_short_from_prompt",
            stages: ["queued", "planning", "youtube_script", "youtube_short"],
            summary: "Plan the short, timed narration, and source clip searches.",
          },
          {
            id: "voiceover",
            tool_id: "generate_voiceover",
            stages: ["voiceover", "youtube_voiceover_generated"],
            summary: "Generate the narration track for the short.",
          },
          {
            id: "clips",
            tool_id: "download_youtube_clips",
            stages: ["youtube_clips_downloaded", "youtube_clip_download"],
            summary: "Search, download, and trim YouTube source clips.",
          },
          {
            id: "stitch",
            tool_id: "stitch_final_video",
            stages: ["stitching", "youtube_short_stitched"],
            summary: "Assemble source clips and voiceover into the final edit.",
          },
        ]
      : [
          {
            id: "plan",
            tool_id: "draft_video_plan",
            stages: ["queued", "planning", "plan_drafted"],
            summary: "Draft script, narration, visual style, and scene prompts.",
          },
          {
            id: "voiceover",
            tool_id: "generate_voiceover",
            stages: ["voiceover", "voiceover_generated", "voiceover_images"],
            summary: "Generate the narration track.",
          },
          {
            id: "images",
            tool_id: "generate_scene_images",
            stages: ["image_generation", "images_generated", "voiceover_images"],
            summary: "Generate scene keyframes.",
          },
          {
            id: "videos",
            tool_id: "animate_scene_videos",
            stages: ["video_generation", "videos_animated"],
            summary: "Animate generated keyframes into scene clips.",
          },
          {
            id: "stitch",
            tool_id: "stitch_final_video",
            stages: ["stitching"],
            summary: "Stitch scenes and voiceover into the final edit.",
          },
        ];

  const activeIndex = steps.findIndex((step) => step.stages.includes(runningStage));

  return steps.map((step, index) => {
    let status: WorkflowStepStatus = "planned";
    if (complete) status = "succeeded";
    if (failed) status = step.stages.includes(runningStage) ? "failed" : "skipped";
    if (!complete && !failed && step.stages.includes(runningStage)) status = "running";
    if (!complete && !failed && activeIndex > index) status = "succeeded";
    return {
      id: step.id,
      tool_id: step.tool_id,
      status,
      summary: step.summary,
      error: failed && step.stages.includes(runningStage) ? job.error ?? null : null,
    };
  });
}

function artifactsForJob(job: ProjectStatusResponse | null, workflow: WorkflowMode): CreativeArtifact[] {
  if (!job) return [];

  const artifacts: CreativeArtifact[] = [];
  const plan = job.manifest?.plan ?? job.project_state?.current_plan;
  const images = job.manifest?.images ?? job.project_state?.scene_assets.images ?? [];
  const videos = job.manifest?.videos ?? job.project_state?.scene_assets.videos ?? [];
  const voiceover = job.manifest?.voiceover ?? job.project_state?.scene_assets.voiceover ?? null;
  const finalVideoPath = job.manifest?.final_video_path ?? job.project_state?.scene_assets.final_video_path ?? null;
  const finalVideoUrl = job.manifest?.final_video_url ?? null;
  const videoTool = workflow === "youtube_clips" ? "download_youtube_clips" : "animate_scene_videos";

  if (plan) {
    artifacts.push({
      id: "script",
      kind: "file",
      label: "Script",
      path: "",
      tool_id: workflow === "youtube_clips" ? "create_youtube_short_from_prompt" : "draft_video_plan",
      metadata: { plan },
    });
  }

  if (finalVideoPath || finalVideoUrl) {
    artifacts.push({
      id: "final-video",
      kind: "video",
      label: "Final video",
      path: finalVideoPath ?? "",
      url: finalVideoUrl,
      tool_id: "stitch_final_video",
    });
  }

  videos.forEach((video, index) => {
    artifacts.push({
      id: `video-${video.scene_id}-${index}`,
      kind: "video",
      label: workflow === "youtube_clips" ? `Source clip ${index + 1}` : `Scene video ${index + 1}`,
      path: video.path,
      url: video.url,
      tool_id: videoTool,
      provider_job_id: video.provider_job_id,
      metadata: {
        scene_id: video.scene_id,
        model: video.model,
        prompt: video.prompt,
        duration_seconds: video.duration_seconds,
      },
    });
  });

  images.forEach((image, index) => {
    artifacts.push({
      id: `image-${image.scene_id}-${index}`,
      kind: "image",
      label: `Scene image ${index + 1}`,
      path: image.path,
      url: image.url,
      tool_id: "generate_scene_images",
      provider_job_id: image.provider_job_id,
      metadata: { scene_id: image.scene_id, model: image.model, prompt: image.prompt },
    });
  });

  if (voiceover?.path) {
    artifacts.push({
      id: "voiceover",
      kind: "audio",
      label: "Voiceover",
      path: voiceover.path,
      url: voiceover.url,
      tool_id: "generate_voiceover",
      metadata: { model: voiceover.model, duration_seconds: voiceover.duration_seconds },
    });
  }

  return artifacts;
}

function creativeStateForJob(
  job: ProjectStatusResponse | null,
  prompt: string | null,
  workflow: WorkflowMode,
): CreativeState | null {
  if (!job) return null;
  const artifacts = artifactsForJob(job, workflow);
  return {
    messages: messagesForJob(job, prompt),
    artifacts,
    workflow_steps: workflowStepsForJob(job, workflow),
    status: { stage: job.stage, message: job.message, progress: job.progress },
  };
}

function activeStepLabel(status: CreativeState["status"] | null, steps: WorkflowStep[]) {
  const running = steps.find((step) => step.status === "running");
  if (status?.stage === "youtube_short") return "Building the YouTube clip short";
  if (running?.tool_id === "create_youtube_short_from_prompt" || status?.stage === "youtube_script") return "Planning the YouTube script and search hints";
  if (running?.tool_id === "download_youtube_clips" || status?.stage === "youtube_clips_downloaded") return "Collecting source clips";
  if (running?.tool_id === "draft_video_plan" || status?.stage === "planning") return "Planning the script and scene continuity";
  if (running?.tool_id === "generate_voiceover" || status?.stage === "voiceover") return "Recording the voiceover";
  if (running?.tool_id === "generate_scene_images" || status?.stage === "image_generation") return "Generating scene keyframes";
  if (running?.tool_id === "animate_scene_videos" || status?.stage === "video_generation") return "Animating scene clips";
  if (running?.tool_id === "stitch_final_video" || status?.stage === "stitching") return "Stitching the final edit";
  if (status?.stage === "queued") return "Queued for the video agent";
  return status?.message || "Waiting for a request";
}

function iconForArtifact(kind: ArtifactKind) {
  if (kind === "video") return <Video className="h-4 w-4" />;
  if (kind === "audio") return <Music className="h-4 w-4" />;
  if (kind === "file") return <FileText className="h-4 w-4" />;
  return <ImageIcon className="h-4 w-4" />;
}

export function ChatWorkspace({
  activeMode = "compose",
  job,
  isBusy,
  onCreate,
  onModeChange,
  onMessage,
  onNewCreate,
}: {
  activeMode?: AppMode;
  job: ProjectStatusResponse | null;
  isBusy: boolean;
  onCreate: (values: ChatSubmitValues) => void;
  onModeChange?: (mode: AppMode) => void;
  onMessage: (message: string) => void;
  onNewCreate: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [localPrompt, setLocalPrompt] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowMode>("generated");
  const [duration, setDuration] = useState<AutoNumber>("auto");
  const [sceneCount, setSceneCount] = useState<AutoNumber>("auto");
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>("9:16");
  const [resolution, setResolution] = useState<(typeof VIDEO_RESOLUTIONS)[number]>("720p");
  const [imageModel, setImageModel] = useState<ImageModelSelection>("seedream-v4");
  const [imageResolution, setImageResolution] = useState<MagicImageResolution>("1k");
  const [videoModel, setVideoModel] = useState<VideoModelSelection>("ltx-2.3");
  const [videoResolution, setVideoResolution] = useState<(typeof VIDEO_RESOLUTIONS)[number]>("720p");
  const [youtubeSearchProvider, setYoutubeSearchProvider] = useState<YouTubeSearchProvider>("auto");

  const activeWorkflow = workflowFromJob(job) ?? workflow;
  const state = useMemo(
    () => creativeStateForJob(job, localPrompt, activeWorkflow),
    [activeWorkflow, job, localPrompt],
  );
  const selected = useMemo(
    () => state?.artifacts.find((artifact) => artifact.id === selectedArtifactId) ?? state?.artifacts[0] ?? null,
    [selectedArtifactId, state?.artifacts],
  );
  const activeWorkflowMeta = WORKFLOWS.find((item) => item.value === activeWorkflow) ?? WORKFLOWS[0];
  const canSendFollowUp = Boolean(job?.project_id) && !isBusy;

  useEffect(() => {
    if (!state?.artifacts.length) {
      setSelectedArtifactId(null);
      return;
    }
    const stillExists = state.artifacts.some((artifact) => artifact.id === selectedArtifactId);
    if (!stillExists) {
      setSelectedArtifactId(state.artifacts[0].id);
    }
  }, [selectedArtifactId, state?.artifacts]);

  const startNewCreate = () => {
    setPrompt("");
    setFollowUp("");
    setLocalPrompt(null);
    setSelectedArtifactId(null);
    setWorkflow("generated");
    setYoutubeSearchProvider("auto");
    onNewCreate();
  };

  const submitInitial = () => {
    const cleaned = prompt.trim();
    if (!cleaned || isBusy) return;
    setLocalPrompt(cleaned);
    setSelectedArtifactId(null);
    onCreate({
      prompt: cleaned,
      workflow,
      duration_seconds: duration === "auto" ? null : duration,
      scene_count: sceneCount === "auto" ? null : sceneCount,
      aspect_ratio: aspectRatio,
      resolution,
      image_model: workflow === "generated" && imageModel !== "auto" ? imageModel : null,
      image_resolution: workflow === "generated" ? imageResolution : null,
      video_model: workflow === "generated" && videoModel !== "auto" ? videoModel : null,
      video_resolution: workflow === "generated" ? videoResolution : null,
      youtube_search_provider: workflow === "youtube_clips" ? youtubeSearchProvider : "youtube_data_api",
    });
    setPrompt("");
  };

  const submitFollowUp = () => {
    const cleaned = followUp.trim();
    if (!cleaned || !canSendFollowUp) return;
    onMessage(cleaned);
    setFollowUp("");
  };

  return (
    <main className="min-h-screen bg-candy text-[#26172f] selection:bg-pink-300/60 selection:text-[#26172f]">
      <header className="flex h-16 items-center justify-between border-b border-white/70 bg-white/65 px-5 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-rainbow text-xs font-extrabold text-white shadow-candy">
            VA
          </div>
          <div>
            <h1 className="text-sm font-bold">Local Video Composer</h1>
            <p className="text-xs text-[#7c6688]">OpenAI agent plus Magic Hour renders</p>
          </div>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-[#875caa2e] bg-white/75 px-3 py-1 text-xs text-[#563861] shadow-sm sm:flex">
          {activeWorkflow === "youtube_clips" ? <Youtube className="h-3.5 w-3.5 text-rose-500" /> : <Sparkles className="h-3.5 w-3.5 text-pink-500" />}
          {activeWorkflowMeta.label}
        </div>
        <div className="flex items-center gap-2">
          {onModeChange && (
            <div className="grid grid-cols-2 rounded-full border border-[#875caa24] bg-white/75 p-1 text-xs font-bold text-[#7c6688]">
              {(["review", "compose"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onModeChange(mode)}
                  className={`h-8 rounded-full px-3 transition ${
                    activeMode === mode ? "bg-[#26172f] text-white shadow-sm" : "hover:bg-white"
                  }`}
                >
                  {mode === "review" ? "Review" : "Composer"}
                </button>
              ))}
            </div>
          )}
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={startNewCreate}
            className="gap-1.5 border-[#875caa2e] bg-white/75 text-[#563861] hover:bg-white"
          >
            <Plus className="h-3.5 w-3.5" />
            New
          </Button>
        </div>
      </header>

      <div className="grid min-h-[calc(100vh-4rem)] gap-4 p-4 lg:grid-cols-[370px_minmax(460px,1fr)_330px]">
        <ConversationPanel
          activeWorkflow={activeWorkflow}
          canSendFollowUp={canSendFollowUp}
          duration={duration}
          followUp={followUp}
          imageModel={imageModel}
          imageResolution={imageResolution}
          isBusy={isBusy}
          messages={state?.messages ?? []}
          onDurationChange={setDuration}
          onFollowUpChange={setFollowUp}
          onImageModelChange={setImageModel}
          onImageResolutionChange={setImageResolution}
          onPromptChange={setPrompt}
          onResolutionChange={setResolution}
          onSceneCountChange={setSceneCount}
          onSubmitFollowUp={submitFollowUp}
          onSubmitInitial={submitInitial}
          onToggleSettings={() => setShowSettings((value) => !value)}
          onVideoModelChange={setVideoModel}
          onVideoResolutionChange={setVideoResolution}
          onWorkflowChange={setWorkflow}
          onYoutubeSearchProviderChange={setYoutubeSearchProvider}
          prompt={prompt}
          resolution={resolution}
          sceneCount={sceneCount}
          selectedWorkflow={workflow}
          showSettings={showSettings}
          videoModel={videoModel}
          videoResolution={videoResolution}
          youtubeSearchProvider={youtubeSearchProvider}
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          hasProject={Boolean(job?.project_id)}
        />

        <section className="glass-panel grid min-h-0 grid-rows-[1fr_126px] overflow-hidden rounded-[14px]">
          <ArtifactCanvas artifact={selected} status={state?.status ?? null} steps={state?.workflow_steps ?? []} workflow={activeWorkflow} />
          <ArtifactStrip artifacts={state?.artifacts ?? []} selectedId={selected?.id ?? null} onSelect={setSelectedArtifactId} workflow={activeWorkflow} />
        </section>

        <aside className="min-h-0 max-lg:hidden">
          <RunPlanPanel steps={state?.workflow_steps ?? []} workflow={activeWorkflow} />
        </aside>
      </div>
    </main>
  );
}

function ConversationPanel({
  activeWorkflow,
  aspectRatio,
  canSendFollowUp,
  duration,
  followUp,
  hasProject,
  imageModel,
  imageResolution,
  isBusy,
  messages,
  onAspectRatioChange,
  onDurationChange,
  onFollowUpChange,
  onImageModelChange,
  onImageResolutionChange,
  onPromptChange,
  onResolutionChange,
  onSceneCountChange,
  onSubmitFollowUp,
  onSubmitInitial,
  onToggleSettings,
  onVideoModelChange,
  onVideoResolutionChange,
  onWorkflowChange,
  onYoutubeSearchProviderChange,
  prompt,
  resolution,
  sceneCount,
  selectedWorkflow,
  showSettings,
  videoModel,
  videoResolution,
  youtubeSearchProvider,
}: {
  activeWorkflow: WorkflowMode;
  aspectRatio: (typeof ASPECT_RATIOS)[number];
  canSendFollowUp: boolean;
  duration: AutoNumber;
  followUp: string;
  hasProject: boolean;
  imageModel: ImageModelSelection;
  imageResolution: MagicImageResolution;
  isBusy: boolean;
  messages: CreativeState["messages"];
  onAspectRatioChange: (value: (typeof ASPECT_RATIOS)[number]) => void;
  onDurationChange: (value: AutoNumber) => void;
  onFollowUpChange: (value: string) => void;
  onImageModelChange: (value: ImageModelSelection) => void;
  onImageResolutionChange: (value: MagicImageResolution) => void;
  onPromptChange: (value: string) => void;
  onResolutionChange: (value: (typeof VIDEO_RESOLUTIONS)[number]) => void;
  onSceneCountChange: (value: AutoNumber) => void;
  onSubmitFollowUp: () => void;
  onSubmitInitial: () => void;
  onToggleSettings: () => void;
  onVideoModelChange: (value: VideoModelSelection) => void;
  onVideoResolutionChange: (value: (typeof VIDEO_RESOLUTIONS)[number]) => void;
  onWorkflowChange: (value: WorkflowMode) => void;
  onYoutubeSearchProviderChange: (value: YouTubeSearchProvider) => void;
  prompt: string;
  resolution: (typeof VIDEO_RESOLUTIONS)[number];
  sceneCount: AutoNumber;
  selectedWorkflow: WorkflowMode;
  showSettings: boolean;
  videoModel: VideoModelSelection;
  videoResolution: (typeof VIDEO_RESOLUTIONS)[number];
  youtubeSearchProvider: YouTubeSearchProvider;
}) {
  const visibleWorkflow = hasProject ? activeWorkflow : selectedWorkflow;
  return (
    <section className="glass-panel grid min-h-0 grid-rows-[auto_1fr_auto] overflow-hidden rounded-[14px]">
      <div className="flex items-center justify-between border-b border-[#875caa24] bg-white/55 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold">Conversation</h2>
          <p className="mt-0.5 text-xs text-[#7c6688]">Choose a workflow and describe the video</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-teal-100/70 px-2 py-1 text-[11px] text-emerald-700">
          <WandSparkles className="h-3 w-3" />
          agentic
        </span>
      </div>

      <div className="custom-scrollbar min-h-0 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <>
            <div className="max-w-[92%] rounded-[14px] border border-[#875caa24] bg-white/75 px-3 py-2 text-sm leading-6 text-[#392545]">
              Send a short-video brief. The agent can either generate the scenes or build from YouTube source clips.
            </div>
            <div className="rounded-[14px] border border-[#875caa24] bg-white/65 p-3 text-xs text-[#6b4b78]">
              Render status, intermediate assets, and the final output appear across the canvas and run plan.
            </div>
          </>
        ) : (
          messages.map((item, index) => (
            <div
              key={`${item.created_at}-${index}`}
              className={`max-w-[92%] rounded-[14px] px-3 py-2 text-sm leading-6 ${
                item.role === "user"
                  ? "ml-auto bg-gradient-to-br from-pink-400 to-violet-400 text-white shadow-lg shadow-pink-300/20"
                  : "border border-[#875caa24] bg-white/75 text-[#392545]"
              }`}
            >
              {item.content}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-[#875caa24] bg-white/45 p-3">
        {!hasProject ? (
          <div className="space-y-3">
            <WorkflowToggle selected={selectedWorkflow} disabled={isBusy} onChange={onWorkflowChange} />
            {selectedWorkflow === "youtube_clips" && (
              <YouTubeProviderToggle
                disabled={isBusy}
                onChange={onYoutubeSearchProviderChange}
                selected={youtubeSearchProvider}
              />
            )}
            <div className="grid grid-cols-[1fr_auto] gap-2 rounded-[14px] border border-[#875caa38] bg-white/90 p-2 shadow-inner">
              <textarea
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    onSubmitInitial();
                  }
                }}
                className="min-h-[92px] resize-none border-0 bg-transparent px-1 py-1 text-sm text-[#26172f] outline-none placeholder:text-[#a08ca9]"
                placeholder={
                  selectedWorkflow === "youtube_clips"
                    ? "Make a fast Formula One news short using real race clips..."
                    : "Make a tense cinematic story about a courier crossing a neon city..."
                }
                disabled={isBusy}
              />
              <Button
                type="button"
                onClick={onSubmitInitial}
                disabled={isBusy || !prompt.trim()}
                size="icon"
                className="self-end rounded-xl bg-gradient-to-br from-pink-400 to-violet-400 text-white hover:opacity-90"
                aria-label="Start generation"
              >
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <button
              type="button"
              onClick={onToggleSettings}
              className="flex w-full items-center justify-between rounded-[12px] border border-[#875caa24] bg-white/65 px-3 py-2 text-xs font-semibold text-[#563861]"
            >
              <span className="flex items-center gap-2">
                <Settings2 className="h-3.5 w-3.5" />
                Advanced controls
              </span>
              <ChevronDown className={`h-3.5 w-3.5 transition ${showSettings ? "rotate-180" : ""}`} />
            </button>
            {showSettings && (
              <SettingsGrid
                aspectRatio={aspectRatio}
                duration={duration}
                imageModel={imageModel}
                imageResolution={imageResolution}
                onAspectRatioChange={onAspectRatioChange}
                onDurationChange={onDurationChange}
                onImageModelChange={onImageModelChange}
                onImageResolutionChange={onImageResolutionChange}
                onResolutionChange={onResolutionChange}
                onSceneCountChange={onSceneCountChange}
                onVideoModelChange={onVideoModelChange}
                onVideoResolutionChange={onVideoResolutionChange}
                resolution={resolution}
                sceneCount={sceneCount}
                videoModel={videoModel}
                videoResolution={videoResolution}
                workflow={selectedWorkflow}
              />
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1 rounded-[14px] border border-[#875caa24] bg-white/70 p-1">
              {WORKFLOWS.map((option) => (
                <div
                  key={option.value}
                  className={`flex h-9 items-center justify-center gap-2 rounded-[10px] text-xs font-bold ${
                    visibleWorkflow === option.value
                      ? "bg-gradient-to-br from-pink-400 to-violet-400 text-white shadow-sm"
                      : "text-[#7c6688]"
                  }`}
                >
                  {option.value === "generated" ? <Sparkles className="h-3.5 w-3.5" /> : <Youtube className="h-3.5 w-3.5" />}
                  {option.label}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2 rounded-[14px] border border-[#875caa38] bg-white/90 p-2 shadow-inner">
              <textarea
                value={followUp}
                onChange={(event) => onFollowUpChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    onSubmitFollowUp();
                  }
                }}
                className="min-h-[72px] resize-none border-0 bg-transparent px-1 py-1 text-sm text-[#26172f] outline-none placeholder:text-[#a08ca9]"
                placeholder="Ask for a revision..."
                disabled={!canSendFollowUp}
              />
              <Button
                type="button"
                onClick={onSubmitFollowUp}
                disabled={!followUp.trim() || !canSendFollowUp}
                size="icon"
                className="self-end rounded-xl bg-gradient-to-br from-pink-400 to-violet-400 text-white hover:opacity-90"
                aria-label="Send message"
              >
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function WorkflowToggle({
  disabled,
  onChange,
  selected,
}: {
  disabled: boolean;
  onChange: (value: WorkflowMode) => void;
  selected: WorkflowMode;
}) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-[14px] border border-[#875caa24] bg-white/70 p-1">
      {WORKFLOWS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`grid min-h-[64px] rounded-[11px] px-3 py-2 text-left transition ${
            selected === option.value
              ? "bg-gradient-to-br from-pink-400 to-violet-400 text-white shadow-sm"
              : "text-[#7c6688] hover:bg-white/85"
          }`}
          disabled={disabled}
        >
          <span className="flex items-center gap-2 text-xs font-black">
            {option.value === "generated" ? <Sparkles className="h-3.5 w-3.5" /> : <Youtube className="h-3.5 w-3.5" />}
            {option.label}
          </span>
          <span className={`mt-1 text-[11px] leading-4 ${selected === option.value ? "text-white/82" : "text-[#8e7899]"}`}>
            {option.summary}
          </span>
        </button>
      ))}
    </div>
  );
}

function YouTubeProviderToggle({
  disabled,
  onChange,
  selected,
}: {
  disabled: boolean;
  onChange: (value: YouTubeSearchProvider) => void;
  selected: YouTubeSearchProvider;
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-[14px] border border-[#875caa24] bg-white/70 p-1">
      {YOUTUBE_SEARCH_PROVIDERS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`grid min-h-[56px] rounded-[11px] px-3 py-2 text-left transition ${
            selected === option.value
              ? "bg-gradient-to-br from-rose-400 to-sky-400 text-white shadow-sm"
              : "text-[#7c6688] hover:bg-white/85"
          }`}
          disabled={disabled}
        >
          <span className="flex items-center gap-2 text-xs font-black">
            {option.value === "youtube_data_api" ? <Database className="h-3.5 w-3.5" /> : <Terminal className="h-3.5 w-3.5" />}
            {option.label}
          </span>
          <span className={`mt-1 text-[11px] leading-4 ${selected === option.value ? "text-white/82" : "text-[#8e7899]"}`}>
            {option.summary}
          </span>
        </button>
      ))}
    </div>
  );
}

function SettingsGrid({
  aspectRatio,
  duration,
  imageModel,
  imageResolution,
  onAspectRatioChange,
  onDurationChange,
  onImageModelChange,
  onImageResolutionChange,
  onResolutionChange,
  onSceneCountChange,
  onVideoModelChange,
  onVideoResolutionChange,
  resolution,
  sceneCount,
  videoModel,
  videoResolution,
  workflow,
}: {
  aspectRatio: (typeof ASPECT_RATIOS)[number];
  duration: AutoNumber;
  imageModel: ImageModelSelection;
  imageResolution: MagicImageResolution;
  onAspectRatioChange: (value: (typeof ASPECT_RATIOS)[number]) => void;
  onDurationChange: (value: AutoNumber) => void;
  onImageModelChange: (value: ImageModelSelection) => void;
  onImageResolutionChange: (value: MagicImageResolution) => void;
  onResolutionChange: (value: (typeof VIDEO_RESOLUTIONS)[number]) => void;
  onSceneCountChange: (value: AutoNumber) => void;
  onVideoModelChange: (value: VideoModelSelection) => void;
  onVideoResolutionChange: (value: (typeof VIDEO_RESOLUTIONS)[number]) => void;
  resolution: (typeof VIDEO_RESOLUTIONS)[number];
  sceneCount: AutoNumber;
  videoModel: VideoModelSelection;
  videoResolution: (typeof VIDEO_RESOLUTIONS)[number];
  workflow: WorkflowMode;
}) {
  return (
    <div className="grid gap-2 rounded-[14px] border border-[#875caa24] bg-white/72 p-3 text-xs sm:grid-cols-2">
      {workflow === "generated" && (
        <>
          <Select label="Image model" value={imageModel} onChange={(value) => onImageModelChange(value as ImageModelSelection)} options={IMAGE_MODELS} />
          <Select
            label="Image res"
            value={imageResolution}
            onChange={(value) => onImageResolutionChange(value as MagicImageResolution)}
            options={IMAGE_RESOLUTIONS.map((value) => ({ value, label: value }))}
          />
          <Select label="Video model" value={videoModel} onChange={(value) => onVideoModelChange(value as VideoModelSelection)} options={VIDEO_MODELS} />
          <Select
            label="Video res"
            value={videoResolution}
            onChange={(value) => onVideoResolutionChange(value as (typeof VIDEO_RESOLUTIONS)[number])}
            options={VIDEO_RESOLUTIONS.map((value) => ({ value, label: value }))}
          />
        </>
      )}
      <Select
        label="Aspect"
        value={aspectRatio}
        onChange={(value) => onAspectRatioChange(value as (typeof ASPECT_RATIOS)[number])}
        options={ASPECT_RATIOS.map((value) => ({ value, label: value }))}
      />
      <Select
        label="Output res"
        value={resolution}
        onChange={(value) => onResolutionChange(value as (typeof VIDEO_RESOLUTIONS)[number])}
        options={VIDEO_RESOLUTIONS.map((value) => ({ value, label: value }))}
      />
      <AutoNumberField label="Seconds" value={duration} min={5} max={60} onChange={onDurationChange} />
      <AutoNumberField label="Scenes" value={sceneCount} min={1} max={10} onChange={onSceneCountChange} />
    </div>
  );
}

function Select({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string }>;
  value: string;
}) {
  return (
    <label className="grid gap-1">
      <span className="font-semibold text-[#7c6688]">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-[10px] border border-[#875caa24] bg-white/90 px-2 text-[#392545] outline-none focus:border-pink-300"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function AutoNumberField({
  label,
  max,
  min,
  onChange,
  value,
}: {
  label: string;
  max: number;
  min: number;
  onChange: (value: AutoNumber) => void;
  value: AutoNumber;
}) {
  const options = Array.from({ length: max - min + 1 }, (_, index) => min + index);
  return (
    <label className="grid gap-1">
      <span className="font-semibold text-[#7c6688]">{label}</span>
      <select
        value={value === "auto" ? "auto" : String(value)}
        onChange={(event) => onChange(event.target.value === "auto" ? "auto" : Number(event.target.value))}
        className="h-9 rounded-[10px] border border-[#875caa24] bg-white/90 px-2 text-[#392545] outline-none focus:border-pink-300"
      >
        <option value="auto">Auto</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function ArtifactCanvas({
  artifact,
  status,
  steps,
  workflow,
}: {
  artifact: CreativeArtifact | null;
  status: CreativeState["status"] | null;
  steps: WorkflowStep[];
  workflow: WorkflowMode;
}) {
  const source = mediaUrl(artifact?.url ?? artifact?.path);
  const plan = planFromArtifact(artifact);

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr]">
      <div className="flex items-center justify-between border-b border-[#875caa24] bg-white/55 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold">Artifact Canvas</h2>
          <p className="mt-0.5 text-xs text-[#7c6688]">{workflowLabel(workflow)} workflow output</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-[#875caa2e] bg-white/70 px-3 py-1 text-xs font-semibold text-[#563861]">
          {status?.progress ?? 0}%
        </div>
      </div>

      <div className="grid min-h-0 place-items-center bg-[linear-gradient(90deg,rgba(159,122,234,.08)_1px,transparent_1px),linear-gradient(0deg,rgba(84,200,255,.08)_1px,transparent_1px),rgba(255,255,255,.32)] bg-[length:42px_42px] p-4">
        {plan ? (
          <ScriptCanvas plan={plan} workflow={workflow} />
        ) : source ? (
          artifact?.kind === "video" ? (
            <video src={source} controls className="max-h-[66vh] max-w-full rounded-[18px] border border-white/90 bg-white/80 shadow-candy" />
          ) : artifact?.kind === "audio" ? (
            <div className="grid w-[min(84%,620px)] gap-4 rounded-[18px] border border-white/90 bg-white/86 p-5 shadow-candy">
              <div className="flex items-center gap-3 text-[#392545]">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-pink-100 text-pink-500">
                  <Music className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-bold">{artifact?.label ?? "Audio"}</p>
                  <p className="text-xs text-[#7c6688]">{String(artifact?.metadata?.model ?? "voiceover")}</p>
                </div>
              </div>
              <audio src={source} controls className="w-full" />
            </div>
          ) : (
            <img src={source} alt={artifact?.label ?? "Artifact"} className="max-h-[66vh] max-w-full rounded-[18px] border border-white/90 bg-white/80 object-contain shadow-candy" />
          )
        ) : status ? (
          <ProcessingCanvas status={status} steps={steps} workflow={workflow} />
        ) : (
          <EmptyCanvas workflow={workflow} />
        )}
      </div>
    </div>
  );
}

function ScriptCanvas({ plan, workflow }: { plan: PlanView; workflow: WorkflowMode }) {
  return (
    <article className="custom-scrollbar max-h-[66vh] w-full max-w-4xl overflow-y-auto rounded-[18px] border border-white/90 bg-white/86 p-5 shadow-candy">
      <div className="mb-4 flex items-center gap-2 text-xs font-bold uppercase text-pink-500">
        <FileText className="h-4 w-4" />
        {workflow === "youtube_clips" ? "Clip Script" : "Script"}
      </div>
      <h3 className="text-2xl font-black text-[#2c1735]">{plan.title ?? "Untitled video"}</h3>
      {plan.visual_bible && (
        <blockquote className="mt-4 rounded-2xl border-l-4 border-pink-300 bg-pink-50/80 px-4 py-3 text-sm leading-6 text-[#62436f]">
          {plan.visual_bible}
        </blockquote>
      )}
      {plan.narration && (
        <section className="mt-5">
          <div className="text-xs font-bold uppercase text-[#8a5b9b]">Voiceover</div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-[#392545]">{plan.narration}</p>
        </section>
      )}
      {!!plan.scenes?.length && (
        <section className="mt-5 grid gap-3">
          <div className="text-xs font-bold uppercase text-[#8a5b9b]">Scenes</div>
          {plan.scenes.map((scene, index) => (
            <div key={scene.id ?? index} className="rounded-2xl border border-[#875caa24] bg-white/80 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-sm font-bold text-[#382244]">Scene {index + 1}</div>
                {scene.duration_seconds && (
                  <div className="rounded-full bg-sky-100 px-2 py-1 text-[11px] font-semibold text-sky-700">
                    {scene.duration_seconds}s
                  </div>
                )}
              </div>
              {scene.narration && <p className="text-sm leading-6 text-[#392545]">{scene.narration}</p>}
              {scene.image_prompt && (
                <details className="mt-3 rounded-xl bg-pink-50/80 px-3 py-2 text-xs text-[#6b4b78]">
                  <summary className="cursor-pointer font-semibold text-pink-600">Image prompt</summary>
                  <p className="mt-2 leading-5">{scene.image_prompt}</p>
                </details>
              )}
              {scene.video_prompt && (
                <details className="mt-2 rounded-xl bg-sky-50/80 px-3 py-2 text-xs text-[#567081]">
                  <summary className="cursor-pointer font-semibold text-sky-600">
                    {workflow === "youtube_clips" ? "Clip search" : "Video prompt"}
                  </summary>
                  <p className="mt-2 leading-5">{scene.video_prompt}</p>
                </details>
              )}
            </div>
          ))}
        </section>
      )}
    </article>
  );
}

function ProcessingCanvas({
  status,
  steps,
  workflow,
}: {
  status: CreativeState["status"] | null;
  steps: WorkflowStep[];
  workflow: WorkflowMode;
}) {
  const label = activeStepLabel(status, steps);
  const assets =
    workflow === "youtube_clips"
      ? "Script, voiceover, source clips, and final video become clickable as they finish."
      : "Script, voiceover, generated scenes, and final video become clickable as they finish.";
  return (
    <div className="relative grid aspect-[16/10] w-[min(84%,780px)] place-items-center overflow-hidden rounded-[18px] border border-white/90 bg-[radial-gradient(circle_at_20%_20%,rgba(255,102,196,.42),transparent_28%),radial-gradient(circle_at_82%_18%,rgba(84,200,255,.38),transparent_30%),radial-gradient(circle_at_60%_82%,rgba(94,234,212,.4),transparent_34%),linear-gradient(135deg,#fff,#fff5fd_46%,#effcff)] shadow-candy">
      <div className="absolute inset-0 animate-pulse bg-rainbow opacity-10" />
      <div className="relative grid max-w-md gap-4 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-white/80 text-pink-500 shadow-lg shadow-pink-300/20">
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
        <div>
          <p className="animate-pulse text-base font-black text-[#392545]">{label}</p>
          <p className="mt-2 text-xs leading-5 text-[#7c6688]">{assets}</p>
        </div>
        {status && (
          <div className="mx-auto h-2 w-64 overflow-hidden rounded-full bg-white/70">
            <div className="h-full rounded-full bg-rainbow transition-all" style={{ width: `${Math.max(4, Math.min(100, status.progress))}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyCanvas({ workflow }: { workflow: WorkflowMode }) {
  return (
    <div className="relative grid aspect-[16/10] w-[min(84%,780px)] place-items-center overflow-hidden rounded-[18px] border border-white/90 bg-[radial-gradient(circle_at_20%_20%,rgba(255,102,196,.42),transparent_28%),radial-gradient(circle_at_82%_18%,rgba(84,200,255,.38),transparent_30%),radial-gradient(circle_at_60%_82%,rgba(94,234,212,.4),transparent_34%),linear-gradient(135deg,#fff,#fff5fd_46%,#effcff)] shadow-candy">
      <div className="grid gap-3 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/75 text-pink-500 shadow-lg shadow-pink-300/20">
          {workflow === "youtube_clips" ? <Youtube className="h-6 w-6" /> : <Sparkles className="h-6 w-6" />}
        </div>
        <div>
          <p className="text-sm font-semibold text-[#392545]">Your video artifacts appear here</p>
          <p className="mt-1 text-xs text-[#7c6688]">Scripts, voiceover, clips, images, and the final edit share this canvas.</p>
        </div>
      </div>
    </div>
  );
}

function ArtifactStrip({
  artifacts,
  onSelect,
  selectedId,
  workflow,
}: {
  artifacts: CreativeArtifact[];
  onSelect: (artifactId: string) => void;
  selectedId: string | null;
  workflow: WorkflowMode;
}) {
  if (artifacts.length === 0) {
    return (
      <div className="border-t border-[#875caa24] bg-white/45 p-3 text-xs text-[#7c6688]">
        {workflow === "youtube_clips"
          ? "Script, voiceover, source clips, and the final video will collect here."
          : "Generated images, audio, scene clips, and the final video will collect here."}
      </div>
    );
  }

  return (
    <div className="custom-scrollbar flex gap-2 overflow-x-auto border-t border-[#875caa24] bg-white/45 p-3">
      {artifacts.map((artifact, index) => (
        <button
          key={artifact.id}
          type="button"
          onClick={() => onSelect(artifact.id)}
          className={`w-28 shrink-0 overflow-hidden rounded-xl border text-left shadow-sm transition ${
            selectedId === artifact.id ? "border-pink-300 bg-white shadow-candy" : "border-white/90 bg-white/75 hover:-translate-y-0.5 hover:bg-white"
          }`}
        >
          <div
            className={`grid h-14 place-items-center ${
              [
                "bg-gradient-to-br from-pink-200 to-sky-100",
                "bg-gradient-to-br from-yellow-100 to-pink-200",
                "bg-gradient-to-br from-pink-200 to-violet-200",
                "bg-gradient-to-br from-teal-100 to-white",
                "bg-gradient-to-br from-sky-100 to-pink-100",
              ][index % 5]
            }`}
          >
            {artifact.kind === "image" && (artifact.url || artifact.path) ? (
              <img src={mediaUrl(artifact.url ?? artifact.path)} alt={artifact.label} className="h-full w-full object-cover" />
            ) : (
              <span className="text-[#7c6688]">{iconForArtifact(artifact.kind)}</span>
            )}
          </div>
          <div className="truncate px-2 py-1.5 text-[11px] text-[#7c6688]">{artifact.label}</div>
        </button>
      ))}
    </div>
  );
}

function RunPlanPanel({ steps, workflow }: { steps: WorkflowStep[]; workflow: WorkflowMode }) {
  return (
    <section className="glass-panel h-full overflow-hidden rounded-[14px]">
      <div className="border-b border-[#875caa24] bg-white/55 px-4 py-3">
        <h2 className="text-sm font-bold">Run Plan</h2>
        <p className="mt-0.5 text-xs text-[#7c6688]">{workflowLabel(workflow)} chain</p>
      </div>
      <div className="custom-scrollbar max-h-[calc(100vh-8.5rem)] space-y-3 overflow-y-auto p-4">
        {steps.length === 0 && (
          <div className="rounded-[14px] border border-dashed border-[#875caa47] bg-white/65 p-3 text-xs leading-5 text-[#7c6688]">
            The selected workflow steps will appear after you send a request.
          </div>
        )}
        <div className="space-y-3">
          {steps.map((step, index) => {
            const done = step.status === "succeeded";
            const running = step.status === "running";
            const failed = step.status === "failed";
            return (
              <div key={step.id} className="grid grid-cols-[26px_1fr] gap-2 text-xs">
                <div
                  className={`grid h-6 w-6 place-items-center rounded-full ${
                    done
                      ? "bg-teal-200 text-emerald-800"
                      : running
                        ? "bg-sky-200 text-sky-700"
                        : failed
                          ? "bg-rose-200 text-rose-700"
                          : "bg-white/75 text-[#a08ca9]"
                  }`}
                >
                  {done ? <Check className="h-3.5 w-3.5" /> : running ? <Sparkles className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                </div>
                <div>
                  <div className="font-semibold text-[#382244]">
                    {index + 1}. {step.tool_id.replaceAll("_", " ")}
                  </div>
                  <div className="mt-0.5 leading-5 text-[#7c6688]">{step.error ?? step.summary}</div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
