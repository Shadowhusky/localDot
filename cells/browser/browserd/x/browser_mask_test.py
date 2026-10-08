import importlib.util
import io
from pathlib import Path
import struct
import sys
import types
import unittest
from unittest.mock import Mock, patch
import zlib

stub = types.ModuleType('Xlib')
stub.X = types.SimpleNamespace(LSBFirst=0, ZPixmap=2)
stub.display = types.SimpleNamespace()
specification = importlib.util.spec_from_file_location('browser_capture_mask', Path(__file__).with_name('browser-capture.py'))
module = importlib.util.module_from_spec(specification)
with patch.dict(sys.modules, {'Xlib': stub}):
    specification.loader.exec_module(module)


def packet(identity=1, width=1280, height=800, content=(10, 80, 1200, 700), redactions=((20, 100, 100, 30),)):
    return struct.pack('!9I', 0, identity, width, height, *content, len(redactions)) + b''.join(struct.pack('!4I', *rectangle) for rectangle in redactions)


def connection_fixture(scale):
    width, height = 1280 * scale, 800 * scale
    root = types.SimpleNamespace(get_geometry=Mock(return_value=types.SimpleNamespace(width=width, height=height, depth=24)), get_image=Mock(return_value=types.SimpleNamespace(depth=24, data=b'\x12\x34\x56\x00' * (width * height))))
    visual = types.SimpleNamespace(visual_id=1, red_mask=0xff0000, green_mask=0xff00, blue_mask=0xff)
    info = types.SimpleNamespace(pixmap_formats=[types.SimpleNamespace(depth=24, bits_per_pixel=32, scanline_pad=32)], image_byte_order=0)
    screen = types.SimpleNamespace(root=root, allowed_depths=[types.SimpleNamespace(visuals=[visual])], root_visual=1)
    connection = types.SimpleNamespace(display=types.SimpleNamespace(info=info), screen=Mock(return_value=screen), close=Mock())
    return connection, root


def decode_png_pixels(png):
    offset = 8
    compressed = b''
    dimensions = None
    while offset < len(png):
        length = struct.unpack('!I', png[offset:offset + 4])[0]
        kind = png[offset + 4:offset + 8]
        value = png[offset + 8:offset + 8 + length]
        if kind == b'IHDR':
            dimensions = struct.unpack('!IIBBBBB', value)[:2]
        if kind == b'IDAT':
            compressed += value
        offset += length + 12
    return dimensions, zlib.decompress(compressed)


class BrowserMaskTest(unittest.TestCase):
    def test_raw_and_masked_requests_share_strict_sequence(self):
        output = io.BytesIO()
        masked = Mock(return_value=b'm' * 30)
        raw = Mock(return_value=b'r' * 30)
        module.serve(io.BytesIO(packet() + struct.pack('!I', 2)), output, raw, masked)
        masked.assert_called_once_with((1280, 800, (10, 80, 1200, 700), ((20, 100, 100, 30),)))
        raw.assert_called_once_with()
        self.assertEqual(output.getvalue(), b'LDCP' + struct.pack('!II', 1, 30) + b'm' * 30 + struct.pack('!II', 2, 30) + b'r' * 30)

    def test_truncated_packets_do_not_fallback_to_raw(self):
        full = packet()
        for length in [1, 3, 4, 5, 31, 35, 36, len(full) - 1]:
            with self.subTest(length=length):
                output = io.BytesIO()
                raw = Mock()
                masked = Mock()
                with self.assertRaisesRegex(RuntimeError, 'capture request'):
                    module.serve(io.BytesIO(full[:length]), output, raw, masked)
                raw.assert_not_called()
                masked.assert_not_called()
                self.assertEqual(output.getvalue(), b'LDCP')

    def test_invalid_geometry_nonce_and_count_are_rejected_before_capture(self):
        invalid = [packet(identity=0), packet(identity=2), packet(width=2560), packet(content=(0, 0, 0, 1)), packet(content=(0, 0, 1281, 800)), packet(redactions=((1279, 799, 2, 2),)), struct.pack('!9I', 0, 1, 1280, 800, 0, 0, 1280, 800, 257)]
        for request in invalid:
            with self.subTest(request=request):
                masked = Mock()
                raw = Mock()
                with self.assertRaisesRegex(RuntimeError, 'capture request'):
                    module.serve(io.BytesIO(request), io.BytesIO(), raw, masked)
                raw.assert_not_called()
                masked.assert_not_called()

    def test_expected_display_is_checked_before_sampling(self):
        connection, root = connection_fixture(2)
        with patch.object(module.display, 'Display', return_value=connection, create=True), patch.object(module.subprocess, 'run') as encode:
            with self.assertRaisesRegex(RuntimeError, 'capture request'):
                module.capture((1280, 800, (0, 0, 1280, 800), ()))
        root.get_image.assert_not_called()
        encode.assert_not_called()
        connection.close.assert_called_once_with()

    def test_all_pixels_outside_content_and_inside_masks_are_erased_before_encoding(self):
        for scale in [1, 2]:
            with self.subTest(scale=scale):
                connection, root = connection_fixture(scale)
                width, height = 1280 * scale, 800 * scale
                content = (10 * scale, 80 * scale, 1200 * scale, 700 * scale)
                region = (20 * scale, 100 * scale, 100 * scale, 30 * scale)
                encoded = b'RIFF' + bytes(4) + b'WEBP' + bytes(18)
                with patch.object(module.display, 'Display', return_value=connection, create=True), patch.object(module.subprocess, 'run', return_value=types.SimpleNamespace(stdout=encoded)) as encode:
                    self.assertEqual(module.capture((width, height, content, (region,))), encoded)
                dimensions, rows = decode_png_pixels(encode.call_args.kwargs['input'])
                self.assertEqual(dimensions, (width, height))
                expected_rows = []
                for vertical in range(height):
                    row = bytearray(width * 3)
                    if content[1] <= vertical < content[1] + content[3]:
                        row[content[0] * 3:(content[0] + content[2]) * 3] = b'\x56\x34\x12' * content[2]
                    if region[1] <= vertical < region[1] + region[3]:
                        row[region[0] * 3:(region[0] + region[2]) * 3] = bytes(region[2] * 3)
                    expected_rows.append(b'\x00' + row)
                self.assertEqual(rows, b''.join(expected_rows))
                root.get_image.assert_called_once()
                connection.close.assert_called_once_with()

    def test_empty_masks_still_remove_chrome(self):
        pixels = bytearray(b'\xff\x00\x7f' * 1280 * 800)
        module.redact(pixels, 1280, 800, (1280, 800, (0, 100, 1280, 700), ()))
        self.assertEqual(pixels[:1280 * 100 * 3], bytes(1280 * 100 * 3))
        self.assertEqual(pixels[1280 * 100 * 3:], b'\xff\x00\x7f' * 1280 * 700)

    def test_maximum_redactions_remain_bounded_and_erase_last_pixel(self):
        pixels = bytearray(b'\x12\x34\x56' * 1280 * 800)
        module.redact(pixels, 1280, 800, (1280, 800, (0, 0, 1280, 800), ((1279, 799, 1, 1),) * 256))
        self.assertEqual(pixels[-3:], bytes(3))
        self.assertEqual(pixels[-6:-3], b'\x12\x34\x56')

    def test_bad_mask_or_pixel_length_does_not_modify_pixels(self):
        original = b'x' * 30
        for mask in [None, (1280, 800, (0, 0, 1280, 800), ()), (1280, 800, (False, 0, 1280, 800), ())]:
            pixels = bytearray(original)
            with self.assertRaises(RuntimeError):
                module.redact(pixels, 1280, 800, mask)
            self.assertEqual(pixels, original)


if __name__ == '__main__':
    unittest.main()
