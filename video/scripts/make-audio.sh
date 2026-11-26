#!/usr/bin/env bash
# Synthesises the ambient-electronic bed (assets/ambient.m4a) locally with ffmpeg.
# No samples, no downloads: every sound is a generated sine or noise source.
# Two pads: a dark A-minor pad until the reveal (25 s), then a brighter lift.
set -euo pipefail
cd "$(dirname "$0")/.."
D=90      # film length in seconds
R=25      # reveal moment: the music opens here
OUT=assets/ambient.m4a

ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "sine=f=55:d=$D" \
  -f lavfi -i "sine=f=110:d=$D" \
  -f lavfi -i "sine=f=164.81:d=$D" \
  -f lavfi -i "sine=f=261.63:d=$D" \
  -f lavfi -i "sine=f=329.63:d=$D" \
  -f lavfi -i "sine=f=392.00:d=$D" \
  -f lavfi -i "sine=f=493.88:d=$D" \
  -f lavfi -i "sine=f=659.25:d=$D" \
  -f lavfi -i "anoisesrc=c=pink:d=$D:a=0.6:seed=7" \
  -filter_complex "
    [0]volume=0.30,tremolo=f=0.5:d=0.3[s0];
    [1]volume=0.22,tremolo=f=0.13:d=0.4[s1];
    [2]volume=0.16,tremolo=f=0.21:d=0.5[s2];
    [3]volume='0.10+0.10*clip((t-$R+0.5)/2.5,0,1)':eval=frame,tremolo=f=0.17:d=0.6[s3];
    [4]volume='0.05+0.11*clip((t-$R+0.5)/2.5,0,1)':eval=frame,tremolo=f=0.29:d=0.6[s4];
    [5]volume='0.00+0.09*clip((t-$R+0.5)/2.5,0,1)':eval=frame,tremolo=f=0.11:d=0.7[s5];
    [6]volume='0.00+0.06*clip((t-$R+0.5)/2.5,0,1)':eval=frame,tremolo=f=0.37:d=0.8[s6];
    [7]volume='0.00+0.035*clip((t-$R+0.5)/2.5,0,1)':eval=frame,tremolo=f=2:d=0.9[s7];
    [8]bandpass=f=900:width_type=o:w=1.2,tremolo=f=0.1:d=0.7,volume=0.05[n];
    [s0][s1][s2][s3][s4][s5][s6][s7][n]amix=inputs=9:normalize=0,
      lowpass=f=5200,aecho=0.8:0.6:420|700:0.35|0.22,
      afade=t=in:d=2.5,afade=t=out:st=$((D-4)):d=4,
      loudnorm=I=-20:TP=-2:LRA=7,aformat=sample_rates=48000:channel_layouts=stereo[out]" \
  -map "[out]" -c:a aac -b:a 192k "$OUT"
echo "wrote $OUT"
