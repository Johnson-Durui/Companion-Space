# Archived assets

This directory preserves pre-rebuild files for review. Exclude its contents from
product distributions. The active asset collection is in [assets/avatars](../assets/avatars/).

- `models/` holds the six retired Companion Space VRM prototypes. Their
  visual quality fell below the target for the tutor experience. The original
  manifest is a historical record and lists earlier bundled samples as well.
- `motions/` holds the four generated VRMA clips, their manifest, and the
  original CC0 dedication.
- `pets/` holds the retired Mori and Yuzu sprite sheets and metadata.
- `scripts/` holds the old production and validation scripts for these
  assets. The scripts retain their historical source paths.
- `not-for-distribution/Seed-san.vrm` is the VirtualCast, Inc. sample from
  the [VRM specification repository](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san).
  The embedded metadata allows redistribution. VirtualCast's separate terms
  restrict redistribution of unmodified model data, so the product excludes
  this file.

- `retired-vrm/` holds the 3D VRM sample models and catalog entries retired on
  2026-11-19 when the character subsystem moved to `<TutorVideoBox>`.
- `retired-portraits/` holds the six pre-2026-11-19 built-in portraits
  (`mira/kite/cael/lyra/nova/echo`) and their catalog JSONs replaced by the
  owner-verified six-character anime roster (`xuechuan/shenyan/lanyue/chutang/qingheng/lanyin`).
- The complete pre-rebuild notices are available under the local snapshot tag:
`git show pre-rebuild-20261116:assets/THIRD_PARTY_NOTICES.md`.
