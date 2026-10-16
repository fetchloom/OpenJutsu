#!/usr/bin/env python3
"""Download the model files listed in models.json into a ComfyUI install.

Usage:  python download_models.py [--comfy /path/to/ComfyUI] [--quality]
--quality also fetches the optional 14B model (needs a 24 GB+ GPU).
"""
import argparse, json, os, sys, urllib.request

ap = argparse.ArgumentParser()
ap.add_argument("--comfy", default=os.environ.get("COMFY_DIR", "/opt/ComfyUI"))
ap.add_argument("--manifest", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "models.json"))
ap.add_argument("--quality", action="store_true", default=os.environ.get("OPENJUTSU_QUALITY") == "1")
args = ap.parse_args()

for m in json.load(open(args.manifest))["downloads"]:
    if m.get("optional") and not args.quality:
        continue
    dest = os.path.join(args.comfy, m["dest"])
    if os.path.exists(dest):
        continue
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print("downloading", m["dest"], flush=True)
    try:
        urllib.request.urlretrieve(m["url"], dest + ".part")
    except Exception as e:
        sys.exit(f"download failed for {m['url']}: {e}")
    os.rename(dest + ".part", dest)
print("models ready")
