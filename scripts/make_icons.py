#!/usr/bin/env python3
"""오픈코드 Go 앱 아이콘 생성기 — 외부 라이브러리 없이 PNG를 직접 인코딩한다.
민트색 링 + 중앙 점(◍) 마크. 안드로이드 mipmap 밀도별 + 어댑티브 포그라운드 생성."""
import math
import os
import struct
import zlib

BG = (12, 13, 18)
MINT = (69, 207, 160)
MINT_SOFT = (76, 217, 168)

RES = os.path.join(os.path.dirname(__file__), '..', 'android', 'app', 'src', 'main', 'res')

LEGACY = {'mipmap-mdpi': 48, 'mipmap-hdpi': 72, 'mipmap-xhdpi': 96,
          'mipmap-xxhdpi': 144, 'mipmap-xxxhdpi': 192}
FOREGROUND = {'mipmap-mdpi': 108, 'mipmap-hdpi': 162, 'mipmap-xhdpi': 216,
              'mipmap-xxhdpi': 324, 'mipmap-xxxhdpi': 432}
SS = 4  # 슈퍼샘플링


def png(path, w, h, pixels):
    raw = bytearray()
    for y in range(h):
        raw += b'\x00'
        for x in range(w):
            raw += bytes(pixels[y * w + x])

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'wb') as f:
        f.write(out)
    return len(out)


def blend(dst, src, a):
    if a <= 0:
        return dst
    if a >= 1:
        return src
    return tuple(int(round(src[i] * a + dst[i] * (1 - a))) for i in range(3))


def render(size, background=False, rounded=False, scale=1.0):
    """scale: 마크가 캔버스에서 차지하는 비율(어댑티브 아이콘은 작게)."""
    big = size * SS
    px = [(0, 0, 0, 0)] * (big * big)
    cx = cy = big / 2
    r_out = big * 0.34 * scale
    r_in = big * 0.235 * scale
    r_dot = big * 0.085 * scale
    corner = big * 0.22

    for y in range(big):
        for x in range(big):
            # 배경
            if background:
                if rounded:
                    # 둥근 사각형 판정
                    dx = max(abs(x - cx) - (cx - corner), 0)
                    dy = max(abs(y - cy) - (cy - corner), 0)
                    if math.hypot(dx, dy) > corner:
                        px[y * big + x] = (0, 0, 0, 0)
                        continue
                px[y * big + x] = (*BG, 255)

            d = math.hypot(x - cx, y - cy)
            # 안티에일리어싱: 경계 1px 페더
            if r_in <= d <= r_out:
                edge = min(d - r_in, r_out - d)
                a = min(1.0, max(0.0, edge / SS))
                base = px[y * big + x]
                col = blend(base[:3], MINT, a)
                px[y * big + x] = (*col, 255 if background else int(255 * a))
            elif d <= r_dot:
                edge = r_dot - d
                a = min(1.0, max(0.0, edge / SS))
                base = px[y * big + x]
                col = blend(base[:3], MINT_SOFT, a)
                px[y * big + x] = (*col, 255 if background else int(255 * a))

    # 다운샘플
    out = [(0, 0, 0, 0)] * (size * size)
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    p = px[(y * SS + dy) * big + (x * SS + dx)]
                    r += p[0] * p[3]
                    g += p[1] * p[3]
                    b += p[2] * p[3]
                    a += p[3]
            n = SS * SS
            if a == 0:
                out[y * size + x] = (0, 0, 0, 0)
            else:
                out[y * size + x] = (int(r / a), int(g / a), int(b / a), int(a / n))
    return out


def main():
    total = 0
    for folder, size in LEGACY.items():
        d = os.path.join(RES, folder)
        total += png(os.path.join(d, 'ic_launcher.png'), size, size,
                     render(size, background=True, rounded=False))
        total += png(os.path.join(d, 'ic_launcher_round.png'), size, size,
                     render(size, background=True, rounded=True))
        fg = int(size * 2.25)
        total += png(os.path.join(d, 'ic_launcher_foreground.png'), fg, fg,
                     render(fg, background=False, scale=0.82))
        print(f'{folder}: {size}px + foreground {fg}px')

    # 어댑티브 배경색
    colors = os.path.join(RES, 'values', 'ic_launcher_background.xml')
    with open(colors, 'w', encoding='utf-8') as f:
        f.write("<?xml version='1.0' encoding='utf-8'?>\n<resources>\n"
                "    <color name=\"ic_launcher_background\">#0C0D12</color>\n</resources>\n")
    print(f'총 {total/1024:.0f} KB')


if __name__ == '__main__':
    main()
