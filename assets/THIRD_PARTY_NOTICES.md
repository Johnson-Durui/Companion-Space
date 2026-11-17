# Third-Party Notices

Companion Space source code is licensed under Apache License 2.0. The code and
character models listed below retain their upstream notices and remain governed
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

## NOVA / 星澜 and ECHO / 沐音 2D portraits

- Bundled files:
  - `assets/avatars/portraits/nova.png`
    (`faf3313f0094adeaddd9e67054468d4848e1ecfea415233de85af47dfbed7325`)
  - `assets/avatars/portraits/echo.png`
    (`e81dc98eab6fe9a85e4724508d592a5b77ca547611fce82a7a299925f4718a9a`)
- Author: Companion Space project.
- Provenance: original AI-assisted artwork generated specifically for Companion
  Space on 2026-09-22, then reviewed and registered as portrait-only runtime
  assets. The images are not copied from AIRI, an anime franchise, a celebrity,
  or another mascot.
- Third-party license: none. These project-owned portrait assets are distributed
  under the same Apache License 2.0 terms as the repository unless a release
  notice says otherwise.
- Runtime boundary: these are reactive 2D portraits; they do not claim to be
  Cubism Live2D models and do not introduce a third-party Live2D runtime.

## VRM1 Constraint Twist Sample

- Bundled file: `assets/avatars/models/VRM1_Constraint_Twist_Sample.vrm`
- SHA-256: `12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2`
- Author / licensor: pixiv Inc.
- Source: [vrm-c/vrm-specification samples](https://github.com/vrm-c/vrm-specification/tree/master/samples/VRM1_Constraint_Twist_Sample)
- Canonical binary: [VRM1_Constraint_Twist_Sample.vrm](https://github.com/vrm-c/vrm-specification/raw/refs/heads/master/samples/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm)
- License: [VRM Public License 1.0](https://vrm.dev/en/licenses/1.0/)
- Redistribution: allowed by the model's embedded VRM 1.0 metadata.
- Modification and modified redistribution: allowed by the embedded metadata.
- Credit: not required by the embedded metadata. The source is still recorded
  here for traceability.

## Sendagaya Shino

- Bundled file: `assets/avatars/models/Sendagaya-Shino.vrm`
- SHA-256: `f11b2648e7e588ae171ad1c32e465f84e5b130b1d1789e3a3702946c0981d2a9`
- Author / licensor: VRoid Project / pixiv Inc.
- Official license page: [Sendagaya Shino](https://vroid.pixiv.help/hc/en-us/articles/360013482714-Sendagaya-Shino)
- Official model page: [VRoid Hub](https://hub.vroid.com/characters/5860098757548846785/models/6567311261748429976)
- Binary distribution source used for this repository:
  [OpenGameArt mirror](https://opengameart.org/node/170868)
- License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
- Redistribution, modification, and commercial use: allowed.
- Credit: not required.
- Embedded format: VRM 0.x. The original embedded metadata records permission to redistribute.

## Sakurada Fumiriya

- Bundled file: `assets/avatars/models/Sakurada-Fumiriya.vrm`
- SHA-256: `a36e91b81518c59f6da0e3f34a176b79090a8c68cc6bd5fe03c1560744b283f3`
- Author / licensor: VRoid Project / pixiv Inc.
- Official license page: [Sakurada Fumiriya](https://vroid.pixiv.help/hc/en-us/articles/360014788554-Sakurada-Fumiriya)
- Official model page: [VRoid Hub](https://hub.vroid.com/characters/6912965120285194650)
- Binary distribution source used for this repository:
  [OpenGameArt mirror](https://opengameart.org/node/170868)
- License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
- Redistribution, modification, and commercial use: allowed.
- Credit: not required.
- Embedded format: VRM 0.x. The original embedded metadata records permission to redistribute.

## Distribution Rules

- See [Avatar asset licenses](avatars/LICENSES.md) for all retained assets.
- Preserve embedded VRM metadata, attribution, usage restrictions, and license files.
- Exclude [archived assets](../assets-archive/README.md) from product distributions.
