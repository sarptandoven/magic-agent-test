import { describe, it, expect } from "vitest";
import {
  FISH_AUDIO_VOICES,
  FEMALE_DEFAULT_VOICE,
  MALE_DEFAULT_VOICE,
  inferCharacterGender,
  resolveVoiceReferenceId,
} from "../src/voices.js";

const SARAH = FISH_AUDIO_VOICES.sarah!.reference_id;
const ETHAN = FISH_AUDIO_VOICES.ethan!.reference_id;
const JASPHINA = FISH_AUDIO_VOICES.jasphina!.reference_id;
const ALLE = FISH_AUDIO_VOICES.alle!.reference_id;
const ENV_DEFAULT_REF = "ENV_DEFAULT_REF";

const ctx = { fish_audio_reference_id: ENV_DEFAULT_REF };

describe("inferCharacterGender", () => {
  it("detects a clearly-female description", () => {
    expect(
      inferCharacterGender({ visual_bible: "She is a young woman, a confident lady and mother." }),
    ).toBe("female");
  });

  it("detects a clearly-male description", () => {
    expect(
      inferCharacterGender({ visual_bible: "He is a young man, a confident guy and father." }),
    ).toBe("male");
  });

  it("returns unknown when there are no gender words", () => {
    expect(
      inferCharacterGender({ visual_bible: "A cozy kitchen at sunrise with warm tones." }),
    ).toBe("unknown");
  });

  it("returns unknown on a tie", () => {
    expect(inferCharacterGender({ visual_bible: "She and he walk together." })).toBe("unknown");
  });

  it("uses word boundaries (does not match 'he' inside 'the')", () => {
    expect(inferCharacterGender({ visual_bible: "The theme is there." })).toBe("unknown");
  });

  it("scans scenes narration and image_prompt as well as the bible", () => {
    expect(
      inferCharacterGender({
        scenes: [
          { narration: "A woman speaks." },
          { image_prompt: "portrait of a girl, actress" },
        ],
      }),
    ).toBe("female");
  });
});

describe("resolveVoiceReferenceId", () => {
  it("female bible, no voice -> sarah", () => {
    expect(
      resolveVoiceReferenceId({ visual_bible: "She is a woman." }, ctx),
    ).toBe(SARAH);
  });

  it("male bible, no voice -> ethan", () => {
    expect(
      resolveVoiceReferenceId({ visual_bible: "He is a man." }, ctx),
    ).toBe(ETHAN);
  });

  it("voice=jasphina (female) + female bible -> jasphina (candidate honored)", () => {
    expect(
      resolveVoiceReferenceId({ voice: "jasphina", visual_bible: "She is a woman." }, ctx),
    ).toBe(JASPHINA);
  });

  it("voice=ethan (male) + female bible -> overridden to sarah (mismatch guard)", () => {
    expect(
      resolveVoiceReferenceId({ voice: "ethan", visual_bible: "She is a woman." }, ctx),
    ).toBe(SARAH);
  });

  it("voice=alle (neutral) + female bible -> alle (neutral never overridden)", () => {
    expect(
      resolveVoiceReferenceId({ voice: "alle", visual_bible: "She is a woman." }, ctx),
    ).toBe(ALLE);
  });

  it("no voice + ambiguous bible -> env default reference id", () => {
    expect(
      resolveVoiceReferenceId({ visual_bible: "A cozy kitchen at sunrise." }, ctx),
    ).toBe(ENV_DEFAULT_REF);
  });

  it("invalid voice key + male bible -> ethan (gender default)", () => {
    expect(
      resolveVoiceReferenceId({ voice: "bogus", visual_bible: "He is a man." }, ctx),
    ).toBe(ETHAN);
  });
});

describe("catalog constants", () => {
  it("exposes the five curated voices", () => {
    expect(Object.keys(FISH_AUDIO_VOICES).sort()).toEqual(
      ["alle", "energetic_male", "ethan", "jasphina", "sarah"].sort(),
    );
  });

  it("uses sarah/ethan as gender defaults", () => {
    expect(FEMALE_DEFAULT_VOICE).toBe("sarah");
    expect(MALE_DEFAULT_VOICE).toBe("ethan");
  });
});
