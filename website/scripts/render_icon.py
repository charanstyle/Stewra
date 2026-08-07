#!/usr/bin/env python3
"""Render the Stewra mark to a square PNG.

Why a script rather than a checked-in binary somebody once exported: the same artwork exists in
three places — `src/components/StewraMark/StewraMark.tsx` (in-app), `public/favicon.svg` (browser
tab), and `public/icon-1024.png` (Meta's app icon, and anywhere else a raster is demanded). Three
hand-maintained copies drift. This one is generated, so the PNG can never quietly disagree with the
SVG as long as both are edited together and this is re-run.

Why Python and PIL rather than something in the JS toolchain: there is no rasteriser in the repo's
dependencies, no ImageMagick or librsvg on the machine, and macOS QuickLook renders this SVG as a
blank page. PIL is present and can draw the shapes exactly, which is why the geometry below is
deliberately expressible in both SVG and PIL primitives — rounded rectangles, a triangle and three
circles, no arbitrary bezier paths.

    python3 website/scripts/render_icon.py            # writes public/icon-1024.png
    python3 website/scripts/render_icon.py 512 out.png
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

# The design, in the same 64-unit space as the viewBox in favicon.svg. Keep the two in step.
VIEWBOX = 64.0

TILE_RADIUS = 14.0
GRADIENT_FROM = (0x6D, 0x5B, 0xF5)
GRADIENT_TO = (0xB4, 0x4B, 0xEA)

BUBBLE = (13.0, 14.0, 51.0, 40.0)
BUBBLE_RADIUS = 7.0
TAIL = ((23.0, 39.0), (23.0, 50.0), (34.0, 40.0))

DOT_Y = 27.0
DOT_RADIUS = 3.1
DOTS = (
    (24.5, (0x6D, 0x5B, 0xF5)),
    (32.0, (0x8B, 0x54, 0xF0)),
    (39.5, (0xB4, 0x4B, 0xEA)),
)

# Draw large, then shrink. PIL has no antialiasing of its own, so supersampling is what keeps the
# rounded corners and circles from coming out jagged.
SUPERSAMPLE = 4


def diagonal_gradient(size: int) -> Image.Image:
    """The tile fill: a linear gradient along the top-left → bottom-right diagonal.

    Matches `linearGradient x1=0 y1=0 x2=64 y2=64` in the SVG, whose parameter at a point is
    (x + y) / 128 in viewBox units. Built small and scaled up — interpolating 64×64 and resizing is
    visually identical to computing a million pixels, and about a thousand times faster.
    """
    small = Image.new('RGB', (64, 64))
    pixels = small.load()
    if pixels is None:
        raise RuntimeError('PIL returned no pixel access object for the gradient image')
    for y in range(64):
        for x in range(64):
            t = (x + y) / 126.0
            pixels[x, y] = tuple(
                round(GRADIENT_FROM[c] + (GRADIENT_TO[c] - GRADIENT_FROM[c]) * t) for c in range(3)
            )
    return small.resize((size, size), Image.LANCZOS)


def render(size: int, rounded: bool = False) -> Image.Image:
    """Draw the mark at `size` px square.

    `rounded` knocks the tile corners out to transparency, which is right for a browser tab where
    the icon is shown exactly as given. It is wrong for the PNG: Meta's app dashboard and iOS both
    apply their own corner mask, so a pre-rounded icon either gets double-rounded or shows
    transparent corners against whatever colour they composite it on. The PNG is therefore
    full-bleed by default and lets each platform do its own masking.
    """
    work = size * SUPERSAMPLE
    scale = work / VIEWBOX

    def s(value: float) -> float:
        return value * scale

    canvas = diagonal_gradient(work).convert('RGBA')

    if rounded:
        mask = Image.new('L', (work, work), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, work - 1, work - 1), radius=s(TILE_RADIUS), fill=255
        )
        canvas.putalpha(mask)

    draw = ImageDraw.Draw(canvas)

    # The tail is drawn before the bubble body so the seam where they meet is covered by the body.
    draw.polygon([(s(x), s(y)) for x, y in TAIL], fill=(255, 255, 255, 255))
    draw.rounded_rectangle(
        (s(BUBBLE[0]), s(BUBBLE[1]), s(BUBBLE[2]), s(BUBBLE[3])),
        radius=s(BUBBLE_RADIUS),
        fill=(255, 255, 255, 255),
    )

    for cx, colour in DOTS:
        draw.ellipse(
            (
                s(cx - DOT_RADIUS),
                s(DOT_Y - DOT_RADIUS),
                s(cx + DOT_RADIUS),
                s(DOT_Y + DOT_RADIUS),
            ),
            fill=(*colour, 255),
        )

    return canvas.resize((size, size), Image.LANCZOS)


def main() -> int:
    size = int(sys.argv[1]) if len(sys.argv) > 1 else 1024
    here = Path(__file__).resolve().parent
    out = Path(sys.argv[2]) if len(sys.argv) > 2 else here.parent / 'public' / f'icon-{size}.png'
    out.parent.mkdir(parents=True, exist_ok=True)
    render(size).save(out, 'PNG')
    print(f'wrote {out} ({size}x{size})')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
