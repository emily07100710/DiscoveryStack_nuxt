#!/usr/bin/env python3
"""Check five baseline screenshot rounds against baseline round 0."""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageChops

ROUTES = [
    "/en", "/zh-hant", "/en/privacy", "/zh-hant/privacy",
    "/en/services/seo-geo-growth-system", "/zh-hant/services/seo-geo-growth-system",
    "/en/methodology/journey-intelligence", "/zh-hant/methodology/journey-intelligence",
    "/en/glossary/geo", "/zh-hant/glossary/geo",
    "/en/publications/what-a-public-website-can-tell-you",
    "/zh-hant/publications/what-a-public-website-can-tell-you",
]


def slug(route: str) -> str:
    return route.strip("/").replace("/", "-")


def ratio(first: Path, second: Path) -> float:
    a = Image.open(first).convert("RGB")
    b = Image.open(second).convert("RGB")
    if a.size != b.size:
        raise SystemExit(f"size mismatch: {first} vs {second}")
    difference = ImageChops.difference(a, b)
    pixels = list(difference.getdata())
    return sum(1 for pixel in pixels if max(pixel) > 12) / len(pixels)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--runs", nargs=5, type=Path, required=True, metavar="RUN")
    args = parser.parse_args()
    baseline = args.runs[0]
    failures = 0
    print("round\tviewport\troute\tdiff_ratio\tthreshold\tpass")
    for run_number, run in enumerate(args.runs[1:], start=1):
        for viewport in ("desktop", "mobile"):
            for route in ROUTES:
                first = baseline / f"baseline-{viewport}-{slug(route)}.png"
                second = run / f"baseline-{viewport}-{slug(route)}.png"
                changed = ratio(first, second)
                threshold = 0.01 if route in {"/en", "/zh-hant"} else 0.005
                passed = changed <= threshold
                failures += not passed
                print(f"{run_number}\t{viewport}\t{route}\t{changed:.6%}\t{threshold:.2%}\t{passed}")
    print(f"FAILED={failures} TOTAL={(len(args.runs) - 1) * len(ROUTES) * 2}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
