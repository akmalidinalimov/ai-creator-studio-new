# Renders the student groups' morning / evening post images (group-room edge function) in the Challenge 6.0 style
# (the day images in public/challenge/days): dark navy, a coral or violet glow, Unbounded display + Onest body.
# One image per weekday and kind → public/group-room/{morning,evening}-{0..6}.jpg (0 = Sunday, like JS getUTCDay()).
# Run: python scripts/render-group-room-images.py
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "public" / "group-room"
FONTS = ROOT / "public" / "fonts"
W, H = 1280, 720

NAVY = (17, 14, 38)
WHITE = (244, 241, 255)
CORAL = (255, 122, 89)
SOFT = (196, 190, 228)
VIOLET = (150, 120, 255)

# (white line, accent line, bottom line) per weekday 0..6
MORNING = {
    1: ("YANGI HAFTA,", "YANGI ISHLAR", "Bugun: dars → amaliyot → ishingizni ulashing"),
    2: ("BUGUN", "YARATAMIZ", "Rasm · Video · Prompt — bittasini sinab koʻring"),
    3: ("BIRGA", "OʻSAMIZ", "Savol bering · Yordam bering · Ilhom bering"),
    4: ("IJOD", "VAQTI", "Bugun bitta yangi rasm yoki video yarating"),
    5: ("JUMA", "ILHOMI", "Haftaning eng yaxshi ishini Instagram'ga joylang"),
    6: ("AMALIYOT", "KUNI", "Darsda koʻrganingizni bugun qoʻlda sinab koʻring"),
    0: ("DAM OLING,", "IJOD QILING", "Yakshanba — erkin ijod uchun eng yaxshi kun"),
}
EVENING = {
    1: ("RAHMAT,", "JAMOA!", "Haftaning birinchi kuni ajoyib oʻtdi"),
    2: ("AJOYIB", "KUN BOʻLDI", "Bugungi har bir qadam uchun rahmat"),
    3: ("BUGUN HAM", "OʻSDINGIZ", "Har bir ish — portfolio uchun yana bir sahifa"),
    4: ("SIZ BILAN", "FAXRLANAMIZ", "Bugun qilgan ishlaringiz uchun rahmat"),
    5: ("JUMA", "MUBORAK", "Hafta yakuniga chiroyli kun bilan yetdik"),
    6: ("YAXSHI", "DAM OLING", "Bugungi mehnatingiz uchun katta rahmat"),
    0: ("ERTAGA", "YANA DAVOM", "Yangi hafta — yangi imkoniyatlar"),
}


_STATIC: dict = {}


def font(name: str, size: int, weight: int) -> ImageFont.FreeTypeFont:
    """A STATIC instance of the variable font at `weight` (fontTools), so glyph boxes match the weight drawn."""
    key = (name, weight)
    if key not in _STATIC:
        import tempfile

        from fontTools.ttLib import TTFont
        from fontTools.varLib import instancer

        inst = instancer.instantiateVariableFont(TTFont(str(FONTS / name)), {"wght": weight},
                                                 overlap=instancer.OverlapMode.KEEP_AND_SET_FLAGS)
        path = Path(tempfile.gettempdir()) / f"group-room-{Path(name).stem}-{weight}.ttf"
        inst.save(str(path))
        _STATIC[key] = str(path)
    return ImageFont.truetype(_STATIC[key], size)


def glow(img: Image.Image, center, radius: int, color, alpha: int) -> None:
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    x, y = center
    d.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*color, alpha))
    layer = layer.filter(ImageFilter.GaussianBlur(radius // 2))
    img.alpha_composite(layer)


# PIL's basic layout keeps the DEFAULT weight's advances when a variable font is set to a heavier weight, so heavy
# display text overlaps ("SIZ BILAN"). Every line is therefore laid out glyph by glyph from each glyph's own ink box.
def tracked_width(text: str, f: ImageFont.FreeTypeFont, track: float) -> float:
    w = 0.0
    for ch in text:
        if ch == " ":
            w += f.size * 0.3
            continue
        b = f.getbbox(ch)
        w += (b[2] - b[0]) + f.size * track
    return w - (f.size * track if text and text[-1] != " " else 0)


def draw_tracked(d: ImageDraw.ImageDraw, xy, text: str, f: ImageFont.FreeTypeFont, fill, track: float) -> None:
    x, y = xy
    for ch in text:
        if ch == " ":
            x += f.size * 0.3
            continue
        b = f.getbbox(ch)
        d.text((x - b[0], y), ch, font=f, fill=fill)
        x += (b[2] - b[0]) + f.size * track


def fit(text: str, name: str, weight: int, max_w: int, start: int, track: float) -> ImageFont.FreeTypeFont:
    size = start
    while size > 24:
        f = font(name, size, weight)
        if tracked_width(text, f, track) <= max_w:
            return f
        size -= 4
    return font(name, size, weight)


def render(kind: str, dow: int, lines) -> None:
    white, accent, bottom = lines
    img = Image.new("RGBA", (W, H), (*NAVY, 255))
    if kind == "morning":
        glow(img, (1120, 40), 360, (200, 70, 50), 150)   # sunrise, top right
        glow(img, (60, 760), 300, (90, 60, 220), 120)
        accent_color, chip = CORAL, "XAYRLI TONG"
    else:
        glow(img, (1100, 80), 320, (110, 80, 240), 150)  # moonlight, top right
        glow(img, (80, 780), 300, (200, 70, 90), 90)
        accent_color, chip = VIOLET, "XAYRLI KECH"

    # translucent pieces on their own layer, then composited (drawing RGBA straight onto the image does not blend)
    over = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    o = ImageDraw.Draw(over)
    for x in range(0, W, 64):                             # faint grid, like the day images
        o.line((x, 0, x, H), fill=(255, 255, 255, 10))
    for y in range(0, H, 64):
        o.line((0, y, W, y), fill=(255, 255, 255, 10))
    chip_f = font("Onest[wght].ttf", 26, 700)
    cw = tracked_width(chip, chip_f, 0.06) + 64 + 26
    o.rounded_rectangle((W - 80 - cw, 64, W - 80, 122), radius=29, outline=(255, 255, 255, 110), width=2,
                        fill=(255, 255, 255, 16))
    for i in range(7):                                    # weekday dots, Monday first; today = the accent
        cx = W - 80 - (6 - i) * 24
        if (i + 1) % 7 != dow:
            o.ellipse((cx - 6, 636, cx + 6, 648), fill=(255, 255, 255, 70))
    img.alpha_composite(over)

    d = ImageDraw.Draw(img)
    for i in range(7):
        cx = W - 80 - (6 - i) * 24
        if (i + 1) % 7 == dow:
            d.ellipse((cx - 7, 635, cx + 7, 649), fill=accent_color)
    # chip: a sun (filled disc) or a moon (crescent) drawn as shapes — the fonts have no ☀ / ☾ glyph
    ix, iy = W - 80 - cw + 30, 93
    if kind == "morning":
        d.ellipse((ix - 9, iy - 9, ix + 9, iy + 9), fill=CORAL)
    else:
        d.ellipse((ix - 10, iy - 10, ix + 10, iy + 10), fill=VIOLET)
        d.ellipse((ix - 4, iy - 14, ix + 14, iy + 4), fill=(38, 32, 74))
    draw_tracked(d, (W - 80 - cw + 52, 77), chip, chip_f, WHITE, 0.06)

    top = font("Unbounded[wght].ttf", 30, 800)
    draw_tracked(d, (80, 80), "AI CREATORS", top, WHITE, 0.04)
    draw_tracked(d, (80 + tracked_width("AI CREATORS ", top, 0.04) + 10, 80), "CHALLENGE 6.0", top, (255, 176, 156), 0.04)

    size = min(fit(white, "Unbounded[wght].ttf", 900, W - 160, 150, 0.04).size,
               fit(accent, "Unbounded[wght].ttf", 900, W - 160, 150, 0.04).size)
    big = font("Unbounded[wght].ttf", size, 900)
    y1 = 372 - size - 14
    draw_tracked(d, (80, y1), white, big, WHITE, 0.04)
    draw_tracked(d, (80, y1 + size + 26), accent, big, accent_color, 0.04)

    body = fit(bottom, "Onest[wght].ttf", 600, W - 330, 32, 0.012)
    draw_tracked(d, (80, 622), bottom, body, SOFT, 0.012)

    OUT.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(OUT / f"{kind}-{dow}.jpg", quality=88, optimize=True, progressive=True)


if __name__ == "__main__":
    for dow, lines in MORNING.items():
        render("morning", dow, lines)
    for dow, lines in EVENING.items():
        render("evening", dow, lines)
    print("rendered", len(MORNING) + len(EVENING), "images →", OUT)
