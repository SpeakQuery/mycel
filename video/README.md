# Mycel launch film

> The film is a dramatization. Its 500 MB video example with transcript uses illustrative data (video/data.json); today the built-in video digest returns metadata and keyframe refs, no transcript. The film's final frame shows an outdated command; the correct one is `npx @speakquery/mycel init` (the package is published as @speakquery/mycel).

The source for the 90-second Mycel launch video, built with [HyperFrames](https://hyperframes.heygen.com): HTML and GSAP, rendered locally to MP4. Nothing in it uses a paid or cloud service.

## Re-render everything (one command)

From this `video/` folder:

```bash
bash scripts/build-media.sh      # same as: npm run media
```

This command:

1. copies `data.json` into `assets/data.js`,
2. builds the ambient music bed if `assets/ambient.m4a` is missing,
3. renders `../media/mycel-launch.mp4` (1920×1080, 30 fps, H.264 + AAC, 90 s),
4. writes `../media/mycel-launch-preview.gif` (960 px, about 11 s, ffmpeg palettegen),
   `../media/mycel-poster.png` (1920×1080, the architecture frame at 41 s) and
   `../media/mycel-social.png` (1280×640, the logo reveal at 30.5 s).

It takes about a minute. You need Node 22+ and ffmpeg.

## Changing the numbers

Every number on screen comes from **`data.json`**: benchmark figures, token counts, round trips, the import summary, the video metadata in the Ref Store demo, and the dashboard port. Edit that file, then run the command above. Do not edit `assets/data.js`, because the build overwrites it.

| Key | Where it shows |
| --- | --- |
| `hookTools`, `hookTokens` | Opening context-window meter ("Your AI agent has 167 tools") |
| `toolsDirect`, `serversDirect`, `tokensDirect` | Problem card 1, before/after panel 1, montage |
| `toolsMycel`, `tokensMycel`, `tokenSavings` | Before/after panel 1, architecture box, montage |
| `roundTripsDirect`, `roundTripsMycel` | Problem card 3, before/after panel 3 (one row per round trip) |
| `rowsThrough`, `timeoutSec` | Problem cards 2 and 5 |
| `videoSize`, `videoMeta`, `refHash`, `digestTokens`, `keyframeTimes`, `transcript` | Before/after panel 2 (Ref Store) |
| `featuresTotal` | Montage closing line |
| `imports`, `importedTotal`, `dashboardPort` | `npx mycel init` terminal |

`toolsDirect` sets how many tool chips are drawn, and `roundTripsDirect` sets how many round-trip rows are drawn (capped at 14).

## Working on it

```bash
npm run data                         # sync data.json -> assets/data.js (do this before preview/check)
npx hyperframes preview              # live Studio preview in the browser
npx hyperframes check                # lint, layout, contrast and motion checks
npx hyperframes snapshot --at 5,30,41  # PNG stills to inspect
```

| Scene file | Time | Beat |
| --- | --- | --- |
| `compositions/bg.html` | 0–90 s | Persistent mycelium network background (seeded, deterministic) |
| `compositions/hook.html` | 0–8 s | Context window filling with tool schemas |
| `compositions/problem.html` | 8–25 s | Six problem cards |
| `compositions/reveal.html` | 25–32 s | Threads form the Mycel lockup |
| `compositions/arch.html` | 32–44 s | Architecture: clients, the Mycel layer, upstream servers |
| `compositions/proof.html` | 44–60 s | Before and after: tools, Ref Store, Code Mode |
| `compositions/montage.html` | 60–78 s | Feature grid |
| `compositions/cta.html` | 78–90 s | `npx mycel init`, then the end card |

Colours: ground `#07110D`, accent `#3DFFB0`, warning `#FFB547`. Fonts: Inter and JetBrains Mono, both bundled with HyperFrames.

## Audio

`scripts/make-audio.sh` synthesises the ambient bed with ffmpeg sine and noise generators: a dark pad that opens into a brighter chord at the 25 s reveal. No samples are used. Delete `assets/ambient.m4a` and re-run to regenerate it. The mix is about −19 LUFS integrated with a peak around −10 dBFS.
