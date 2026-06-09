# Local Video Composer

Production-shaped local workflow for turning one prompt into a finished MP4 with an OpenAI art-director agent, Magic Hour image/video generation, Fish Audio voiceover, and ffmpeg stitching.

This project is intentionally local-first. It does not add queue durability, backups, retries, or cloud deployment glue. It does make the local experience strict: clear configuration checks, pollable render status, deterministic output folders, direct ffmpeg errors, and a polished browser workspace.

## Structure

```text
backend/app/main.py          FastAPI app, agent loop, project status API
backend/app/render_state.py  JSON artifact and scene retry state helpers
backend/app/tools/media.py   Magic Hour, Fish Audio, and ffmpeg provider primitives
frontend/app/page.tsx        Local composer UI and render monitor
dev.sh                       One-command local launcher
tests/test_fast_pipeline.py  Backend contract and pipeline tests
```

## Agent Design

The OpenAI agent owns the creative loop and render decisions. Python exposes a small `video_studio` namespace of bounded tools for safe provider calls, artifact writes, status inspection, retries, and stitching.

```python
video_agent = Agent(
    name="Autonomous Video Art Director",
    tools=[*VIDEO_STUDIO_TOOLS, ToolSearchTool()],
)
```

The agent now moves through explicit production steps:

```text
draft_video_plan -> generate_voiceover
                 -> generate_scene_images -> animate_scene_videos
                 -> inspect_render_status / record_project_decision / retry_scene
                 -> stitch_final_video

After inspection:
regenerate_scene / revise_narration / replace_voiceover -> restitch_video
```

The provider primitives still live in `backend/app/tools/media.py`; the agent-facing tools wrap them in small, readable artifact steps. The tool schemas describe the visual contract directly: `image_prompt` is a stable cinematic keyframe, while `video_prompt` animates only what already exists in that keyframe. The agent also chooses Magic Hour image and image-to-video models when calling the media tools.
Persistent project memory lives in `project_state.json`, not in process memory, so the agent can inspect the current plan, scene assets, failures, user preferences, and recorded decisions across tool calls or backend restarts.

## Workflow

1. `POST /api/projects` validates local configuration and starts a render job.
2. The frontend polls `GET /api/projects/{project_id}` for stage and progress.
3. The agent drafts and saves the creative plan.
4. Fish voiceover and Magic Hour image generation run as separate bounded tool calls.
5. Magic Hour image-to-video runs for completed images, with scene-level retries available.
6. The agent records important creative/retry choices into project memory.
7. The agent inspects status, retries failed scenes if useful, then asks ffmpeg to stitch `final.mp4`.
8. After inspecting the output, the agent can patch one part with `regenerate_scene`, `revise_narration`, or `replace_voiceover`, then verify by calling `restitch_video`.
9. `POST /api/projects/{project_id}/messages` queues a follow-up agent turn against the existing project state without requiring frontend UI changes.

If one scene video fails, the renderer now stitches the successful scene videos into a marked partial MP4 instead of leaving you with no video.

Generated assets are written under:

```text
outputs/<project_id>/plan.json
outputs/<project_id>/status.json
outputs/<project_id>/project_state.json
outputs/<project_id>/manifest.json
outputs/<project_id>/images.json
outputs/<project_id>/videos.json
outputs/<project_id>/voiceover.json
outputs/<project_id>/images/<scene_id>/output-*.jpg
outputs/<project_id>/videos/<scene_id>/output-*.mp4
outputs/<project_id>/voiceover/voiceover.mp3
outputs/<project_id>/token_output.json
outputs/<project_id>/final.mp4
```

`token_output.json` records only the OpenAI agent run token usage and estimated OpenAI token cost. Magic Hour, Fish Audio, and ffmpeg costs are not included.

## Setup

The app reads shared secrets from:

```text
/Users/tanmay/Magic Hour ML role/.env
```

You can also add a project-local `.env`. Project-local values override the shared file.

Required values:

```bash
OPENAI_API_KEY=
MAGIC_HOUR_API_KEY=
FISH_AUDIO_API_KEY=
FISH_AUDIO_REFERENCE_ID=
```

Useful defaults:

```bash
OPENAI_MODEL=gpt-5.5
OPENAI_REASONING_EFFORT=low
OPENAI_VERBOSITY=low
OUTPUT_DIR=outputs
MAGIC_HOUR_IMAGE_MODEL=seedream-v4
MAGIC_HOUR_IMAGE_RESOLUTION=1k
MAGIC_HOUR_IMAGE_STYLE_TOOL=general
MAGIC_HOUR_VIDEO_MODEL=ltx-2.3
MAGIC_HOUR_VIDEO_AUDIO=false
FISH_AUDIO_MODEL=s2-pro
FISH_AUDIO_FORMAT=mp3
```

Required local commands:

```bash
python3
node
npm
ffmpeg
ffprobe
curl
```

## Run

```bash
cd "/Users/tanmay/Magic Hour ML role/openai_sdk_agent"
./dev.sh
```

URLs:

- Frontend: `http://localhost:3000`
- Backend: `http://localhost:8000`
- Backend log: `.run-logs/backend.log`
- Frontend log: `.run-logs/frontend.log`

`dev.sh` binds both servers to `127.0.0.1` by default. Override `BACKEND_HOST`, `BACKEND_PORT`, `FRONTEND_HOST`, or `FRONTEND_PORT` in `.env` if needed.

## Verify

```bash
.venv/bin/python -m pytest -q
cd frontend && npm run build
```

## API

Start a project:

```bash
curl -sS http://localhost:8000/api/projects \
  -H 'content-type: application/json' \
  -d '{
    "prompt": "A cinematic launch video for a compact AI camera",
    "duration_seconds": 20,
    "scene_count": 4,
    "aspect_ratio": "9:16",
    "resolution": "720p"
  }'
```

Poll the returned `status_url` until `status` is `succeeded` or `failed`.

Send a follow-up message to the agent for an existing project:

```bash
curl -sS http://localhost:8000/api/projects/<project_id>/messages \
  -H 'content-type: application/json' \
  -d '{
    "message": "Scene 2 feels flat. Make the lighting more dramatic and restitch."
  }'
```

The message endpoint appends the user message to `project_state.json`, queues an agent turn, and returns the same pollable project status shape. The agent receives the current project state and can inspect, patch, regenerate, or restitch through the bounded `video_studio` tools.
