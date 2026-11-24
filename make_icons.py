#!/usr/bin/env python3
"""生成 PWA 图标：普通图标（带圆角）+ maskable（满背景、内容收进安全区）。"""
import pathlib
from PIL import Image, ImageDraw

BG = (11, 13, 18)
CARD = (21, 25, 34)
ACC = (124, 140, 255)
GOOD = (74, 222, 128)


def draw(size, maskable=False):
    s = size
    img = Image.new('RGB', (s, s), BG)
    d = ImageDraw.Draw(img)

    if maskable:
        # maskable：背景铺满，内容压到中心 62%，躲开圆形/圆角裁切
        inset = 0.0
        scale = 0.62
    else:
        inset = 0.10
        scale = 1.0
        pad = int(s * inset)
        d.rounded_rectangle([pad, pad, s - pad, s - pad],
                            radius=int(s * 0.22), fill=CARD)

    # 以中心为基准缩放坐标
    def P(x, y):
        cx = 0.5
        px = cx + (x - cx) * scale
        py = cx + (y - cx) * scale
        return (int(px * s), int(py * s))

    w = max(2, int(s * (0.052 if maskable else 0.055)))
    pts = [(0.22, 0.66), (0.40, 0.47), (0.55, 0.58), (0.72, 0.34), (0.80, 0.40)]
    Pp = [P(x, y) for x, y in pts]
    d.line(Pp, fill=ACC, width=w, joint='curve')
    for p in (Pp[0], Pp[-1]):
        rr = w // 2
        d.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], fill=ACC)
    tip = Pp[-1]
    rr = int(s * (0.050 if maskable else 0.055) * (scale if maskable else 1))
    d.ellipse([tip[0] - rr, tip[1] - rr, tip[0] + rr, tip[1] + rr], fill=GOOD)
    return img


jobs = [
    ('icon-192.png', 192, False),
    ('icon-512.png', 512, False),
    ('icon-512-maskable.png', 512, True),
]
SS = 4  # 超采样倍数：先按 4 倍尺寸画，再 LANCZOS 缩小，消除折线锯齿
out = pathlib.Path(__file__).resolve().parent
for name, size, mk in jobs:
    big = draw(size * SS, mk)
    im = big.resize((size, size), Image.Resampling.LANCZOS)
    im = im.convert('P', palette=Image.ADAPTIVE, colors=96)
    im.save(out / name, optimize=True)
    print('wrote', name, im.size, '(supersampled x%d)' % SS)
