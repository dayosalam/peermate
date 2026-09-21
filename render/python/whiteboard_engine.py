"""Deterministic whiteboard renderer used by Peermate's restricted scene DSL."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

WIDTH, HEIGHT = 1280, 720
BOARD_BOTTOM = 650
BG = (252, 251, 247, 255)
INK = (30, 41, 59, 255)
FONT_CANDIDATES = (
    "/System/Library/Fonts/Supplemental/Chalkboard.ttc",
    "/System/Library/Fonts/Supplemental/Comic Sans MS.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
)


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONT_CANDIDATES:
        if Path(candidate).exists():
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                pass
    return ImageFont.load_default(size=size)


def color(value: str | None, fallback=INK):
    if not value:
        return fallback
    value = value.lstrip("#")
    if len(value) != 6:
        return fallback
    try:
        return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
    except ValueError:
        return fallback


def point(x: float, y: float) -> tuple[int, int]:
    return (int(55 + x * 1170), int(65 + y * 550))


def ease(value: float) -> float:
    value = max(0.0, min(1.0, value))
    return value * value * (3 - 2 * value)


def text_layer(action: dict[str, Any]) -> tuple[Image.Image, tuple[int, int]]:
    layer = Image.new("RGBA", (WIDTH, HEIGHT), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    xy = point(action["x"], action["y"])
    text = str(action["text"]).translate(str.maketrans({"→": " to ", "⇒": " therefore ", "✓": "", "—": "-", "–": "-"}))
    draw.text(xy, text, font=font(int(action.get("size", 42))), fill=color(action.get("color")))
    return layer, xy


def reveal_text(board: Image.Image, action: dict[str, Any], progress: float) -> tuple[int, int]:
    layer, xy = text_layer(action)
    alpha = layer.getchannel("A")
    bbox = alpha.getbbox()
    if not bbox:
        return xy
    right = bbox[0] + max(1, int((bbox[2] - bbox[0]) * progress))
    mask = Image.new("L", (WIDTH, HEIGHT), 0)
    ImageDraw.Draw(mask).rectangle((bbox[0], bbox[1], right, bbox[3]), fill=255)
    layer.putalpha(Image.composite(alpha, Image.new("L", alpha.size, 0), mask))
    board.alpha_composite(layer)
    return (right, (bbox[1] + bbox[3]) // 2)


def stroke(draw: ImageDraw.ImageDraw, pts: list[tuple[int, int]], progress: float, fill, width=6):
    if len(pts) < 2:
        return pts[0] if pts else (0, 0)
    lengths = [math.dist(a, b) for a, b in zip(pts, pts[1:])]
    target = sum(lengths) * progress
    shown = [pts[0]]
    for start, end, length in zip(pts, pts[1:], lengths):
        if target >= length:
            shown.append(end)
            target -= length
            continue
        ratio = target / max(length, 1)
        shown.append((int(start[0] + (end[0] - start[0]) * ratio), int(start[1] + (end[1] - start[1]) * ratio)))
        break
    if len(shown) > 1:
        draw.line(shown, fill=fill, width=width, joint="curve")
    return shown[-1]


def draw_action(board: Image.Image, action: dict[str, Any], progress: float) -> tuple[int, int] | None:
    if progress <= 0:
        return None
    progress = ease(progress)
    draw = ImageDraw.Draw(board)
    kind = action["type"]
    ink = color(action.get("color"))
    if kind in ("write", "title"):
        return reveal_text(board, action, progress)
    if kind == "bullets":
        items = action["items"]
        each = 1 / max(len(items), 1)
        active = None
        for index, item in enumerate(items):
            local = max(0, min(1, (progress - index * each) / each))
            if local <= 0:
                continue
            bullet = dict(action, type="write", text=f"  {item}", y=action["y"] + index * action.get("spacing", .09), size=action.get("size", 36))
            bx, by = point(action["x"], bullet["y"])
            draw.ellipse((bx, by + 12, bx + 10, by + 22), fill=ink)
            active = reveal_text(board, bullet, local)
        return active
    if kind in ("line", "arrow"):
        start, end = point(action["fromX"], action["fromY"]), point(action["toX"], action["toY"])
        tip = stroke(draw, [start, end], progress, ink)
        if kind == "arrow" and progress > .9:
            angle = math.atan2(end[1] - start[1], end[0] - start[0])
            wings = [
                (end[0] - int(22 * math.cos(angle - .5)), end[1] - int(22 * math.sin(angle - .5))),
                end,
                (end[0] - int(22 * math.cos(angle + .5)), end[1] - int(22 * math.sin(angle + .5))),
            ]
            draw.line(wings, fill=ink, width=6)
        return tip
    if kind in ("box", "highlight"):
        x, y = point(action["x"], action["y"])
        w, h = int(action["width"] * 1170), int(action["height"] * 550)
        if kind == "highlight":
            overlay = Image.new("RGBA", board.size, (0, 0, 0, 0))
            ImageDraw.Draw(overlay).rounded_rectangle((x, y, x + int(w * progress), y + h), radius=8, fill=color(action.get("color"), (250, 204, 21, 120))[:3] + (100,))
            board.alpha_composite(overlay)
            return x + int(w * progress), y + h // 2
        pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
        return stroke(draw, pts, progress, ink)
    if kind == "circle":
        cx, cy = point(action["x"], action["y"])
        radius = int(action["radius"] * 1170)
        end = -90 + 360 * progress
        draw.arc((cx-radius, cy-radius, cx+radius, cy+radius), -90, end, fill=ink, width=6)
        angle = math.radians(end)
        return cx + int(radius * math.cos(angle)), cy + int(radius * math.sin(angle))
    if kind == "road":
        x, y = point(action["x"], action["y"])
        w, h = int(action["width"] * 1170), int(action["height"] * 550)
        pts = [(x, y+h), (x+int(w*.2), y), (x+int(w*.8), y), (x+w, y+h)]
        tip = stroke(draw, pts, progress, ink, 7)
        if progress > .55:
            draw.line((x+w//2, y+5, x+w//2, y+h), fill=(234, 160, 44, 255), width=5)
        return tip
    if kind == "layers":
        names = action["items"]
        x, y = point(action["x"], action["y"])
        w = int(action["width"] * 1170)
        row = int(action.get("rowHeight", .08) * 550)
        active = None
        for index, name in enumerate(names):
            local = max(0, min(1, progress * len(names) - index))
            if local <= 0:
                continue
            active = stroke(draw, [(x, y+index*row), (x+int(w*local), y+index*row)], local, ink, 5)
            if local > .65:
                draw.text((x+w+18, y+index*row-18), name, font=font(28), fill=ink)
        if progress >= 1:
            draw.rectangle((x, y, x+w, y+row*(len(names)-1)), outline=ink, width=5)
        return active
    raise ValueError(f"unsupported action: {kind}")


def render(spec: dict[str, Any], output: Path, fps: int, seconds: float, hand_path: Path | None):
    output.mkdir(parents=True, exist_ok=True)
    actions = spec["actions"]
    hand = Image.open(hand_path).convert("RGBA") if hand_path and hand_path.exists() else None
    if hand:
        hand.thumbnail((320, 260))
    count = max(2, math.ceil(seconds * fps))
    for frame in range(count):
        t = frame / max(count - 1, 1)
        board = Image.new("RGBA", (WIDTH, HEIGHT), BG)
        active_tip = None
        for action in actions:
            local = max(0, min(1, (t - action["at"]) / action["duration"]))
            tip = draw_action(board, action, local)
            if 0 < local < 1 and tip:
                active_tip = tip
        if active_tip and hand:
            board.alpha_composite(hand, (active_tip[0] - 56, active_tip[1] - 45))
        if spec.get("source"):
            ImageDraw.Draw(board).text((55, 682), spec["source"], font=font(20), fill=(120, 130, 145, 255))
        board.convert("RGB").save(output / f"{frame:06d}.png", optimize=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--spec", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--seconds", required=True, type=float)
    parser.add_argument("--fps", default=12, type=int)
    parser.add_argument("--hand")
    args = parser.parse_args()
    render(json.loads(Path(args.spec).read_text()), Path(args.output), args.fps, args.seconds, Path(args.hand) if args.hand else None)
