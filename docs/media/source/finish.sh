#!/bin/bash
# Carve the music under the voice, check, render both variants and encode them for the repository.
#   ./finish.sh [poster-time-in-seconds]      (env: CLIP_DIR, OUT_DIR = docs/media, CRF)
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT=${OUT_DIR:-$HERE/..}
CRF=${CRF:-20}
POSTER_AT=${1:-39.2}
export HYPERFRAMES_NO_TELEMETRY=1
RAW=$HERE/composition/renders
mkdir -p "$RAW"

render() { # name
  (cd "$HERE/composition" && npx hyperframes check 2>&1 | grep -E "error\(s\)|✗" | head -5; npx hyperframes render --quality delivery --output "renders/$1.mp4")
}
encode() { # name final-name
  ffmpeg -y -loglevel error -i "$RAW/$1.mp4" -c:v libx264 -preset slow -crf "$CRF" -pix_fmt yuv420p -profile:v high -r 30 \
    -c:a aac -b:a 160k -movflags +faststart "$OUT/$2.mp4"
}

# 1. voice only (no music): the voice, the sound effects, nothing else
NO_MUSIC=1 node "$HERE/build.mjs" > /dev/null
render nomusic
encode nomusic chdash-presentation-nomusic

# 2. with music: the bed carved under the voice
node "$HERE/build.mjs" > /dev/null
node "$HOME/.claude/skills/hyperframes-audio/scripts/carve.mjs" --comp "$HERE/composition/index.html"
node "$HERE/merge-fade.mjs" "$HERE/composition/index.html"
render music
encode music chdash-presentation

# 3. the poster: a settled frame, also baked as frame 0 of the video (what thumbnails show)
ffmpeg -y -loglevel error -ss "$POSTER_AT" -i "$OUT/chdash-presentation.mp4" -frames:v 1 -q:v 2 "$OUT/chdash-presentation.jpg"
for f in chdash-presentation chdash-presentation-nomusic; do
  ffmpeg -y -loglevel error -i "$OUT/$f.mp4" -i "$OUT/chdash-presentation.jpg" \
    -filter_complex "[0:v][1:v]overlay=0:0:enable='eq(n,0)'[v]" -map "[v]" -map "0:a?" \
    -c:v libx264 -preset slow -crf "$CRF" -pix_fmt yuv420p -c:a copy -movflags +faststart "$OUT/$f.poster.mp4"
  mv "$OUT/$f.poster.mp4" "$OUT/$f.mp4"
done
ls -la "$OUT"/chdash-presentation*
