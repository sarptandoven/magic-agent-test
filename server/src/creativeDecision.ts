import type { ProjectContext } from "./context.js";
import {
  MAGIC_VIDEO_MODEL_DURATIONS,
  type CreateProjectRequest,
  type VideoPlan,
} from "./schemas.js";

export type CreativeFormat =
  | "ugc"
  | "product_demo"
  | "problem_solution"
  | "testimonial"
  | "founder_story"
  | "comparison"
  | "cinematic_ad"
  | "tutorial"
  | "youtube_clips";
export type CreativePlatform = "tiktok" | "reels" | "shorts" | "web" | "general";
export type CreativeGoal = "awareness" | "conversion" | "education" | "product_proof" | "story" | "edit";
export type CreativeSpeechMode = "quoted_user_speech" | "inferred_creator_dialogue" | "voiceover" | "mostly_visual";
export type RequiredBeat = "hook" | "creator_reaction" | "product_proof" | "broll_demo" | "payoff_cta";

export interface CreativeIntent {
  format: CreativeFormat;
  platform: CreativePlatform;
  goal: CreativeGoal;
  speech_mode: CreativeSpeechMode;
  required_beats: RequiredBeat[];
  pacing: {
    preferred_scene_count: number;
    min_scene_seconds: number;
    ideal_min_scene_seconds: number;
    ideal_max_scene_seconds: number;
  };
  video_model: string;
  notes: string[];
}

const QUOTED_SPEECH = /["“”'][^"“”'\n]{4,}["“”']/;
const CREATOR_STYLE = /\b(ugc|tiktok|reel|shorts?|testimonial|founder|day[- ]?in[- ]?life|normal person|creator|influencer|selfie|talking to camera)\b/i;
const PRODUCT = /\b(product|demo|ad|commercial|launch|brand|bottle|lamp|app|tool|software|feature|close[- ]?ups?)\b/i;
const PROBLEM_SOLUTION = /\b(problem|annoying|struggle|forget|pain|before|after|then show|helps?|fix(?:es)?|solution|instead)\b/i;
const COMPARISON = /\b(compare|comparison|versus|vs\.?|before and after|instead of|old way|new way)\b/i;
const TUTORIAL = /\b(tutorial|how to|step[- ]?by[- ]?step|walkthrough|teach|explain how)\b/i;
const FOUNDER = /\b(founder|startup|our story|why we built|behind the scenes)\b/i;
const TESTIMONIAL = /\b(testimonial|review|customer|i tried|my experience|honest take)\b/i;
const CINEMATIC = /\b(cinematic|polished|commercial|story commercial|brand film|dramatic|hero shot)\b/i;
const VISUAL_DIRECTION = /\b(show|include|close[- ]?ups?|caption|captions|subtitles?|b[- ]?roll|camera|scene|shot|visual|reveal)\b/i;
const CTA = /\b(cta|call to action|buy|try|download|visit|sign up|shop|order|grab|get one|get yours|today|now)\b/i;
const PROOF = /\b(proof|demo|use|using|close[- ]?up|feature|setting|before|after|result|screen|charging|brightness|reminds?|tracks?|workflow)\b/i;
const PAYOFF = /\b(payoff|result|reveal|ending|final|better|focused|empty|solves?|transforms?|finish|complete|strong ending)\b/i;
const RISKY_VIDEO_PROMPT = /\b(cut to|new scene|new location|suddenly|transforms?|appears|disappears|caption|subtitle|text overlay|logo appears)\b/i;
const LEAKY_NARRATION =
  /\b(camera|wide shot|close[- ]?up|b[- ]?roll|subtitle|caption|text overlay|scene shows|image prompt|video prompt|cut to|include|show a|show the)\b/i;
const SCHEMA_LEAK = /\b(scene_\d+|json|schema|visual_bible|image_prompt|video_prompt|duration_seconds|on_camera|required beats?)\b/i;

function uniqueBeats(beats: RequiredBeat[]): RequiredBeat[] {
  return [...new Set(beats)];
}

function textFor(request: CreateProjectRequest): string {
  return request.prompt.toLowerCase();
}

export function inferCreativeIntent(request: CreateProjectRequest, ctx: ProjectContext): CreativeIntent {
  const text = textFor(request);
  const workflow = request.workflow;
  let format: CreativeFormat = "ugc";
  if (workflow === "youtube_clips") format = "youtube_clips";
  else if (FOUNDER.test(text)) format = "founder_story";
  else if (TESTIMONIAL.test(text)) format = "testimonial";
  else if (CREATOR_STYLE.test(text)) format = "ugc";
  else if (COMPARISON.test(text)) format = "comparison";
  else if (TUTORIAL.test(text)) format = "tutorial";
  else if (PROBLEM_SOLUTION.test(text) && PRODUCT.test(text)) format = "problem_solution";
  else if (CINEMATIC.test(text) && !CREATOR_STYLE.test(text)) format = "cinematic_ad";
  else if (PRODUCT.test(text) && !CREATOR_STYLE.test(text)) format = "product_demo";

  const platform: CreativePlatform = /\btiktok\b/i.test(text)
    ? "tiktok"
    : /\breels?\b|instagram/i.test(text)
      ? "reels"
      : /\bshorts?|youtube/i.test(text)
        ? "shorts"
        : /\bwebsite|landing page|web\b/i.test(text)
          ? "web"
          : "general";

  const goal: CreativeGoal = /\b(edit|change|replace|regenerate|trim|speed up|slow down)\b/i.test(text)
    ? "edit"
    : CTA.test(text) || /\b(ad|commercial|strong ending)\b/i.test(text)
      ? "conversion"
      : TUTORIAL.test(text)
        ? "education"
        : PROOF.test(text) || PRODUCT.test(text)
          ? "product_proof"
          : CINEMATIC.test(text)
            ? "story"
            : "awareness";

  const speech_mode: CreativeSpeechMode = QUOTED_SPEECH.test(request.prompt)
    ? "quoted_user_speech"
    : VISUAL_DIRECTION.test(text) && !CREATOR_STYLE.test(text) && !/\bsay|voice|talk|speaking\b/i.test(text)
        ? "mostly_visual"
        : format === "cinematic_ad" && !CREATOR_STYLE.test(text)
          ? "voiceover"
          : "inferred_creator_dialogue";

  const required_beats = uniqueBeats([
    "hook",
    ...(CREATOR_STYLE.test(text) || ["ugc", "testimonial", "founder_story"].includes(format)
      ? (["creator_reaction"] as RequiredBeat[])
      : []),
    ...(PRODUCT.test(text) || ["product_demo", "problem_solution", "comparison", "cinematic_ad"].includes(format)
      ? (["product_proof", "payoff_cta"] as RequiredBeat[])
      : []),
    ...(format === "problem_solution" || format === "product_demo" || format === "comparison"
      ? (["broll_demo"] as RequiredBeat[])
      : []),
  ]);

  const duration = request.duration_seconds ?? 30;
  const preferredSceneCount = request.scene_count ?? (duration >= 50 ? 5 : duration >= 36 ? 4 : 3);
  return {
    format,
    platform,
    goal,
    speech_mode,
    required_beats,
    pacing: {
      preferred_scene_count: Math.max(1, Math.min(10, preferredSceneCount)),
      min_scene_seconds: duration >= 24 ? 5 : 3,
      ideal_min_scene_seconds: duration >= 30 ? 7 : 5,
      ideal_max_scene_seconds: duration >= 30 ? 13 : 10,
    },
    video_model: ctx.video_model,
    notes: [
      `Use ${ctx.image_model} for stills unless a selected model overrides it.`,
      `Use ${ctx.video_model} duration limits for b-roll I2V scenes.`,
    ],
  };
}

export function creativeIntentBrief(intent: CreativeIntent): string {
  return [
    "Creative intent profile:",
    `- Format intent: ${intent.format}`,
    `- Platform intent: ${intent.platform}`,
    `- Goal intent: ${intent.goal}`,
    `- Speech interpretation: ${intent.speech_mode}`,
    `- Required first-run beats: ${intent.required_beats.join(", ") || "none"}`,
    `- Pacing target: about ${intent.pacing.preferred_scene_count} scene(s), ideally ${intent.pacing.ideal_min_scene_seconds}-${intent.pacing.ideal_max_scene_seconds}s each when constraints allow.`,
    "- Provider-cost rule: fix objective plan issues before provider calls; do not depend on post-render subjective reruns.",
  ].join("\n");
}

function planText(plan: VideoPlan): string {
  return [plan.title, plan.narration, plan.visual_bible, ...plan.scenes.flatMap((scene) => [
    scene.narration,
    scene.image_prompt,
    scene.video_prompt,
  ])].join(" ");
}

export function validatePlanForCreativeIntent(
  plan: VideoPlan,
  intent: CreativeIntent,
  request: CreateProjectRequest,
): string[] {
  const issues: string[] = [];
  const combined = planText(plan);
  const finalSeconds = request.duration_seconds ?? plan.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0);
  const supportedDurations = MAGIC_VIDEO_MODEL_DURATIONS[intent.video_model];

  for (const scene of plan.scenes) {
    if (LEAKY_NARRATION.test(scene.narration) || SCHEMA_LEAK.test(scene.narration)) {
      issues.push(`${scene.id} spoken narration contains visual directions or schema words.`);
    }
    if (scene.on_camera !== true && supportedDurations && !supportedDurations.has(scene.duration_seconds)) {
      issues.push(`${scene.id} b-roll duration ${scene.duration_seconds}s is not supported by the selected I2V model.`);
    }
    if (RISKY_VIDEO_PROMPT.test(scene.video_prompt)) {
      issues.push(`${scene.id} video prompt asks for cuts, text, new objects, scene changes, or ungrounded motion.`);
    }
  }

  if (intent.required_beats.includes("creator_reaction") && !plan.scenes.some((scene) => scene.on_camera === true)) {
    issues.push("The inferred UGC/testimonial/founder format requires at least one on-camera creator/reaction beat.");
  }
  if (intent.required_beats.includes("product_proof")) {
    if (!plan.scenes.some((scene) => PROOF.test(`${scene.image_prompt} ${scene.video_prompt}`))) {
      issues.push("The inferred product/commercial goal requires visible product proof, demo, feature, screen, or result action.");
    }
    if (plan.scenes.every((scene) => scene.on_camera === true) && plan.scenes.length >= 3) {
      issues.push("Product-oriented plans need at least one product proof or b-roll/demo scene, not only talking-head scenes.");
    }
  }
  if (intent.required_beats.includes("payoff_cta")) {
    const ending = plan.scenes
      .slice(Math.max(0, plan.scenes.length - 2))
      .map((scene) => `${scene.narration} ${scene.image_prompt} ${scene.video_prompt}`)
      .join(" ");
    if (!PAYOFF.test(ending) && !CTA.test(ending)) {
      issues.push("The inferred product/commercial goal requires a final payoff, result reveal, or CTA.");
    }
  }
  if (finalSeconds >= 30 && plan.scenes.length > 1) {
    const average = plan.scenes.reduce((sum, scene) => sum + scene.duration_seconds, 0) / plan.scenes.length;
    if (average < intent.pacing.min_scene_seconds) {
      issues.push("Scene pacing is too fragmented for the requested runtime; use fewer stronger scenes.");
    }
  }
  if (intent.speech_mode !== "quoted_user_speech" && SCHEMA_LEAK.test(combined)) {
    issues.push("The plan contains schema or implementation terms that must never reach provider prompts or narration.");
  }
  return issues;
}
