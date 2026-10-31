"""Generate Android Jeda adaptive icons, legacy icons, and splash screens from the official cleaned logo."""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1] / "android/app/src/main/res"
CLEAN_LOGO_PATH = Path(__file__).resolve().parents[1] / "artifacts/branding/logo-jeda-clean-1024.png"

BACKGROUND = "#10120f"
SURFACE = "#181c18"
LIME = "#c5ef75"
FONT_PATH = Path("C:/Windows/Fonts/segoeuib.ttf")

# Load base high-res cleaned logo
base_logo = Image.open(CLEAN_LOGO_PATH).convert("RGBA")


def make_legacy_icon(size: int, shape: str) -> Image.Image:
    """Create legacy rounded-rect or circular launcher icon."""
    scale = 4
    large = size * scale
    img = Image.new("RGBA", (large, large), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    if shape == "round":
        draw.ellipse((0, 0, large - 1, large - 1), fill=BACKGROUND)
    else:
        radius = round(0.22 * large)
        draw.rounded_rectangle((0, 0, large - 1, large - 1), radius=radius, fill=BACKGROUND)

    # Content size is ~70% of canvas
    content_size = round(large * 0.70)
    logo_resized = base_logo.resize((content_size, content_size), Image.Resampling.LANCZOS)
    pos_x = (large - content_size) // 2
    pos_y = (large - content_size) // 2
    img.paste(logo_resized, (pos_x, pos_y), logo_resized)

    return img.resize((size, size), Image.Resampling.LANCZOS)


def make_adaptive_foreground(size: int) -> Image.Image:
    """
    Create adaptive icon foreground.
    Android specs: Canvas is 108dp. Safe zone is 66dp centered (61.1%).
    We fit content within 60dp to ensure it's NEVER clipped by any OEM mask.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    content_size = round(size * (60.0 / 108.0))
    logo_resized = base_logo.resize((content_size, content_size), Image.Resampling.LANCZOS)
    pos_x = (size - content_size) // 2
    pos_y = (size - content_size) // 2
    img.paste(logo_resized, (pos_x, pos_y), logo_resized)
    return img


# 1. Update mipmap densities
densities = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

for density, (legacy_size, foreground_size) in densities.items():
    folder = ROOT / f"mipmap-{density}"
    folder.mkdir(parents=True, exist_ok=True)
    make_legacy_icon(legacy_size, "square").save(folder / "ic_launcher.png")
    make_legacy_icon(legacy_size, "round").save(folder / "ic_launcher_round.png")
    make_adaptive_foreground(foreground_size).save(folder / "ic_launcher_foreground.png")

# 2. Update Splash Screens
splash_files = list(ROOT.glob("drawable*/splash.png"))
for path in splash_files:
    orig = Image.open(path)
    width, height = orig.size
    splash = Image.new("RGB", (width, height), BACKGROUND)

    # Logo size ~28% of shortest dimension
    icon_size = round(min(width, height) * 0.28)
    logo_resized = base_logo.resize((icon_size, icon_size), Image.Resampling.LANCZOS)

    center_x = (width - icon_size) // 2
    center_y = (height - icon_size) // 2 - (icon_size // 6)
    splash.paste(logo_resized, (center_x, center_y), logo_resized)

    if FONT_PATH.is_file():
        draw = ImageDraw.Draw(splash)
        font_size = max(20, round(icon_size * 0.24))
        font = ImageFont.truetype(str(FONT_PATH), font_size)
        text = "Jeda"
        box = draw.textbbox((0, 0), text, font=font)
        text_w = box[2] - box[0]
        text_x = (width - text_w) // 2
        text_y = center_y + icon_size + round(icon_size * 0.12)
        draw.text((text_x, text_y), text, font=font, fill=LIME)

    splash.save(path)

print(f"Generated icons for {len(densities)} densities and {len(splash_files)} splash screens.")
