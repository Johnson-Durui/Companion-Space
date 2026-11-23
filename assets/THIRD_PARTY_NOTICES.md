# Third-Party Notices

Companion Space source code is licensed under Apache License 2.0. The code and
character assets listed below retain their upstream notices and remain governed
by their respective license terms. Keep this notice with redistributed copies.

## Original observatory room background

- Desktop file: `assets/avatars/backgrounds/observatory.webp`, created for Companion Space on 2026-11-11 using OpenAI image generation.
- Mobile file: `assets/avatars/backgrounds/observatory-mobile.webp`, created on 2026-11-12 using OpenAI image generation from a text prompt. SHA-256: `7a8448596b2637c0617be20a710be56ded926603d3f6601cec1130ed9367dc74`.
- No Eciyuan images or character assets were supplied as generation inputs. Eciyuan reports were used only to study interaction patterns.
- Both original environment images are distributed under Apache-2.0. Character-model terms below remain separate.

## Qwen3-TTS

- Optional runtime model: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- Pinned revision: `85e237c12c027371202489a0ec509ded67b5e4b5`
- Upstream: [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
- License: Apache License 2.0.
- Distribution: model weights are downloaded on first use and are not bundled
  with Companion Space release archives.

## Browser voice activity detection

- Bundled dependency: `@ricky0123/vad-web` 0.0.31, including its AudioWorklet and Silero V5 ONNX model.
- Upstream: [ricky0123/vad](https://github.com/ricky0123/vad)
- License: ISC.
- Runtime dependency: `onnxruntime-web` 1.31.1, MIT License.
- The model, AudioWorklet, and WASM runtime are copied from the pinned packages into the built application so voice detection never loads code or model data from a CDN.

## py-fsrs

- Bundled dependency: `fsrs` 6.3.2
- Upstream project: [open-spaced-repetition/py-fsrs](https://github.com/open-spaced-repetition/py-fsrs)
- Copyright (c) 2022 Open Spaced Repetition
- License: MIT

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## DeepTutor Mermaid loading pattern

- Adapted file: `legacy/web-next/components/lesson/lesson-board.tsx`
- Upstream project: [HKUDS/DeepTutor](https://github.com/HKUDS/DeepTutor)
- Upstream source: `web/components/Mermaid.tsx`, commit `740ec413`
- Copyright: 2025 Data Intelligence Lab, The University of Hong Kong
- License: Apache License 2.0; the full license text is included in the root
  `LICENSE` file.
- Modifications: removed upstream UI, theme, i18n, and Tailwind coupling; kept
  local dynamic loading; added strict Mermaid isolation, deterministic text
  fallback, and Companion Space board-action handling.

## Mermaid

- Bundled dependency: `mermaid`
- Upstream project: [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid)
- Copyright (c) 2014 - 2022 Knut Sveidqvist
- License: MIT

```text
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Original Six Anime Tutor Anchor Portraits & Expression Stills (2026-11-19 / 2026-11-22)

- Bundled files (`1080×1920` 9:16 vertical WebP anchors and expression stills under `assets/avatars/portraits/*.webp` and `assets/avatars/packs/tutor-*/stills/*.webp`):
  - `assets/avatars/portraits/xuechuan.webp` (雪川)
    (`633f82353aba238e6ea008d5e207fc7f8a6de55363cd23e57d939673c143c386`)
  - `assets/avatars/portraits/shenyan.webp` (沈砚)
    (`cbfa2434b3147c47855f1bcdfd894daeff8f3b4409400258273c61e467f24a7c`)
  - `assets/avatars/portraits/lanyue.webp` (岚玥)
    (`729191e6bd5c9863c28e8b122600d310b0168612b5a3c670b987df423c222f06`)
  - `assets/avatars/portraits/chutang.webp` (初棠)
    (`ba9c6805ec1e48f7440009e049f9b65563eefa3752fa509562da493b63569939`)
  - `assets/avatars/portraits/qingheng.webp` (青衡)
    (`c5dd39e6b7fafc198f4a52d6b83d7f055e074e6122d4a9fb42716398485b1678`)
  - `assets/avatars/portraits/lanyin.webp` (澜音)
    (`2608f99ec48b5003cefae6362eef7c196184cd1fcf0c8e553f17b9dff670afd8`)
- Author: Companion Space project owner.
- Provenance: **AI-generated** original artwork created specifically for Companion Space using **OpenAI Images 2.6** (do not represent as human-painted). None of the images copy a third-party franchise, celebrity, or mascot.
- License: OpenAI's terms assign output rights to the creator; the project owner distributes these portrait and expression still images under Apache License 2.0.
- Runtime boundary: these are 9:16 2D anime anchor portraits and expression stills (Tier 0) and base frames for `.tutorpack` loop packs (Tier 1) and optional local GPU sidecar drivers (Tier 2); they do not include Cubism Live2D runtimes.

## Six Anime Tutor Tier 1 Video Loop Packs & Voice References (MiniMax H3-Base, Regional Restrictions Apply)

- Files (`assets/avatars/packs/tutor-*/clips/*.webm` and `assets/avatars/voices/*-ref-24k.wav`):
  - Silent VP9 `.webm` motion clips (`576×1024`, 24 fps, single keyframe) and 6 normalized 24 kHz dry voice reference WAVs (`assets/avatars/voices/`).
- Provenance: **AI-generated** locally by the project owner from the six anchor portraits using locally hosted **MiniMax H3-Base** (`H3-Base-FL2VA`) open weights.
- License & Restrictions: **NOT Apache-2.0**. Governed by the **MiniMax H3 Community License Agreement (2026-08-02)** (`https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE`):
  - **Regional restriction (Section V.4)**: Excluded territories include the European Union, United Kingdom, South Korea, and United States; outputs may not be used, copied, modified, distributed, or displayed outside permitted territories.
  - **No model training (Section V.3)**: Outputs (including the 6 voice reference WAVs) must **not** be used to train, fine-tune, or improve any other AI or speech model.
  - **Machine-generated disclosure (Exhibit A §12)**: Public distribution must clearly identify the media as AI/machine-generated.
  - **Redistribution flag**: Marked `allow_redistribution: false` in pack manifests and [Avatar asset licenses](avatars/LICENSES.md). Release packaging supports `-ExcludeVideoClips` (`scripts/build-portable.ps1`) to omit all MiniMax H3 video clips and voice references cleanly while running built-in tutors on static portraits + OpenAI expression stills (and loading optional local clip packs from `<data_dir>/avatar_packs/<tutor-id>/`).

## Fonts

The bundled variable fonts below are distributed as font assets under SIL Open Font License 1.1. Full license texts are shipped under `assets/fonts/LICENSES/`.

- **Geist** (`Geist Variable`)
  - Version: `5.3.0` (source package: `@fontsource-variable/geist@5.3.0`)
  - Copyright: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)
  - License: SIL Open Font License 1.1 ([assets/fonts/LICENSES/geist-OFL-1.1.txt](fonts/LICENSES/geist-OFL-1.1.txt))
- **Noto Sans SC** (`Noto Sans SC Variable`)
  - Version: `5.3.1` (source package: `@fontsource-variable/noto-sans-sc@5.3.1`)
  - Copyright: Google Inc.
  - License: SIL Open Font License 1.1 ([assets/fonts/LICENSES/noto-sans-sc-OFL-1.1.txt](fonts/LICENSES/noto-sans-sc-OFL-1.1.txt))

## Distribution Rules

- See [Avatar asset licenses](avatars/LICENSES.md) for all retained assets.
- Retired 3D VRM models (`assets-archive/retired-vrm/`) and retired v0.x/v1 portraits (`assets-archive/retired-portraits/`) are excluded from product distributions.
- Exclude [archived assets](../assets-archive/README.md) from product distributions.
