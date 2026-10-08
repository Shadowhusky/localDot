import importlib.util
import io
from pathlib import Path
import struct
import subprocess
import sys
import types
import unittest
from unittest.mock import Mock, patch
import zlib

stub = types.ModuleType('Xlib')
stub.X = types.SimpleNamespace(LSBFirst=0, ZPixmap=2)
stub.display = types.SimpleNamespace()
specification = importlib.util.spec_from_file_location('browser_capture_review', Path(__file__).with_name('browser-capture.py'))
module = importlib.util.module_from_spec(specification)
with patch.dict(sys.modules, {'Xlib': stub}):
    specification.loader.exec_module(module)

def connection_fixture():
    root = types.SimpleNamespace(get_geometry=Mock(return_value=types.SimpleNamespace(width=1280, height=800, depth=24)), get_image=Mock(return_value=types.SimpleNamespace(depth=24, data=b'\x12\x34\x56\x00' * (1280 * 800))))
    visual = types.SimpleNamespace(visual_id=1, red_mask=0xff0000, green_mask=0xff00, blue_mask=0xff)
    info = types.SimpleNamespace(pixmap_formats=[types.SimpleNamespace(depth=24, bits_per_pixel=32, scanline_pad=32)], image_byte_order=0)
    screen = types.SimpleNamespace(root=root, allowed_depths=[types.SimpleNamespace(visuals=[visual])], root_visual=1)
    connection = types.SimpleNamespace(display=types.SimpleNamespace(info=info), screen=Mock(return_value=screen), close=Mock())
    return connection, root, info, visual

class CaptureWorkerReview(unittest.TestCase):
    def test_bgrx_becomes_bounded_png_rgb_and_fixed_encoder_invocation(self):
        connection, root, _, _ = connection_fixture()
        returned = b'RIFF' + b'\x00' * 4 + b'WEBP' + b'\x00' * 18
        with patch.object(module.display, 'Display', return_value=connection, create=True) as open_display, patch.object(module.subprocess, 'run', return_value=types.SimpleNamespace(stdout=returned)) as encode:
            self.assertEqual(module.capture(), returned)
        open_display.assert_called_once_with(':1')
        connection.close.assert_called_once_with()
        root.get_image.assert_called_once_with(0, 0, 1280, 800, 2, 0xffffffff)
        args, kwargs = encode.call_args
        self.assertEqual(args[0], ['/usr/bin/cwebp', '-quiet', '-q', '80', '-resize', '1280', '800', '-metadata', 'none', '-o', '-', '--', '-'])
        self.assertEqual(kwargs['timeout'], 2)
        self.assertTrue(kwargs['check'])
        self.assertEqual(kwargs['stderr'], subprocess.DEVNULL)
        png = kwargs['input']
        self.assertEqual(png[:8], b'\x89PNG\r\n\x1a\n')
        offset = 8
        chunks = []
        while offset < len(png):
            length = struct.unpack('!I', png[offset:offset+4])[0]
            kind = png[offset+4:offset+8]
            value = png[offset+8:offset+8+length]
            crc = struct.unpack('!I', png[offset+8+length:offset+12+length])[0]
            self.assertEqual(crc, zlib.crc32(kind + value))
            chunks.append((kind, value))
            offset += 12 + length
        self.assertEqual(offset, len(png))
        self.assertEqual([item[0] for item in chunks], [b'IHDR', b'IDAT', b'IEND'])
        self.assertEqual(struct.unpack('!IIBBBBB', chunks[0][1]), (1280, 800, 8, 2, 0, 0, 0))
        pixels = zlib.decompress(chunks[1][1])
        self.assertEqual(pixels, (b'\x00' + b'\x56\x34\x12' * 1280) * 800)

    def test_bad_geometry_byte_order_and_visual_masks_refuse_before_capture(self):
        for mode in ['geometry', 'byte-order', 'masks']:
            with self.subTest(mode=mode):
                connection, root, info, visual = connection_fixture()
                if mode == 'geometry':
                    root.get_geometry.return_value.width = 1
                if mode == 'byte-order':
                    info.image_byte_order = 1
                if mode == 'masks':
                    visual.red_mask = 0xff
                with patch.object(module.display, 'Display', return_value=connection, create=True), patch.object(module.subprocess, 'run') as encode:
                    with self.assertRaises(RuntimeError):
                        module.capture()
                root.get_image.assert_not_called()
                encode.assert_not_called()
                connection.close.assert_called_once_with()

    def test_encoder_timeout_closes_display_and_publishes_no_frame(self):
        connection, _, _, _ = connection_fixture()
        output = io.BytesIO()
        with patch.object(module.display, 'Display', return_value=connection, create=True), patch.object(module.subprocess, 'run', side_effect=subprocess.TimeoutExpired('/usr/bin/cwebp', 2)):
            with self.assertRaises(subprocess.TimeoutExpired):
                module.serve(io.BytesIO(struct.pack('!I', 1)), output, module.capture)
        connection.close.assert_called_once_with()
        self.assertEqual(output.getvalue(), b'LDCP')

if __name__ == '__main__':
    unittest.main()
