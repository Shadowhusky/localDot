import pytest

from voiced.config import ConfigError, Settings

TOKEN = "t" * 43


def test_reads_the_token_port_and_defaults():
    settings = Settings.from_env({"LOCALDOT_VOICED_TOKEN": TOKEN, "LOCALDOT_VOICED_PORT": "4752"})
    assert (settings.port, settings.voice, settings.idle_unload_s, settings.accurate_asr) == (4752, None, 600.0, False)
    assert settings.lm_studio_url == "http://127.0.0.1:1234"


def test_refuses_a_short_token_without_echoing_it():
    with pytest.raises(ConfigError) as problem:
        Settings.from_env({"LOCALDOT_VOICED_TOKEN": "short-secret"})
    assert "short-secret" not in str(problem.value)


def test_loads_a_voice_folder_and_names_what_is_missing(tmp_path):
    (tmp_path / "ref.wav").write_bytes(b"RIFF")
    with pytest.raises(ConfigError, match="ref.txt"):
        Settings.from_env({"LOCALDOT_VOICED_TOKEN": TOKEN, "LOCALDOT_VOICE_DIR": str(tmp_path)})
    (tmp_path / "ref.txt").write_text("  hello there  \n", encoding="utf-8")
    voice = Settings.from_env({"LOCALDOT_VOICED_TOKEN": TOKEN, "LOCALDOT_VOICE_DIR": str(tmp_path)}).voice
    assert voice is not None and voice.audio == tmp_path / "ref.wav" and voice.text == "hello there"


def test_rejects_a_port_that_is_not_a_number():
    with pytest.raises(ConfigError, match="LOCALDOT_VOICED_PORT"):
        Settings.from_env({"LOCALDOT_VOICED_TOKEN": TOKEN, "LOCALDOT_VOICED_PORT": "47x2"})
