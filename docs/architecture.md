# Current architecture

Companion Space is a single-owner, local-first application. The supported first-run path uses the built-in Mock providers, bundled avatars and an isolated local SQLite database. External model services and the neural speech sidecar are optional.

## Responsibilities

| Boundary | Location | Owns |
| --- | --- | --- |
| Browser UI | `apps/web/app`, `components`, `lib/api.ts` | Navigation, in-memory owner session, API calls and visible loading/error states |
| Avatar stage | `apps/web/components/avatar` | Recipe resolution, local VRM/portrait/sprite rendering, expressions, gaze and audio-driven mouth movement |
| API composition | `services/api/app/api/v1.py` | The `/api/v1` prefix and assembly of domain routers |
| HTTP and WebSocket transport | `services/api/app/api/routes` | Request validation, per-route authorization, status codes and protocol events |
| Service wiring | `services/api/app/api/deps.py` | One service container, owner/local-owner checks and application lifecycle |
| Domain services | `services/api/app/services` | Vault, providers, spaces, characters, conversations, demos and metrics |
| Persistence | `services/api/app/services/repository.py` | SQLite transactions and space-scoped data access |
| Shared contracts | `services/api/app/models`, `apps/web/lib/types.ts`, `libs/schemas` | Validated payloads, character recipes and prompt/schema resources |
| Optional native shells | `apps/mobile` | Trusted server selection, device pairing and native credential storage |
| Self-hosted entry point | `docker-compose.yml`, `infra/caddy` | Same-origin HTTPS and API/WebSocket proxying |

The transport modules use the existing services; they do not construct their own databases or provider registries. Authentication remains explicit on each operation, because vault initialization, unlock and device exchange have different access requirements. The route-contract regression test locks public operations, authorization dependencies, response contracts and operation IDs during extraction.

## A learning turn

1. Initialize or unlock the vault. The browser keeps its owner token in memory and the API client attaches it to protected requests.
2. Create a space and import material. Ingestion and retrieval stay scoped to that space.
3. Select a character. Its recipe and asset manifest are persisted independently from the model provider assignment.
4. Open a session. Text requests use HTTP; realtime audio/events use a short-lived ticket and the existing WebSocket protocol.
5. The conversation service resolves providers, builds the answer from retrieved material and returns server-generated citations. Browser rendering consumes the same character recipe and turn emotion.
6. End the session and review its recap. Memory candidates require confirmation before becoming persistent memories.

## Avatars

The six bundled models are `mira`, `kite`, `cael`, `lyra`, `nova` and `echo`. MIRA is the default. MIRA/KITE/CAEL/LYRA have painted Blender models; NOVA/ECHO currently use lighter procedural prototypes. Their 2D roster cards and Mori/Yuzu sprite characters also ship with the repository.

`CharacterRecipe` -> `getRuntimeRecipeView()` -> `AvatarRuntime` -> VRM, portrait or sprite stage. Imported protected assets take precedence over built-in model IDs. Unknown or unavailable assets produce an explicit blocked/loading/error state; the runtime must not silently substitute a different character. WebGL-unavailable fallback follows the registered recipe and is covered by browser tests.

Models load from local static assets, not a third-party CDN. The manifest records hashes and licensing; imported packs retain their own restrictions. See [asset licensing](asset-licensing.md), [original model production](design/original-companions-3d.md) and [asset notices](../assets/THIRD_PARTY_NOTICES.md).

## Runtime and data boundaries

- Run one API worker: local locks, ingestion ownership and unlocked-vault state are process-local.
- Keys remain in the encrypted vault; they are never returned to the browser or included in exported character packs.
- Original audio persistence defaults to off. Test storage is separate from user `storage/`.
- Mock is an explicit provider, and external provider errors remain visible rather than silently switching to Mock.
- Docker builds use same-origin URLs. Local development uses loopback API/WebSocket origins. Public frontend variables are build-time configuration.
- Caddy uses a local CA by default; LAN/mobile clients need trusted HTTPS configured for their actual server origin.

## Development and verification

Use Node 24 and Python 3.12 or 3.13. Install from the committed lockfile and requirements, then follow [Windows local setup](../WINDOWS-README.md) or the Docker steps in the [README](../README.md). Playwright launchers use Node and a project-local Python environment on both Windows and Unix; `COMPANION_E2E_PYTHON` selects an explicit interpreter.

The release gates cover backend lint/tests, route contracts, avatar asset hashes and expressions, frontend typecheck/lint/build, browser Mock/character/realtime flows, dependency audits, Docker startup and native-shell CI. A green loader test proves model structure; the browser tests separately prove visible rendering and persisted selection.

The older [v0.1 execution plan](plan/v0.1-execution-plan.md) describes the original migration and is retained as history. Use this document and the current source for present-day boundaries.
