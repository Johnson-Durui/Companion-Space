# Asset Licensing

Code in this repository is Apache-2.0. Character models, textures, motion files, voices, and other media assets are not automatically covered by that code license unless their own license terms explicitly allow it.

## Required Manifest For Redistributable Assets

Every bundled asset pack should ship a manifest with:

- asset name
- source URL or origin
- author / licensor
- license name and version
- redistribution allowed: `yes` or `no`
- modification allowed: `yes` or `no`
- attribution required: `yes` or `no`
- usage restrictions

## Built-In Pure-Video Anime Tutor Packs (`1.0.0-rc.2+`)

- The six built-in tutors (`xuechuan`, `shenyan`, `lanyue`, `chutang`, `qingheng`, `lanyin`) ship with original 9:16 anime anchor portraits (`assets/avatars/portraits/*.webp`), complete 8/8 silent VP9 `.webm` loop packs (`assets/avatars/packs/`), and normalized 24 kHz dry voice-clone reference WAVs (`assets/avatars/voices/`).
- Every built-in asset file is owner-created and registered under Apache-2.0 in `assets/avatars/LICENSES.md` and `assets/THIRD_PARTY_NOTICES.md`.
- Historical 3D VRM models (`Seed-san.vrm`, `Sendagaya-Shino.vrm`, `Sakurada-Fumiriya.vrm`, `VRM1_Constraint_Twist_Sample.vrm`, and prototype VRM bodies) and legacy v0.x portraits (`mira`, `kite`, `cael`, `lyra`, `nova`, `echo`) were retired and removed from the public repository tree.
- Do not export or redistribute third-party `.tutorpack` archives, portraits, or voice references whose terms forbid redistribution.
- Do not strip attribution or usage restrictions from imported assets.

## Suggested Manifest Template

```yaml
asset_name: Example Character Pack
origin: https://example.com/example-pack
author: Example Studio
license: CC BY 4.0
redistribution_allowed: yes
modification_allowed: yes
attribution_required: yes
usage_restrictions:
  - no impersonation
  - no resale as standalone asset
notes: Includes one base model and two textures.
```

## Repository Policy

- Do not merge assets with unclear provenance.
- Prefer placeholder or self-created assets until licensing is verified.
- Keep license manifests close to the asset directory or linked from release docs.
