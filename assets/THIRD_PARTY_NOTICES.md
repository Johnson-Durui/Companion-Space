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

## Original Six Anime Tutor Anchor Portraits (2026-11-19)

- Bundled files (`1080×1920` 9:16 vertical WebP anchors):
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
- Provenance: original AI-assisted artwork created specifically for Companion
  Space on 2026-11-19 for the pure-video `<TutorVideoBox>` roster. None of the
  images copy a third-party franchise, celebrity, or mascot.
- Third-party license: none. These project-owned portrait assets are distributed
  under the same Apache License 2.0 terms as the repository unless a release
  notice says otherwise.
- Runtime boundary: these are 9:16 2D anime anchor portraits (Tier 0) and base
  frames for `.tutorpack` loop packs (Tier 1) and optional local GPU sidecar
  drivers (Tier 2); they do not include Cubism Live2D runtimes.

## Original Six Anime Tutor Tier 1 Video Loop Packs & Voice References (2026-11-21)

- Bundled packs (`assets/avatars/packs/tutor-{xuechuan,shenyan,lanyue,chutang,qingheng,lanyin}/`):
  - 6 complete 8-clip silent VP9 `.webm` packs (`480×864`, 24 fps, `idle_breathe`, `listen_nod`, `think_chin`, `speak_explain_a`, `speak_explain_b`, `board_point`, `react_praise`, `react_comfort`) plus matching `anchor.webp` and `manifest.json`.
  - 6 matching dry 24 kHz mono PCM WAV voice-clone reference clips (`assets/avatars/voices/*-ref-24k.wav`) and `voices_manifest.json`.
- Provenance: generated locally on 2026-11-21 by the Companion Space project owner from the six original 2026-11-19 anchor portraits using locally hosted MiniMax H3-Base (`H3-Base-FL2VA`), then sliced and transcoded into silent VP9 `.webm` loops and normalized reference WAV clips.
- Third-party license: none. These project-owned media assets are distributed under Apache License 2.0 alongside the repository unless a release notice states otherwise. Individual file registrations are listed in [Avatar asset licenses](avatars/LICENSES.md).

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
