#!/usr/bin/env python3
"""Test that our generated textures meet the requirements."""
import os
import subprocess
import sys
from PIL import Image
import numpy as np


def test_textures_exist():
    """Every texture file exists and is 64x64."""
    outdir = "/tmp/tb_textures_test"
    # Run the generator
    result = subprocess.run(
        ["python3", "scripts/mk_textures.py", outdir],
        capture_output=True, text=True
    )
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr)
        sys.exit(1)

    required = [
        "wall_grey.png", "floor_flag.png", "stair_edge.png",
        "door_frame.png", "trim_red.png", "trim_blue.png",
        "star_wblue.png",
    ]

    for name in required:
        path = os.path.join(outdir, name)
        assert os.path.exists(path), f"{name} does not exist"
        img = Image.open(path)
        assert img.size == (64, 64), f"{name} is {img.size}, expected 64x64"


def test_distinct_colours():
    """Each texture has more than 8 distinct colours."""
    outdir = "/tmp/tb_textures_test"
    required = [
        "wall_grey.png", "floor_flag.png", "stair_edge.png",
        "door_frame.png", "trim_red.png", "trim_blue.png",
        "star_wblue.png",
    ]

    for name in required:
        path = os.path.join(outdir, name)
        img = Image.open(path)
        distinct = len(set(img.getdata()))
        assert distinct > 8, f"{name} has only {distinct} distinct colours, expected > 8"


def test_wall_grey_rgb_similar():
    """wall_grey's average R, G, B are within 12 of each other."""
    outdir = "/tmp/tb_textures_test"
    path = os.path.join(outdir, "wall_grey.png")
    img = Image.open(path)
    pixels = list(img.getdata())
    avg_r = sum(p[0] for p in pixels) / len(pixels)
    avg_g = sum(p[1] for p in pixels) / len(pixels)
    avg_b = sum(p[2] for p in pixels) / len(pixels)
    assert abs(avg_r - avg_g) <= 12, f"wall_grey: R={avg_r:.1f} G={avg_g:.1f} diff={abs(avg_r - avg_g):.1f}"
    assert abs(avg_g - avg_b) <= 12, f"wall_grey: G={avg_g:.1f} B={avg_b:.1f} diff={abs(avg_g - avg_b):.1f}"
    assert abs(avg_r - avg_b) <= 12, f"wall_grey: R={avg_r:.1f} B={avg_b:.1f} diff={abs(avg_r - avg_b):.1f}"


def test_star_wblue_blue_exceeds_red():
    """star_wblue's average blue exceeds red by at least 40."""
    outdir = "/tmp/tb_textures_test"
    path = os.path.join(outdir, "star_wblue.png")
    img = Image.open(path)
    pixels = list(img.getdata())
    avg_r = sum(p[0] for p in pixels) / len(pixels)
    avg_b = sum(p[2] for p in pixels) / len(pixels)
    assert avg_b - avg_r >= 40, f"star_wblue: B={avg_b:.1f} R={avg_r:.1f} diff={avg_b - avg_r:.1f}"


def test_trim_red_is_red():
    """trim_red is mostly red."""
    outdir = "/tmp/tb_textures_test"
    path = os.path.join(outdir, "trim_red.png")
    img = Image.open(path)
    pixels = list(img.getdata())
    # Count pixels where red is the dominant channel
    red_dominant = sum(1 for p in pixels if p[0] >= p[1] and p[0] >= p[2])
    proportion = red_dominant / len(pixels)
    assert proportion >= 0.5, f"trim_red: red-dominant pixels={red_dominant}/{len(pixels)}={proportion:.2f}"


def test_trim_blue_is_blue():
    """trim_blue is mostly blue."""
    outdir = "/tmp/tb_textures_test"
    path = os.path.join(outdir, "trim_blue.png")
    img = Image.open(path)
    pixels = list(img.getdata())
    # Count pixels where blue is the dominant channel
    blue_dominant = sum(1 for p in pixels if p[2] >= p[0] and p[2] >= p[1])
    proportion = blue_dominant / len(pixels)
    assert proportion >= 0.5, f"trim_blue: blue-dominant pixels={blue_dominant}/{len(pixels)}={proportion:.2f}"


if __name__ == "__main__":
    test_textures_exist()
    test_distinct_colours()
    test_wall_grey_rgb_similar()
    test_star_wblue_blue_exceeds_red()
    test_trim_red_is_red()
    test_trim_blue_is_blue()
    print("\nAll tests passed!")