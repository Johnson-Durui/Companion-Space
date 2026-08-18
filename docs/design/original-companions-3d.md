# Original companion 3D contract

Four featured study companions use project-owned VRM 1.0 bodies. 2D roster
cards stay as portraits; Mori / Yuzu stay as sprite fallbacks.

| Id | Name | Hair | Outfit | Presence |
| --- | --- | --- | --- | --- |
| `mira` | 澄羽 MIRA | Deep-sea teal short bob | Fog-white cloak, coral ribbon | Soft, petite, review navigator |
| `kite` | 曜柚 KITE | Dark high ponytail | Yuzu-yellow sport jacket, teal inner | Round, athletic, kickoff rival |
| `cael` | 凛序 CAEL | Ink-navy long wave | Long navy coat, gold trim, glasses | Tall, sharp, constraint senior |
| `lyra` | 弦灯 LYRA | Charcoal-purple asymmetric bob | Charcoal studio wrap, lantern-orange sash | Serene, curious story partner |

Production builder: `scripts/blender/build_original_companions.py`
(Blender 4.5 LTS + VRM Add-on). Pass local painted inputs with `--paint` and
choose the ignored Blender working-output directory with `--blend`.
Prototype fallback: `scripts/generate-original-vrm.mjs --prototype`.
Runtime: existing `avatar-runtime` / `vrm-stage` / CC0 VRMA / 7-emotion face /
1.30s exactly-once body reaction.

Current quality (`painted-blender`, albedo pass 1.4):

- VRM 1.0 humanoid from Blender `icyp.make_basic_armature` (fingers, eyes, toes)
- Voxel-remeshed body with nearest-bone weights + MToon outlines
- Hand-painted Face / Hair / Cloth albedo maps
- Mood morphs and `aa/ih/ou/ee/oh` visemes on the Face card
- Extra hair layers and slightly larger outfit silhouettes
- Inverse-distance blend of the three nearest bones instead of hard 1.0 weights
- Local source `.blend` working files

These are project-owned Blender bodies for the study stage. They are **not**
VRoid Hub store sculpts. VRoid Studio is installed for further hand work.
Licensed sample VRM files must not be presented as these four characters.

The public repository ships the reviewed VRM binaries and their hashes, but it
does not ship the exact painted albedo inputs or local `.blend` working files.
A clean clone can run and inspect the committed models. Running the builder
without `--paint` uses its programmatic fallback, so it is not expected to
reproduce the published `painted-blender` hashes byte for byte.
