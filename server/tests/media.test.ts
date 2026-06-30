import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { decode as msgpackDecode } from "@msgpack/msgpack";
import { execa } from "execa";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectContext } from "../src/context.js";
import { PROJECT_CONTEXT_DEFAULTS } from "../src/context.js";
import { isTransientProviderError, magicHourPollRequestAttempts, magicHourPollRequestTimeoutMs, probeMediaDuration, probeMediaStreamDurations } from "../src/media.js";
import {
  anyEmbeddedAudio,
  generateSceneVoiceovers,
  stitchAssetsPerSection,
  stitchMixedAssets,
  stitchTimelineAssets,
} from "../src/media.js";
import type { Scene } from "../src/schemas.js";

describe("provider polling guards", () => {
  afterEach(() => {
    delete process.env.MAGIC_HOUR_POLL_REQUEST_TIMEOUT_MS;
    delete process.env.MAGIC_HOUR_POLL_REQUEST_ATTEMPTS;
  });

  it("classifies status codes and network timeouts as transient provider errors", () => {
    expect(isTransientProviderError(Object.assign(new Error("502 was returned"), { status: 502 }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error("socket reset"), { code: "ECONNRESET" }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }))).toBe(true);
    expect(isTransientProviderError(Object.assign(new Error("bad request"), { status: 400 }))).toBe(false);
  });

  it("keeps a bounded per-request timeout and request failure budget", () => {
    process.env.MAGIC_HOUR_POLL_REQUEST_TIMEOUT_MS = "10";
    process.env.MAGIC_HOUR_POLL_REQUEST_ATTEMPTS = "0";
    expect(magicHourPollRequestTimeoutMs()).toBe(5000);
    expect(magicHourPollRequestAttempts()).toBe(1);
  });
});

async function makeSilentVideo(pathname: string, seconds: number) {
  await execa("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=320x180:d=${seconds}:r=30`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    pathname,
  ]);
}

async function makeTone(pathname: string, seconds: number) {
  await execa("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${seconds}`,
    "-c:a",
    "mp3",
    pathname,
  ]);
}

function testContext(projectDir: string): ProjectContext {
  return {
    project_id: "media-duration-test",
    project_dir: projectDir,
    aspect_ratio: "16:9",
    resolution: "720p",
    ...PROJECT_CONTEXT_DEFAULTS,
  };
}

describe("stitchAssetsPerSection", () => {
  it("pads the final video to an explicit target duration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-duration-"));
    const video = path.join(dir, "scene.mp4");
    const audio = path.join(dir, "scene.mp3");
    await makeSilentVideo(video, 1);
    await makeTone(audio, 1);

    const final = await stitchAssetsPerSection(
      testContext(dir),
      [{ video_path: video, audio_path: audio, audio_duration_seconds: 1 }],
      { target_duration_seconds: 3 },
    );

    expect(await probeMediaDuration(final)).toBeGreaterThanOrEqual(2.9);
    expect(await probeMediaDuration(final)).toBeLessThanOrEqual(3.2);
  });
});

function makeScene(overrides: Partial<Scene> & Pick<Scene, "id">): Scene {
  return {
    narration: "",
    image_prompt: "",
    video_prompt: "",
    duration_seconds: 2,
    on_camera: true,
    ...overrides,
  };
}

describe("generateSceneVoiceovers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keys voiceovers by the real scene.id and writes them under voiceover/scenes/", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-"));

    // fishAudioTts POSTs to Fish Audio then probes the written bytes with
    // ffprobe, so the stubbed fetch must return a REAL audio buffer (>=1024
    // bytes, >=0.5s) or the probe step rejects.
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(toneBytes, { status: 200 })),
    );

    const result = await generateSceneVoiceovers(testContext(dir), [
      makeScene({
        id: "scene_7",
        narration: "hello",
        duration_seconds: 2,
        on_camera: true,
      }),
    ]);

    expect(result).toHaveLength(1);
    const [item] = result;
    expect(item!.scene_id).toBe("scene_7");
    expect(item!.path).toContain(path.join("voiceover", "scenes"));
    expect(item!.path.endsWith(`scene_7.${PROJECT_CONTEXT_DEFAULTS.audio_format}`)).toBe(true);
    expect(item!.duration_seconds).toBeGreaterThan(0);
    // The probed duration reflects the real audio buffer we returned (~2s).
    expect(await probeMediaDuration(item!.path)).toBeGreaterThan(0);
  });

  it("throws when a scene has blank narration", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-blank-"));
    await expect(
      generateSceneVoiceovers(testContext(dir), [makeScene({ id: "scene_1", narration: "   " })]),
    ).rejects.toThrow(/No narration for scene/);
  });

  it("sends an explicit referenceId override to Fish Audio", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-ref-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);

    const bodies: Uint8Array[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        bodies.push(new Uint8Array(init.body));
        return new Response(toneBytes, { status: 200 });
      }),
    );

    await generateSceneVoiceovers(
      testContext(dir),
      [makeScene({ id: "scene_1", narration: "hello" })],
      "CUSTOM_REF_123",
    );

    expect(bodies).toHaveLength(1);
    const decoded = msgpackDecode(bodies[0]!) as { reference_id: string };
    expect(decoded.reference_id).toBe("CUSTOM_REF_123");
  });

  it("defaults to the context reference_id when no override is given", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-scene-vo-default-"));
    const tone = path.join(dir, "tone.mp3");
    await makeTone(tone, 2);
    const toneBytes = readFileSync(tone);

    const bodies: Uint8Array[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: any, init: any) => {
        bodies.push(new Uint8Array(init.body));
        return new Response(toneBytes, { status: 200 });
      }),
    );

    const ctx = { ...testContext(dir), fish_audio_reference_id: "ENV_REF_DEFAULT" };
    await generateSceneVoiceovers(ctx, [makeScene({ id: "scene_1", narration: "hello" })]);

    expect(bodies).toHaveLength(1);
    const decoded = msgpackDecode(bodies[0]!) as { reference_id: string };
    expect(decoded.reference_id).toBe("ENV_REF_DEFAULT");
  });
});

describe("anyEmbeddedAudio", () => {
  it("returns true when any video has embedded audio or is on-camera", () => {
    expect(anyEmbeddedAudio([{ has_embedded_audio: true }])).toBe(true);
    expect(anyEmbeddedAudio([{ on_camera: true }])).toBe(true);
  });

  it("returns false for plain b-roll videos", () => {
    expect(anyEmbeddedAudio([{}])).toBe(false);
  });
});

describe("stitchMixedAssets", () => {
  it("concatenates per-section scenes preserving each scene's own audio", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-mixed-"));
    const video1 = path.join(dir, "scene1.mp4");
    const audio1 = path.join(dir, "scene1.mp3");
    const video2 = path.join(dir, "scene2.mp4");
    const audio2 = path.join(dir, "scene2.mp3");
    await makeSilentVideo(video1, 1);
    await makeTone(audio1, 1);
    await makeSilentVideo(video2, 1);
    await makeTone(audio2, 1);

    const final = await stitchMixedAssets(
      testContext(dir),
      [
        { video_path: video1, audio_path: audio1, audio_duration_seconds: 1 },
        { video_path: video2, audio_path: audio2, audio_duration_seconds: 1 },
      ],
      {},
    );

    const streams = await probeMediaStreamDurations(final);
    expect(streams.audio_duration_seconds).not.toBeNull();
    // Two ~1s scenes concatenated -> well over 1.5s total.
    expect(streams.format_duration_seconds).toBeGreaterThan(1.5);
  });
});

describe("stitchTimelineAssets", () => {
  it("pads each timeline clip to its own duration before final mux", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "media-timeline-"));
    const video = path.join(dir, "scene.mp4");
    const audio = path.join(dir, "voiceover.mp3");
    await makeSilentVideo(video, 1);
    await makeTone(audio, 2);

    const final = await stitchTimelineAssets(
      testContext(dir),
      [
        {
          id: "video:scene_1",
          path: video,
          source_start: 0,
          source_end: 1,
          timeline_start: 0,
          timeline_end: 2,
          duration: 2,
        },
      ],
      { path: audio },
      { target_duration_seconds: 2 },
    );

    expect(await probeMediaDuration(final)).toBeGreaterThanOrEqual(1.9);
    expect(await probeMediaDuration(final)).toBeLessThanOrEqual(2.2);
  });
});
