#!/usr/bin/env bash
# Step 3's motion run with timestamps, so its samples line up with recorder.js's ldSummary(from, to):
# 500 Down presses at 40 ms into the focused window, ten docker stats samples 2 s apart, and the
# brief's `top -l 3 -s 2` summed over one Chrome's process tree (the viewer's, not everyday Chrome).
#   CHROME_PID=<the viewer's browser process> HOST_LOG=<host.mjs output> ./motion.sh <label>
set -uo pipefail
LABEL=${1:?usage: CHROME_PID=<pid> HOST_LOG=<file> motion.sh <label>}
CHROME_PID=${CHROME_PID:?set CHROME_PID to the browser process of the viewer Chrome}
HOST_LOG=${HOST_LOG:?set HOST_LOG to the file host.mjs writes}
OUT="$(cd "$(dirname "$0")" && pwd)/out"
mkdir -p "$OUT"
now() { perl -MTime::HiRes=time -e 'printf "%.3f", time'; }
exec > >(tee "$OUT/motion-$LABEL.txt") 2>&1
echo "label $LABEL"
echo "host_log_line_at_start $(wc -l < "$HOST_LOG" | tr -d ' ')"
echo "scroll_start $(now)"
docker exec -u abc -e DISPLAY=:1 ld-s8-desktop xdotool key --delay 40 --repeat 500 Down &
keys=$!
(
  sleep 3
  echo "top_start $(now)"
  top -l 3 -s 2 -stats pid,cpu,command > "$OUT/top-$LABEL.txt"
) &
top_job=$!
for _ in $(seq 1 10); do
  echo "stats $(now) $(docker stats --no-stream --format '{{.CPUPerc}} {{.MemUsage}}' ld-s8-desktop)"
  sleep 2
done
wait "$keys"
echo "keys_end $(now)"
wait "$top_job"
echo "host_log_line_at_end $(wc -l < "$HOST_LOG" | tr -d ' ')"
pids=$(ps -axo pid,ppid | awk -v r="$CHROME_PID" '$1 == r || $2 == r { print $1 }' | tr '\n' ' ')
awk -v pids="$pids" '
  BEGIN { n = split(pids, a, " "); for (i = 1; i <= n; i++) want[a[i]] = 1 }
  /^Processes:/ { sample++ }
  sample > 0 && ($1 in want) { sum[sample] += $2 }
  END { for (s = 2; s <= sample; s++) printf "chrome_cpu_sample_%d %.1f\n", s, sum[s] }
' "$OUT/top-$LABEL.txt"
