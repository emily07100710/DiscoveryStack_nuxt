#!/usr/bin/env python3
"""Compare paired baseline/candidate screenshots and write a TSV evidence matrix."""
from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

from PIL import Image, ImageChops

ROUTES = [
    "/en",
    "/zh-hant",
    "/en/privacy",
    "/zh-hant/privacy",
    "/en/services/seo-geo-growth-system",
    "/zh-hant/services/seo-geo-growth-system",
    "/en/methodology/journey-intelligence",
    "/zh-hant/methodology/journey-intelligence",
    "/en/glossary/geo",
    "/zh-hant/glossary/geo",
    "/en/publications/what-a-public-website-can-tell-you",
    "/zh-hant/publications/what-a-public-website-can-tell-you",
]


def slug(route: str) -> str:
    return route.strip("/").replace("/", "-")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--matrix", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    rows: list[tuple[str, str, float, float, float, bool]] = []
    for viewport in ("desktop", "mobile"):
        for route in ROUTES:
            baseline_path = args.root / f"baseline-{viewport}-{slug(route)}.png"
            candidate_path = args.root / f"candidate-{viewport}-{slug(route)}.png"
            baseline = Image.open(baseline_path).convert("RGB")
            candidate = Image.open(candidate_path).convert("RGB")
            if baseline.size != candidate.size:
                raise SystemExit(f"size mismatch: {route} {viewport}: {baseline.size} != {candidate.size}")
            difference = ImageChops.difference(baseline, candidate)
            pixels = list(difference.getdata())
            changed = sum(1 for pixel in pixels if max(pixel) > 12)
            total = len(pixels)
            ratio = changed / total
            mean = sum(sum(pixel) for pixel in pixels) / (total * 3)
            threshold = 0.01 if route in {"/en", "/zh-hant"} else 0.005
            rows.append((viewport, route, ratio, mean, threshold, ratio <= threshold))

    args.matrix.parent.mkdir(parents=True, exist_ok=True)
    with args.matrix.open("w", encoding="utf-8") as matrix:
        matrix.write("viewport\troute\tchanged_ratio\tmean_abs_channel_diff\tthreshold\tpass\n")
        for viewport, route, ratio, mean, threshold, passed in rows:
            matrix.write(f"{viewport}\t{route}\t{ratio:.6%}\t{mean:.3f}\t{threshold:.2%}\t{passed}\n")

    with args.manifest.open("w", encoding="utf-8") as manifest:
        manifest.write("kind\tviewport\tsite\troute\tsha256\n")
        for viewport in ("desktop", "mobile"):
            for site in ("baseline", "candidate"):
                for route in ROUTES:
                    path = args.root / f"{site}-{viewport}-{slug(route)}.png"
                    digest = hashlib.sha256(path.read_bytes()).hexdigest()
                    manifest.write(f"screenshot\t{viewport}\t{site}\t{route}\t{digest}\n")

    for row in rows:
        viewport, route, ratio, mean, threshold, passed = row
        print(f"{viewport:8} {route:58} {ratio:8.3%} mean={mean:5.2f} threshold={threshold:.1%} {'PASS' if passed else 'FAIL'}")
    failed = [row for row in rows if not row[-1]]
    print(f"FAILED={len(failed)} TOTAL={len(rows)}")
    if failed:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
