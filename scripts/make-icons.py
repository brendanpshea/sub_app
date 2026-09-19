"""Render the launcher icons from the same drawing as public/favicon.svg.

Run with `python scripts/make-icons.py` after changing the design. Needs Pillow.
"""
from PIL import Image, ImageDraw

GREEN, ORANGE, YELLOW = (14, 74, 58), (201, 76, 28), (242, 194, 58)
SS = 4  # supersample, then downscale, for clean edges


def draw(size: int, rounded: bool, inset: float) -> Image.Image:
    """`inset` shrinks the artwork towards the centre (maskable safe zone)."""
    n = size * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    if rounded:
        d.rounded_rectangle([0, 0, n - 1, n - 1], radius=n * 14 / 64, fill=GREEN)
    else:
        d.rectangle([0, 0, n, n], fill=GREEN)

    k = n * (1 - 2 * inset) / 64
    o = n * inset
    p = lambda v: o + v * k
    line = (134, 164, 156)  # white at half opacity over the green
    w = max(1, round(2 * k))
    d.rounded_rectangle([p(12), p(8), p(52), p(56)], radius=2 * k, outline=line, width=w)
    d.line([p(12), p(32), p(52), p(32)], fill=line, width=w)
    d.ellipse([p(24), p(24), p(40), p(40)], outline=line, width=w)
    d.ellipse([p(26.5), p(13.5), p(37.5), p(24.5)], fill=ORANGE)
    d.ellipse([p(26.5), p(39.5), p(37.5), p(50.5)], fill=YELLOW)
    return img.resize((size, size), Image.LANCZOS)


draw(192, True, 0).save('public/icon-192.png')
draw(512, True, 0).save('public/icon-512.png')
draw(512, False, 0.1).save('public/icon-maskable-512.png')
draw(180, False, 0.04).convert('RGB').save('public/apple-touch-icon.png')
print('ok')
