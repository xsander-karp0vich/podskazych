"""
Иконки Call Copilot — пиксельный суфлёр в наушниках.

Источник правды — Claude Design, проект «Call Copilot прототип», файл
«Call Copilot - Логотип», раздел «Итог v2 · правка сеток иконки», карточка 5a
(набор размеров — карточка 4b «Набор размеров для .ico»). Сетки и палитра ниже
переписаны оттуда как есть. Та же сетка 16×14 — у маскота в окне приложения
(src/renderer/components/Mascot.tsx): менять их только вместе.

От 32 px рисуем большую сетку 16×14 с целой клеткой (2 / 3 / 4 / 8 / 16 px).
Для 16–24 px своя сетка 8×8: большая там дробится на полуторные клетки
и мылится, поэтому остаются наушники, глаза, рот и две ножки.

Никакого ресэмплинга и сглаживания: каждый пиксель ложится в целую клетку,
фон прозрачный, без плашки. Каждая запись .ico — свой рендер, а не ужатый 256.
Скрипт детерминирован: повторный запуск даёт побайтно те же файлы и не трогает
неизменившиеся.

    python scripts/make-icons.py                        # build/icon.ico, icon.png, tray*.png, logo.svg
    python scripts/make-icons.py --preview preview.png  # плюс лист проверки на тёмном и светлом фоне
"""
from __future__ import annotations

import argparse
import io
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / 'build'

# Большая сетка 16×14 — для 32 px и крупнее.
BIG = (
    '....HHHHHHHH....',
    '...HH......HH...',
    '..HH..####..HH..',
    '.HH.########.HH.',
    'HHH##########HHH',
    'HHH##########HHH',
    '.H##EW####EW##H.',
    '..##EE####EE##..',
    '..############..',
    '..###M#MM#M###..',
    '..###M#MM#M###..',
    '...##########...',
    '....LL.LL.LL....',
    '....LL.LL.LL....',
)

# Малая сетка 8×8 — для 16, 20 и 24 px.
TINY = (
    '.HHHHHH.',
    'HH####HH',
    'H######H',
    '.#E##E#.',
    '.######.',
    '.##MM##.',
    '.######.',
    '.LL..LL.',
)

# '.' — полностью прозрачно, всё остальное непрозрачно (alpha 255).
PALETTE = {
    '#': '#C8F53A',  # лаймовое тело
    'L': '#C8F53A',  # ножки
    'H': '#9AD8FF',  # голубые наушники
    'E': '#14200A',  # глаза
    'M': '#14200A',  # рот
    'W': '#F1F7F7',  # блик в глазу
}

# сторона холста → (сетка, клетка, смещение арта (x, y) внутри квадрата)
PLAN = {
    16: (TINY, 2, (0, 0)),
    20: (TINY, 2, (2, 2)),
    24: (TINY, 3, (0, 0)),
    32: (BIG, 2, (0, 2)),
    40: (BIG, 2, (4, 6)),
    48: (BIG, 3, (0, 3)),
    64: (BIG, 4, (0, 4)),
    128: (BIG, 8, (0, 8)),
    256: (BIG, 16, (0, 16)),
}

# Суффиксы, которые nativeImage.createFromPath сам подбирает под масштаб экрана.
TRAY = {
    'tray.png': 16,
    'tray@1.25x.png': 20,
    'tray@1.5x.png': 24,
    'tray@2x.png': 32,
    'tray@2.5x.png': 40,
    'tray@3x.png': 48,
}


def rgba(hex_color: str) -> tuple[int, int, int, int]:
    h = hex_color.lstrip('#')
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 255


def check_grid(grid: tuple[str, ...], cols: int, rows: int) -> None:
    # опечатка в сетке молча сдвинет пиксели — лучше упасть сразу
    assert len(grid) == rows, f'grid: {len(grid)} rows, expected {rows}'
    for i, row in enumerate(grid):
        assert len(row) == cols, f'grid row {i}: {len(row)} cols, expected {cols}'
        bad = {ch for ch in row if ch != '.' and ch not in PALETTE}
        assert not bad, f'grid row {i}: unknown cells {bad}'


def render(size: int) -> Image.Image:
    grid, cell, (ox, oy) = PLAN[size]
    w, h = len(grid[0]) * cell, len(grid) * cell
    # смещения из карточки — ровно центр холста; иначе план переписан с ошибкой
    assert size - w == 2 * ox and size - h == 2 * oy, f'{size}px: art {w}x{h} at {ox},{oy} is off-centre'
    im = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    for r, row in enumerate(grid):
        for c, ch in enumerate(row):
            if ch == '.':
                continue
            x, y = ox + c * cell, oy + r * cell
            im.paste(rgba(PALETTE[ch]), (x, y, x + cell, y + cell))
    return im


def png_bytes(im: Image.Image) -> bytes:
    # Pillow не пишет в PNG ни времени, ни dpi — байты зависят только от пикселей
    buf = io.BytesIO()
    im.save(buf, format='PNG', optimize=True)
    return buf.getvalue()


def ico_bytes(entries: list[tuple[int, bytes]]) -> bytes:
    """ICO собираем сами: Pillow при сохранении ужимает одну картинку во все размеры."""
    # ICONDIR: reserved 0, type 1 (иконка), число картинок
    head = struct.pack('<HHH', 0, 1, len(entries))
    table, blobs = [], []
    offset = 6 + 16 * len(entries)
    for size, png in entries:
        side = 0 if size == 256 else size  # 256 в байт не влезает, по формату это 0
        # ICONDIRENTRY: ширина, высота, цветов 0, резерв 0, planes 1, 32 bpp, длина PNG, смещение
        table.append(struct.pack('<BBBBHHII', side, side, 0, 0, 1, 32, len(png), offset))
        blobs.append(png)
        offset += len(png)
    return head + b''.join(table) + b''.join(blobs)


def svg_text(grid: tuple[str, ...]) -> str:
    """Вектор большой сетки: один rect на горизонтальную полосу одного цвета."""
    rows, cols = len(grid), len(grid[0])
    rects = []
    for y, row in enumerate(grid):
        x = 0
        while x < cols:
            if row[x] == '.':
                x += 1
                continue
            fill = PALETTE[row[x]]
            end = x
            while end < cols and row[end] != '.' and PALETTE[row[end]] == fill:
                end += 1
            rects.append(f'  <rect x="{x}" y="{y}" width="{end - x}" height="1" fill="{fill}"/>')
            x = end
    head = (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {cols} {rows}" '
        f'width="{cols * 16}" height="{rows * 16}" shape-rendering="crispEdges">'
    )
    return '\n'.join([head, *rects, '</svg>']) + '\n'


def label_font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    try:
        return ImageFont.load_default(size=size)
    except (ImportError, OSError):  # Pillow без FreeType: мелкий растровый, но подписи будут
        return ImageFont.load_default()


def preview(renders: dict[int, Image.Image]) -> Image.Image:
    """Лист проверки: каждый размер в 1x и в x8 ближайшим соседом, на тёмном и на светлом фоне."""
    pad, gap, label_h, title_h, zoom = 32, 32, 28, 44, 8
    font = label_font(18)
    sizes = sorted(renders)
    rows = [
        [(s, 1) for s in sizes],
        [(s, zoom) for s in sizes if s <= 64],
        [(s, zoom) for s in sizes if s > 64],
    ]

    def row_w(row: list[tuple[int, int]]) -> int:
        return sum(s * k for s, k in row) + gap * (len(row) - 1)

    def row_h(row: list[tuple[int, int]]) -> int:
        return max(s * k for s, k in row) + label_h

    width = pad * 2 + max(row_w(r) for r in rows)
    panel_h = pad * 2 + title_h + sum(row_h(r) for r in rows) + gap * (len(rows) - 1)
    # фон, подписи, рамка холста (видно прозрачные поля и центровку)
    themes = (
        ('dark', '#0B1418', '#8FA0A5', '#2A3B42'),
        ('light', '#F3F3F3', '#5C5C5C', '#CFCFCF'),
    )
    sheet = Image.new('RGBA', (width, panel_h * len(themes)))
    for i, (name, bg, ink, frame) in enumerate(themes):
        panel = Image.new('RGBA', (width, panel_h), rgba(bg))
        ImageDraw.Draw(panel).text(
            (pad, pad), f'{name} {bg}    top row 1x, below x{zoom} nearest-neighbour', font=font, fill=ink
        )
        y = pad + title_h
        for row in rows:
            x = pad
            for s, k in row:
                side = s * k
                im = renders[s] if k == 1 else renders[s].resize((side, side), Image.Resampling.NEAREST)
                panel.alpha_composite(im, (x, y))
                draw = ImageDraw.Draw(panel)
                if k > 1:
                    draw.rectangle((x - 1, y - 1, x + side, y + side), outline=frame)
                draw.text((x, y + side + 6), f'{s} px' if k == 1 else f'{s} px x{k}', font=font, fill=ink)
                x += side + gap
            y += row_h(row) + gap
        sheet.paste(panel, (0, panel_h * i))
    return sheet.convert('RGB')


def put(path: Path, data: bytes) -> None:
    path = path.resolve()
    same = path.is_file() and path.read_bytes() == data
    if not same:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    try:
        shown = path.relative_to(ROOT).as_posix()
    except ValueError:
        shown = str(path)
    print(f'{"unchanged" if same else "wrote":<9}  {shown}  ({len(data)} bytes)')


def main() -> None:
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='replace')  # кириллица справки в чужой кодовой странице не роняет скрипт
    ap = argparse.ArgumentParser(description='Иконки Call Copilot из пиксельных сеток суфлёра.')
    ap.add_argument('--preview', type=Path, help='куда положить лист проверки (PNG); без флага не рисуется')
    args = ap.parse_args()

    check_grid(BIG, 16, 14)
    check_grid(TINY, 8, 8)
    renders = {size: render(size) for size in sorted(PLAN)}
    pngs = {size: png_bytes(im) for size, im in renders.items()}

    put(BUILD / 'icon.ico', ico_bytes([(size, pngs[size]) for size in sorted(PLAN)]))
    put(BUILD / 'icon.png', pngs[256])
    for name, size in TRAY.items():
        put(BUILD / name, pngs[size])
    put(BUILD / 'logo.svg', svg_text(BIG).encode('utf-8'))
    if args.preview:
        put(args.preview, png_bytes(preview(renders)))


if __name__ == '__main__':
    main()
