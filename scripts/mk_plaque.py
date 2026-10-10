#!/usr/bin/env python3
"""Generate a credits plaque texture for the QWTF build stamp.

Draws a 256x128 stone-like plaque with the credits text rendered in plain
lettering. Uses the build date from web/build.json.

Output: build/eggs/plaque_credits.png (256x128)
"""

import json
import os
from PIL import Image, ImageDraw, ImageFont


def main():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    web_dir = os.path.join(root, "web")
    build_dir = os.path.join(root, "build", "eggs")

    # Read build date from web/build.json
    build_json_path = os.path.join(web_dir, "build.json")
    with open(build_json_path, "r") as f:
        build_data = json.load(f)

    built = build_data.get("built", "unknown")
    sha = build_data.get("sha", "unknown")

    # Create 256x128 image with stone background
    bg_color = (130, 130, 120)  # aged stone grey
    plaque = Image.new("RGB", (256, 128), bg_color)
    draw = ImageDraw.Draw(plaque)

    # Try to use a default font; fall back to basic if not available
    try:
        # Try to load a TTF font; use a small system font
        font_paths = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        ]
        font = None
        for fp in font_paths:
            if os.path.exists(fp):
                font = ImageFont.truetype(fp, 16)
                break
        if font is None:
            font = ImageFont.load_default()
    except Exception:
        font = ImageFont.load_default()

    # Draw text on the plaque - multi-line with credits and build info
    lines = [
        "Credits",
        "",
        "Built by Jason Wolff",
        "with Claude Code (Opus 5.5)",
        "and OpenCode (space bunny, via OpenRouter) and Nemotron",
        "",
        f"Build: {built}",
        f"SHA: {sha}",
    ]

    # Calculate total text height
    line_height = font.getbbox("Tg")[3] - font.getbbox("Tg")[1] if hasattr(font, "getbbox") else 20
    total_text_height = len([l for l in lines if l]) * line_height + (len([l for l in lines if l]) - 1) * 4

    # Starting Y position to center text vertically
    y = (128 - total_text_height) // 2

    # Draw each line in dark brown/black text
    text_color = (80, 60, 40)  # dark brown
    for line in lines:
        if not line:
            y += line_height + 4
            continue
        bbox = draw.textbbox((0, 0), line, font=font)
        text_width = bbox[2] - bbox[0]
        x = (256 - text_width) // 2
        draw.text((x, y), line, font=font, fill=text_color)
        y += line_height + 4

    # Ensure output directory exists
    os.makedirs(build_dir, exist_ok=True)

    # Save the plaque
    output_path = os.path.join(build_dir, "plaque_credits.png")
    plaque.save(output_path, "PNG")

    # Print the done-when verification
    im = Image.open(output_path)
    distinct_colors = len(set(im.getdata()))
    print(f"Plaque saved: {output_path}")
    print(f"Size: {im.size}, Distinct colors: {distinct_colors}")


if __name__ == "__main__":
    main()