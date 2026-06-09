# AI Video Competitor Comparison Test Plan

Use this when comparing the local Video Agent against strong prompt-to-video tools. The goal is not to prove every model-level capability. The goal is to show whether a product can turn a rough creative request into a coherent finished short with story, pacing, narration, usable visuals, and revision potential.

## Recommended Competitor Set

Strict model-controlled competitors:

- Local Video Agent: uses `seedream-v4` for image generation and `ltx-2` for image-to-video.
- Krea LTX-2: external UI baseline for LTX-2 text-to-video. It does not use a separate `seedream-v4` image stage, but it is still useful because the video model can be matched.

Skip these for strict model-controlled evals unless you are doing a broader product UX comparison:

- Focal: closest conceptual match for AI-assisted story/video production. It positions itself as an AI video generator, editor, and animation maker that can help with scriptwriting, video production, voiceovers, edits, consistent characters, and locations.
- InVideo AI: strong finished-video baseline. It turns a prompt into a script, visuals, voiceover, subtitles, music, and social/promo formats.
- VideoGen: direct text/script-to-video competitor for quick social videos, AI voices, and dynamic visuals.
- Runway: best high-end creative control baseline, but Gen-4 is not LTX-2.
- Kling AI: strong pure generation baseline, but Kling models are not LTX-2.
- Luma Dream Machine or Pika: useful extra baselines for pure visual quality and fast creative iteration.

Optional ad-specific tools:

- AdCreate, VEED, Kapwing, Creatify, or Feqol if the benchmark shifts toward product ads, UGC-style ads, avatars, captions, or e-commerce URL-to-video workflows.

For tonight's strict benchmark, test Local Video Agent and Krea LTX-2 first. Keep Focal, InVideo, and VideoGen only as a separate product-level comparison if the cofounder still wants them despite non-matching model controls.

Research references:

- Focal: https://focalml.com/ and https://focalml.com/about
- Krea LTX-2: https://www.krea.ai/models/ltx-2-19b
- InVideo AI: https://invideo.io/make/ai-video-generator/
- VideoGen: https://www.videogen.lol/
- Runway Gen-4: https://help.runwayml.com/hc/en-us/articles/37327109429011-Creating-with-Gen-4-Video and https://help.runwayml.com/hc/en-us/articles/39789879462419-Gen-4-Video-Prompting-Guide
- Kling AI: https://app.klingai.com/cn/quickstart/klingai-video-3-model-user-guide
- Luma Dream Machine: https://www.luma-ai.com/luma-dream-machine/

## Scoring Rubric

Score each output 1-5 on:

- Prompt adherence: Did it respect duration, aspect ratio, scene count, tone, and requested structure?
- Story coherence: Does the video feel intentionally planned rather than a collage of unrelated clips?
- Visual quality: Are images/videos sharp, cinematic, and free of obvious artifacts?
- Motion quality: Does the video move naturally without random morphing, jitter, or impossible actions?
- Narration/audio: Is the voiceover natural, specific, and timed well?
- Finishedness: Can this be shared as-is, or does it feel like a raw generation?
- Editability: Can a user ask for a targeted revision without restarting from scratch?
- Speed/cost transparency: Was it easy to understand wait time and credits/cost?

Suggested weighted score:

```text
prompt_adherence: 20
story_coherence: 20
visual_quality: 20
motion_quality: 15
narration_audio: 10
finishedness: 10
editability: 5
```

Formula:

```text
weighted_score_100 =
  (prompt_adherence_1_5 * 20
 + story_coherence_1_5 * 20
 + visual_quality_1_5 * 20
 + motion_quality_1_5 * 15
 + narration_audio_1_5 * 10
 + finishedness_1_5 * 10
 + editability_1_5 * 5) / 5
```

## How To Run

1. Use the exact prompts in `video_generation_benchmark_prompts.jsonl`.
2. Keep the default requested shape unless a competitor cannot set it:
   - `aspect_ratio`: usually `9:16`
   - `duration_seconds`: 12-20 seconds
   - `scene_count`: 3-5 scenes
3. For tools that only generate single clips, run enough clips to approximate the story, then record that extra manual work in the notes.
4. Save output links or file paths in `comparison_results_template.csv`.
5. Do not compare only best frames. Judge the complete output.
6. Mark whether the output was usable on first generation or needed regeneration.

## Automated Local-Agent Run

The local Video Agent can be run headlessly through the FastAPI API:

```bash
python3 scripts/run_video_benchmark.py --execute
```

Useful variants:

```bash
# Run one paid/provider-backed smoke case first.
python3 scripts/run_video_benchmark.py --execute --limit 1

# Run a specific case.
python3 scripts/run_video_benchmark.py --execute --ids vg-bench-002

# Use the public demo tunnel instead of localhost.
python3 scripts/run_video_benchmark.py --execute --api-base https://YOUR-TUNNEL.trycloudflare.com
```

The runner defaults to the required model pair:

```text
image_model=seedream-v4
video_model=ltx-2
```

Outputs are written under `evals/runs/<timestamp>/`:

- `comparison_results.csv`: Google-Sheets-ready results table.
- `comparison_results.json`: same rows as JSON.
- `requests/*.json`: exact payloads submitted to the local agent.
- `status_snapshots/*-created.json` and `*-final.json`: API responses.
- `manifests/*.json`: final manifests when generation succeeds.

The runner is safe by default. Without `--execute`, it only writes a dry-run sheet and does not submit paid provider jobs.

For third-party competitors, use official APIs where available. Browser automation can be added later if there is an authenticated session, but it should be treated as brittle and product-specific rather than the default benchmark path.

## Safari Browser Workflow

If you are logged into the external tools in Safari, open the strict benchmark tabs and copy the first prompt to clipboard:

```bash
python3 scripts/open_benchmark_tabs.py --case-id vg-bench-001
```

This opens:

- the local demo URL if `.run-logs/demo-url.txt` exists, otherwise `http://127.0.0.1:3000`
- Krea's LTX-2 page

It also writes a queue file under `evals/runs/browser_<timestamp>/browser_run_queue.csv`.

To also open skipped product-level tools:

```bash
python3 scripts/open_benchmark_tabs.py --case-id vg-bench-001 --include-skipped
```

After login, Safari JavaScript automation can inspect the active tab DOM. Use that to build a Krea-specific submitter instead of pasting prompts manually. Do not attempt blind submission until the DOM for the logged-in page has been inspected.

## What Counts As Winning

The local Video Agent wins a test case if it produces the most complete usable short with the least manual recovery. It does not need the single best image frame in every case if it wins the whole workflow: interpretation, scene planning, narration, continuity, stitched result, and follow-up editability.
