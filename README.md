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

## Quick start (no GPU, 1 minute)

You only need [Node.js 22+](https://nodejs.org). There is nothing to install.

```bash
git clone https://github.com/fetchloom/OpenJutsu.git
cd OpenJutsu
npm start
```

Open http://127.0.0.1:8500. You'll see a **mock backend** badge: the whole UI works (upload, click-to-mask, presets, queue, before/after), but the "result" is just your input video, because no model is attached. Use this to try the interface or develop the frontend. Run `npm test` to run the test suite.

## Real generation (needs an NVIDIA GPU)

Generation runs in ComfyUI on a GPU machine. Your laptop only needs a browser. Pick one:

**Option A: Docker on any Linux GPU host** (Lambda, Vast.ai, a cloud VM, your own box). It needs an NVIDIA driver, Docker and the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

```bash
git clone https://github.com/fetchloom/OpenJutsu.git && cd OpenJutsu
export OPENJUTSU_TOKEN="$(openssl rand -hex 24)"   # your API password; keep it
docker compose -f docker/docker-compose.yml up --build
```

The first start downloads about 10 GB of model files into a Docker volume (the optional 14B model adds roughly 28 GB), so wait for `models ready` in the log. Then open `http://<host>:8500` and paste the token under **Advanced → API token**. For the 14B quality model, set `OPENJUTSU_QUALITY=1` before `up` (needs 24 GB+ of GPU memory).

**Option B: ComfyUI you already run** (for example a Runpod pod, where Docker isn't available).

```bash
# 1. On the GPU machine, inside your ComfyUI folder:
cd ComfyUI/custom_nodes
git clone https://github.com/Fannovel16/comfyui_controlnet_aux
git clone https://github.com/kijai/ComfyUI-segment-anything-2
pip install -r comfyui_controlnet_aux/requirements.txt -r ComfyUI-segment-anything-2/requirements.txt
git clone https://github.com/fetchloom/OpenJutsu /tmp/OpenJutsu
python /tmp/OpenJutsu/docker/download_models.py --comfy ..   # add --quality for the 14B model
cd .. && python main.py --listen 127.0.0.1 --port 8188

# 2. In a SECOND terminal (ComfyUI keeps running in the first), check that this install matches OpenJutsu's graphs:
cd /tmp/OpenJutsu && COMFY_URL=http://127.0.0.1:8188 npm run validate-comfy

# 3. Start the web app next to it:
COMFY_URL=http://127.0.0.1:8188 OPENJUTSU_TOKEN=pick-a-password HOST=0.0.0.0 npm start
```

On Runpod, expose port 8500 (the web app) and leave 8188 (ComfyUI) closed.

**Security:** ComfyUI has no login of its own, so never expose port 8188 to the internet. OpenJutsu's server is the only thing that should be public, and only with `OPENJUTSU_TOKEN` set.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `COMFY_URL` | unset (mock mode) | ComfyUI address, for example `http://127.0.0.1:8188` |
| `OPENJUTSU_TOKEN` | unset | If set, the API requires `Authorization: Bearer <token>` |
| `PORT` / `HOST` | `8500` / `127.0.0.1` | Where the web app listens. Use `HOST=0.0.0.0` to accept outside connections |
| `COMFY_API_KEY` | unset | Bearer key, if your ComfyUI sits behind a proxy that needs one |
| `OPENJUTSU_QUALITY` | unset | `1` downloads the 14B model |

### Troubleshooting

- **`validate-comfy` says a node class is missing:** the custom nodes didn't install. Re-run the `pip install` lines and restart ComfyUI.
- **It says a model file isn't in the list:** the file name in `models.json` doesn't match what's on disk. Fix the name there, or download the file.
- **Out of GPU memory:** use the `fast` tier and `480p`, and shorten the clip.
- **"a mask point falls in the cropped-away border":** the clip's aspect ratio is cropped to fit. Click closer to the center of the frame.
- **401 in the UI:** enter the token under Advanced → API token.

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
