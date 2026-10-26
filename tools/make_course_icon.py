"""Draws the Custom Maps course icon (plugin/Resources/course-icon.png) in the style of the game's course badges:
a rounded crest with a rim, an island with a flag on it, and a folded map corner. Run: python3 tools/make_course_icon.py"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

S = 512
out = Path(__file__).resolve().parent.parent / "plugin" / "Resources" / "course-icon.png"


def crest(draw, inset, fill):
    # Arched top, straight sides, a soft point at the bottom.
    l, t, r, b = 70 + inset, 40 + inset, S - 70 - inset, S - 40 - inset
    w = r - l
    draw.pieslice([l, t, r, t + w], 180, 360, fill=fill)
    draw.polygon([(l, t + w / 2), (r, t + w / 2), (r, b - 90), (S / 2, b), (l, b - 90)], fill=fill)


img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
crest(ImageDraw.Draw(shadow), 0, (0, 0, 0, 90))
img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(10)).transform((S, S), Image.AFFINE, (1, 0, 0, 0, 1, -12)))
d = ImageDraw.Draw(img)
crest(d, 0, (255, 255, 255, 255))  # white outline
crest(d, 14, (54, 120, 182, 255))  # rim
crest(d, 30, (125, 200, 240, 255))  # sky

# Clip the scene to the inner crest.
mask = Image.new("L", (S, S), 0)
crest(ImageDraw.Draw(mask), 30, 255)
scene = Image.new("RGBA", (S, S), (0, 0, 0, 0))
s = ImageDraw.Draw(scene)
s.rectangle([0, 330, S, S], fill=(70, 160, 220, 255))  # sea
s.ellipse([110, 270, 400, 420], fill=(244, 222, 160, 255))  # beach
s.ellipse([128, 255, 382, 395], fill=(108, 196, 80, 255))  # island
s.ellipse([170, 300, 300, 360], fill=(150, 222, 110, 255))  # green
s.ellipse([238, 318, 262, 330], fill=(40, 60, 30, 255))  # cup
s.rectangle([247, 150, 255, 324], fill=(255, 255, 255, 255))  # pole
s.polygon([(255, 152), (345, 180), (255, 210)], fill=(232, 68, 58, 255))  # flag
s.line([(255, 152), (345, 180), (255, 210)], fill=(169, 42, 34, 255), width=6)
# A folded map corner, top left.
s.polygon([(150, 120), (215, 105), (220, 185), (155, 200)], fill=(255, 246, 214, 255))
s.line([(183, 112), (187, 192)], fill=(210, 190, 140, 255), width=4)
s.line([(162, 150), (205, 140)], fill=(232, 68, 58, 255), width=5)
s.line([(168, 175), (210, 165)], fill=(108, 196, 80, 255), width=5)
img.paste(scene, (0, 0), Image.composite(scene, Image.new("RGBA", (S, S)), mask).getchannel("A"))

img.resize((256, 256), Image.LANCZOS).save(out)
print(out)
