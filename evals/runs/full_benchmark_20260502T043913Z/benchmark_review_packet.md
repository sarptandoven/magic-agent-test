# AI Video Benchmark Review Packet

Run: `full_benchmark_20260502T043913Z`  
Public demo: https://selections-float-matt-buffer.trycloudflare.com

## Result Snapshot

- Local app completed **10/10** benchmark prompts with status `succeeded`.
- Local total GPT-side cost: **$0.947483**.
- Local average generation latency: **3.71 minutes**.
- External competitor coverage is partial because several products either gated generation behind plans, did not expose LTX-2 in the current session, or ran out of credits before a full 10-prompt sweep.
- No upgrade, top-up, plan purchase, or debit-card action was taken.

## Local Outputs

| Prompt | Name | Status | Latency (min) | Cost | Output |
| --- | --- | --- | ---: | ---: | --- |
| vg-bench-001 | AI camera launch short | succeeded | 3.51 | $0.078711 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/06ec9c3fd0f74e21903096d4296fb013/final.mp4) |
| vg-bench-002 | B2B workflow explainer | succeeded | 2.75 | $0.070800 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/c018832897654a829569646038fffc59/final.mp4) |
| vg-bench-003 | Cinematic micro-story | succeeded | 3.76 | $0.086770 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/4975d0ea7ed145819706ec4e3ee4bdd1/final.mp4) |
| vg-bench-004 | Science education short | succeeded | 3.01 | $0.090844 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/fb426655872c4a1c99e5f883af718c67/final.mp4) |
| vg-bench-005 | Local restaurant reel | succeeded | 3.01 | $0.088437 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/8c3a5d892907413097f067882da775d7/final.mp4) |
| vg-bench-006 | Climate nonprofit appeal | succeeded | 3.76 | $0.138895 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/a6e53a96cf364073b9e6e653eebf5b78/final.mp4) |
| vg-bench-007 | Hardware founder update | succeeded | 4.01 | $0.074460 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/6f9962e191ae4f9d9401e68c51811075/final.mp4) |
| vg-bench-008 | Travel mini-documentary | succeeded | 5.51 | $0.148374 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/d74c10c205b24f8fa568b6c9d1796c3c/final.mp4) |
| vg-bench-009 | Fitness habit coach | succeeded | 3.26 | $0.084393 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/d795a1768eb04831981d0e02fba257b0/final.mp4) |
| vg-bench-010 | Technical concept visualizer | succeeded | 4.51 | $0.085799 | [video](https://selections-float-matt-buffer.trycloudflare.com/media/f4893f5377974ab0b5719af1048f21ca/final.mp4) |

## External Platform Results

| Prompt | Platform | Status | Cost / credits | Output | Notes |
| --- | --- | --- | --- | --- | --- |
| vg-bench-001 | Krea LTX-2 | succeeded | free account credits; exact debit not exposed | [link](https://test1-emgndhaqd0c9h2db.a01.azurefd.net/images/d2117ad9-e14c-45ca-8901-1fc0ed4f665b.mp4) | Completed in Safari. Only reliable completed Krea sample; subsequent programmatic submit did not fire consistently. |
| vg-bench-002 | Krea LTX-2 | staged_not_submitted | not charged |  | Prompt is staged in Krea editor, but Safari automation could not reliably trigger Generate after prompt 1. |
| vg-bench-001 | FocalML | generated_project_page | 149 credits still displayed after run | [link](https://focalml.com/project/S1R8Puyuue) | Focal required an approval step before generation and displayed a Pro upsell. Export became enabled; DOM did not expose a direct video URL. |
| vg-bench-001 | LTX Studio | succeeded | credits dropped from 68% to 36% | [link](https://storage.googleapis.com/lt-infinity-prd/artifacts/ltxv/444f4c4dec350279b81ecc74eb3de63374e408fe0e56040fa40fcfd24402797d) | Completed. Aspect ratio and duration differ from benchmark prompt because LTX Studio disabled 9:16 and capped run at 8s in this setup. |
| vg-bench-002 | LTX Studio | succeeded | credits dropped from 36% to 4% | [link](https://storage.googleapis.com/lt-infinity-prd/artifacts/ltxv/cc4de7207e1350d31ae2a01140e2152f96fbab23de7bdce9ac0ab8af65992e80) | Completed. Stopped further LTX Studio runs at 4% credits to avoid top-up/debit-card flow. |
| all | VideoGen | blocked_requires_business_plan | not charged | [link](https://app.videogen.io/project/a96af3fa-dc5b-495c-babc-ce2e8f57d2ea?internalReferrerPath=%2F) | Skipped to honor no-debit-card constraint. |
| all | InVideo | blocked_not_logged_in_no_ltx2_visible | not charged | [link](https://invideo.io/make/ai-video-generator/) | Skipped to honor no-debit-card constraint and because LTX-2 was not exposed in the current page/session. |

## Honest Comparison Notes

- The strict model parity target was `seedream-v4` for images and `ltx-2` for video. The local app matches that policy.
- Krea and LTX Studio exposed LTX-2 text-to-video, but not the same Seedream image stage.
- FocalML exposed an LTX2/Focal pipeline and produced a project page, but the browser DOM did not expose a direct MP4 link during automation.
- VideoGen was blocked by a Business-plan gate before I could access the relevant generation path.
- InVideo did not expose LTX-2 in the current public/logged-out session, so it is not a valid strict LTX-2 competitor run from this session.
- Subjective visual scoring columns are intentionally blank in the CSV; the benchmark has generation outputs and access/status evidence, not manual visual ratings yet.

## Files

- `merged_results_for_review.csv` combines local and external actual run results.
- `summary_for_review.csv` contains sheet-friendly summary metrics.
- `comparison_results.csv` is the raw local runner output.
- `external_browser_results.csv` is the raw Safari/browser competitor log.
