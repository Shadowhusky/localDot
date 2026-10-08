import struct
import subprocess
import sys
import zlib
from Xlib import X, display


def png_chunk(kind, content):
    return struct.pack('!I', len(content)) + kind + content + struct.pack('!I', zlib.crc32(kind + content))


def validate_mask(mask, width, height):
    if not isinstance(mask, tuple) or len(mask) != 4:
        raise RuntimeError('capture request')
    expected_width, expected_height, content, redactions = mask
    if (expected_width, expected_height) != (width, height) or (width, height) not in [(1280, 800), (2560, 1600)]:
        raise RuntimeError('capture request')
    if not isinstance(redactions, tuple) or len(redactions) > 256:
        raise RuntimeError('capture request')
    for rectangle in (content, *redactions):
        if not isinstance(rectangle, tuple) or len(rectangle) != 4 or any(type(value) is not int for value in rectangle):
            raise RuntimeError('capture request')
        left, top, extent_x, extent_y = rectangle
        if left < 0 or top < 0 or extent_x <= 0 or extent_y <= 0 or left + extent_x > width or top + extent_y > height:
            raise RuntimeError('capture request')


def redact(pixels, width, height, mask):
    validate_mask(mask, width, height)
    if len(pixels) != width * height * 3:
        raise RuntimeError('capture pixels')
    content = mask[2]
    left, top, extent_x, extent_y = content
    row_bytes = width * 3
    black_row = bytes(row_bytes)
    for row in range(height):
        offset = row * row_bytes
        if row < top or row >= top + extent_y:
            pixels[offset:offset + row_bytes] = black_row
        else:
            pixels[offset:offset + left * 3] = black_row[:left * 3]
            right = (left + extent_x) * 3
            pixels[offset + right:offset + row_bytes] = black_row[:row_bytes - right]
    for region_left, region_top, region_width, region_height in mask[3]:
        black = bytes(region_width * 3)
        for row in range(region_top, region_top + region_height):
            start = (row * width + region_left) * 3
            pixels[start:start + len(black)] = black


def capture(mask=None):
    connection = display.Display(':1')
    try:
        screen = connection.screen()
        root = screen.root
        geometry = root.get_geometry()
        width, height = geometry.width, geometry.height
        if (width, height) not in [(1280, 800), (2560, 1600)] or geometry.depth != 24:
            raise RuntimeError('capture geometry')
        if mask is not None:
            validate_mask(mask, width, height)
        info = connection.display.info
        formats = [entry for entry in info.pixmap_formats if entry.depth == 24]
        visuals = [visual for depth in screen.allowed_depths for visual in depth.visuals if visual.visual_id == screen.root_visual]
        if len(formats) != 1 or formats[0].bits_per_pixel != 32 or formats[0].scanline_pad != 32 or info.image_byte_order != X.LSBFirst:
            raise RuntimeError('capture pixel format')
        if len(visuals) != 1 or (visuals[0].red_mask, visuals[0].green_mask, visuals[0].blue_mask) != (0xff0000, 0xff00, 0xff):
            raise RuntimeError('capture color masks')
        image = root.get_image(0, 0, width, height, X.ZPixmap, 0xffffffff)
        if image.depth != 24 or len(image.data) != width * height * 4:
            raise RuntimeError('capture pixels')
        pixels = bytearray(width * height * 3)
        pixels[0::3] = image.data[2::4]
        pixels[1::3] = image.data[1::4]
        pixels[2::3] = image.data[0::4]
        if mask is not None:
            redact(pixels, width, height, mask)
        rows = b''.join(b'\x00' + pixels[row * width * 3:(row + 1) * width * 3] for row in range(height))
        png = b'\x89PNG\r\n\x1a\n' + png_chunk(b'IHDR', struct.pack('!IIBBBBB', width, height, 8, 2, 0, 0, 0)) + png_chunk(b'IDAT', zlib.compress(rows, 1)) + png_chunk(b'IEND', b'')
        converted = subprocess.run(['/usr/bin/cwebp', '-quiet', '-q', '80', '-resize', '1280', '800', '-metadata', 'none', '-o', '-', '--', '-'], input=png, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, check=True, timeout=2)
        if len(converted.stdout) > 2 * 1024 * 1024 or converted.stdout[:4] != b'RIFF' or converted.stdout[8:12] != b'WEBP':
            raise RuntimeError('capture output')
        return converted.stdout
    finally:
        connection.close()


def serve(source, destination, capture_image=capture, capture_masked=capture):
    destination.write(b'LDCP')
    destination.flush()
    expected = 1
    while True:
        request = source.read(4)
        if not request:
            return
        if len(request) != 4:
            raise RuntimeError('capture request')
        identity = struct.unpack('!I', request)[0]
        if identity == 0:
            header = source.read(32)
            if len(header) != 32:
                raise RuntimeError('capture request')
            identity, width, height, left, top, extent_x, extent_y, count = struct.unpack('!8I', header)
            if identity != expected or count > 256:
                raise RuntimeError('capture request')
            payload = source.read(count * 16)
            if len(payload) != count * 16:
                raise RuntimeError('capture request')
            redactions = tuple(struct.unpack('!4I', payload[offset:offset + 16]) for offset in range(0, len(payload), 16))
            mask = (width, height, (left, top, extent_x, extent_y), redactions)
            validate_mask(mask, width, height)
            encoded = capture_masked(mask)
        else:
            if identity != expected:
                raise RuntimeError('capture request')
            encoded = capture_image()
        if len(encoded) < 30 or len(encoded) > 2 * 1024 * 1024:
            raise RuntimeError('capture output')
        destination.write(struct.pack('!II', expected, len(encoded)))
        destination.write(encoded)
        destination.flush()
        expected += 1
        if expected > 0xffffffff:
            return


if __name__ == '__main__':
    try:
        serve(sys.stdin.buffer, sys.stdout.buffer)
    except Exception:
        sys.exit(1)
