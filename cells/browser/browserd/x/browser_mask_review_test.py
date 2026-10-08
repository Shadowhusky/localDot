import importlib.util
import io
from pathlib import Path
import struct
import sys
import types
import unittest
from unittest.mock import Mock, patch

stub = types.ModuleType('Xlib')
stub.X = types.SimpleNamespace(LSBFirst=0, ZPixmap=2)
stub.display = types.SimpleNamespace()
spec = importlib.util.spec_from_file_location('review_browser_capture', Path(__file__).with_name('browser-capture.py'))
capture = importlib.util.module_from_spec(spec)
with patch.dict(sys.modules, {'Xlib': stub}):
    spec.loader.exec_module(capture)


def packet(identity=1, content=(0, 100, 1280, 700), redactions=()):
    return struct.pack('!9I', 0, identity, 1280, 800, *content, len(redactions)) + b''.join(struct.pack('!4I', *r) for r in redactions)


class IndependentMaskReview(unittest.TestCase):
    def test_P1_valid_visible_pixels_are_preserved_when_no_redaction_intersects(self):
        data = bytearray(b'\x12\xb7\x49' * (1280 * 800))
        capture.redact(data, 1280, 800, (1280, 800, (0, 0, 1280, 800), ()))
        self.assertEqual(data, b'\x12\xb7\x49' * (1280 * 800))

    def test_B1_intersections_and_edges_erase_pixels_at_both_scales(self):
        for scale in [1, 2]:
            with self.subTest(scale=scale):
                w, h = 1280 * scale, 800 * scale
                data = bytearray(b'\x12\xb7\x49' * (w * h))
                content = (8 * scale, 90 * scale, 1200 * scale, 700 * scale)
                redactions = ((0, 0, 12 * scale, 100 * scale), (1200 * scale, 780 * scale, 80 * scale, 20 * scale))
                capture.redact(data, w, h, (w, h, content, redactions))
                for x, y in [(0, 0), (9 * scale, 92 * scale), (1205 * scale, 789 * scale), (1279 * scale, 799 * scale)]:
                    start = (y * w + x) * 3
                    self.assertEqual(data[start:start + 3], b'\x00\x00\x00')
                start = (300 * scale * w + 600 * scale) * 3
                self.assertEqual(data[start:start + 3], b'\x12\xb7\x49')

    def test_B2_invalid_second_mask_never_downgrades_to_raw(self):
        output = io.BytesIO()
        masked, raw = Mock(return_value=b'm' * 30), Mock(return_value=b'r' * 30)
        stream = packet() + packet(identity=2, content=(0, 0, 1281, 800))
        with self.assertRaisesRegex(RuntimeError, 'capture request'):
            capture.serve(io.BytesIO(stream), output, raw, masked)
        masked.assert_called_once()
        raw.assert_not_called()
        self.assertEqual(output.getvalue(), b'LDCP' + struct.pack('!II', 1, 30) + b'm' * 30)

    def test_B3_all_truncated_mask_prefixes_emit_no_frame_or_raw_capture(self):
        complete = packet(redactions=((100, 100, 50, 50),))
        for size in range(1, len(complete)):
            with self.subTest(size=size):
                raw, masked = Mock(), Mock()
                output = io.BytesIO()
                with self.assertRaisesRegex(RuntimeError, 'capture request'):
                    capture.serve(io.BytesIO(complete[:size]), output, raw, masked)
                raw.assert_not_called()
                masked.assert_not_called()
                self.assertEqual(output.getvalue(), b'LDCP')


if __name__ == '__main__':
    unittest.main()
