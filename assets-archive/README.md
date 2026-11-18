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
- The public release omits Seed-san, a VirtualCast, Inc. sample from
  the [VRM specification repository](https://github.com/vrm-c/vrm-specification/tree/master/samples/Seed-san).
  The embedded metadata allows redistribution. VirtualCast's separate terms
  restrict redistribution of unmodified model data.

The complete pre-rebuild notices are available under the local snapshot tag:
`git show pre-rebuild-20261116:assets/THIRD_PARTY_NOTICES.md`.
