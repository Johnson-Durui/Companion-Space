# Archived assets

This directory preserves lightweight non-restricted historical metadata and
CC0 motion fixtures used by legacy compatibility tests. Exclude its contents
from product distributions. The active Apache-2.0 anime tutor assets live in
[assets/avatars](../assets/avatars/).

- `motions/` holds four CC0 VRMA clips (`LICENSE-CC0.txt`) retained for
  historical compatibility tests (`services/api/tests/test_m5_character_service.py`).
- `pets/` holds historical Mori and Yuzu sprite sheets and metadata.
- `scripts/` holds legacy asset utility scripts for reference.

Heavy retired 3D VRM binaries (`models/`, `retired-vrm/`), VirtualCast's
non-redistributable sample (`not-for-distribution/Seed-san.vrm`), and
unverified legacy portraits (`retired-portraits/`) were removed from the public
repository tree prior to open-source release. Historical pre-rebuild notices
remain recorded under local snapshot tag `pre-rebuild-20261116`.
