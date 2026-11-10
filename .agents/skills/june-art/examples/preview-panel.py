#!/usr/bin/env python3
"""Prepare a NEW isolated QML proof directory from existing art. Does not run it."""
import argparse
import json
import shlex
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--set", type=Path, required=True, help="existing avatar set")
    parser.add_argument("--name", required=True, help="existing pose ID")
    parser.add_argument("--out", type=Path, required=True, help="NEW proof directory")
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parents[4])
    args = parser.parse_args()
    repo, art = args.repo.resolve(), args.set.expanduser().resolve()
    try:
        manifest = json.loads((art / "manifest.json").read_text())
        base = json.loads((repo / "templates/avatar/manifest.json").read_text())
    except (OSError, json.JSONDecodeError) as error:
        parser.error(str(error))
    pose = manifest.get("poses", {}).get(args.name)
    if not pose or not (art / pose["file"]).is_file():
        parser.error("pose or its image is missing")
    if "waist" not in pose.get("framings", ["close-up", "head", "bust", "waist"]):
        parser.error("this proof expects a pose supporting waist framing")
    output = args.out.expanduser().resolve()
    output.mkdir(parents=True, exist_ok=False)
    for source in (repo / "desktop").iterdir():
        if source.suffix in [".qml", ".mjs"] and source.name != "shell.qml":
            (output / source.name).symlink_to(source)
    template = Path(__file__).with_name("panel.qml")
    (output / "shell.qml").write_text(template.read_text())
    data = {"manifest": manifest, "baseManifest": base, "poseName": args.name,
            "stageUrl": art.as_uri() + "/", "baseUrl": (repo / "templates/avatar").as_uri() + "/",
            "outputPath": str(output / "panel-preview.png")}
    (output / "proof-data.mjs").write_text("\n".join(
        f"export const {key} = {json.dumps(value)};" for key, value in data.items()) + "\n")
    print("Prepared without modifying source art or application:", output)
    print("Read references/preview.org for an isolated Xvfb/OpenGL launch.")
    print("Config:", shlex.quote(str(output / "shell.qml")))


if __name__ == "__main__":
    main()
