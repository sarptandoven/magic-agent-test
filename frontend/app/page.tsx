"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ChatWorkspace, type ChatSubmitValues } from "@/components/chat-workspace";
import { YoutubeReviewWorkspace } from "@/components/youtube-review-workspace";
import {
  useCreateProject,
  useCreateYoutubeReviewBatch,
  useLatestYoutubeReviewBatch,
  useProject,
  useSaveYoutubeReviewComment,
  useSendProjectMessage,
  useYoutubeReviewBatch,
} from "@/hooks/use-project";
import type { YouTubeReviewProvider } from "@/lib/types";

type AppMode = "review" | "compose";

export default function HomePage() {
  const [mode, setMode] = useState<AppMode>("review");
  const createProject = useCreateProject();
  const projectId = createProject.data?.project_id ?? null;
  const { data: job, isError: isJobError } = useProject(projectId);
  const sendMessage = useSendProjectMessage(projectId);
  const createReviewBatch = useCreateYoutubeReviewBatch();
  const { data: latestReviewBatch } = useLatestYoutubeReviewBatch();
  const activeBatchId = createReviewBatch.data?.batch_id ?? latestReviewBatch?.batch_id ?? null;
  const { data: reviewBatch, isError: isReviewError } = useYoutubeReviewBatch(activeBatchId);
  const currentReviewBatch = reviewBatch ?? createReviewBatch.data ?? latestReviewBatch ?? null;
  const saveReviewComment = useSaveYoutubeReviewComment(currentReviewBatch?.batch_id);

  const currentJob = job ?? createProject.data ?? null;
  const isBusy =
    createProject.isPending ||
    sendMessage.isPending ||
    currentJob?.status === "queued" ||
    currentJob?.status === "running";
  const isReviewBusy =
    createReviewBatch.isPending ||
    (currentReviewBatch?.items ?? []).some((item) =>
      Object.values(item.review?.providers ?? {}).some(
        (provider) => provider.status?.status === "queued" || provider.status?.status === "running",
      ),
    );

  if (isJobError) {
    toast.error("Could not read project status.", { id: "polling-error" });
  }
  if (isReviewError) {
    toast.error("Could not read review status.", { id: "review-polling-error" });
  }

  const handleCreate = (values: ChatSubmitValues) => {
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

  const handleNewCreate = () => {
    createProject.reset();
    sendMessage.reset();
  };

  const handleCreateReviewBatch = () => {
    createReviewBatch.mutate(undefined, {
      onSuccess: () => toast.success("Fresh prompt set started."),
      onError: (error) => toast.error(error instanceof Error ? error.message : "Could not start prompt set."),
    });
  };

  const handleSaveReviewComment = (reviewId: string, provider: YouTubeReviewProvider, comments: string) => {
    saveReviewComment.mutate(
      { reviewId, provider, comments },
      {
        onSuccess: () => toast.success("Comments saved."),
        onError: (error) => toast.error(error instanceof Error ? error.message : "Could not save comments."),
      },
    );
  };

  const handleNewReview = () => {
    createReviewBatch.reset();
    saveReviewComment.reset();
  };

  if (mode === "review") {
    return (
      <YoutubeReviewWorkspace
        activeMode={mode}
        isBusy={Boolean(isReviewBusy)}
        isSavingComment={saveReviewComment.isPending}
        onCreateBatch={handleCreateReviewBatch}
        onModeChange={setMode}
        onNewReview={handleNewReview}
        onSaveComment={handleSaveReviewComment}
        savingProvider={saveReviewComment.variables?.provider ?? null}
        savingReviewId={saveReviewComment.variables?.reviewId ?? null}
        batch={currentReviewBatch}
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
      onNewCreate={handleNewCreate}
    />
  );
}
