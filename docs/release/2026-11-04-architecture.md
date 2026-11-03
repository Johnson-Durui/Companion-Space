# Architecture and avatar verification — 2026-11-04

This update preserves the public application and its six bundled original avatars while separating API transport by domain and making clean startup reproducible across Windows and Unix.

## Changes

- `api/v1.py` composes eight domain routers; service wiring, storage ownership and per-operation authorization remain in their existing layers.
- The 73 HTTP operations, one WebSocket endpoint and full 59-path OpenAPI document were compared with the public baseline. Compact regression tests retain operation, authorization and response contracts.
- Nested route templates now remain correct in local metrics and provider timeout classification. Unmatched paths use a constant label rather than persisting caller-controlled identifiers.
- Active-turn interruption acknowledges cancellation before awaiting slow SQLite persistence, while still awaiting that persistence before reading subsequent events.
- Node launchers replace Bash-only E2E startup. Local Python discovery, explicit interpreter overrides, path confinement, failed-start cleanup and app-directory selection are covered by runnable checks.
- Existing dependencies were patched and the installer pinned to npm 11.21.1. Older npm versions can drop root overrides across workspace links; see [npm's fix](https://github.com/npm/cli/pull/9673). Capacitor native metadata was synchronized to 8.6.0. Android CI requests `platform-tools` instead of the removed `tools` package.
- The README now shows the six character cards and links current architecture and local setup instructions. The four painted Blender models and two procedural prototypes are labelled separately.

## Fresh local evidence

Verification used an independent worktree based on public commit `95b0e0a`, a fresh `npm ci`, and a fresh project-local Python environment. Original user storage and the unrelated local Git history were left untouched.

| Gate | Result |
| --- | --- |
| Backend Ruff and complete pytest suite | PASS — 553 passed, 3 skipped |
| Route-contract and real-request observability checks | PASS — 6 targeted checks; full OpenAPI unchanged |
| Web typecheck, zero-warning lint and Next.js 15.5.28 production build | PASS |
| Original VRM loader/expression checks | PASS — 6 models, 9 expressions each |
| Viseme, sprite integrity and runtime-config checks | PASS |
| Portable launcher checks, including real child HTTP startup | PASS — 6 checks |
| Windows PowerShell 5.1 shell validation | PASS — 7 LF shell files, 6 PowerShell files parsed |
| Real Chromium Mock journey, six-character persistence, portraits and WebGL fallback/text behavior | PASS — 8 checks |
| Responsive desktop/mobile UI checks | 14 passed initially; the one cold-call navigation failure was traced to a pending RSC response and passed separately after its wait was aligned with the existing Mock journey |
| Mobile build/typecheck/security/release gates and native metadata sync | PASS; physical devices and store signing were not exercised locally |
| npm audit at the repository's high threshold | PASS — 0 high / 0 critical; 14 moderate and 2 low findings remain |
| Python requirements audit | PASS — no known vulnerabilities |

The interrupt regression was first demonstrated failing with a blocked persistence operation (about 1 second before acknowledgement), then passed with the existing 250ms requirement unchanged. The web launcher was exercised through the real launcher process, not just path calculations. Desktop and mobile screenshots were inspected; browser rendering is tested separately from model-file parsing.

## Publication gate and limits

Final rendered review exposed an older face-card export defect that the
initial loader checks had missed: MIRA/KITE/CAEL/LYRA had one-metre face
planes. The Blender source axis and all four bundled exports were repaired;
face positions, curvature, normals and expression regions now use their
intended dimensions. Face depth, elliptical edges and a front hair-cap
opening also prevent the opaque head and hair from hiding facial features.
Textures, UVs, body geometry, hair vertices, skeleton and license metadata
were preserved. Semantic recoloring now leaves authored emissive and rim
effects unchanged instead of adding a bright wash. The verifier evaluates
all ten deformations, rejects invalid face/body dimensions and global
facial deformation, and checks five visible facial landmarks per painted
model. Visibility checks failed at 0/5 before repair and pass at 5/5 after.
The four painted models were rendered again through all four motion states and
seven emotion controls; 46 browser capture artifacts were inspected, with
neutral previews retained in `docs/images/`. The full backend remained at
553 passed / 3 skipped, and the authored-material regression passed.
The procedural NOVA/ECHO generators also had inverted facial UVs and front
hair-cap occlusion. Their texture orientation and face openings were fixed,
only those two prototypes regenerated, and the eye/mouth visibility checks
changed from 0/3 to 3/3. Their neutral browser renders were reviewed too.
See [model production and repair](../design/original-companions-3d.md).

The exact published revision must pass the repository's GitHub Actions jobs: backend, Windows smoke, frontend, TTS sidecar, both Android API levels, iOS, dependency audit, E2E and Docker smoke. Current runs are visible in [GitHub Actions](https://github.com/Johnson-Durui/Companion-Space/actions/workflows/ci.yml); local evidence above does not stand in for a failed or pending remote check.

Mock needs no external credentials. Real model endpoints, microphones, physical mobile devices, GPU speech performance and app-store signing depend on the operator's setup and are not implied by these checks. Remaining lower-severity npm findings are retained rather than applying npm's suggested breaking framework changes or unrelated tool downgrades.
