"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChatWorkspace, type ChatSubmitValues } from "@/components/chat-workspace";
import { YoutubeReviewWorkspace } from "@/components/youtube-review-workspace";
import {
  useCreateProject,
  useCreateYoutubeReviewBatch,
  useLatestYoutubeReviewBatch,
  usePatchProjectTimeline,
  useProject,
  useSaveYoutubeReviewComment,
  useSendProjectMessage,
} from "@/hooks/use-project";
import type { TimelineEditPayload, YouTubeReviewProvider } from "@/lib/types";

type AppMode = "review" | "compose";

export default function HomePage() {
  const [mode, setMode] = useState<AppMode>("compose");
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("project_id");
  });
  const [savingTarget, setSavingTarget] = useState<{ reviewId: string; provider: YouTubeReviewProvider } | null>(null);

  const createProject = useCreateProject();
  const projectId = createProject.data?.project_id ?? loadedProjectId;
  const { data: job, isError: isJobError } = useProject(projectId);
  const sendMessage = useSendProjectMessage(projectId);
  const patchTimeline = usePatchProjectTimeline(projectId);

  const latestBatch = useLatestYoutubeReviewBatch(mode === "review");
  const createBatch = useCreateYoutubeReviewBatch();
  const saveComment = useSaveYoutubeReviewComment(latestBatch.data?.batch_id ?? null);

  const currentJob = job ?? createProject.data ?? null;
  const isBusy =
    createProject.isPending ||
    sendMessage.isPending ||
    patchTimeline.isPending ||
    currentJob?.status === "queued" ||
    currentJob?.status === "running";

  if (isJobError) {
    toast.error("Could not read project status.", { id: "polling-error" });
  }

  const handleCreate = (values: ChatSubmitValues) => {
    setLoadedProjectId(null);
    createProject.mutate(values, {
      onSuccess: () => toast.success("Generation started."),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not start generation."),
    });
  };

  const handleMessage = (message: string) => {
    sendMessage.mutate(
      { message },
      {
        onSuccess: () => toast.success("Message sent to agent."),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Could not send message."),
      },
    );
  };

  const handleTimelineEdit = (payload: TimelineEditPayload) => {
    patchTimeline.mutate(payload, {
      onSuccess: () => toast.success("Timeline updated."),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not update timeline."),
    });
  };

  const handleNewCreate = () => {
    setLoadedProjectId(null);
    if (typeof window !== "undefined" && window.location.search.includes("project_id=")) {
      window.history.replaceState(null, "", window.location.pathname);
    }
    createProject.reset();
    sendMessage.reset();
    patchTimeline.reset();
  };

  const handleCreateBatch = () => {
    createBatch.mutate(undefined, {
      onSuccess: () => toast.success("Review batch started."),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not start review batch."),
    });
  };

  const handleSaveComment = (reviewId: string, provider: YouTubeReviewProvider, comments: string) => {
    setSavingTarget({ reviewId, provider });
    saveComment.mutate(
      { reviewId, provider, comments },
      {
        onSuccess: () => toast.success("Comments saved."),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save comments."),
        onSettled: () => setSavingTarget(null),
      },
    );
  };

  if (mode === "review") {
    return (
      <YoutubeReviewWorkspace
        activeMode={mode}
        batch={createBatch.data ?? latestBatch.data ?? null}
        isBusy={createBatch.isPending}
        isSavingComment={saveComment.isPending}
        onCreateBatch={handleCreateBatch}
        onModeChange={setMode}
        onNewReview={handleCreateBatch}
        onSaveComment={handleSaveComment}
        savingProvider={savingTarget?.provider ?? null}
        savingReviewId={savingTarget?.reviewId ?? null}
      />
    );
  }

  return (
    <ChatWorkspace
      activeMode={mode}
      job={currentJob}
      isBusy={Boolean(isBusy)}
      onCreate={handleCreate}
      onModeChange={setMode}
      onMessage={handleMessage}
      onTimelineEdit={handleTimelineEdit}
      onNewCreate={handleNewCreate}
    />
  );
}
