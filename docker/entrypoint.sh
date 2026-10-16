#!/usr/bin/env bash
# Fetch any missing models (OPENJUTSU_QUALITY=1 adds the 14B one), then start ComfyUI.
set -euo pipefail
cd /opt/ComfyUI
python /opt/download_models.py --comfy /opt/ComfyUI --manifest /opt/models.json
exec python main.py --listen 0.0.0.0 --port 8188 "$@"
