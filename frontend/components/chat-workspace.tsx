"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  Bot,
  BrainCircuit,
  Check,
  ChevronDown,
  Clock,
  FileText,
  ImageIcon,
  ListChecks,
  Loader2,
  Music,
  MoveHorizontal,
  Plus,
  Scissors,
  Send,
  Settings2,
  Sparkles,
  TimerReset,
  Video,
  Wrench,
  Youtube,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useProjectEvents } from "@/hooks/use-project-events";
import {
  buildClarifyingQuestions,
  composeClarifiedPrompt,
  type ClarifyingAnswer,
  type ClarifyingOption,
  type ClarifyingQuestion,
} from "@/lib/clarifying-questions";
import { mediaUrl } from "@/lib/api";
import type {
  CreateProjectPayload,
  MagicImageModel,
  MagicImageResolution,
  MagicVideoModel,
  ProjectActivityEvent,
  ProjectStatusResponse,
  TimelineArtifact,
  TimelineClip,
  TimelineEditPayload,
  WorkflowMode,
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

type ClarificationSession = {
  prompt: string;
  workflow: WorkflowMode;
  questions: ClarifyingQuestion[];
  questionIndex: number;
  answers: ClarifyingAnswer[];
  customAnswer: string;
  customMode: boolean;
  review: boolean;
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
  onTimelineEdit,
}: {
  activeMode?: AppMode;
  job: ProjectStatusResponse | null;
  isBusy: boolean;
  onCreate: (values: ChatSubmitValues) => void;
  onModeChange?: (mode: AppMode) => void;
  onMessage: (message: string) => void;
  onNewCreate: () => void;
  onTimelineEdit: (payload: TimelineEditPayload) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [localPrompt, setLocalPrompt] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<WorkflowMode>("generated");
  const [clarificationSession, setClarificationSession] = useState<ClarificationSession | null>(null);
  const [duration, setDuration] = useState<AutoNumber>("auto");
  const [sceneCount, setSceneCount] = useState<AutoNumber>("auto");
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>("9:16");
  const [resolution, setResolution] = useState<(typeof VIDEO_RESOLUTIONS)[number]>("720p");
  const [imageModel, setImageModel] = useState<ImageModelSelection>("seedream-v4");
  const [imageResolution, setImageResolution] = useState<MagicImageResolution>("1k");
  const [videoModel, setVideoModel] = useState<VideoModelSelection>("ltx-2.3");
  const [videoResolution, setVideoResolution] = useState<(typeof VIDEO_RESOLUTIONS)[number]>("720p");

  const { events, connected } = useProjectEvents(job?.project_id ?? null);
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
    setClarificationSession(null);
    onNewCreate();
  };

  const createInitialProject = (projectPrompt: string, projectWorkflow: WorkflowMode) => {
    setLocalPrompt(projectPrompt);
    setSelectedArtifactId(null);
    onCreate({
      prompt: projectPrompt,
      workflow: projectWorkflow,
      duration_seconds: duration === "auto" ? null : duration,
      scene_count: sceneCount === "auto" ? null : sceneCount,
      aspect_ratio: aspectRatio,
      resolution,
      image_model: projectWorkflow === "generated" && imageModel !== "auto" ? imageModel : null,
      image_resolution: projectWorkflow === "generated" ? imageResolution : null,
      video_model: projectWorkflow === "generated" && videoModel !== "auto" ? videoModel : null,
      video_resolution: projectWorkflow === "generated" ? videoResolution : null,
      youtube_search_provider: "youtube_data_api",
    });
    setPrompt("");
    setClarificationSession(null);
  };

  const submitInitial = () => {
    const cleaned = prompt.trim();
    if (!cleaned || isBusy) return;
    setClarificationSession({
      prompt: cleaned,
      workflow,
      questions: buildClarifyingQuestions(workflow),
      questionIndex: 0,
      answers: [],
      customAnswer: "",
      customMode: false,
      review: false,
    });
  };

  const answerClarification = (option: ClarifyingOption) => {
    setClarificationSession((session) => {
      if (!session) return session;
      const question = session.questions[session.questionIndex];
      const answers = [
        ...session.answers.filter((answer) => answer.questionId !== question.id),
        { questionId: question.id, label: option.label, value: option.value },
      ];
      const isLastQuestion = session.questionIndex >= session.questions.length - 1;
      return {
        ...session,
        answers,
        questionIndex: isLastQuestion ? session.questionIndex : session.questionIndex + 1,
        customAnswer: "",
        customMode: false,
        review: isLastQuestion,
      };
    });
  };

  const useCustomClarificationAnswer = () => {
    const cleaned = clarificationSession?.customAnswer.trim();
    if (!cleaned) return;
    answerClarification({
      id: "custom",
      label: "Something else",
      summary: "",
      value: cleaned,
    });
  };

  const goBackClarification = () => {
    setClarificationSession((session) => {
      if (!session) return session;
      if (session.review) {
        return { ...session, review: false, customAnswer: "", customMode: false };
      }
      return {
        ...session,
        questionIndex: Math.max(0, session.questionIndex - 1),
        customAnswer: "",
        customMode: false,
      };
    });
  };

  const startClarifiedProject = () => {
    if (!clarificationSession || isBusy) return;
    const projectPrompt = composeClarifiedPrompt(
      clarificationSession.prompt,
      clarificationSession.questions,
      clarificationSession.answers,
    );
    createInitialProject(projectPrompt, clarificationSession.workflow);
  };

  const skipClarification = () => {
    if (!clarificationSession || isBusy) return;
    createInitialProject(clarificationSession.prompt, clarificationSession.workflow);
  };

  const submitFollowUp = () => {
    const cleaned = followUp.trim();
    if (!cleaned || !canSendFollowUp) return;
    onMessage(cleaned);
    setFollowUp("");
  };

  return (
    <main className="min-h-screen bg-workspace-grid text-slate-900 selection:bg-slate-300/60 selection:text-slate-950">
      <header className="flex h-16 items-center justify-between border-b border-slate-200/80 bg-white/88 px-5 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand-mark text-xs font-extrabold text-white shadow-soft-panel">
            VA
          </div>
          <div>
            <h1 className="text-sm font-bold">Local Video Composer</h1>
            <p className="text-xs text-slate-500">OpenAI agent plus Magic Hour renders</p>
          </div>
        </div>
        <div className="hidden items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3 py-1 text-xs text-slate-700 shadow-sm sm:flex">
          {activeWorkflow === "youtube_clips" ? <Youtube className="h-3.5 w-3.5 text-red-600" /> : <Sparkles className="h-3.5 w-3.5 text-slate-600" />}
          {activeWorkflowMeta.label}
        </div>
        <div className="flex items-center gap-2">
          {onModeChange && (
            <div className="grid grid-cols-2 rounded-full border border-slate-200 bg-white/80 p-1 text-xs font-bold text-slate-500">
              {(["review", "compose"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => onModeChange(mode)}
                  className={`h-8 rounded-full px-3 transition ${
                    activeMode === mode ? "bg-slate-900 text-white shadow-sm" : "hover:bg-white"
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
            className="gap-1.5 border-slate-200 bg-white/80 text-slate-700 hover:bg-white"
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
          clarificationSession={clarificationSession}
          duration={duration}
          followUp={followUp}
          imageModel={imageModel}
          imageResolution={imageResolution}
          isBusy={isBusy}
          messages={state?.messages ?? []}
          onCancelClarification={() => setClarificationSession(null)}
          onClarificationAnswer={answerClarification}
          onClarificationBack={goBackClarification}
          onClarificationCustomAnswerChange={(value) =>
            setClarificationSession((session) => (session ? { ...session, customAnswer: value } : session))
          }
          onClarificationCustomModeChange={(value) =>
            setClarificationSession((session) =>
              session ? { ...session, customMode: value, customAnswer: value ? session.customAnswer : "" } : session,
            )
          }
          onDurationChange={setDuration}
          onFollowUpChange={setFollowUp}
          onStartClarifiedProject={startClarifiedProject}
          onImageModelChange={setImageModel}
          onImageResolutionChange={setImageResolution}
          onPromptChange={setPrompt}
          onResolutionChange={setResolution}
          onSceneCountChange={setSceneCount}
          onSkipClarification={skipClarification}
          onSubmitFollowUp={submitFollowUp}
          onSubmitInitial={submitInitial}
          onToggleSettings={() => setShowSettings((value) => !value)}
          onUseCustomClarificationAnswer={useCustomClarificationAnswer}
          onVideoModelChange={setVideoModel}
          onVideoResolutionChange={setVideoResolution}
          onWorkflowChange={setWorkflow}
          prompt={prompt}
          resolution={resolution}
          sceneCount={sceneCount}
          selectedWorkflow={workflow}
          showSettings={showSettings}
          videoModel={videoModel}
          videoResolution={videoResolution}
          aspectRatio={aspectRatio}
          onAspectRatioChange={setAspectRatio}
          hasProject={Boolean(job?.project_id)}
        />

        <section className="glass-panel grid min-h-0 grid-rows-[minmax(0,1fr)_260px] overflow-hidden rounded-[14px]">
          <ArtifactCanvas artifact={selected} status={state?.status ?? null} steps={state?.workflow_steps ?? []} workflow={activeWorkflow} />
          <SceneTimeline
            artifacts={state?.artifacts ?? []}
            disabled={isBusy}
            job={job}
            onSelect={setSelectedArtifactId}
            onTimelineEdit={onTimelineEdit}
            selectedId={selected?.id ?? null}
            workflow={activeWorkflow}
          />
        </section>

        <aside className="min-h-0 max-lg:hidden">
          <RunPanel
            connected={connected}
            events={events}
            steps={state?.workflow_steps ?? []}
            workflow={activeWorkflow}
          />
        </aside>
      </div>
    </main>
  );
}

function ConversationPanel({
  activeWorkflow,
  aspectRatio,
  canSendFollowUp,
  clarificationSession,
  duration,
  followUp,
  hasProject,
  imageModel,
  imageResolution,
  isBusy,
  messages,
  onAspectRatioChange,
  onCancelClarification,
  onClarificationAnswer,
  onClarificationBack,
  onClarificationCustomAnswerChange,
  onClarificationCustomModeChange,
  onDurationChange,
  onFollowUpChange,
  onImageModelChange,
  onImageResolutionChange,
  onPromptChange,
  onResolutionChange,
  onSceneCountChange,
  onSkipClarification,
  onStartClarifiedProject,
  onSubmitFollowUp,
  onSubmitInitial,
  onToggleSettings,
  onUseCustomClarificationAnswer,
  onVideoModelChange,
  onVideoResolutionChange,
  onWorkflowChange,
  prompt,
  resolution,
  sceneCount,
  selectedWorkflow,
  showSettings,
  videoModel,
  videoResolution,
}: {
  activeWorkflow: WorkflowMode;
  aspectRatio: (typeof ASPECT_RATIOS)[number];
  canSendFollowUp: boolean;
  clarificationSession: ClarificationSession | null;
  duration: AutoNumber;
  followUp: string;
  hasProject: boolean;
  imageModel: ImageModelSelection;
  imageResolution: MagicImageResolution;
  isBusy: boolean;
  messages: CreativeState["messages"];
  onAspectRatioChange: (value: (typeof ASPECT_RATIOS)[number]) => void;
  onCancelClarification: () => void;
  onClarificationAnswer: (option: ClarifyingOption) => void;
  onClarificationBack: () => void;
  onClarificationCustomAnswerChange: (value: string) => void;
  onClarificationCustomModeChange: (value: boolean) => void;
  onDurationChange: (value: AutoNumber) => void;
  onFollowUpChange: (value: string) => void;
  onImageModelChange: (value: ImageModelSelection) => void;
  onImageResolutionChange: (value: MagicImageResolution) => void;
  onPromptChange: (value: string) => void;
  onResolutionChange: (value: (typeof VIDEO_RESOLUTIONS)[number]) => void;
  onSceneCountChange: (value: AutoNumber) => void;
  onSkipClarification: () => void;
  onStartClarifiedProject: () => void;
  onSubmitFollowUp: () => void;
  onSubmitInitial: () => void;
  onToggleSettings: () => void;
  onUseCustomClarificationAnswer: () => void;
  onVideoModelChange: (value: VideoModelSelection) => void;
  onVideoResolutionChange: (value: (typeof VIDEO_RESOLUTIONS)[number]) => void;
  onWorkflowChange: (value: WorkflowMode) => void;
  prompt: string;
  resolution: (typeof VIDEO_RESOLUTIONS)[number];
  sceneCount: AutoNumber;
  selectedWorkflow: WorkflowMode;
  showSettings: boolean;
  videoModel: VideoModelSelection;
  videoResolution: (typeof VIDEO_RESOLUTIONS)[number];
}) {
  const visibleWorkflow = hasProject ? activeWorkflow : selectedWorkflow;
  return (
    <section className="glass-panel grid min-h-0 grid-rows-[auto_1fr_auto] overflow-hidden rounded-[14px]">
      <div className="flex items-center justify-between border-b border-slate-200 bg-white/70 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold">Conversation</h2>
          <p className="mt-0.5 text-xs text-slate-500">Choose a workflow and describe the video</p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-100 px-2 py-1 text-[11px] text-slate-700">
          <Wrench className="h-3 w-3" />
          local agent
        </span>
      </div>

      <div className="custom-scrollbar min-h-0 space-y-4 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <>
            <div className="max-w-[92%] rounded-[14px] border border-slate-200 bg-white/82 px-3 py-2 text-sm leading-6 text-slate-800">
              Send a short-video brief. The agent can either generate the scenes or build from YouTube source clips.
            </div>
            <div className="rounded-[14px] border border-slate-200 bg-white/70 p-3 text-xs text-slate-600">
              Render status, intermediate assets, and the final output appear across the canvas and run plan.
            </div>
          </>
        ) : (
          messages.map((item, index) => (
            <div
              key={`${item.created_at}-${index}`}
              className={`max-w-[92%] rounded-[14px] px-3 py-2 text-sm leading-6 ${
                item.role === "user"
                  ? "ml-auto bg-slate-900 text-white shadow-lg shadow-slate-300/20"
                  : "border border-slate-200 bg-white/82 text-slate-800"
              }`}
            >
              {item.content}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-slate-200 bg-slate-50/70 p-3">
        {!hasProject ? (
          clarificationSession ? (
            <ClarificationCard
              session={clarificationSession}
              isBusy={isBusy}
              onAnswer={onClarificationAnswer}
              onBack={onClarificationBack}
              onCancel={onCancelClarification}
              onCustomAnswerChange={onClarificationCustomAnswerChange}
              onCustomModeChange={onClarificationCustomModeChange}
              onSkip={onSkipClarification}
              onStart={onStartClarifiedProject}
              onUseCustomAnswer={onUseCustomClarificationAnswer}
            />
          ) : (
            <div className="space-y-3">
            <WorkflowToggle selected={selectedWorkflow} disabled={isBusy} onChange={onWorkflowChange} />
            <div className="grid grid-cols-[1fr_auto] gap-2 rounded-[14px] border border-slate-300 bg-white/92 p-2 shadow-inner">
              <textarea
                value={prompt}
                onChange={(event) => onPromptChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    onSubmitInitial();
                  }
                }}
                className="min-h-[92px] resize-none border-0 bg-transparent px-1 py-1 text-sm text-slate-900 outline-none placeholder:text-slate-400"
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
                className="self-end rounded-xl bg-slate-900 text-white hover:bg-slate-800"
                aria-label="Start generation"
              >
                {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <button
              type="button"
              onClick={onToggleSettings}
              className="flex w-full items-center justify-between rounded-[12px] border border-slate-200 bg-white/80 px-3 py-2 text-xs font-semibold text-slate-700"
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
          )
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-1 rounded-[14px] border border-slate-200 bg-white/80 p-1">
              {WORKFLOWS.map((option) => (
                <div
                  key={option.value}
                  className={`flex h-9 items-center justify-center gap-2 rounded-[10px] text-xs font-bold ${
                    visibleWorkflow === option.value
                      ? "bg-slate-900 text-white shadow-sm"
                      : "text-slate-500"
                  }`}
                >
                  {option.value === "generated" ? <Sparkles className="h-3.5 w-3.5" /> : <Youtube className="h-3.5 w-3.5" />}
                  {option.label}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2 rounded-[14px] border border-slate-300 bg-white/92 p-2 shadow-inner">
              <textarea
                value={followUp}
                onChange={(event) => onFollowUpChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    onSubmitFollowUp();
                  }
                }}
                className="min-h-[72px] resize-none border-0 bg-transparent px-1 py-1 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                placeholder="Ask for a revision..."
                disabled={!canSendFollowUp}
              />
              <Button
                type="button"
                onClick={onSubmitFollowUp}
                disabled={!followUp.trim() || !canSendFollowUp}
                size="icon"
                className="self-end rounded-xl bg-slate-900 text-white hover:bg-slate-800"
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

function ClarificationCard({
  isBusy,
  onAnswer,
  onBack,
  onCancel,
  onCustomAnswerChange,
  onCustomModeChange,
  onSkip,
  onStart,
  onUseCustomAnswer,
  session,
}: {
  isBusy: boolean;
  onAnswer: (option: ClarifyingOption) => void;
  onBack: () => void;
  onCancel: () => void;
  onCustomAnswerChange: (value: string) => void;
  onCustomModeChange: (value: boolean) => void;
  onSkip: () => void;
  onStart: () => void;
  onUseCustomAnswer: () => void;
  session: ClarificationSession;
}) {
  const question = session.questions[session.questionIndex];
  const progressLabel = `Question ${session.questionIndex + 1} of ${session.questions.length}`;
  const canGoBack = session.review || session.questionIndex > 0;

  if (session.review) {
    return (
      <div className="space-y-3 rounded-[14px] border border-slate-200 bg-white/86 p-3 shadow-inner">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-slate-900 text-white">
            <Check className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-black text-slate-900">Ready to brief the agent</p>
            <p className="mt-1 text-xs leading-5 text-slate-500">I will send the original brief plus these choices.</p>
          </div>
        </div>
        <div className="rounded-[12px] border border-slate-200 bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-700">
          {session.prompt}
        </div>
        <div className="grid gap-2">
          {session.answers.map((answer) => {
            const answerQuestion = session.questions.find((item) => item.id === answer.questionId);
            return (
              <div key={answer.questionId} className="rounded-[12px] border border-slate-200 bg-white px-3 py-2">
                <p className="text-[11px] font-bold uppercase text-slate-500">{answerQuestion?.label ?? answer.label}</p>
                <p className="mt-1 text-xs leading-5 text-slate-800">{answer.value}</p>
              </div>
            );
          })}
        </div>
        <div className="grid grid-cols-[auto_1fr_auto] gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onBack}
            className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          >
            Previous
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          >
            Back to brief
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={onStart}
            disabled={isBusy}
            className="gap-1.5 bg-slate-900 text-white hover:bg-slate-800"
          >
            {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Start
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-[14px] border border-slate-200 bg-white/86 p-3 shadow-inner">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-2">
          <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] bg-slate-900 text-white">
            <BrainCircuit className="h-4 w-4" />
          </div>
          <div>
            <p className="text-[11px] font-bold uppercase text-slate-500">{progressLabel}</p>
            <h3 className="mt-1 text-sm font-black text-slate-900">{question.question}</h3>
            <p className="mt-1 text-xs leading-5 text-slate-500">{question.helper}</p>
          </div>
        </div>
        <button type="button" onClick={onCancel} className="text-[11px] font-bold text-slate-500 hover:text-slate-900">
          Back
        </button>
      </div>

      <div className="grid gap-2">
        {question.options.map((option) => (
          <button
            key={option.id}
            type="button"
            onClick={() => onAnswer(option)}
            disabled={isBusy}
            className="rounded-[12px] border border-slate-200 bg-white px-3 py-2 text-left transition hover:border-slate-400 hover:bg-slate-50 disabled:opacity-50"
          >
            <span className="block text-xs font-black text-slate-900">{option.label}</span>
            <span className="mt-1 block text-[11px] leading-4 text-slate-500">{option.summary}</span>
          </button>
        ))}
      </div>

      {session.customMode ? (
        <div className="space-y-2 rounded-[12px] border border-slate-200 bg-slate-50 p-2">
          <textarea
            value={session.customAnswer}
            onChange={(event) => onCustomAnswerChange(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onUseCustomAnswer();
              }
            }}
            className="min-h-[70px] w-full resize-none rounded-[10px] border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-slate-400"
            placeholder="Type a different answer..."
            disabled={isBusy}
          />
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onCustomModeChange(false)}
              className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
            >
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={onUseCustomAnswer}
              disabled={isBusy || !session.customAnswer.trim()}
              className="bg-slate-900 text-white hover:bg-slate-800"
            >
              Use answer
            </Button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => onCustomModeChange(true)}
          className="w-full rounded-[12px] border border-dashed border-slate-300 bg-white/60 px-3 py-2 text-left text-xs font-bold text-slate-600 hover:border-slate-500 hover:text-slate-900"
        >
          Something else
        </button>
      )}

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onSkip}
          className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
        >
          Skip and start
        </Button>
        {canGoBack && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onBack}
            className="border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          >
            Previous
          </Button>
        )}
      </div>
    </div>
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
    <div className="grid grid-cols-3 gap-1 rounded-[14px] border border-slate-200 bg-white/70 p-1">
      {WORKFLOWS.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          className={`grid min-h-[64px] rounded-[11px] px-3 py-2 text-left transition ${
            selected === option.value
              ? "bg-slate-900 text-white shadow-sm"
              : "text-slate-500 hover:bg-white/85"
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
    <div className="grid gap-2 rounded-[14px] border border-slate-200 bg-white/72 p-3 text-xs sm:grid-cols-2">
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
      <span className="font-semibold text-slate-500">{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 rounded-[10px] border border-slate-200 bg-white/90 px-2 text-slate-800 outline-none focus:border-slate-400"
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
      <span className="font-semibold text-slate-500">{label}</span>
      <select
        value={value === "auto" ? "auto" : String(value)}
        onChange={(event) => onChange(event.target.value === "auto" ? "auto" : Number(event.target.value))}
        className="h-9 rounded-[10px] border border-slate-200 bg-white/90 px-2 text-slate-800 outline-none focus:border-slate-400"
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
      <div className="flex items-center justify-between border-b border-slate-200 bg-white/55 px-4 py-3">
        <div>
          <h2 className="text-sm font-bold">Artifact Canvas</h2>
          <p className="mt-0.5 text-xs text-slate-500">{workflowLabel(workflow)} workflow output</p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-slate-300 bg-white/70 px-3 py-1 text-xs font-semibold text-slate-700">
          {status?.progress ?? 0}%
        </div>
      </div>

      <div className="grid min-h-0 place-items-center bg-[linear-gradient(90deg,rgba(15,23,42,.05)_1px,transparent_1px),linear-gradient(0deg,rgba(15,23,42,.05)_1px,transparent_1px),rgba(248,250,252,.72)] bg-[length:42px_42px] p-4">
        {plan ? (
          <ScriptCanvas plan={plan} workflow={workflow} />
        ) : source ? (
          artifact?.kind === "video" ? (
            <video src={source} controls className="max-h-[66vh] max-w-full rounded-[18px] border border-white/90 bg-white/80 shadow-soft-panel" />
          ) : artifact?.kind === "audio" ? (
            <div className="grid w-[min(84%,620px)] gap-4 rounded-[18px] border border-white/90 bg-white/86 p-5 shadow-soft-panel">
              <div className="flex items-center gap-3 text-slate-800">
                <div className="grid h-12 w-12 place-items-center rounded-2xl bg-slate-100 text-slate-700">
                  <Music className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-bold">{artifact?.label ?? "Audio"}</p>
                  <p className="text-xs text-slate-500">{String(artifact?.metadata?.model ?? "voiceover")}</p>
                </div>
              </div>
              <audio src={source} controls className="w-full" />
            </div>
          ) : (
            <img src={source} alt={artifact?.label ?? "Artifact"} className="max-h-[66vh] max-w-full rounded-[18px] border border-white/90 bg-white/80 object-contain shadow-soft-panel" />
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
    <article className="custom-scrollbar max-h-[66vh] w-full max-w-4xl overflow-y-auto rounded-[18px] border border-white/90 bg-white/86 p-5 shadow-soft-panel">
      <div className="mb-4 flex items-center gap-2 text-xs font-bold uppercase text-slate-700">
        <FileText className="h-4 w-4" />
        {workflow === "youtube_clips" ? "Clip Script" : "Script"}
      </div>
      <h3 className="text-2xl font-black text-slate-900">{plan.title ?? "Untitled video"}</h3>
      {plan.visual_bible && (
        <blockquote className="mt-4 rounded-2xl border-l-4 border-slate-400 bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
          {plan.visual_bible}
        </blockquote>
      )}
      {plan.narration && (
        <section className="mt-5">
          <div className="text-xs font-bold uppercase text-slate-500">Voiceover</div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-slate-800">{plan.narration}</p>
        </section>
      )}
      {!!plan.scenes?.length && (
        <section className="mt-5 grid gap-3">
          <div className="text-xs font-bold uppercase text-slate-500">Scenes</div>
          {plan.scenes.map((scene, index) => (
            <div key={scene.id ?? index} className="rounded-2xl border border-slate-200 bg-white/80 p-4">
              <div className="mb-2 flex items-center justify-between gap-3">
                <div className="text-sm font-bold text-[#382244]">Scene {index + 1}</div>
                {scene.duration_seconds && (
                  <div className="rounded-full bg-sky-100 px-2 py-1 text-[11px] font-semibold text-sky-700">
                    {scene.duration_seconds}s
                  </div>
                )}
              </div>
              {scene.narration && <p className="text-sm leading-6 text-slate-800">{scene.narration}</p>}
              {scene.image_prompt && (
                <details className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
                  <summary className="cursor-pointer font-semibold text-slate-900">Image prompt</summary>
                  <p className="mt-2 leading-5">{scene.image_prompt}</p>
                </details>
              )}
              {scene.video_prompt && (
                <details className="mt-2 rounded-xl bg-sky-50/80 px-3 py-2 text-xs text-slate-600">
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
    <div className="relative grid aspect-[16/10] w-[min(84%,780px)] place-items-center overflow-hidden rounded-[18px] border border-slate-200 bg-slate-100 shadow-soft-panel">
      <div className="absolute inset-x-0 top-0 h-1 bg-slate-900/10" />
      <div className="relative grid max-w-md gap-4 text-center">
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-white/80 text-slate-700 shadow-lg shadow-slate-300/20">
          <Loader2 className="h-7 w-7 animate-spin" />
        </div>
        <div>
          <p className="animate-pulse text-base font-black text-slate-800">{label}</p>
          <p className="mt-2 text-xs leading-5 text-slate-500">{assets}</p>
        </div>
        {status && (
          <div className="mx-auto h-2 w-64 overflow-hidden rounded-full bg-white/70">
            <div className="h-full rounded-full bg-brand-mark transition-all" style={{ width: `${Math.max(4, Math.min(100, status.progress))}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyCanvas({ workflow }: { workflow: WorkflowMode }) {
  return (
    <div className="relative grid aspect-[16/10] w-[min(84%,780px)] place-items-center overflow-hidden rounded-[18px] border border-slate-200 bg-slate-100 shadow-soft-panel">
      <div className="grid gap-3 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-white/75 text-slate-700 shadow-lg shadow-slate-300/20">
          {workflow === "youtube_clips" ? <Youtube className="h-6 w-6" /> : <Sparkles className="h-6 w-6" />}
        </div>
        <div>
          <p className="text-sm font-semibold text-slate-800">Your video artifacts appear here</p>
          <p className="mt-1 text-xs text-slate-500">Scripts, voiceover, clips, images, and the final edit share this canvas.</p>
        </div>
      </div>
    </div>
  );
}

type SceneTimelineEntry = {
  sceneId: string;
  index: number;
  durationSeconds: number | null;
  narration: string | null;
  image: CreativeArtifact | null;
  video: CreativeArtifact | null;
};

function sceneTimelineForJob(job: ProjectStatusResponse | null, artifacts: CreativeArtifact[]): SceneTimelineEntry[] {
  const plan = (job?.manifest?.plan ?? job?.project_state?.current_plan ?? null) as PlanView | null;
  const scenes = plan?.scenes ?? [];
  return scenes.map((scene, index) => {
    const sceneId = scene.id ?? `scene-${index + 1}`;
    const image = artifacts.find((item) => item.kind === "image" && item.metadata?.scene_id === sceneId) ?? null;
    const video = artifacts.find((item) => item.kind === "video" && item.metadata?.scene_id === sceneId) ?? null;
    return {
      sceneId,
      index,
      durationSeconds: scene.duration_seconds ?? null,
      narration: scene.narration ?? null,
      image,
      video,
    };
  });
}

function timelineForJob(job: ProjectStatusResponse | null): TimelineArtifact | null {
  return job?.project_state?.timeline ?? job?.manifest?.timeline ?? null;
}

function secondsLabel(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "--";
  const rounded = Math.round(Number(value) * 10) / 10;
  return `${rounded}s`;
}

function parseSeconds(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timelineTicks(durationSeconds: number): number[] {
  const duration = Math.max(1, durationSeconds);
  const step = duration <= 12 ? 2 : duration <= 30 ? 5 : 10;
  const ticks: number[] = [];
  for (let value = 0; value <= duration + 0.01; value += step) ticks.push(Math.round(value * 10) / 10);
  if (ticks[ticks.length - 1] !== Math.round(duration * 10) / 10) ticks.push(Math.round(duration * 10) / 10);
  return ticks.slice(0, 10);
}

function clipTone(kind: TimelineClip["track"]) {
  if (kind === "video") return "border-sky-300 bg-sky-100 text-sky-900";
  if (kind === "narration") return "border-emerald-300 bg-emerald-100 text-emerald-900";
  return "border-amber-300 bg-amber-100 text-amber-900";
}

function SceneTimeline({
  artifacts,
  disabled,
  job,
  onSelect,
  onTimelineEdit,
  selectedId,
  workflow,
}: {
  artifacts: CreativeArtifact[];
  disabled: boolean;
  job: ProjectStatusResponse | null;
  onSelect: (artifactId: string) => void;
  onTimelineEdit: (payload: TimelineEditPayload) => void;
  selectedId: string | null;
  workflow: WorkflowMode;
}) {
  const scenes = useMemo(() => sceneTimelineForJob(job, artifacts), [artifacts, job]);
  const chips = artifacts.filter((artifact) => ["script", "voiceover", "final-video"].includes(artifact.id));
  const timeline = useMemo(() => timelineForJob(job), [job]);
  const timelineClips = useMemo(() => timeline?.tracks.flatMap((track) => track.clips) ?? [], [timeline]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const selectedClip = timelineClips.find((clip) => clip.id === selectedClipId) ?? timelineClips[0] ?? null;
  const [sourceStart, setSourceStart] = useState("");
  const [sourceEnd, setSourceEnd] = useState("");
  const [timelineStart, setTimelineStart] = useState("");
  const [holdSeconds, setHoldSeconds] = useState("");

  useEffect(() => {
    if (!timelineClips.length) {
      setSelectedClipId(null);
      return;
    }
    if (!selectedClipId || !timelineClips.some((clip) => clip.id === selectedClipId)) {
      setSelectedClipId(timelineClips.find((clip) => clip.track === "video")?.id ?? timelineClips[0]!.id);
    }
  }, [selectedClipId, timelineClips]);

  useEffect(() => {
    if (!selectedClip) return;
    setSourceStart(String(selectedClip.source_start));
    setSourceEnd(String(selectedClip.source_end));
    setTimelineStart(String(selectedClip.timeline_start));
  }, [selectedClip]);

  useEffect(() => {
    if (timeline) setHoldSeconds(String(timeline.ending.hold_seconds));
  }, [timeline]);

  if (artifacts.length === 0) {
    return (
      <div className="border-t border-slate-200 bg-white/45 p-3 text-xs text-slate-500">
        {workflow === "youtube_clips"
          ? "Script, voiceover, source clips, and the final video will collect along this timeline."
          : "Script, voiceover, scene previews, and the final video will collect along this timeline."}
      </div>
    );
  }

  if (timeline) {
    const duration = Math.max(1, timeline.duration_seconds);
    const ticks = timelineTicks(duration);
    const verification = timeline.ending.verification;
    const aligned = verification?.aligned;
    const applyTrim = () => {
      if (!selectedClip || selectedClip.locked) return;
      const start = parseSeconds(sourceStart);
      const end = parseSeconds(sourceEnd);
      onTimelineEdit({
        operation: "trim_clip",
        clip_id: selectedClip.id,
        source_start: start,
        source_end: end,
      });
    };
    const applyMove = () => {
      if (!selectedClip || selectedClip.locked) return;
      const start = parseSeconds(timelineStart);
      if (start === null) return;
      onTimelineEdit({ operation: "move_clip", clip_id: selectedClip.id, timeline_start: start });
    };
    const applyHold = () => {
      const hold = parseSeconds(holdSeconds);
      if (hold === null) return;
      onTimelineEdit({ operation: "set_final_hold", hold_seconds: hold, reason: "UI final hold control." });
    };

    return (
      <div className="grid min-h-0 grid-rows-[auto_1fr] border-t border-slate-200 bg-white/55">
        <div className="flex items-center justify-between gap-2 px-3 pt-2">
          <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto">
            {chips.map((artifact) => (
              <button
                key={artifact.id}
                type="button"
                onClick={() => onSelect(artifact.id)}
                className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
                  selectedId === artifact.id
                    ? "border-slate-400 bg-white text-slate-900 shadow-sm"
                    : "border-slate-200 bg-white/70 text-slate-500 hover:bg-white"
                }`}
              >
                {iconForArtifact(artifact.kind)}
                {artifact.label}
              </button>
            ))}
          </div>
          <div className="shrink-0 text-[11px] font-semibold text-slate-500">{secondsLabel(timeline.duration_seconds)}</div>
        </div>

        <div className="grid min-h-0 gap-3 p-3 md:grid-cols-[minmax(0,1fr)_220px]">
          <div className="min-h-0 overflow-hidden rounded-lg border border-slate-200 bg-white/70">
            <div className="relative ml-24 h-6 border-b border-slate-200 text-[10px] font-semibold text-slate-400">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute top-1"
                  style={{ left: `${Math.min(96, (tick / duration) * 100)}%` }}
                >
                  {secondsLabel(tick)}
                </span>
              ))}
            </div>
            <div className="custom-scrollbar max-h-[180px] overflow-y-auto">
              {timeline.tracks.map((track) => (
                <div key={track.id} className="grid min-h-12 grid-cols-[88px_minmax(0,1fr)] border-b border-slate-100 last:border-b-0">
                  <div className="flex items-center gap-1.5 border-r border-slate-100 px-2 text-[11px] font-bold text-slate-500">
                    {track.kind === "video" ? <Video className="h-3.5 w-3.5" /> : track.kind === "narration" ? <Music className="h-3.5 w-3.5" /> : <TimerReset className="h-3.5 w-3.5" />}
                    <span className="truncate">{track.label}</span>
                  </div>
                  <div className="relative h-12">
                    <div className="absolute inset-y-0 left-0 right-0 bg-[linear-gradient(to_right,rgba(148,163,184,.16)_1px,transparent_1px)] bg-[length:10%_100%]" />
                    {track.clips.map((clip) => {
                      const left = Math.min(96, Math.max(0, (clip.timeline_start / duration) * 100));
                      const width = Math.max(4, ((clip.timeline_end - clip.timeline_start) / duration) * 100);
                      const active = selectedClip?.id === clip.id;
                      return (
                        <button
                          key={clip.id}
                          type="button"
                          onClick={() => setSelectedClipId(clip.id)}
                          title={`${clip.label} ${secondsLabel(clip.timeline_start)}-${secondsLabel(clip.timeline_end)}`}
                          className={`absolute top-2 flex h-8 items-center gap-1 overflow-hidden rounded-md border px-2 text-left text-[11px] font-bold shadow-sm transition ${clipTone(clip.track)} ${
                            active ? "ring-2 ring-slate-500/40" : "hover:brightness-95"
                          }`}
                          style={{ left: `${left}%`, width: `max(42px, ${Math.min(100 - left, width)}%)` }}
                        >
                          <span className="truncate">{clip.label}</span>
                          <span className="ml-auto shrink-0 opacity-70">{secondsLabel(clip.duration)}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="grid min-h-0 content-start gap-2 rounded-lg border border-slate-200 bg-white/75 p-2">
            <div className="min-w-0">
              <p className="truncate text-xs font-black text-slate-800">{selectedClip?.label ?? "Timeline"}</p>
              <p className="mt-0.5 truncate text-[11px] text-slate-500">
                {selectedClip ? `${selectedClip.id} - ${selectedClip.end_behavior}` : secondsLabel(timeline.duration_seconds)}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <label className="grid gap-1 text-[10px] font-bold uppercase text-slate-400">
                Source in
                <input
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-slate-400 disabled:bg-slate-100"
                  disabled={disabled || !selectedClip || selectedClip.locked}
                  inputMode="decimal"
                  onChange={(event) => setSourceStart(event.target.value)}
                  value={sourceStart}
                />
              </label>
              <label className="grid gap-1 text-[10px] font-bold uppercase text-slate-400">
                Source out
                <input
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-slate-400 disabled:bg-slate-100"
                  disabled={disabled || !selectedClip || selectedClip.locked}
                  inputMode="decimal"
                  onChange={(event) => setSourceEnd(event.target.value)}
                  value={sourceEnd}
                />
              </label>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <label className="grid gap-1 text-[10px] font-bold uppercase text-slate-400">
                Timeline start
                <input
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-slate-400 disabled:bg-slate-100"
                  disabled={disabled || !selectedClip || selectedClip.locked}
                  inputMode="decimal"
                  onChange={(event) => setTimelineStart(event.target.value)}
                  value={timelineStart}
                />
              </label>
              <div className="flex items-end gap-1">
                <button
                  type="button"
                  title="Apply trim"
                  onClick={applyTrim}
                  disabled={disabled || !selectedClip || selectedClip.locked}
                  className="grid h-8 w-8 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <Scissors className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  title="Move clip"
                  onClick={applyMove}
                  disabled={disabled || !selectedClip || selectedClip.locked}
                  className="grid h-8 w-8 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <MoveHorizontal className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <label className="grid gap-1 text-[10px] font-bold uppercase text-slate-400">
                Final hold
                <input
                  className="h-8 rounded-md border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-700 outline-none focus:border-slate-400 disabled:bg-slate-100"
                  disabled={disabled}
                  inputMode="decimal"
                  onChange={(event) => setHoldSeconds(event.target.value)}
                  value={holdSeconds}
                />
              </label>
              <button
                type="button"
                title="Set final hold"
                onClick={applyHold}
                disabled={disabled}
                className="mt-5 grid h-8 w-8 place-items-center rounded-md border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-45"
              >
                <TimerReset className="h-3.5 w-3.5" />
              </button>
            </div>
            <div className="flex items-center justify-between rounded-md bg-slate-50 px-2 py-1.5 text-[11px] font-semibold text-slate-500">
              <span>{aligned === false ? "ffprobe mismatch" : aligned === true ? "ffprobe aligned" : "ffprobe pending"}</span>
              <span>{timeline.ending.intentional ? "intentional end" : "no hold"}</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr] border-t border-slate-200 bg-white/45">
      <div className="flex items-center gap-1.5 px-3 pt-2">
        {chips.map((artifact) => (
          <button
            key={artifact.id}
            type="button"
            onClick={() => onSelect(artifact.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition ${
              selectedId === artifact.id
                ? "border-slate-400 bg-white text-slate-900 shadow-sm"
                : "border-slate-200 bg-white/70 text-slate-500 hover:bg-white"
            }`}
          >
            {iconForArtifact(artifact.kind)}
            {artifact.label}
          </button>
        ))}
      </div>
      <div className="custom-scrollbar flex items-stretch gap-2 overflow-x-auto p-3">
        {scenes.length === 0 ? (
          <div className="grid place-items-center px-2 text-xs text-slate-500">Scene previews appear once the plan is drafted.</div>
        ) : (
          scenes.map((scene) => {
            const target = scene.video ?? scene.image;
            const active = target !== null && selectedId === target.id;
            const ready = scene.video !== null;
            const partial = !ready && scene.image !== null;
            return (
              <button
                key={scene.sceneId}
                type="button"
                onClick={() => target && onSelect(target.id)}
                disabled={!target}
                title={scene.narration ?? undefined}
                className={`relative w-32 shrink-0 overflow-hidden rounded-xl border text-left shadow-sm transition ${
                  active
                    ? "border-slate-400 bg-white shadow-soft-panel"
                    : target
                      ? "border-white/90 bg-white/75 hover:-translate-y-0.5 hover:bg-white"
                      : "border-dashed border-slate-300 bg-white/55"
                }`}
              >
                <div className="grid h-16 place-items-center overflow-hidden bg-gradient-to-br from-slate-100 to-slate-200">
                  {scene.image && (scene.image.url || scene.image.path) ? (
                    <img
                      src={mediaUrl(scene.image.url ?? scene.image.path)}
                      alt={`Scene ${scene.index + 1}`}
                      className="h-full w-full object-cover"
                    />
                  ) : ready ? (
                    <Video className="h-4 w-4 text-slate-500" />
                  ) : (
                    <Clock className="h-4 w-4 text-slate-400" />
                  )}
                </div>
                <div className="flex items-center justify-between px-2 py-1.5">
                  <span className="text-[11px] font-bold text-slate-700">Scene {scene.index + 1}</span>
                  <span className="flex items-center gap-1">
                    {scene.durationSeconds != null && (
                      <span className="rounded-full bg-sky-100 px-1.5 text-[10px] font-semibold text-sky-700">
                        {scene.durationSeconds}s
                      </span>
                    )}
                    <span
                      className={`h-2 w-2 rounded-full ${
                        ready ? "bg-emerald-400" : partial ? "bg-amber-400" : "bg-slate-300"
                      }`}
                    />
                  </span>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

function describeActivityEvent(event: ProjectActivityEvent): { icon: JSX.Element; title: string; detail: string | null } {
  if (event.type === "status") {
    return {
      icon: <Activity className="h-3.5 w-3.5" />,
      title: `${event.stage ?? "status"} (${event.progress ?? 0}%)`,
      detail: event.error ?? event.message ?? null,
    };
  }
  switch (event.item_type) {
    case "tool_call_item":
      return {
        icon: <Wrench className="h-3.5 w-3.5" />,
        title: String(event.tool_name ?? "tool").replaceAll("_", " "),
        detail: event.arguments_preview ?? null,
      };
    case "tool_call_output_item":
      return {
        icon: <Check className="h-3.5 w-3.5" />,
        title: `${String(event.tool_name ?? "tool").replaceAll("_", " ")} finished`,
        detail: event.output_preview ?? null,
      };
    case "reasoning_item":
      return {
        icon: <BrainCircuit className="h-3.5 w-3.5" />,
        title: "Thinking",
        detail: event.text || null,
      };
    case "message_output_item":
      return {
        icon: <Bot className="h-3.5 w-3.5" />,
        title: "Agent",
        detail: event.text || null,
      };
    default:
      if (event.event_name === "agent_updated") {
        return {
          icon: <Bot className="h-3.5 w-3.5" />,
          title: `Agent: ${event.agent_name ?? "agent"}`,
          detail: null,
        };
      }
      return {
        icon: <Sparkles className="h-3.5 w-3.5" />,
        title: event.event_name ?? event.item_type ?? "event",
        detail: null,
      };
  }
}

function ActivityFeed({ events }: { events: ProjectActivityEvent[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events.length]);

  if (events.length === 0) {
    return (
      <div className="rounded-[14px] border border-dashed border-slate-300 bg-white/65 p-3 text-xs leading-5 text-slate-500">
        Tool calls, agent messages, and status changes stream here live while the agent works.
      </div>
    );
  }

  return (
    <div ref={containerRef} className="custom-scrollbar min-h-0 space-y-2 overflow-y-auto pr-1">
      {events.map((event) => {
        const { icon, title, detail } = describeActivityEvent(event);
        return (
          <div key={event.id} className="grid grid-cols-[22px_1fr] gap-2 text-xs">
            <div className="mt-0.5 grid h-5 w-5 place-items-center rounded-full bg-white/80 text-slate-500">{icon}</div>
            <div className="min-w-0">
              <div className="truncate font-semibold text-[#382244]">{title}</div>
              {detail && <div className="mt-0.5 break-words font-mono text-[10px] leading-4 text-slate-500">{detail}</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RunPanel({
  connected,
  events,
  steps,
  workflow,
}: {
  connected: boolean;
  events: ProjectActivityEvent[];
  steps: WorkflowStep[];
  workflow: WorkflowMode;
}) {
  const [tab, setTab] = useState<"plan" | "activity">("plan");

  // Jump to the live feed automatically once the first agent event arrives.
  const sawEvents = useRef(false);
  useEffect(() => {
    if (events.length > 0 && !sawEvents.current) {
      sawEvents.current = true;
      setTab("activity");
    }
    if (events.length === 0) sawEvents.current = false;
  }, [events.length]);

  return (
    <section className="glass-panel grid h-full grid-rows-[auto_1fr] overflow-hidden rounded-[14px]">
      <div className="border-b border-slate-200 bg-white/55 px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold">Agent Run</h2>
            <p className="mt-0.5 text-xs text-slate-500">{workflowLabel(workflow)} chain</p>
          </div>
          <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-bold uppercase ${
              connected
                ? "border-emerald-200 bg-teal-100/70 text-emerald-700"
                : "border-slate-200 bg-white/70 text-slate-400"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${connected ? "animate-pulse bg-emerald-500" : "bg-slate-300"}`} />
            {connected ? "live" : "idle"}
          </span>
        </div>
        <div className="mt-2 grid grid-cols-2 rounded-full border border-slate-200 bg-white/70 p-0.5 text-[11px] font-bold text-slate-500">
          {(
            [
              { id: "plan", label: "Run plan", icon: <ListChecks className="h-3 w-3" /> },
              { id: "activity", label: `Activity${events.length ? ` (${events.length})` : ""}`, icon: <Activity className="h-3 w-3" /> },
            ] as const
          ).map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => setTab(option.id)}
              className={`flex h-7 items-center justify-center gap-1.5 rounded-full transition ${
                tab === option.id ? "bg-slate-900 text-white shadow-sm" : "hover:bg-white"
              }`}
            >
              {option.icon}
              {option.label}
            </button>
          ))}
        </div>
      </div>
      <div className="custom-scrollbar min-h-0 overflow-y-auto p-4">
        {tab === "plan" ? (
          <div className="space-y-3">
            {steps.length === 0 && (
              <div className="rounded-[14px] border border-dashed border-slate-300 bg-white/65 p-3 text-xs leading-5 text-slate-500">
                The selected workflow steps will appear after you send a request.
              </div>
            )}
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
                            : "bg-white/75 text-slate-400"
                    }`}
                  >
                    {done ? <Check className="h-3.5 w-3.5" /> : running ? <Sparkles className="h-3.5 w-3.5" /> : <Clock className="h-3.5 w-3.5" />}
                  </div>
                  <div>
                    <div className="font-semibold text-[#382244]">
                      {index + 1}. {step.tool_id.replaceAll("_", " ")}
                    </div>
                    <div className="mt-0.5 leading-5 text-slate-500">{step.error ?? step.summary}</div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <ActivityFeed events={events} />
        )}
      </div>
    </section>
  );
}
