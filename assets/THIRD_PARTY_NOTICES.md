# Third-Party Notices

Companion Space source code is licensed under Apache License 2.0. The code and
character models listed below retain their upstream notices and remain governed
by their respective license terms. Keep this notice with redistributed copies.

## Qwen3-TTS

- Optional runtime model: `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- Pinned revision: `85e237c12c027371202489a0ec509ded67b5e4b5`
- Upstream: [QwenLM/Qwen3-TTS](https://github.com/QwenLM/Qwen3-TTS)
- License: Apache License 2.0.
- Distribution: model weights are downloaded on first use and are not bundled
  with Companion Space release archives.

## DeepTutor Mermaid loading pattern

- Adapted file: `apps/web/components/lesson/lesson-board.tsx`
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

## Character assets

The character models below are separate media assets and remain governed by
their own license terms and embedded VRM metadata.

The four featured study personas (MIRA, KITE, CAEL, LYRA) use project-owned
original custom VRM bodies. The older licensed models below stay bundled as
**samples**, not as the main companion appearance. Seed-san still requires
credit to **VirtualCast, Inc.**

## Original custom 3D companions

- Bundled files:
  - `apps/web/public/assets/characters/models/Mira.vrm`
    (`e82bed2eef81d81118df47c01ab502bd8432d06c97bf316a50af392211c52c79`)
  - `apps/web/public/assets/characters/models/Kite.vrm`
    (`a9bd96ee9002ba46dc46025d1d2f3ff0919b6251f570abf973a040964198bdda`)
  - `apps/web/public/assets/characters/models/Cael.vrm`
    (`a6d92d890bf2fa5000329ba57ba32c3c7d04986caf64a2dcf3d4b26559b254ca`)
  - `apps/web/public/assets/characters/models/Lyra.vrm`
    (`e873fa0072d08a9fc78a5f71bdd4ded9db1ab295d27b9bca077591ce1b3b7bbf`)
- Author: Companion Space project.
- Provenance: original custom humanoids built in Blender 4.5 LTS with
  VRM Add-on for Blender, via `scripts/blender/build_original_companions.py`.
  They are not derived from Sendagaya Shino, Seed-san, Sakurada Fumiriya, the
  VRM1 Constraint Twist Sample, AIRI, CyberVerse, or another franchise.
- License: project-owned original bodies. Embedded VRM 1.0 permissions follow
  [VRM Public License 1.0](https://vrm.dev/licenses/1.0/) so `@pixiv/three-vrm`
  can load them. They are not derived from the licensed sample files below.
- Embedded usage permissions: avatars may be used by everyone; redistribution
  and modification are allowed; credit is unnecessary; commercial usage is
  limited to `personalProfit` (corporate commercial use is not granted).
  Excessively violent or sexual use, political or religious use, and
  antisocial or hate use are not allowed. The embedded metadata in each VRM is
  authoritative and must not be stripped.
- Quality: painted-blender MToon humanoids with remeshed bodies, Face/Hair/Cloth
  albedo maps, and full finger bones. Not VRoid Hub store sculpts or
  commissioned final art.

## Mori / 森森 2D companion

- Bundled files:
  - `apps/web/public/assets/characters/pets/mori/spritesheet.webp`
  - `apps/web/public/assets/characters/pets/mori/pet.json`
- Author: Companion Space project.
- Provenance: original AI-assisted artwork generated specifically for Companion
  Space, then assembled and validated as an 8 x 11 animated sprite atlas. It is
  not copied from AIRI, an anime franchise, a celebrity, or another mascot.
- Third-party license: none. This project-owned asset is distributed under the
  same Apache License 2.0 terms as the repository unless a release notice says
  otherwise.

## Yuzu / 柚子 2D companion

- Bundled files:
  - `apps/web/public/assets/characters/pets/yuzu/spritesheet.webp`
  - `apps/web/public/assets/characters/pets/yuzu/pet.json`
- SHA-256: `8b32aa729d01e3880d9d2b426bee481fc32611186cc8c583f0c05ce3254815f2`
- Author: Companion Space project.
- Provenance: original AI-assisted artwork generated specifically for Companion
  Space, then assembled and validated as an 8 x 11 animated sprite atlas. It is
  not copied from 友学伴 UniGrow, AIRI, an anime franchise, a celebrity, or
  another mascot.
- Third-party license: none. This project-owned asset is distributed under the
  same Apache License 2.0 terms as the repository unless a release notice says
  otherwise.

## Licensed VRM samples

These files may still be selected in Character Workshop. They are not MIRA,
KITE, CAEL, or LYRA.

## VRM1 Constraint Twist Sample

- Bundled file: `apps/web/public/assets/characters/models/VRM1_Constraint_Twist_Sample.vrm`
- SHA-256: `12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2`
- Author / licensor: pixiv Inc.
- Source: [vrm-c/vrm-specification samples](https://github.com/vrm-c/vrm-specification/tree/master/samples/VRM1_Constraint_Twist_Sample)
- Canonical binary: [VRM1_Constraint_Twist_Sample.vrm](https://github.com/vrm-c/vrm-specification/raw/refs/heads/master/samples/VRM1_Constraint_Twist_Sample/vrm/VRM1_Constraint_Twist_Sample.vrm)
- License: [VRM Public License 1.0](https://vrm.dev/en/licenses/1.0/)
- Redistribution: allowed by the model's embedded VRM 1.0 metadata.
- Modification and modified redistribution: allowed by the embedded metadata.
- Credit: not required by the embedded metadata. The source is still recorded
  here for traceability.

## Seed-san

- Bundled file: `apps/web/public/assets/characters/models/Seed-san.vrm`
- SHA-256: `624d0d554bc205bbdc33e22a68a2c3c20edebb3e573011ead8878a65e5329b23`
- Model author: VirtualCast, Inc.
- Source: [vrm-c/vrm-specification samples](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san)
- Canonical binary: [Seed-san.vrm](https://github.com/vrm-c/vrm-specification/raw/refs/heads/master/samples/Seed-san/vrm/Seed-san.vrm)
- License: [VRM Public License 1.0](https://vrm.dev/en/licenses/1.0/)
- Redistribution: allowed by the model's embedded VRM 1.0 metadata.
- Modification and modified redistribution: allowed by the embedded metadata.
- Credit: required. Attribute the model to **VirtualCast, Inc.**

## Sendagaya Shino

- Bundled file: `apps/web/public/assets/characters/models/Sendagaya-Shino.vrm`
- SHA-256: `f11b2648e7e588ae171ad1c32e465f84e5b130b1d1789e3a3702946c0981d2a9`
- Author / licensor: VRoid Project / pixiv Inc.
- Official license page: [Sendagaya Shino](https://vroid.pixiv.help/hc/en-us/articles/360013482714-Sendagaya-Shino)
- Official model page: [VRoid Hub](https://hub.vroid.com/characters/5860098757548846785/models/6567311261748429976)
- Binary distribution source used for this repository:
  [OpenGameArt mirror](https://opengameart.org/node/170868)
- License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
- Redistribution, modification, and commercial use: allowed.
- Credit: not required.
- Embedded format: VRM 0.x. The application reads and preserves its embedded
  VRM metadata when importing or exporting a character pack.

## Sakurada Fumiriya

- Bundled file: `apps/web/public/assets/characters/models/Sakurada-Fumiriya.vrm`
- SHA-256: `a36e91b81518c59f6da0e3f34a176b79090a8c68cc6bd5fe03c1560744b283f3`
- Author / licensor: VRoid Project / pixiv Inc.
- Official license page: [Sakurada Fumiriya](https://vroid.pixiv.help/hc/en-us/articles/360014788554-Sakurada-Fumiriya)
- Official model page: [VRoid Hub](https://hub.vroid.com/characters/6912965120285194650)
- Binary distribution source used for this repository:
  [OpenGameArt mirror](https://opengameart.org/node/170868)
- License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)
- Redistribution, modification, and commercial use: allowed.
- Credit: not required.
- Embedded format: VRM 0.x. The application reads and preserves its embedded
  VRM metadata when importing or exporting a character pack.

## Companion Space CC0 VRMA motion set

- Bundled files:
  - `apps/web/public/assets/characters/motions/companion-idle.vrma`
    (`0ed3bb51dfe023eb650bc20e9810ab6299845133a461c5bd8e753e5aab31b59e`)
  - `apps/web/public/assets/characters/motions/companion-listening.vrma`
    (`a34c126931f50efd85eb4df9d9bc0fbac2f77dc8f4fe0c27ee1a841b20aa4633`)
  - `apps/web/public/assets/characters/motions/companion-thinking.vrma`
    (`29e8ebf58dc841ba03136aa4a3f8a6eaba0d0298d34a3cd139115201ef4bbe90`)
  - `apps/web/public/assets/characters/motions/companion-speaking.vrma`
    (`d9a441a5bef4f6527172a75b258493d30e8a99923284f8ed741ca2af2a49b7bb`)
- Author: Companion Space project.
- Source: deterministically generated by `scripts/generate-cc0-vrma.mjs`; no AIRI,
  pixiv sample-motion, or Mixamo binary was copied.
- License: [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/).
- Motion contract: VRMC_vrm_animation 1.0, loopable, in-place humanoid rotation
  tracks for `idle`, `listening`, `thinking`, and `speaking`.
- Redistribution, modification, and commercial use: allowed.
- Credit: not required.

## Distribution Rules

- Do not assume that Apache-2.0 applies to any model, texture, voice, motion, or
  other character asset.
- Do not strip embedded VRM metadata, attribution, usage restrictions, or
  license files.
- The character-pack exporter must refuse assets whose metadata or manifest
  forbids redistribution.
- No Live2D/Cubism asset, third-party official VRMA motion, or Mixamo animation
  is bundled. The four bundled VRMA files are the project-owned CC0 set above.
