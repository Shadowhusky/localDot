import importlib.util
import io
from pathlib import Path
import struct
import sys
import types
import unittest
from unittest.mock import patch


stub = types.ModuleType('Xlib')
stub.X = types.SimpleNamespace()
stub.display = types.SimpleNamespace()
location = Path(__file__).with_name('browser-capture.py')
specification = importlib.util.spec_from_file_location('browser_capture', location)
module = importlib.util.module_from_spec(specification)
with patch.dict(sys.modules, {'Xlib': stub}):
    specification.loader.exec_module(module)


class CaptureProtocolTest(unittest.TestCase):
    def test_idle_eof_writes_only_readiness(self):
        output = io.BytesIO()
        module.serve(io.BytesIO(), output, lambda: self.fail('unexpected capture'))
        self.assertEqual(output.getvalue(), b'LDCP')

    def test_sequential_captures_have_exact_identity_and_length(self):
        output = io.BytesIO()
        image = b'x' * 30
        source = io.BytesIO(struct.pack('!II', 1, 2))
        module.serve(source, output, lambda: image)
        self.assertEqual(output.getvalue(), b'LDCP' + struct.pack('!II', 1, 30) + image + struct.pack('!II', 2, 30) + image)

    def test_rejects_truncated_wrong_and_replayed_identity_before_capture(self):
        for request in [b'\x00', b'\x00\x00\x00', struct.pack('!I', 0), struct.pack('!I', 2)]:
            with self.subTest(request=request):
                output = io.BytesIO()
                with self.assertRaisesRegex(RuntimeError, 'capture request'):
                    module.serve(io.BytesIO(request), output, lambda: self.fail('unexpected capture'))
                self.assertEqual(output.getvalue(), b'LDCP')
        output = io.BytesIO()
        with self.assertRaisesRegex(RuntimeError, 'capture request'):
            module.serve(io.BytesIO(struct.pack('!II', 1, 1)), output, lambda: b'x' * 30)
        self.assertEqual(len(output.getvalue()), 42)

    def test_rejects_invalid_size_before_writing_frame_bytes(self):
        for length in [0, 29, 2 * 1024 * 1024 + 1]:
            with self.subTest(length=length):
                output = io.BytesIO()
                with self.assertRaisesRegex(RuntimeError, 'capture output'):
                    module.serve(io.BytesIO(struct.pack('!I', 1)), output, lambda: b'x' * length)
                self.assertEqual(output.getvalue(), b'LDCP')

    def test_capture_failure_does_not_write_exception_or_partial_image(self):
        output = io.BytesIO()
        def fail_capture():
            raise RuntimeError('private-canary')
        with self.assertRaises(RuntimeError):
            module.serve(io.BytesIO(struct.pack('!I', 1)), output, fail_capture)
        self.assertEqual(output.getvalue(), b'LDCP')


if __name__ == '__main__':
    unittest.main()
