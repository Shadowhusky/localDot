---
name: captions
description: Transcribe speech in audio or video into SRT or VTT subtitles with Whisper, fix them up, and burn them in or attach them to the video with ffmpeg.
---
# Captions and subtitles

## Transcribe
1. Audio track for speed: `ffmpeg -i in.mp4 -vn -ac 1 -ar 16000 /tmp/speech.wav`
2. Install once: `python3 -m venv ~/.venvs/asr && ~/.venvs/asr/bin/pip install faster-whisper`
3. Transcribe to SRT (the `small` model is a good CPU default; `medium` is better and slower):
   ```python
   from faster_whisper import WhisperModel
   m = WhisperModel("small", device="cpu", compute_type="int8")
   segs, info = m.transcribe("/tmp/speech.wav", vad_filter=True, word_timestamps=False)
   def ts(t): h, r = divmod(t, 3600); mi, s = divmod(r, 60); return f"{int(h):02}:{int(mi):02}:{s:06.3f}".replace(".", ",")
   with open("subs.srt", "w") as f:
       for i, s in enumerate(segs, 1): f.write(f"{i}\n{ts(s.start)} --> {ts(s.end)}\n{s.text.strip()}\n\n")
   ```
   Pass `language="en"` (or the right code) when you know it; `info.language` says what it heard.
4. Read the SRT and fix names, jargon and obvious mishearings. Keep lines under ~42 characters and
   two lines per cue; split long cues.

## Use them
- Attach as a track (can be turned off): `ffmpeg -i in.mp4 -i subs.srt -c copy -c:s mov_text out.mp4`
- Burn in (always visible, social video):
  `ffmpeg -i in.mp4 -vf "subtitles=subs.srt:force_style='FontName=Inter,FontSize=18,Bold=1,Outline=2,BorderStyle=1,MarginV=60'" -c:a copy out.mp4`
- WebVTT for the web: `ffmpeg -i subs.srt subs.vtt`

## Check before handing over
Watch three or four cues in the exported video: in sync, readable, nothing cut off at the bottom
(vertical video needs a larger MarginV).
