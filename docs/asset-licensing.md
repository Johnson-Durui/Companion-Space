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

## VRM-Specific Notes

- The four featured 3D bodies are project-owned original VRM files
  (`mira`, `kite`, `cael`, `lyra`). They are not the bundled licensed samples.
- Sendagaya Shino, Seed-san, Sakurada Fumiriya, and Constraint Twist remain
  optional samples. Credit Seed-san to VirtualCast, Inc. Do not strip
  embedded metadata.
- Respect embedded VRM metadata and license tags.
- Do not export or redistribute assets whose metadata forbids redistribution.
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
