#!/usr/bin/env python3
"""Generate our plain textures for the QWTF kit.

Draws 64x64 PNG textures with visible texture (noise/lines), not flat colour:
- wall_grey.png: grey stone blocks with darker mortar lines (roughly 4 rows of offset bricks)
- floor_flag.png: darker grey-brown flagstones
- stair_edge.png: a light strip along one edge on a mid-grey base
- door_frame.png: a warm tan or brown frame colour
- trim_red.png and trim_blue.png: team trim bands
- star_wblue.png: blue water (becomes *wblue in the WAD)
"""
import os
import random
from PIL import Image, ImageDraw, ImageFilter


def make_wall_grey():
    """Grey stone blocks with darker mortar lines, roughly 4 rows of offset bricks."""
    img = Image.new("RGB", (64, 64), (100, 100, 100))
    draw = ImageDraw.Draw(img)
    brick_height = 16
    for row in range(4):
        y = row * brick_height
        for col in range(4):
            x = col * 16 + (row % 2) * 8
            # Draw brick with natural colour variation
            brick_color = (80 + random.randint(-5, 5),
                           80 + random.randint(-5, 5),
                           80 + random.randint(-5, 5))
            draw.rectangle([x, y, x + 15, y + brick_height - 1], fill=brick_color)
            # Add mortar lines
            draw.rectangle([x, y, x, y + brick_height - 1], fill=(60, 60, 60))  # left
            draw.rectangle([x + 15, y, x + 15, y + brick_height - 1], fill=(60, 60, 60))  # right
        # Add texture noise within each brick row
        for _ in range(30):
            px = random.randint(col * 16, min((col + 1) * 16 - 1, 63))
            py = random.randint(y + 2, y + brick_height - 3)
            draw.point((px, py), fill=(70, 70, 70))
    # Add overall fine noise across the whole image
    for _ in range(100):
        px = random.randint(0, 63)
        py = random.randint(0, 63)
        noise = random.randint(-15, 15)
        c = max(0, min(255, 100 + noise))
        draw.point((px, py), fill=(c, c, c))
    return img


def make_floor_flag():
    """Darker grey-brown flagstones."""
    img = Image.new("RGB", (64, 64), (80, 70, 50))
    draw = ImageDraw.Draw(img)
    # Draw flagstone rectangles
    stone_width = 12
    stone_height = 12
    for row in range(5):
        for col in range(5):
            x = col * stone_width
            y = row * stone_height
            # Variation in stone color
            color = (80 + random.randint(-10, 10), 70 + random.randint(-10, 10), 50 + random.randint(-10, 10))
            draw.rectangle([x, y, x + stone_width - 1, y + stone_height - 1], fill=color)
            # Add mortar lines between stones
            if col < 4:
                draw.rectangle([x + stone_width, y, x + stone_width, y + stone_height - 1], fill=(60, 50, 30))
            if row < 4:
                draw.rectangle([x, y + stone_height, x + stone_width - 1, y + stone_height], fill=(60, 50, 30))
    # Add some subtle noise
    for _ in range(100):
        px = random.randint(0, 63)
        py = random.randint(0, 63)
        color = (
            max(0, min(255, 70 + random.randint(-20, 20))),
            max(0, min(255, 60 + random.randint(-20, 20))),
            max(0, min(255, 40 + random.randint(-20, 20))),
        )
        draw.point((px, py), fill=color)
    return img


def make_stair_edge():
    """A light strip along one edge on a mid-grey base."""
    img = Image.new("RGB", (64, 64), (120, 120, 120))
    draw = ImageDraw.Draw(img)
    # Light strip along the top-left edge
    # A gradual light area
    for x in range(32):
        for y in range(8):
            ratio = x / 31.0 if x < 31 else 1.0
            ratio = max(0, min(1, ratio))
            # Also factor in y position
            g_ratio = y / 7.0 if y < 7 else 1.0
            g_ratio = max(0, min(1, g_ratio))
            r = int(120 + 45 * ratio)
            g = int(120 + 45 * g_ratio)
            b = int(120 + 20 * ratio)
            img.putpixel((x, y), (r, g, b))
    # Add some line texture in the stair
    for i in range(0, 64, 4):
        draw.line([(i, 0), (i, 63)], fill=(100, 100, 100), width=1)
    return img


def make_door_frame():
    """A warm tan or brown frame colour."""
    img = Image.new("RGB", (64, 64), (150, 110, 80))
    draw = ImageDraw.Draw(img)
    # Add vertical panel lines with slight colour variation
    for pos in [20, 44]:
        color = (100 + random.randint(-5, 5), 80 + random.randint(-5, 5), 50 + random.randint(-5, 5))
        draw.line([(pos, 10), (pos, 53)], fill=color, width=1)
    # Add horizontal panel lines
    for pos in [20, 40]:
        color = (100 + random.randint(-5, 5), 80 + random.randint(-5, 5), 50 + random.randint(-5, 5))
        draw.line([(10, pos), (53, pos)], fill=color, width=1)
    # Add screw holes / detail with variation
    for pos in [(15, 15), (15, 35), (35, 15), (35, 35)]:
        c = (100 + random.randint(-5, 5), 70 + random.randint(-5, 5), 40 + random.randint(-5, 5))
        draw.ellipse([pos[0]-3, pos[1]-3, pos[0]+3, pos[1]+3], fill=c)
    # Add overall subtle noise
    for _ in range(100):
        px = random.randint(0, 63)
        py = random.randint(0, 63)
        noise = random.randint(-10, 10)
        c = max(0, min(255, 150 + noise))
        g = max(0, min(255, 110 + noise))
        b = max(0, min(255, 80 + noise))
        draw.point((px, py), fill=(c, g, b))
    return img


def make_trim_red():
    """A red team trim band."""
    img = Image.new("RGB", (64, 64), (50, 0, 0))
    draw = ImageDraw.Draw(img)
    # Add horizontal stripe variation
    for i in range(0, 64, 4):
        # Vary the red intensity across stripes
        intensity = 30 + random.randint(-10, 10) + (i // 4) % 3 * 20
        intensity = max(0, min(255, intensity))
        draw.line([(0, i), (63, i)], fill=(intensity, 10, 10), width=1)
    # Add some horizontal lines at different intensities
    for _ in range(20):
        y = random.randint(0, 63)
        intensity = 30 + random.randint(-10, 10)
        intensity = max(0, min(255, intensity))
        draw.line([(0, y), (63, y)], fill=(intensity, 10, 10), width=random.randint(1, 2))
    # Add diagonal stripe detail with variation
    for i in range(0, 64, 3):
        intensity = 40 + random.randint(-5, 5)
        intensity = max(0, min(255, intensity))
        draw.line([(0, i), (i, 63)], fill=(intensity, 20, 20), width=1)
    # Add subtle noise
    for _ in range(100):
        px = random.randint(0, 63)
        py = random.randint(0, 63)
        noise = random.randint(-15, 15)
        r = max(0, min(255, 50 + noise))
        g = max(0, min(255, 0 + noise // 2))
        b = max(0, min(255, 0 + noise // 2))
        draw.point((px, py), fill=(r, g, b))
    return img


def make_trim_blue():
    """A blue team trim band."""
    img = Image.new("RGB", (64, 64), (30, 50, 120))
    draw = ImageDraw.Draw(img)
    # Add horizontal stripe variation
    for i in range(0, 64, 4):
        # Vary the blue intensity across stripes
        intensity = 70 + random.randint(-10, 10) + (i // 4) % 3 * 20
        intensity = max(0, min(255, intensity))
        draw.line([(0, i), (63, i)], fill=(10, 20, intensity), width=1)
    # Add some horizontal lines at different intensities
    for _ in range(20):
        y = random.randint(0, 63)
        intensity = 70 + random.randint(-10, 10)
        intensity = max(0, min(255, intensity))
        draw.line([(0, y), (63, y)], fill=(10, 20, intensity), width=random.randint(1, 2))
    # Add diagonal stripe detail with variation
    for i in range(0, 64, 3):
        intensity = 80 + random.randint(-5, 5)
        intensity = max(0, min(255, intensity))
        draw.line([(0, 63-i), (i, 0)], fill=(20, 30, intensity), width=1)
    # Add subtle noise
    for _ in range(100):
        px = random.randint(0, 63)
        py = random.randint(0, 63)
        noise = random.randint(-15, 15)
        r = max(0, min(255, 30 + noise // 2))
        g = max(0, min(255, 50 + noise))
        b = max(0, min(255, 120 + noise))
        draw.point((px, py), fill=(r, g, b))
    return img


def make_star_wblue():
    """Blue water (becomes *wblue in the WAD)."""
    img = Image.new("RGB", (64, 64), (20, 40, 100))
    draw = ImageDraw.Draw(img)
    # Add water ripple pattern
    for _ in range(100):
        x = random.randint(0, 63)
        y = random.randint(0, 63)
        # Radial ripple from center points
        cx, cy = 32, 32
        dist = ((x - cx) ** 2 + (y - cy) ** 2) ** 0.5
        intensity = int(80 * (1 - dist / 40.0))
        intensity = max(0, min(255, intensity))
        draw.point((x, y), fill=(20 + intensity, 40 + intensity // 2, 100 + intensity // 4))
    # Add some horizontal lines for water effect
    for i in range(0, 64, 4):
        draw.line([(0, i), (63, i)], fill=(40, 60, 140), width=1)
    return img


def main():
    outdir = os.sys.argv[1] if len(os.sys.argv) > 1 else "/tmp/tb_textures"
    os.makedirs(outdir, exist_ok=True)

    textures = {
        "wall_grey": make_wall_grey,
        "floor_flag": make_floor_flag,
        "stair_edge": make_stair_edge,
        "door_frame": make_door_frame,
        "trim_red": make_trim_red,
        "trim_blue": make_trim_blue,
        "star_wblue": make_star_wblue,
    }

    for name, fn in textures.items():
        img = fn()
        outpath = os.path.join(outdir, f"{name}.png")
        img.save(outpath, "PNG")
        print(f"Saved {outpath} size={img.size}")

    # Print summary for verification
    print("\nTexture summary:")
    for name in textures:
        img = Image.open(os.path.join(outdir, f"{name}.png"))
        distinct = len(set(img.getdata()))
        avg_r = sum(pixel[0] for pixel in img.getdata()) / (64 * 64)
        avg_g = sum(pixel[1] for pixel in img.getdata()) / (64 * 64)
        avg_b = sum(pixel[2] for pixel in img.getdata()) / (64 * 64)
        print(f"  {name}: {img.size}, distinct_colors={distinct}, avg_R={avg_r:.1f} avg_G={avg_g:.1f} avg_B={avg_b:.1f}")


if __name__ == "__main__":
    main()