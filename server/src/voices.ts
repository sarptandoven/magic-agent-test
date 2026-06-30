export type VoiceGender = "female" | "male" | "neutral";

export interface FishAudioVoice {
  key: string;
  reference_id: string;
  gender: VoiceGender;
  style: string;
}

// All verified live against Fish Audio /model (English).
export const FISH_AUDIO_VOICES: Record<string, FishAudioVoice> = {
  sarah:          { key: "sarah",          reference_id: "933563129e564b19a115bedd57b7406a", gender: "female",  style: "young, soft, conversational" },
  jasphina:       { key: "jasphina",       reference_id: "e9b134e4c0b547a3894793be502314f1", gender: "female",  style: "energetic, social-media" },
  ethan:          { key: "ethan",          reference_id: "536d3a5e000945adb7038665781a4aca", gender: "male",    style: "calm, professional narration" },
  energetic_male: { key: "energetic_male", reference_id: "802e3bc2b27e49c2995d23ef70e6ac89", gender: "male",    style: "young, enthusiastic, ad-style" },
  alle:           { key: "alle",           reference_id: "59e9dc1cb20c452584788a2690c80970", gender: "neutral", style: "young, conversational" },
};

export const VOICE_KEYS = Object.keys(FISH_AUDIO_VOICES) as [string, ...string[]]; // for a zod enum later
export const FEMALE_DEFAULT_VOICE = "sarah";
export const MALE_DEFAULT_VOICE = "ethan";

// Resolved reference_ids for the gender defaults. The catalog is typed as an
// open Record (so unknown `plan.voice` lookups are correctly possibly-undefined
// under noUncheckedIndexedAccess); these constants pin the always-present
// defaults so the resolver stays type-safe without non-null assertions.
const FEMALE_DEFAULT_REFERENCE_ID = FISH_AUDIO_VOICES[FEMALE_DEFAULT_VOICE]!.reference_id;
const MALE_DEFAULT_REFERENCE_ID = FISH_AUDIO_VOICES[MALE_DEFAULT_VOICE]!.reference_id;

// Structural input types so this module does NOT depend on the schema.
// (The schema gains the `voice` field in a later task.)
interface VoiceResolvablePlan {
  voice?: string | null;
  visual_bible?: string | null;
  scenes?: Array<{ narration?: string | null; image_prompt?: string | null }>;
}

interface VoiceResolvableCtx {
  fish_audio_reference_id: string;
}

const FEMALE_CUES =
  /\b(she|her|hers|woman|women|female|girl|lady|mother|mom|sister|daughter|actress)\b/gi;
const MALE_CUES =
  /\b(he|him|his|man|men|male|boy|guy|gentleman|father|dad|brother|son|actor)\b/gi;

function countMatches(text: string, re: RegExp): number {
  const matches = text.match(re);
  return matches ? matches.length : 0;
}

export function inferCharacterGender(plan: VoiceResolvablePlan): "female" | "male" | "unknown" {
  const parts: string[] = [];
  if (plan.visual_bible) parts.push(plan.visual_bible);
  for (const scene of plan.scenes ?? []) {
    if (scene.narration) parts.push(scene.narration);
    if (scene.image_prompt) parts.push(scene.image_prompt);
  }
  const text = parts.join(" ");

  const femaleCount = countMatches(text, FEMALE_CUES);
  const maleCount = countMatches(text, MALE_CUES);

  if (femaleCount > maleCount) return "female";
  if (maleCount > femaleCount) return "male";
  return "unknown";
}

export function resolveVoiceReferenceId(
  plan: VoiceResolvablePlan,
  ctx: VoiceResolvableCtx,
): string {
  const inferred = inferCharacterGender(plan);
  const candidate =
    plan.voice && FISH_AUDIO_VOICES[plan.voice] ? FISH_AUDIO_VOICES[plan.voice] : null;

  // Mismatch guard: a gendered candidate that contradicts the inferred gender is
  // overridden with the inferred gender's default. Neutral candidates pass through.
  if (
    candidate &&
    inferred !== "unknown" &&
    (candidate.gender === "female" || candidate.gender === "male") &&
    candidate.gender !== inferred
  ) {
    return inferred === "female" ? FEMALE_DEFAULT_REFERENCE_ID : MALE_DEFAULT_REFERENCE_ID;
  }

  if (candidate) return candidate.reference_id;

  if (inferred === "female") return FEMALE_DEFAULT_REFERENCE_ID;
  if (inferred === "male") return MALE_DEFAULT_REFERENCE_ID;

  return ctx.fish_audio_reference_id;
}
