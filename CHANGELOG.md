# Changelog

All notable changes to Companion Space are documented here.

## [1.0.0] - 2026-11-25

### Added

- **One-Key & Keyless Local Subscription Providers**:
  - Added native local subscription adapters for **Antigravity (`antigravity-acp` via `agy acp`)** and **ChatGPT / Codex (`codex-app-server` via `codex app-server`)** requiring zero API keys and zero base URLs, covering live teaching, course analysis, independent verification, and photo vision out of the box alongside local **Ollama / LM Studio** and 10+ single-key cloud presets (BigModel, SiliconFlow, DeepSeek, DashScope, Volcano Ark, Kimi, OpenRouter, Gemini, OpenAI, Anthropic).
  - Upgraded the 3-step Connect Wizard with local subscription badges, keyless setup guidance, free-tier filtering, and per-capability live testing.
- **Expanded 27/27 Tutor Motion Library & Single-Source Media Catalog (UM-1 / UM-2)**:
  - Established `libs/schemas/tutor_media_catalog.json` as the single source of truth for 27 active clip slots, 9 reserved 3-stage slots, 7 registered expression stills (`cheerful`, `caring`, `curious`, `focused`, `playful`, `thinking`, `praise`), and out-of-classroom still location mappings.
  - Upgraded all six built-in anime tutors (`雪川`, `沈砚`, `岚玥`, `初棠`, `青衡`, `澜音`) to **27/27 freshly curated MiniMax H3-Base clips (162/162 total, zero legacy fallbacks, `576×1024 @ 24fps` single-keyframe VP9 Profile 0, 73.72 MB total, every pack ≤ 14 MB, every clip ≤ 0.93 MB)** plus **42 registered 1080×1920 expression stills (7/7 per tutor)** and 6 Opus mono `intro_voice` clips (disabled by default per DM-3).
  - Enhanced `@companion-space/avatar-engine` with `Situation` / `OneShotKind` choreography, 4-clip lecture rotation, idle inserts, `settle_ms` reaction-to-speech handoff, two-tier prefetch, and 200 ms reduced-motion / static expression still switching, plus a full 27/27 + 7/7 audition view on `/tutors/:id?tab=assets`.
  - Extended `tools/tutorpack/cli.py` with `legacy-fix`, frequency-tiered 14 MB pack-budget adaptive CRF `ingest`, audio-visual `intro_voice` trimming, Sobel phase-correlated `stills` registration, FFmpeg-backed `validate --strict`, `sheet`, and `sync-licenses` (224 tracked assets in `assets/avatars/LICENSES.md`).
  - Added external pack discovery under `<storage_root>/avatar_packs/<tutor-id>/` and a `-ExcludeVideoClips` switch in `scripts/build-portable.ps1` for static-portrait + expression-still split packaging.
- **DeepTutor-Inspired Study Studio (Phases 1–4, SQLite Schema v10 → v13)**:
  - **Phase 1 — Structured Tree Retrieval & Interactive Parameterized Blackboard**: Zero-extra-dependency structured page retrieval (`retrieve_structured_pages` / `retrieve_with_structure`) across 1-hop `kp_edges`, `material_sections`, `chunks_fts`, and cached `toc_route` fallback; declarative parameterized `plot` blocks (≤ 4 bounded sliders, ≤ 8 keyframes, `mathjs/number` AST whitelist, zero `eval`) synchronized live via `<board_param>` classroom tags.
  - **Phase 2 — Dual-Loop "Ask a Question" Solve Studio (`/courses/:id/solve`, SQLite v11)**: Text/LaTeX or ≤ 8 MB screenshot upload with vision transcription, mandatory `ItemVerifier` dual-pass verification before coaching, honest disputed/unverified fallback, row-level step drilldown (`locate_step`), and independently verified past-exam isomorphic mimic drills with honest BKT discounting.
  - **Phase 3 — "What Your Tutor Remembers" Auditable 3-Layer Memory (SQLite v12)**: Lightweight structured traces (`learning_traces`, zero raw audio or chat dumps), evidence-verified course memories (`memory_facts`) and cross-course synthesis with clickable provenance links, plus full learner sovereignty to pin, edit, or permanently forget any item in `/courses/:id/progress` and `/settings/me`.
  - **Phase 4 — Immersive Material Reader & Course Block Notes (SQLite v13)**: Page-by-page Material Reader (`/courses/:id/materials/:mid/read`) with original page image/text toggle, KP mastery & past-exam frequency badges, highlight-to-ask explanations, read-aloud, save-to-note, and non-spoiler verified quick quizzes; Course Block Notes (`/courses/:id/notes`) reusing all 11 board block types, one-click capture from classroom/reader/solve, strictly read-only Diff suggestions (*"Ask tutor to fill pitfalls"*), one-click FSRS flashcard conversion, and Markdown / Anki TSV export.
- **Design System & Bundled Typography (U1)**: Tailwind CSS v4 semantic token architecture (Desk light surface, Classroom obsidian stage, warm paper board, 6 per-tutor accent themes), bundled `@fontsource-variable/geist` and `@fontsource-variable/noto-sans-sc` with idle prefetching, Lucide icon set, and 25+ accessible Base UI primitives (`Button`, `Dialog`, `ConfirmDialog`, `Drawer`, `Select`, `SegmentedControl`, `Slider`, `Switch`, `Tabs`, `Toaster`, `UnsavedBar`, `LevelMeter`, `ChoiceCardGroup`, `Stepper`, `FileDropzone`, `SecretInput`, etc.).
- **Single-Screen Video-Call Classroom & Lobby Resilience (U2a / U2b)**: Zero-scroll desktop classroom across `1440×900`, `1280×720`, `1366×633`, and `1280×585`, explicit 16-phase lesson state machine (`lobby` → `teaching` → `awaiting` → `judging` → `feedback` → `paused` → `reconnecting` → `recap`), `≥ 44×44px` bottom ControlDock, instant asynchronous Lesson Lobby (`/plan-items/:id/lesson`) with background preparation & embedded warmup, WebSocket auto-reconnect & tab-takeover, and unified `<TutorVideoBox>` in Sample Lesson & Lesson History replay.
- **Guided Student Journey (U3)**: `Today` home page (`/`), 4-step Welcome onboarding (`/welcome`), 5-step Course Setup wizard (`/courses/:id/setup`) with 4-stage reading progress and structured-control fallback interview, Course Hub tabs, Course Settings dialog (with rename/delete), rich Lesson Recap, and unified out-of-classroom tutor speech endpoint (`POST /api/v2/voice/speak`).
- **Tutor Gallery & Six Distinct Voices (U4)**: Interactive `/tutors` gallery with showcase orchestration, 7-column roster, 3-tab `/tutors/:id` editor (Persona, Voice/Theme, Assets) with partial updates and built-in reset, 3-step tutor import wizard, six distinct default Edge neural voices (`Yunxi`, `Yunjian`, `Xiaoyi`, `Xiaoxiao`, `Yunyang`, `HsiaoChen`) across built-in tutors, and global single-video playback coordinator (`I16`).
- **Learning Loop Visualization (U5)**: Custom accessible SVG charts (`MasteryGrid`, `ScoreBar`, `ScoreRing`, `WeightBar`, `MasteryBar`, `StudyCalendar`, `WeeklyMinutes`, `SegmentProgress`, `PrereqChain`), plan-diff tracking (`moved_earlier` / `moved_later` / `added` / `deferred`), two-view Course Map, clickable KP answer timeline, dedicated Review Session (`/courses/:id/review/session`) with post-answer feedback pause (`I14`), FocusShell Practice with reload recovery & debrief, and timeline Course History.
- **Classroom Depth & Mobile Video-Call Layout (U6)**: Line-by-line progressive `steps` reveal, all 3 mark styles with historical dimming, line-level pointer & *"lost from this line"* re-explanation, board clear pagination (`上一页 / 第 k / N 页 / 下一页`), block copy & lightbox zoom, themed Plot (legend + SVG hollow points & labels) & Mermaid diagrams, in-memory Transcript Drawer (`Shift+T` / 3rd column on `≥ 1600px`), `?` Shortcuts dialog, split / board-first draggable PiP switcher, mobile `< 768px` Teacher/Board dual-mode call layout (`I15`), WebAudio synthesized sound cues, and pre-warmed `MicrophoneCapture` with 3-cause permission guidance.
- **Partitioned Settings & Student Vocabulary Audit (U7)**: Six dedicated settings sections (`/settings/me`, `/settings/tutor`, `/settings/ai`, `/settings/voice`, `/settings/privacy`, `/settings/advanced`) with legacy route/hash redirects, embedded Test Chat, non-collapsing advanced role rows, structured `{code, message}` error coverage across all API routes (`test_u7_error_codes.py`), automated §6.2 student vocabulary audit in UI tour, and refreshed v1.0.0 demo video and showcase screenshots.

### Changed

- **Transparent AI Asset Provenance & Licensing (DM-1)**: Updated `assets/avatars/LICENSES.md`, `assets/THIRD_PARTY_NOTICES.md`, pack manifests, and documentation to record exact AI provenance — OpenAI Images 2.6 portraits and 42 expression stills under Apache-2.0, and local MiniMax H3-Base 162 motion clips and 6 voice references under the MiniMax H3 Community License Agreement (regional and no-training restrictions, `allow_redistribution: false`).
- **Portable Packaging**: Upgraded `scripts/build-portable.ps1` to `1.0.0` with the full v1.0.0 showcase screenshot set and optional `-ExcludeVideoClips` static split-pack mode.

### Fixed

- **Lossless Retired Built-In Tutor Filtering**: `TutorCatalog._normalize_recipe` now omits retired built-in character records whose static portrait assets no longer exist without deleting historical SQLite rows, keeping `/tutors` clean with zero broken images across upgrades.
- Wrong answers, *"I don't know"*, *"confused"*, and *"hint"* actions map deterministically to comfort/thinking/hint clips (`hint_finger` / `react_comfort` / `think_chin`) instead of praise (`I9`).
- Placement diagnostics are no longer silently marked skipped when course materials have not finished analyzing (`I13`).
- Unplanned courses no longer display *"today completed"* (`I12`).

### Removed

- Retired all 6 legacy global stylesheets (`tokens.css`, `classroom.css`, `setup.css`, `practice.css`, `progress.css`, `review.css`), removed `@layer legacy`, and eliminated all hardcoded hex color allowlists outside `theme.css` (`I4`).
- Removed the frontend license/generator card from `/tutors/:id?tab=assets` while preserving complete machine-readable license manifests, `assets/avatars/LICENSES.md`, `assets/THIRD_PARTY_NOTICES.md`, and backend license tests.

### Known limitations

- Windows portable archives are unsigned.
- Sherpa-ONNX offline STT and SenseVoice model weights remain optional and are not bundled in release archives.
- Bundled MiniMax H3-Base video clips and voice reference WAVs carry MiniMax H3 Community License regional and no-training restrictions (`allow_redistribution: false`); use `scripts/build-portable.ps1 -ExcludeVideoClips` when distributing purely Apache-2.0 static-portrait builds.

## [1.0.0-rc.2] - 2026-11-21

### Added

- WeChat-video-call style pure-video tutor component (`<TutorVideoBox>`) in `@companion-space/avatar-engine` with 9:16 vertical framing, dual-`<video>` 180 ms crossfade, missing-clip fallback chain, 15 s idle companion mode, instant interrupt recovery, and `prefers-reduced-motion` support.
- Six original anime tutors (`雪川`, `沈砚`, `岚玥`, `初棠`, `青衡`, `澜音`) shipping with initial 8/8 Tier 1 silent VP9 `.webm` video loop packs (`assets/avatars/packs/`) and normalized 24 kHz dry voice-clone reference WAVs (`assets/avatars/voices/`).
- 150 ms instant teaching reactions: objective grading `judge.preview` WebSocket frame, local quick-action triggers, and `recent_avatar_action` prompt context propagation.
- Single-image (PNG/JPG/WebP) instant tutor import and hardened `.tutorpack`/`.zip` archive validation (Zip-Slip, symlink, Windows reserved name, executable, and EBML/MP4 magic-byte checks) with HTTP 206 Range streaming.
- Standalone Python `.tutorpack` CLI toolchain (`tools/tutorpack/cli.py`), per-character prompt sheets (`tools/tutorpack/prompts/characters/`), and ComfyUI start/end-frame workflow template.
- Local GPU Sidecar real-time avatar protocol proxy (`/api/v2/avatar-drivers/*`, loopback-first + explicit LAN allowlist, TSVA/TSVF WebSocket bridge), independent Apache-2.0 reference template (`sidecars/local-gpu-avatar/`), and `/settings#avatar` management panel with Tier 3 cloud-live budget guardrails.

### Changed

- Upgraded tutor catalog recipes to `schema_version = 3` with transparent `v2 -> v3` migration and deterministic fallback for retired VRM/legacy character IDs.
- All six active built-in anime tutors are included cleanly in both portable Windows and Docker builds.

### Removed

- Retired 3D VRM runtime (`three`, `@pixiv/three-vrm`, `@react-three/*`, `wlipsync`, 37 frontend packages removed) and stripped non-redistributable / retired VRM and legacy portrait binaries from the public repository tree.

### Known limitations

- Release artifacts are unsigned.
- Sherpa STT and its model weights are optional and are not bundled.
- Optional local GPU neural avatar model hookup (LivePortrait / Ditto / MuseTalk) and real-microphone physical latency testing remain owner-environment validation items.

## [1.0.0-rc.1] - 2026-11-17

### Added

- Local-first course import, model-driven analysis, editable course maps, learner interview, placement, and study plans.
- Live text and voice classroom with parser-stable speech/board streaming, ordered audio, interruption, reconnect recovery, and playback-time next-beat preparation.
- Tutor library with reactive portraits and licensed VRM examples, voice selection, classroom animation, and audio-driven speaking level.
- Review cards, mistake review, and FSRS scheduling.
- Prerecorded sample lesson with option-specific feedback and a recap, playable without an API key.
- Read-only Markdown export of old conversations from Course History.
- Reproducible Windows x64 directory-package builder with pinned CPython 3.14.10, SHA-256 verification, and an isolated health/UI smoke test.
- Single-service Docker Compose deployment serving both API and web UI.

### Changed

- Replaced the legacy multi-service Caddy/web/API deployment with a loopback-only single service.
- Reframed the product around a real-model AI tutor; missing providers now fail visibly instead of using product mock responses.

### Removed

- Legacy mobile shell, adult mode, character builder, third-party Live2D/Spine bridge, and old multi-container deployment.

### Known limitations

- This release candidate is unsigned and is not published automatically.
- Four historical 2D portraits were excluded from portable and container artifacts until redistribution rights were verified (resolved in `1.0.0-rc.2` by replacing all built-in tutors with six original anime tutors).
- Sherpa STT and its model weights are optional and are not bundled.
- Course analysis and live teaching quality, clean-Windows onboarding, and physical audio latency still require release validation.
