"""Build the SlideX app icon (icon.icns, icon.png): the S^X mark from the
wordmark (tools/logo/iconmark.tex, typeset in Computer Modern) on a navy tile."""
import os
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
MARK = os.path.join(HERE, '..', 'tools', 'logo', 'iconmark.png')
NAVY_TOP, NAVY_BOTTOM = (40, 70, 112), (20, 38, 66)


def tile(n):
    """macOS icon grid: an 824 px rounded square centred on 1024, soft shadow."""
    s = n / 1024
    im = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    box = [100 * s, 100 * s, 924 * s, 924 * s]
    shadow = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([box[0], box[1] + 10 * s, box[2], box[3] + 10 * s],
                                             radius=185 * s, fill=(0, 0, 0, 90))
    im.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(14 * s)))
    grad = Image.new('RGBA', (n, n))
    gd = ImageDraw.Draw(grad)
    for y in range(n):
        t = min(max((y - box[1]) / (box[3] - box[1]), 0), 1)
        gd.line([(0, y), (n, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(NAVY_TOP, NAVY_BOTTOM)) + (255,))
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle(box, radius=185 * s, fill=255)
    im.paste(grad, (0, 0), mask)
    return im


def draw(n=1024):
    im = tile(n)
    mark = Image.open(MARK).convert('RGBA')
    mark = mark.crop(mark.getbbox())
    h = int(0.40 * n)                          # mark height: 40 % of the canvas
    w = int(mark.width * h / mark.height)
    mark = mark.resize((w, h), Image.LANCZOS)
    x = (n - w) // 2 + int(0.01 * n)
    y = (n - h) // 2 + int(0.015 * n)          # optical centre: the S sits a touch low
    im.alpha_composite(mark, (x, y))
    return im


def main(out):
    tmp = tempfile.mkdtemp()
    iconset = os.path.join(tmp, 'icon.iconset')
    os.mkdir(iconset)
    big = draw(1024)
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            px = size * scale
            big.resize((px, px), Image.LANCZOS).save(
                os.path.join(iconset, f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"))
    try:
        subprocess.run(['iconutil', '-c', 'icns', iconset, '-o', out], check=True,
                       stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except (OSError, subprocess.CalledProcessError):
        big.save(out, format='ICNS')
    big.save(os.path.join(HERE, 'icon.png'))
    shutil.rmtree(tmp)
    print('wrote', out)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'icon.icns'))
