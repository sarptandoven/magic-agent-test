export interface ProjectContext {
  project_id: string;
  project_dir: string;
  aspect_ratio: string;
  resolution: string;
  magic_hour_api_key: string;
  fish_audio_api_key: string;
  fish_audio_reference_id: string;
  image_model: string;
  image_resolution: string;
  image_style_tool: string;
  video_model: string;
  video_audio: boolean;
  audio_model: string;
  audio_format: string;
}

export const PROJECT_CONTEXT_DEFAULTS = {
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
} satisfies Partial<ProjectContext>;
