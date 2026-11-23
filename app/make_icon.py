"""Draw the SlideX icon (a slide with a play button) as icon.icns."""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))


def draw(n):
    s = n / 1024
    im = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # macOS icon grid: 824 px rounded square centered on 1024
    d.rounded_rectangle([100 * s, 100 * s, 924 * s, 924 * s], radius=185 * s, fill=(28, 52, 86, 255))
    # the slide
    d.rounded_rectangle([200 * s, 270 * s, 824 * s, 700 * s], radius=26 * s, fill=(250, 250, 247, 255))
    d.rectangle([200 * s, 270 * s, 824 * s, 340 * s], fill=(61, 120, 190, 255))
    d.rounded_rectangle([200 * s, 270 * s, 824 * s, 340 * s], radius=26 * s, fill=(61, 120, 190, 255))
    d.rectangle([200 * s, 300 * s, 824 * s, 340 * s], fill=(61, 120, 190, 255))
    # play triangle
    d.polygon([(450 * s, 405 * s), (450 * s, 625 * s), (630 * s, 515 * s)], fill=(28, 52, 86, 255))
    # scrub bar
    d.rounded_rectangle([250 * s, 760 * s, 774 * s, 784 * s], radius=12 * s, fill=(120, 150, 190, 255))
    d.rounded_rectangle([250 * s, 760 * s, 560 * s, 784 * s], radius=12 * s, fill=(110, 205, 255, 255))
    d.ellipse([536 * s, 748 * s, 584 * s, 796 * s], fill=(255, 255, 255, 255))
    return im


def main(out):
    tmp = tempfile.mkdtemp()
    iconset = os.path.join(tmp, "icon.iconset")
    os.mkdir(iconset)
    big = draw(1024)
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = size * scale
            big.resize((px, px), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"))
    subprocess.run(["iconutil", "-c", "icns", iconset, "-o", out], check=True)
    big.save(os.path.join(HERE, "icon.png"))
    shutil.rmtree(tmp)
    print("wrote", out)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, "icon.icns"))
