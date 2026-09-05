#!/usr/bin/env python3
"""Regenerate the PWA icon set in pwa/icons/ from logo.png.

Only needs to run when the logo changes; the generated PNGs are committed so a
normal `npm run build` has no Python/Pillow dependency.

    python3 scripts/generate-icons.py
"""
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "logo.png"
OUT = ROOT / "pwa" / "icons"

# Brand blue, sampled from the logo disc, so a full-bleed tile is seamless.
BRAND = (0, 112, 243, 255)

# Maskable icons must keep their artwork inside the inner 80% safe zone, since
# the platform may crop the tile to a circle, squircle, rounded square, etc.
SAFE_ZONE = 0.8


def load() -> Image.Image:
    return Image.open(SOURCE).convert("RGBA")


def transparent(logo: Image.Image, size: int) -> Image.Image:
    return logo.resize((size, size), Image.LANCZOS)


def full_bleed(logo: Image.Image, size: int, scale: float) -> Image.Image:
    # Flatten onto the brand colour at source resolution first: resampling a
    # transparent edge would otherwise ring and leave a visible disc outline
    # against the identically coloured tile.
    flat = Image.new("RGBA", logo.size, BRAND)
    flat.alpha_composite(logo)

    tile = Image.new("RGBA", (size, size), BRAND)
    inner = max(1, round(size * scale))
    offset = (size - inner) // 2
    tile.paste(flat.resize((inner, inner), Image.LANCZOS), (offset, offset))
    return tile


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    logo = load()

    written = [
        ("icon-192.png", transparent(logo, 192)),
        ("icon-512.png", transparent(logo, 512)),
        ("icon-192-maskable.png", full_bleed(logo, 192, SAFE_ZONE)),
        ("icon-512-maskable.png", full_bleed(logo, 512, SAFE_ZONE)),
        # iOS applies its own rounded-rect mask and does not honour maskable,
        # so the apple touch icon is opaque and only lightly inset.
        ("apple-touch-icon-180.png", full_bleed(logo, 180, 0.92)),
    ]

    for name, image in written:
        image.save(OUT / name, "PNG", optimize=True)
        print(f"wrote {(OUT / name).relative_to(ROOT)} ({image.width}x{image.height})")


if __name__ == "__main__":
    main()
