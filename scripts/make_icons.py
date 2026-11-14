#!/usr/bin/env python3
"""Generate every icon the app ships from one master image.

    python3 scripts/make_icons.py        # needs Pillow

There is one source of truth, `assets/headroom-icon.png`, and everything under
`apps/web/public/` is derived from it. Icons drift otherwise: a new logo lands
in the favicon and not in the maskable one, nobody notices for months because
the maskable only shows on an Android home screen, and the app ends up with
two logos depending on where you look at it.

Three things are easy to get wrong and are handled here:

* **Trimming.** The master has transparent margins, and they are not even -
  the arrow reaches the left edge while the top has 69px of nothing. Scaling
  the whole canvas would centre the empty space rather than the logo, so it
  is trimmed to its content first and re-centred.

* **The maskable safe zone.** Android crops a maskable icon to whatever shape
  the launcher uses, which may be a circle. Anything outside the middle 80%
  can be cut, so the logo is placed smaller again than that, and on a solid
  background - a maskable icon with transparent corners gets them filled with
  something that is not our choosing.

* **Apple.** iOS composites transparency onto black and applies its own
  rounded-square mask, so the touch icon is drawn on the same solid
  background rather than shipped transparent.
"""

from __future__ import annotations

import pathlib
import sys

try:
    from PIL import Image
except ModuleNotFoundError:  # pragma: no cover - a developer's machine
    sys.exit("This needs Pillow:  python3 -m pip install --user Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
MASTER = ROOT / "assets" / "headroom-icon.png"
OUT = ROOT / "apps" / "web" / "public"

# `--hr-ground` from the default theme, so an icon on a solid background is
# the same colour as the app behind it.
BACKGROUND = (245, 244, 239, 255)

# How much of the canvas the logo fills, per kind of icon.
TRANSPARENT_FILL = 0.94  # nothing crops these, so they can be generous
MASKABLE_FILL = 0.74  # inside the middle 80%, with room for a circular mask
APPLE_FILL = 0.82  # iOS rounds the corners but does not crop to a circle


def trimmed_master() -> Image.Image:
    """The logo with its transparent margins removed."""
    image = Image.open(MASTER).convert("RGBA")
    box = image.getbbox()
    if box is None:
        sys.exit(f"{MASTER} is entirely transparent.")
    return image.crop(box)


def render(logo: Image.Image, size: int, fill: float, background: tuple | None) -> Image.Image:
    """The logo centred on a square canvas, filling `fill` of its width."""
    canvas = Image.new("RGBA", (size, size), background or (0, 0, 0, 0))

    budget = round(size * fill)
    scale = min(budget / logo.width, budget / logo.height)
    scaled = logo.resize(
        (max(1, round(logo.width * scale)), max(1, round(logo.height * scale))),
        Image.LANCZOS,
    )

    canvas.alpha_composite(
        scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2)
    )
    return canvas


def save(image: Image.Image, name: str) -> None:
    path = OUT / name
    image.save(path, optimize=True)
    print(f"  {name:<28} {path.stat().st_size / 1024:6.1f} kB  {image.width}x{image.height}")


def main() -> None:
    if not MASTER.exists():
        sys.exit(f"No master image at {MASTER}.")

    OUT.mkdir(parents=True, exist_ok=True)
    logo = trimmed_master()
    print(f"master {MASTER.name}: {logo.width}x{logo.height} after trimming\n")

    # The manifest's `any` icons. Transparent: the browser or the launcher
    # decides what goes behind them.
    save(render(logo, 192, TRANSPARENT_FILL, None), "icon-192.png")
    save(render(logo, 512, TRANSPARENT_FILL, None), "icon-512.png")

    # The manifest's `maskable` icon, which Android crops to its own shape.
    save(render(logo, 512, MASKABLE_FILL, BACKGROUND), "icon-maskable-512.png")

    # iOS, which ignores the manifest's icons entirely.
    save(render(logo, 180, APPLE_FILL, BACKGROUND), "apple-touch-icon.png")

    # The browser tab. Three sizes in one file, because a 48px icon scaled
    # down to 16 by the browser turns the bars into mush.
    favicon = render(logo, 256, TRANSPARENT_FILL, None)
    favicon.save(OUT / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    print(
        f"  {'favicon.ico':<28} "
        f"{(OUT / 'favicon.ico').stat().st_size / 1024:6.1f} kB  16/32/48"
    )


if __name__ == "__main__":
    main()
