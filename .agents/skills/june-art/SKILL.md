---
name: june-art
description: Reproduce, extend, troubleshoot and ingest June's canonical anime artwork with the existing ComfyUI Anima Ref Adapter v2 and ToonOut pipeline. Use for June character assets, production reference sheets, transparency, face measurements, art provenance and comic-renderer previews. Preserve approved identity and require Jon's approval before production promotion or expanding batches.
---

# June art

Generate coherent June characters from fresh noise with reference conditioning, then extract alpha and validate the real compositor. This skill does not authorize generation, installation, training or production writes by itself.

## Begin

1. Resolve the checkout with `git rev-parse --show-toplevel`. Read the matching Org project and current authorization before work. On Jon's host the project is `~/org/work/suderman/june/june.org`.
2. Read `references/identity-and-records.org`. Locate the canonical sheet and the exact inventory entry, not a similar-looking experimental image. Inspect the images yourself.
3. Read `references/environment.org`; check the live service, model hashes, required node schemas and saved workflow before selecting settings. Do not install or restart things merely because an endpoint or optional node fails.
4. Read `lessons/general.org` and the lessons for your pipeline. Before setting EVAL, add what this job taught you, including what failed. Use `june-art run` (`references/runner.org`) rather than writing a submit script.
5. Read only the task's next reference below. Keep generated artwork and weights outside this skill and repository. Store fresh machine records under host-local state, not synced Org.

This is Jon's personal June art skill. `~/org/work/` is synchronized across his workstations; **kit** is the designated ComfyUI host with the NVIDIA GPU. Read synced records elsewhere, but run ComfyUI/GPU operations on kit. Portability to unrelated environments is not a goal.

All bundled paths below are relative to this skill directory. External paths in the references belong to the existing personal environment, not this checkout. Stop and report missing inputs rather than replacing canon with guessed references.

| Task | Read next |
|---|---|
| Reproduce seed 4002 or generate a named pose | `references/generation.org` |
| Extract or audit alpha | `references/transparency.org` |
| Measure, stage, ingest, promote or inspect manifest | `references/ingestion.org` |
| Crop sheet or actual desktop/narrow panel proof | `references/preview.org` |
| Diagnose visual, node, API or integration failures | `references/troubleshooting.org` |
| Run anything through ComfyUI, or add a pipeline | `references/runner.org` |
| Draw a new tall pose, start to finish | `references/tall-pose.org` |

## Proven starting point

Use `June - Production idle-attentive v2.json` for isolated character sprites, or `June - Conversational pilot v2.json` for expression/scene studies. Both are saved in ComfyUI and exported with the art records. The approved character stack is Anima Base v1.0, Qwen3-0.6B, Qwen Image VAE and **pretrained** Anima Ref Adapter v2. Its weights live in `loras/`, but it is not a June-trained character LoRA or a plain LoRA-loader workflow.

Baseline: 30 steps, CFG 4.5, `er_sde/simple`, denoise 1, fixed recorded seed; adapter reference guidance 2.5, APG, strength/end 1, reference resolution 1 MP. Body and face crops condition one model through an ImageStitch reference board. Output starts from `EmptyLatentImage`. No reference pixels or replacement face are pasted into the output. Treat these as tested starting values, not universal constants.

Preferred alpha: saved `June - Production alpha ToonOut.json`. Preserve RGB, native mask, source RGBA, normalized asset, prompt, seeds and executed workflows separately. Accepted tiny bright hair pixels are not grounds for destructive erosion or another tuning cycle.

## Gates

- Read the named art-list description and keep the fixed 18-expression vocabulary. Canonical skirt outfit overrides obsolete jeans wording.
- Use a bounded candidate count authorized by Jon. Compare identity, expression, anatomy, outfit, framing and rendering. Report rejects and uncertainty.
- Obtain review before promotion. Use a new staging set first; inspect the destination manifest and files before production writes. Never overwrite unrelated art.
- Keep the original canonical sheet highest authority. Palette is approved; turnaround is a working reference with marked angle/pose limits. Outfit-and-props sheet and five props are approved working references; its mug handle protrusion and illustrative keyboard layout are not canon. Check the project for later decisions.
- No automatic LoRA training, model changes, renderer fixes, pose library, chibis or animation. Reference sheets are production aids, not runtime poses.

## Read-only helpers and cold start

`examples/inspect-png.py` checks PNG CRCs and reports embedded executed prompt/workflow. `examples/preview-panel.py` prepares an isolated proof using the checkout's actual QML components and an existing avatar manifest. `examples/preflight-pose.mjs` imports the actual ingester geometry and reports source-edge contact, normalization overflow, gesture bounds and actual variable-width placement or refusal. Run it before accepting gesturing sources, then inspect real panel crops separately. None submits ComfyUI jobs or ingests artwork. Read their help and `references/ingestion.org` before use.

A cold-start audit must locate canon, the seed-4002 generation/alpha workflows, source/settings/mask, production WebP, a new named expression's inventory entry and its approval/staging route. Check the limitations too. Do not regenerate merely to prove documentation works.

Pi discovers `.agents/skills/` recursively at session startup or reload. A Claude Code worker can read this entry point explicitly; do not assume every agent discovers this location automatically. Existing `skills/` in this repository contains skills shipped with June, not this operator skill. No second copy or discovery shim is required.
