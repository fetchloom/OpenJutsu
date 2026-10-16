#!/usr/bin/env bash
# Downloads any missing model listed in models.json (skipping "optional" ones unless OPENJUTSU_QUALITY=1), then starts ComfyUI.
set -euo pipefail
cd /opt/ComfyUI
python - <<'PY'
import json, os, urllib.request
want_optional = os.environ.get("OPENJUTSU_QUALITY") == "1"
for m in json.load(open("/opt/models.json"))["downloads"]:
    if m.get("optional") and not want_optional: continue
    if os.path.exists(m["dest"]): continue
    os.makedirs(os.path.dirname(m["dest"]), exist_ok=True)
    print("downloading", m["dest"], flush=True)
    urllib.request.urlretrieve(m["url"], m["dest"] + ".part")
    os.rename(m["dest"] + ".part", m["dest"])
PY
exec python main.py --listen 0.0.0.0 --port 8188 "$@"
