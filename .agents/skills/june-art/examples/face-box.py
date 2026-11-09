#!/usr/bin/env python3
"""Size a face box by the rule in references/tall-pose.org: height is 1.85 times the eye-to-chin distance.

Give the image and a rough box in source pixels whose bottom edge is on her chin. It finds her irises by colour inside
that box and prints the corrected box. Closed eyes have no iris to find: measure those by eye. Does not change anything.
"""
import argparse
import colorsys
import json
import math
import subprocess
import sys

K = 1.85


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image")
    parser.add_argument("--face", required=True, help="X,Y,W,H in source pixels, bottom on her chin")
    args = parser.parse_args()
    x, y, w, h = (int(n) for n in args.face.split(","))
    raw = subprocess.check_output(["magick", args.image, "-alpha", "off", "-crop", f"{w}x{h}+{x}+{y}", "+repage", "-depth", "8", "RGB:-"])
    iris = []
    for i in range(0, len(raw), 3):
        hue, sat, val = colorsys.rgb_to_hsv(raw[i] / 255, raw[i + 1] / 255, raw[i + 2] / 255)
        if 65 <= hue * 360 <= 165 and sat > 0.35 and val > 0.2:
            iris.append(((i // 3) % w + x, (i // 3) // w + y))
    if len(iris) < 20:
        sys.exit("no green irises found inside that box; measure closed eyes by hand")
    xs = sorted(p[0] for p in iris)
    a, b = xs[len(xs) // 4], xs[3 * len(xs) // 4]
    for _ in range(12):
        left = [p for p in iris if abs(p[0] - a) <= abs(p[0] - b)]
        right = [p for p in iris if abs(p[0] - a) > abs(p[0] - b)]
        if not left or not right:
            sys.exit("found one eye, not two; measure this face by hand")
        a = sum(p[0] for p in left) / len(left)
        b = sum(p[0] for p in right) / len(right)
    centre = lambda pts: (sum(p[0] for p in pts) / len(pts), sum(p[1] for p in pts) / len(pts))
    one, two = centre(left), centre(right)
    tilt = math.atan2(two[1] - one[1], two[0] - one[0])
    distance = (y + h - (one[1] + two[1]) / 2) / math.cos(tilt)
    height = round(K * distance)
    print(json.dumps({"eyes": [[round(n) for n in one], [round(n) for n in two]], "tilt_degrees": round(math.degrees(tilt), 1), "eye_to_chin": round(distance, 1), "ratio_given": round(h / distance, 2), "face": [x, y + h - height, w, height]}))


if __name__ == "__main__":
    main()
