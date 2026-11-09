#!/usr/bin/env python3
"""Render poses in private panels through the checkout's actual Panel.qml, and report how each framed.

Uses its own Xvfb, never the user's display or running overlay. Writes proof.png and results.json into a NEW directory.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def wrapper_environment():
    """Read Quickshell and Qt paths from the installed june-overlay wrapper, without running it."""
    wrapper = shutil.which("june-overlay")
    if not wrapper:
        sys.exit("june-overlay is not on PATH; the proof needs its Quickshell and Qt paths")
    text = Path(wrapper).resolve().read_text()
    found = dict(re.findall(r'^export (PATH|QML2_IMPORT_PATH|QT_PLUGIN_PATH|JUNE_OVERLAY_FONTS)="?([^"\n]*)"?$', text, re.M))
    clean = lambda value: value.split("${")[0].split(":$")[0].rstrip(":")
    qs = next((Path(p) / "qs" for p in clean(found["PATH"]).split(":") if (Path(p) / "qs").exists()), None)
    if qs is None:
        sys.exit("no qs found in the june-overlay wrapper's PATH")
    return qs, {key: clean(found[key]) for key in ("QML2_IMPORT_PATH", "QT_PLUGIN_PATH", "JUNE_OVERLAY_FONTS") if key in found}


def find_xvfb():
    found = shutil.which("Xvfb") or next((str(p) for p in sorted(Path("/nix/store").glob("*-xorg-server-*/bin/Xvfb"))), None)
    if found:
        return found
    out = subprocess.run(["nix", "build", "--no-link", "--print-out-paths", "nixpkgs#xorg.xorgserver"], capture_output=True, text=True, check=True).stdout.strip()
    return f"{out}/bin/Xvfb"


def report(entry):
    """Whether all of her drawn figure is inside the panel, and how far it runs out of each side."""
    art, figure = entry.get("art"), entry.get("figure")
    if not art or not figure:
        return entry
    left = 1 - figure["x"] - figure["w"] if entry["mirror"] else figure["x"]
    x0, x1 = art["x"] + left * art["w"], art["x"] + (left + figure["w"]) * art["w"]
    y0, y1 = art["y"] + figure["y"] * art["h"], art["y"] + (figure["y"] + figure["h"]) * art["h"]
    clip = entry["clip"]
    entry["whole_figure"] = x0 >= clip["x"] - 0.5 and x1 <= clip["x"] + clip["w"] + 0.5 and y0 >= clip["y"] - 0.5 and y1 <= clip["y"] + clip["h"] + 0.5
    entry["cut_px"] = {"left": round(max(0, clip["x"] - x0)), "right": round(max(0, x1 - clip["x"] - clip["w"])), "bottom": round(max(0, y1 - clip["y"] - clip["h"]))}
    entry["feet_y"] = round(y1)
    entry["face_px"] = round(entry["face"]["h"], 1)
    return entry


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", type=Path, required=True, help="avatar set holding the poses")
    parser.add_argument("--pose", action="append", required=True, help="pose ID; repeat for more")
    parser.add_argument("--out", type=Path, required=True, help="NEW directory for the proof")
    parser.add_argument("--repo", type=Path, default=HERE.parents[3], help="June checkout")
    parser.add_argument("--widths", default="1040,820,620,390", help="panel widths, comma separated")
    parser.add_argument("--beats", default="1,7", help="balloons per panel: short, then long")
    parser.add_argument("--sides", default="left,right", help="which sides June stands on")
    parser.add_argument("--height", type=int, default=7000, help="height of the private display")
    args = parser.parse_args()
    if args.out.exists():
        sys.exit(f"{args.out}: already exists")
    art = args.set.expanduser().resolve()
    manifest = json.loads((art / "manifest.json").read_text())
    missing = [p for p in args.pose if p not in manifest["poses"]]
    if missing:
        sys.exit(f"not in {art}/manifest.json: {', '.join(missing)}")
    args.out.mkdir(parents=True)
    out = args.out.resolve()
    for source in (args.repo / "overlay").iterdir():
        if source.suffix in (".qml", ".mjs") and source.name != "shell.qml":
            (out / source.name).symlink_to(source.resolve())
    shutil.copyfile(HERE / "proof-panels.qml", out / "shell.qml")
    widths = [int(w) for w in args.widths.split(",")]
    scenes = [{"pose": p, "side": s, "beats": int(b)} for p in args.pose for s in args.sides.split(",") for b in args.beats.split(",")]
    width = sum(widths) + 16 * (len(widths) + 1)
    data = {"manifest": manifest, "baseManifest": json.loads((args.repo / "templates/avatar/manifest.json").read_text()), "artUrl": art.as_uri() + "/", "baseUrl": (args.repo / "templates/avatar").resolve().as_uri() + "/", "outputPath": str(out / "proof.png"), "scenes": scenes, "widths": widths, "windowWidth": width, "windowHeight": args.height}
    (out / "proof-data.mjs").write_text("".join(f"export const {k} = {json.dumps(v)};\n" for k, v in data.items()))
    qs, environment = wrapper_environment()
    read, write = os.pipe()
    display = subprocess.Popen([find_xvfb(), "-displayfd", str(write), "-screen", "0", f"{width + 40}x{args.height + 40}x24", "-nolisten", "tcp"], pass_fds=(write,), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    os.close(write)
    try:
        number = os.read(read, 16).decode().strip()
        if not number:
            sys.exit("Xvfb did not start")
        env = {**os.environ, **environment, "DISPLAY": f":{number}", "QT_QPA_PLATFORM": "xcb", "QSG_RHI_BACKEND": "opengl"}
        env.pop("WAYLAND_DISPLAY", None)
        run = subprocess.run([str(qs), "-p", str(out / "shell.qml")], env=env, capture_output=True, text=True, timeout=120)
    finally:
        display.terminate()
        display.wait()
    log = run.stdout + run.stderr
    (out / "qs.log").write_text(log)
    results = [report(json.loads(line.split("PROOF ", 1)[1].strip())) for line in log.splitlines() if "PROOF {" in line]
    (out / "results.json").write_text(json.dumps(results, indent=1) + "\n")
    if "SAVED true" not in log or not results:
        sys.exit(f"no proof was saved; see {out / 'qs.log'}")
    for r in results:
        print(f"{r['pose']:34.34s} {r['side']:5s} {r['width']:5d}x{r['height']:<5d} {r['framing']:8s} face {r.get('face_px')} whole {r.get('whole_figure')} feet {r.get('feet_y')} cut {r.get('cut_px')}{' desk' if r['desk'] else ''}{' inset' if r['inset'] else ''}{'' if r['ready'] else ' NOT READY'}")
    print(out / "proof.png")


if __name__ == "__main__":
    main()
