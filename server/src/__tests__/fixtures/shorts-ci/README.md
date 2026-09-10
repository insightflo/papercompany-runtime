# shorts-ci fixtures — ordinary-CI producer test assets

Checked-in synthetic inputs for the shorts CU / local-sketch tests. Ordinary CI reads
these bytes directly and never executes Python, ffmpeg, or a sibling checkout; real
producer semantics run only via the opt-in external suite (`pnpm test:shorts-external`,
see doc/DEVELOPING.md).

| File | Purpose |
| --- | --- |
| `receipt.json` | Independent actual `cu_reuse_sketch.py` output, captured by the parent probe run (`/private/tmp/sketch-parent-probe-nSkRBA/out/receipt.json`) and copied verbatim. Ordinary CI consumes it through `parseLocalSketchReceipt` — only the consumer boundary is proven, not raw Python intake. |
| `portrait.mp4` | Tiny valid 90x160 (9:16) H.264/yuv420p video, 2 s at 25 fps, used as the CU clip media. |
| `screen.png` | First frame of `portrait.mp4` (90x160 PNG), used as the CU source screenshot. |
| `receiver.mjs` | Producer TEST DOUBLE. Reads the controller snapshot for job scope and the hydrated manifest, then emits the literal consumer contract (`shorts.clips-result.v1` + `shorts.cu-receiver-status.v1`). It is NOT a Python reimplementation and verifies nothing about media, source, evidence, snapshot hash or budget. |

## Regenerating the media fixtures

Generate once with the exact command below, then update the sha256 list:

```sh
ffmpeg -y -v error -f lavfi -i color=c=blue:s=90x160:r=25 -t 2 \
  -c:v libx264 -pix_fmt yuv420p portrait.mp4
ffmpeg -y -v error -i portrait.mp4 -frames:v 1 screen.png
```

## sha256

- `portrait.mp4`: `da31ed462a167de89dacb95cd785debd5276730eb639ce8dd762ad2df224ab2a`
- `screen.png`: `4464320d71dfd4186b6ebfc41d2c249f2e9e62d89cb27238f46b95b8aeceb112`
- `receipt.json`: `7b1c2aa82ecdd8929887e00d6c555456f9e5cfc3fd0ae2e15452c5c31c1ca9b9`
- `receiver.mjs`: `c839204e80bff10f1b24db48d371313ae64059a4f9422e11952250e98ed691d2` (source code, pinned for tamper evidence only)
