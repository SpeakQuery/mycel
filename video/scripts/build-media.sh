#!/usr/bin/env bash
# One command: data.json -> rendered film -> GIF, poster and social image in ../media/
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=../media
mkdir -p "$OUT"
node scripts/sync-data.mjs
[ -f assets/ambient.m4a ] || scripts/make-audio.sh
npx --yes hyperframes@0.9.21 render --quality delivery -o "$OUT/mycel-launch.mp4"

# README highlight loop: the reveal (25-31.9 s) cut to the finished architecture (38.5-42.5 s).
ffmpeg -y -hide_banner -loglevel error -i "$OUT/mycel-launch.mp4" -filter_complex "
  [0:v]trim=25:31.9,setpts=PTS-STARTPTS[a];
  [0:v]trim=38.5:42.5,setpts=PTS-STARTPTS[b];
  [a][b]concat=n=2:v=1,fps=15,scale=960:-1:flags=lanczos,split[x][y];
  [x]palettegen=max_colors=128:stats_mode=diff[p];
  [y][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "$OUT/mycel-launch-preview.gif"

# Poster: the finished architecture frame. Social: the logo reveal, cropped to 2:1.
ffmpeg -y -hide_banner -loglevel error -ss 41 -i "$OUT/mycel-launch.mp4" -frames:v 1 "$OUT/mycel-poster.png"
ffmpeg -y -hide_banner -loglevel error -ss 30.5 -i "$OUT/mycel-launch.mp4" -frames:v 1 \
  -vf "crop=1920:960:0:80,scale=1280:640:flags=lanczos" "$OUT/mycel-social.png"
ls -lh "$OUT"
