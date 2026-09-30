"""Shared texts, voices and paths for the V0-4 TTS spike."""

from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"

TTS_DESIGN = "mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit"
TTS_BASE = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-8bit"
ALIGNER = "mlx-community/Qwen3-ForcedAligner-0.6B-8bit"

LANG = {"zh": "Chinese", "en": "English", "ja": "Japanese"}

SENTENCES = {
    "zh": ["你终于回来了。你不在的时候，我把下载文件夹整理好了。", "说实话，里面简直一团糟，不过这次就放过你吧。"],
    "en": [
        "Hey, you're finally back. I sorted your downloads folder while you were gone.",
        "Honestly, it was a disaster, but I'll let it slide this time.",
    ],
    "ja": [
        "やっと帰ってきたのね。あなたがいない間に、ダウンロードフォルダを整理しておいたわ。",
        "正直、ひどい有様だったけど、今回は見逃してあげる。",
    ],
}

# The designed voice speaks this once; the clip and text become the cloning reference.
REF_LANG = "zh"
REF_TEXT = "你好，我是你的助手。今天有什么需要我帮忙的吗？别客气，尽管说吧。"

# Text-only voice descriptions: no real person, no existing character.
VOICE_DESIGNS = {
    "a": "A young woman in her early twenties, clear and calm, quick and precise, a little dry and teasing, warm underneath.",
    "b": "A young woman around eighteen, clear bright slightly high-pitched voice, confident and a little teasing, crisp articulation, anime heroine style.",
    "c": "A young woman around eighteen, mid-pitched, cool and composed, quick precise delivery, dry wit with faint warmth, anime heroine style.",
}
