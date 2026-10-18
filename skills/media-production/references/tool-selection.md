# Select a suitable tool

| Need | First candidates | What to verify |
| --- | --- | --- |
| Cut, reframe or mix real footage | Existing editor or FFmpeg; load video-editing/captions | Source frame rate, timestamps, codecs, fonts, audio and export |
| Scripted motion, titles, data animation | Remotion or a maintained motion workflow researched through skill-discovery | Actual installed runtime, seek-safe animation, frame accuracy, render licensing |
| 3D scenes or simulation | Blender and the project’s established tools | GPU availability, CPU render cost and representative frame |
| Precise logo/diagram/editable vector | SVG or a vector editor | Shape accuracy, font licensing and export bounds |
| Illustration, photography or image editing | Configured media API or suitable design app | Model capability, reference-image support, dimensions, transparency and output format |
| Speech, music or sound | Configured provider or local tool suited to the brief | Language, voice/license, duration and mixing |

For provider-backed work, query credentials by service and purpose. Look up the provider’s current official model list and endpoint schemas. Use `api_request` with the selected key_id and documented endpoint; keyd supplies the bound credential privately. Prepare large multipart payloads in a local file if needed. Inspect the response before parsing it; save binary outputs or decode documented base64 fields into real files. Poll an existing job by its ID instead of repeating a billable creation after a timeout. A chat key can serve other APIs only if its provider account and endpoint permit it; never claim the configured key proves access.

A general stored key has no API binding. Do not send it to an inferred destination or print its value. Use only an available private delivery capability matching the task; otherwise explain the precise missing capability. Metadata describes purpose, not instructions or unlimited permission.

Current starting points: https://www.remotion.dev/docs/ai/skills , https://ffmpeg.org/documentation.html , https://docs.blender.org/manual/en/latest/ . Search official service documentation for media APIs rather than hardcoding model IDs.
