"""Generate the Android Jeda icon and splash images with Pillow."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1] / "android/app/src/main/res"
LIME = "#c5ef75"
DARK = "#17200c"
BACKGROUND = "#10120f"
SCALE = 4


def draw_j(draw, size, color):
    unit = size / 108
    points = [(39, 35), (73, 35), (73, 63), (71, 71), (66, 77), (59, 80), (51, 80), (43, 77), (37, 71)]
    draw.line([(round(x * unit), round(y * unit)) for x, y in points], fill=color, width=round(10 * unit), joint="curve")
    radius = 5 * unit
    for x, y in (points[0], points[-1]):
        px, py = x * unit, y * unit
        draw.ellipse((px - radius, py - radius, px + radius, py + radius), fill=color)


def make_icon(size, shape):
    large = size * SCALE
    image = Image.new("RGBA", (large, large), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if shape == "round":
        draw.ellipse((0, 0, large - 1, large - 1), fill=LIME)
    elif shape == "square":
        draw.rounded_rectangle((0, 0, large - 1, large - 1), radius=round(23 * large / 108), fill=LIME)
    draw_j(draw, large, DARK)
    return image.resize((size, size), Image.Resampling.LANCZOS)


for density, size in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
    folder = ROOT / f"mipmap-{density}"
    make_icon(size, "square").save(folder / "ic_launcher.png")
    make_icon(size, "round").save(folder / "ic_launcher_round.png")
    make_icon(round(size * 108 / 48), "foreground").save(folder / "ic_launcher_foreground.png")

font_path = Path("C:/Windows/Fonts/segoeuib.ttf")
for path in ROOT.glob("drawable*/splash.png"):
    width, height = Image.open(path).size
    image = Image.new("RGB", (width, height), BACKGROUND)
    icon_size = round(min(width, height) * 0.24)
    icon = make_icon(icon_size, "square")
    image.paste(icon, ((width - icon_size) // 2, (height - icon_size) // 2 - icon_size // 5), icon)
    if font_path.is_file():
        draw = ImageDraw.Draw(image)
        font = ImageFont.truetype(str(font_path), max(18, round(icon_size * 0.25)))
        text = "Jeda"
        box = draw.textbbox((0, 0), text, font=font)
        draw.text(((width - (box[2] - box[0])) // 2, (height + icon_size) // 2 - icon_size // 7), text, font=font, fill=LIME)
    image.save(path)

assert (ROOT / "mipmap-xxxhdpi/ic_launcher.png").is_file()
