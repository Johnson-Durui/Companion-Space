# Original companion 3D contract

Six featured study companions use project-owned VRM 1.0 bodies. 2D roster
cards stay as reactive portraits; Mori / Yuzu stay as sprite fallbacks.

| Id | Name | Hair | Outfit | Presence |
| --- | --- | --- | --- | --- |
| `mira` | 澄羽 MIRA | Deep-sea teal short bob | Fog-white cloak, coral ribbon | Soft, petite, review navigator |
| `kite` | 曜柚 KITE | Dark high ponytail | Yuzu-yellow sport jacket, teal inner | Round, athletic, kickoff rival |
| `cael` | 凛序 CAEL | Ink-navy long wave | Long navy coat, gold trim, glasses | Tall, sharp, constraint senior |
| `lyra` | 弦灯 LYRA | Charcoal-purple asymmetric bob | Charcoal studio wrap, lantern-orange sash | Serene, curious story partner |
| `nova` | 星澜 NOVA | Midnight-indigo long hair | Constellation coat, ice-cyan orbit accent, glasses | Tall, observant, systems thinker |
| `echo` | 沐音 ECHO | Chestnut short bob | Terracotta and moss studio jacket | Petite, warm, language and writing coach |

Production builder: `scripts/blender/build_original_companions.py`
(Blender 4.5 LTS + VRM Add-on). Pass local painted inputs with `--paint` and
choose the ignored Blender working-output directory with `--blend`.
Prototype fallback: `scripts/generate-original-vrm.mjs --prototype`.

The four painted exports received a face-card repair on 2026-11-04. The
Blender grid's populated vertical axis was previously left at one metre.
The builder now applies the intended 0.150–0.166 m height. The bundled
exports were repaired with `scripts/repair-painted-vrm-face.mjs`, preserving
their embedded albedo images, UVs, body geometry, skeleton and license
metadata while rebuilding face positions, normals and expression regions.
The face sits outside the head surface with an elliptical outline, and the
central front of the spherical hair cap is open so that brows, eyes and
mouth remain visible. Separate bangs and hair vertices are preserved.
Use `node scripts/repair-painted-vrm-face.mjs --check` to verify that repair;
the default mode is a dry run and `--write` is an explicit maintenance action.

`npm run test:original-vrm` checks face/body proportions, head placement and
actual evaluated vertices for all nine expressions plus blink. Frontal
visibility rays additionally check five authored facial landmarks per
painted model and both eyes plus mouth in each procedural prototype against
the head and hair geometry. Texture V must run from top to bottom in all six
models. Registering
an expression name alone is insufficient evidence of a valid avatar.
Runtime: existing `avatar-runtime` / `vrm-stage` / CC0 VRMA / 7-emotion face /
1.30s exactly-once body reaction.

Current quality for MIRA, KITE, CAEL, and LYRA (`painted-blender`, albedo pass 1.4):

- VRM 1.0 humanoid from Blender `icyp.make_basic_armature` (fingers, eyes, toes)
- Voxel-remeshed body with nearest-bone weights + MToon outlines
- Hand-painted Face / Hair / Cloth albedo maps
- Mood morphs and `aa/ih/ou/ee/oh` visemes on the Face card
- Extra hair layers and slightly larger outfit silhouettes
- Inverse-distance blend of the three nearest bones instead of hard 1.0 weights
- Local source `.blend` working files

These are project-owned Blender bodies for the study stage. They are **not**
VRoid Hub store sculpts. VRoid Studio is installed for further hand work.
Licensed sample VRM files must not be presented as any of these six characters.

NOVA and ECHO use the same project-owned VRM 1.0 metadata, humanoid loading,
expression, and CC0 motion contract in lighter procedural prototype bodies from
`scripts/generate-original-vrm.mjs --prototype`. They are separate from the
painted-blender quality tier and are labelled `original-vrm` in Character
Workshop until their hand-painted Blender passes are available.

Their generator now maps top-down PNG rows to top-down glTF UVs and opens the
front of the bob/long hair caps around the face. This keeps facial texture
features aligned with their lid and mouth deformation regions. Only
NOVA/ECHO were regenerated for that correction; the painted models retain
their separate production path.

The public repository ships the reviewed VRM binaries and their hashes, but it
does not ship the exact painted albedo inputs or local `.blend` working files.
A clean clone can run and inspect the committed models. Running the builder
without `--paint` uses its programmatic fallback, so it is not expected to
reproduce the published `painted-blender` hashes byte for byte.
