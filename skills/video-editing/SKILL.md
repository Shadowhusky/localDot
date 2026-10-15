---
name: video-editing
description: Edit video with ffmpeg - inspect, trim, cut and join, crop or pad for each platform, speed up, add music or voice, normalise loudness, add titles, and export MP4 or GIF.
---
# Video editing with ffmpeg

ffmpeg and ffprobe are installed. Keep the originals; write every step to a new file in a working
folder such as `~/Videos/edit/`.

## Inspect
`ffprobe -v error -show_entries format=duration:stream=codec_type,codec_name,width,height,r_frame_rate -of compact file.mp4`
Contact sheet of the footage (one frame every 5 s):
`ffmpeg -i in.mp4 -vf "fps=1/5,scale=320:-1,tile=6x5" -frames:v 1 /tmp/sheet.png`

## Cut
- Fast trim on keyframes (no re-encode): `ffmpeg -ss 00:01:05 -to 00:01:40 -i in.mp4 -c copy clip.mp4`
- Frame-accurate trim: put `-ss`/`-to` after `-i` and re-encode: `-c:v libx264 -crf 18 -preset medium -c:a aac -b:a 192k`
- Join clips with the same codec and size: write `file 'a.mp4'` lines to `list.txt`, then
  `ffmpeg -f concat -safe 0 -i list.txt -c copy joined.mp4`. Different sources: re-encode them to one
  format first, or use the `concat` filter.
- Crossfade two clips: `-filter_complex "[0:v][1:v]xfade=transition=fade:duration=0.5:offset=<len0-0.5>[v];[0:a][1:a]acrossfade=d=0.5[a]" -map "[v]" -map "[a]"`

## Shape for the platform
- 9:16 vertical (Shorts, Reels, TikTok) from 16:9, centre crop:
  `-vf "crop=ih*9/16:ih,scale=1080:1920,setsar=1"` · keep everything with blurred bars:
  `-filter_complex "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=20[bg];[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2"`
- 16:9 1920×1080 for YouTube: `-vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,setsar=1"`
- Square 1080×1080: `-vf "crop=min(iw\,ih):min(iw\,ih),scale=1080:1080"`

## Time and sound
- Speed up 2× (video and audio): `-filter_complex "[0:v]setpts=0.5*PTS[v];[0:a]atempo=2.0[a]" -map "[v]" -map "[a]"`
- Replace the audio with music, ducked under 30% and cut to the video: `-i music.mp3 -map 0:v -map 1:a -af "volume=0.3" -shortest`
- Mix voice over music: `-filter_complex "[1:a]volume=0.25[m];[0:a][m]amix=inputs=2:duration=first[a]"`
- Loudness for the web (−14 LUFS): `-af loudnorm=I=-14:TP=-1.5:LRA=11`
- Extract audio: `ffmpeg -i in.mp4 -vn -c:a libmp3lame -q:a 2 audio.mp3`

## Titles and stills
- Text overlay: `-vf "drawtext=fontfile=/usr/share/fonts/truetype/inter/Inter-Bold.ttf:text='Day 1':fontsize=64:fontcolor=white:box=1:boxcolor=black@0.4:boxborderw=20:x=(w-tw)/2:y=h*0.1:enable='between(t,0,3)'"`
  (find fonts with `fc-list | grep -i inter`)
- Thumbnail at 3 s: `ffmpeg -ss 3 -i in.mp4 -frames:v 1 -q:v 2 thumb.jpg`
- GIF: `ffmpeg -i clip.mp4 -vf "fps=12,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" out.gif`

## Export defaults
`-c:v libx264 -crf 20 -preset medium -pix_fmt yuv420p -c:a aac -b:a 192k -movflags +faststart` in MP4.

## Check before handing over
ffprobe the export (duration, size, both streams present), pull 3–4 stills across it to look at,
and play a few seconds where cuts happen. Say the final length, resolution and file size.
