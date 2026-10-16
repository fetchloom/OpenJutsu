# OpenJutsu

Open-source, web-based video-to-video studio inspired by Higgsfield Genjutsu. It runs on [ComfyUI](https://github.com/comfyanonymous/ComfyUI) and open-weight models, so you can self-host it or fork any workflow.

- **Motion Transfer**: keep a clip's movement and timing, rebuild the cast, setting or style around it.
- **Object Swap**: click an object, give it a reference image or prompt, and leave the rest of the shot as filmed.
- Up to 8 reference images, presets (no prompt needed), pose or depth control, fast and quality tiers, side-by-side before/after.

> Not affiliated with Higgsfield. OpenJutsu is an independent project that does not use their code or weights.

## Status: v0.1 (alpha)

| Area | State |
| --- | --- |
| Web UI, API, job flow, upload hardening, auth token | Built and covered by automated tests (`npm test`, mock backend) |
| Click-to-mask coordinate mapping (crop math) | Unit-tested |
| ComfyUI workflow graphs (Wan 2.1 VACE based) | **Drafted from the ComfyUI node schemas, not yet run on a GPU.** Run `npm run validate-comfy` on your GPU box first |
| Clip length | 5 s per job (81 frames at 16 fps). Longer clips need segment chaining (roadmap) |

## Run it

Needs Node 22+. No npm dependencies.

```bash
npm start                      # http://127.0.0.1:8500, mock backend: the UI works, output = your input
COMFY_URL=http://gpu-box:8188 npm start     # real generation
```

### Real generation (cloud GPU)

1. Start ComfyUI on any NVIDIA GPU host (Runpod, Lambda, your own) with `docker/Dockerfile.comfy`. It installs ComfyUI plus `comfyui_controlnet_aux` and `ComfyUI-segment-anything-2`, and downloads the models listed in `models.json` on first start. Set `OPENJUTSU_QUALITY=1` to also fetch the 14B model.
2. Check that the install matches the graphs: `COMFY_URL=http://gpu-box:8188 npm run validate-comfy`. It lists any missing node, input or model file.
3. Point the web server at it with `COMFY_URL`. **ComfyUI has no auth, so don't expose port 8188.** Set `OPENJUTSU_TOKEN` before exposing OpenJutsu itself. `docker/docker-compose.yml` wires both for you.

GPU memory: the `fast` tier (Wan VACE 1.3B) fits in about 12 GB. The `quality` tier (14B) wants 24 GB or more.

## How it works

```
browser ──► server/server.js ──► ComfyUI (/upload, /prompt, /history, /view)
              │  validates input, builds the graph in server/workflows.js
              └─ mock backend when COMFY_URL is unset
```

- Motion Transfer: source frames → pose (DWPose) or depth (Depth Anything v2) control video → `WanVaceToVideo` with your reference images → sample → decode.
- Object Swap: SAM2 video segmentation from your click points → grown mask → source with the object greyed out + mask → `WanVaceToVideo` with the reference image.
- `workflows/*.api.json` are generated sample graphs (`npm run export-workflows`); you can POST them straight to ComfyUI's `/prompt`.

## Roadmap

1. Long clips: split into segments, carry identity across them, stitch.
2. Wan 2.2 Animate / LTX tiers; better face and identity consistency.
3. Mask review step (preview the mask before spending GPU time).
4. Accounts, persistent history, queue across several GPU workers.

## Contributing

PRs welcome. `npm test` must pass. Workflow changes should come with an updated `validate-comfy` case. MIT licensed.
