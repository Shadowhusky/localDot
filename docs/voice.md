# Voice input

The composer uses a local whisper.cpp model on the computer running localDot when installed, then browser on-device recognition, then the browser's online recognizer only when enabled in Voice settings. A configured local model takes priority over online speech. Audio is never sent to a model provider for local transcription.

The local route captures mono PCM in an AudioWorklet, resamples to 16 kHz and updates the draft approximately every four seconds plus model processing time. Only one preview request runs at once. Stop flushes the final samples and releases microphone tracks before waiting for transcription; Send waits for that final text; Cancel discards the recording and restores the draft. A new turn owns a new audio graph. Leaving or reloading the page releases capture. Audio lives in browser memory and a private temporary server file while transcribing; that file is removed afterward. The agent receives only submitted text.

AudioContext is resumed synchronously in the initiating click before requesting microphone permission. Where available, Audio Session is set to play-and-record while capturing and restored afterward. This avoids using a second microphone alongside Web Speech recognition. Snapshot waits are bounded; digital silence is not submitted to the model. The browser route still has bounded startup/retry timeouts where no local model is available.

WebKit has an unresolved report of browser SpeechRecognition becoming silent after audio/video playback: [WebKit 321436](https://bugs.webkit.org/show_bug.cgi?id=321436). Retrying that same browser service is not a reliable recovery. Local transcription avoids that service entirely and measures actual microphone samples for the waveform. Desktop WebKit tests do not substitute for testing iOS hardware or OS microphone permission behavior.

## Local speech setup

Install [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`brew install whisper.cpp` on macOS) and a multilingual GGML model from its official model documentation. Put the model in `~/.cache/whisper.cpp/` or set `LOCALDOT_SPEECH_MODEL` in the daemon's environment. Homebrew's current `share/whisper.cpp` and older `share/whisper-cpp` directories are also recognized. A multilingual base or small model is suitable for dictation; an English-only model is used only for English. No provider key is needed. Returning to the page refreshes capability detection. Settings → Voice shows “On your Mac” once the local route is available.

The authenticated `GET /api/voice` reports whether a model is installed. Transcription uses the existing authenticated WAV endpoint; both browser recording and server requests are bounded. Cancellation reaches the child process. Setup failures release the busy flag so future recordings can proceed.

## Verification

Unit tests cover capture ownership, cancellation during permission, page reload cleanup, resampling, silent audio, progressive text, final flush, stale responses, service discovery and server lock release. The opt-in `composer-voice-capture.spec.ts` exercises actual AudioWorklet capture and the local Whisper model in Chromium and mobile WebKit. Set `LOCALDOT_TEST_SPEECH_AUDIO` to a synthesized WAV containing “voice recording”, `LOCALDOT_TEST_SPEECH_MODEL` to the GGML file, and `LOCALDOT_TEST_SPEECH_BINARY` to whisper-cli, then run the spec with projects c14 and w39. It injects synthetic audio into a Web Audio input graph, requires local transcription responses and tests Stop, Cancel, Send, reload and subsequent recordings without accessing a person's microphone.
