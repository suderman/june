#!/usr/bin/env python3
"""Inspect ComfyUI PNG provenance without rendering or changing the source."""
import argparse
import binascii
import hashlib
import json
import struct
import zlib
from pathlib import Path


def inspect(path):
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    pos, metadata, chunks, size = 8, {}, [], None
    while pos < len(data):
        length = int.from_bytes(data[pos:pos + 4], "big")
        kind = data[pos + 4:pos + 8]
        body = data[pos + 8:pos + 8 + length]
        end = pos + 12 + length
        if end > len(data) or len(kind) != 4:
            raise ValueError("truncated PNG chunk")
        expected = int.from_bytes(data[end - 4:end], "big")
        if binascii.crc32(kind + body) & 0xFFFFFFFF != expected:
            raise ValueError(f"CRC mismatch in {kind!r}")
        chunks.append(kind.decode("ascii"))
        if kind == b"IHDR":
            size = list(struct.unpack(">II", body[:8]))
        elif kind == b"tEXt":
            key, value = body.split(bytes([0]), 1)
            metadata[key.decode("latin1")] = value.decode("latin1")
        elif kind == b"zTXt":
            key, value = body.split(bytes([0]), 1)
            if value[0] != 0:
                raise ValueError("unsupported zTXt compression")
            metadata[key.decode("latin1")] = zlib.decompress(value[1:]).decode("latin1")
        elif kind == b"iTXt":
            key, rest = body.split(bytes([0]), 1)
            compressed, method = rest[:2]
            _, _, value = rest[2:].split(bytes([0]), 2)
            if compressed:
                if method != 0:
                    raise ValueError("unsupported iTXt compression")
                value = zlib.decompress(value)
            metadata[key.decode("latin1")] = value.decode("utf8")
        pos = end
        if kind == b"IEND":
            break
    if not chunks or chunks[-1] != "IEND" or pos != len(data):
        raise ValueError("missing IEND or trailing data")
    try:
        prompt = json.loads(metadata["prompt"]) if "prompt" in metadata else None
        workflow = json.loads(metadata["workflow"]) if "workflow" in metadata else None
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid embedded ComfyUI JSON: {error}") from error
    nodes = {key: {field: value for field, value in node.items() if field != "is_changed"}
             for key, node in (prompt or {}).items()}
    return {"path": str(path.resolve()), "sha256": hashlib.sha256(data).hexdigest(),
            "size": size, "chunks": chunks, "crc_valid": True,
            "api_prompt": nodes or None, "workflow": workflow}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("png", type=Path)
    parser.add_argument("--extract", type=Path, help="create a NEW directory with prompt.json, workflow.json and report.json")
    args = parser.parse_args()
    try:
        report = inspect(args.png)
    except (OSError, ValueError, zlib.error) as error:
        parser.error(str(error))
    if args.extract:
        if report["api_prompt"] is None or report["workflow"] is None:
            parser.error("PNG has no embedded ComfyUI prompt/workflow")
        args.extract.mkdir(parents=True, exist_ok=False)
        for filename, content in [("prompt.json", report["api_prompt"]),
                                  ("workflow.json", report["workflow"]), ("report.json", report)]:
            (args.extract / filename).write_text(json.dumps(content, indent=2, ensure_ascii=False) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "workflow"}, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
