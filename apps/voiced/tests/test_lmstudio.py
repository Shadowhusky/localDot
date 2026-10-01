import io
import json

from voiced.lmstudio import lm_studio_refusal


def answering(listing):
    def opener(url, timeout):
        assert url == "http://127.0.0.1:1234/api/v1/models"
        return io.BytesIO(json.dumps(listing).encode())

    return opener


def model(key, size, loaded):
    return {"key": key, "size_bytes": size, "loaded_instances": [{"id": key}] if loaded else []}


def test_refuses_while_a_model_over_30_gb_is_loaded():
    listing = {"models": [model("qwen3.6-35b", 44_500_000_000, True), model("small", 4_000_000_000, True)]}
    assert lm_studio_refusal("http://127.0.0.1:1234", answering(listing)) == "LM Studio has qwen3.6-35b loaded (44.5 GB)"


def test_allows_small_or_unloaded_models():
    listing = {"models": [model("qwen3.6-35b", 44_500_000_000, False), model("small", 17_700_000_000, True)]}
    assert lm_studio_refusal("http://127.0.0.1:1234", answering(listing)) is None


def test_allows_when_lm_studio_is_not_running_or_answers_oddly():
    def refused(url, timeout):
        raise ConnectionRefusedError()

    assert lm_studio_refusal("http://127.0.0.1:1234", refused) is None
    assert lm_studio_refusal("http://127.0.0.1:1234", lambda u, t: io.BytesIO(b"<html>")) is None
    assert lm_studio_refusal("http://127.0.0.1:1234", answering({"models": "nope"})) is None
    assert lm_studio_refusal("http://127.0.0.1:1234", answering([1, 2])) is None
