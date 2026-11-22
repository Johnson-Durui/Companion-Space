# Changelog

All notable changes to Companion Space are documented here.

## [Unreleased]

### Added

- **Design System & Bundled Typography (U1)**: Tailwind CSS v4 semantic token architecture (Desk light surface, Classroom obsidian stage, warm paper board, 6 per-tutor accent themes), bundled `@fontsource-variable/geist` and `@fontsource-variable/noto-sans-sc` with idle prefetching, Lucide icon set, and 25+ accessible Base UI primitives (`Button`, `Dialog`, `ConfirmDialog`, `Drawer`, `Select`, `SegmentedControl`, `Slider`, `Switch`, `Tabs`, `Toaster`, `UnsavedBar`, `LevelMeter`, `ChoiceCardGroup`, `Stepper`, `FileDropzone`, `SecretInput`, etc.).
- **Single-Screen Video-Call Classroom & Lobby Resilience (U2a / U2b)**: Zero-scroll desktop classroom across `1440×900`, `1280×720`, `1366×633`, and `1280×585`, explicit lesson phase state machine (`lobby` → `teaching` → `awaiting` → `judging` → `feedback` → `paused` → `reconnecting` → `recap`), `≥ 44×44px` bottom ControlDock, instant asynchronous Lesson Lobby (`/plan-items/:id/lesson`) with background preparation & embedded warmup, WebSocket auto-reconnect & tab-takeover, and unified TutorVideoBox in Sample Lesson & Lesson History replay.
- **Guided Student Journey (U3)**: `Today` home page (`/`), 4-step Welcome onboarding (`/welcome`), 5-step Course Setup wizard (`/courses/:id/setup`) with 4-stage reading progress and structured-control fallback interview, 3-step AI Connect Wizard, Course Hub tabs, Course Settings dialog (with rename/delete), rich Lesson Recap, and unified out-of-classroom tutor speech endpoint (`POST /api/v2/voice/speak`).
- **Tutor Gallery & Distinct Voices (U4)**: Interactive `/tutors` gallery with showcase orchestration, 7-column roster, 3-tab `/tutors/:id` editor (Persona, Voice/Theme, Assets) with partial updates and built-in reset, 3-step tutor import wizard, six distinct default Edge voices across built-in tutors, and global single-video playback coordinator (`I16`).
- **Learning Loop Visualization (U5)**: Custom accessible SVG charts (`MasteryGrid`, `ScoreBar`, `ScoreRing`, `WeightBar`, `MasteryBar`, `StudyCalendar`, `WeeklyMinutes`, `SegmentProgress`, `PrereqChain`), plan-diff tracking (`moved_earlier` / `moved_later` / `added` / `deferred`), two-view Course Map, clickable KP answer timeline, dedicated Review Session (`/courses/:id/review/session`) with post-answer feedback pause (`I14`), FocusShell Practice with reload recovery & debrief, and timeline Course History.
- **Classroom Depth & Mobile Video-Call Layout (U6)**: Line-by-line progressive `steps` reveal, all 3 mark styles with historical dimming, line-level pointer & *"lost from this line"* re-explanation, board clear pagination (`上一页 / 第 k / N 页 / 下一页`), block copy & lightbox zoom, themed Plot (legend + SVG hollow points & labels) & Mermaid diagrams, in-memory Transcript Drawer (`Shift+T` / 3rd column on `≥ 1600px`), `?` Shortcuts dialog, split / board-first draggable PiP switcher, mobile `< 768px` Teacher/Board dual-mode call layout (`I15`), WebAudio synthesized sound cues, and pre-warmed `MicrophoneCapture` with 3-cause permission guidance.
- **Partitioned Settings & Student Vocabulary Audit (U7)**: Six dedicated settings sections (`/settings/me`, `/settings/tutor`, `/settings/ai`, `/settings/voice`, `/settings/privacy`, `/settings/advanced`) with legacy route/hash redirects, embedded Test Chat, non-collapsing advanced role rows, structured `{code, message}` error coverage across all API routes (`test_u7_error_codes.py`), automated §6.2 student vocabulary audit in UI tour, and refreshed documentation screenshots.

### Fixed

- Wrong answers, *"I don't know"*, *"confused"*, and *"hint"* actions now map deterministically to comfort/thinking clips instead of praise (`I9`).
- Placement diagnostics are no longer silently marked skipped when course materials have not finished analyzing (`I13`).
- Unplanned courses no longer display *"today completed"* (`I12`).

### Removed

- Retired all 6 legacy global stylesheets (`tokens.css`, `classroom.css`, `setup.css`, `practice.css`, `progress.css`, `review.css`), removed `@layer legacy`, and eliminated all hardcoded hex color allowlists outside `theme.css` (`I4`).

## [1.0.0-rc.2] - 2026-11-21

### Added

- WeChat-video-call style pure-video tutor component (`<TutorVideoBox>`) in `@companion-space/avatar-engine` with 9:16 vertical framing, dual-`<video>` 180 ms crossfade, missing-clip fallback chain, 15 s idle companion mode, instant interrupt recovery, and `prefers-reduced-motion` support.
- Six original Apache-2.0 anime tutors (`雪川`, `沈砚`, `岚玥`, `初棠`, `青衡`, `澜音`) shipping with complete **8/8 Tier 1 silent VP9 `.webm` video loop packs** (`assets/avatars/packs/`) and normalized 24 kHz dry voice-clone reference WAVs (`assets/avatars/voices/`).
- 150 ms instant teaching reactions: objective grading `judge.preview` WebSocket frame, local quick-action triggers, and `recent_avatar_action` prompt context propagation.
- Single-image (PNG/JPG/WebP) instant tutor import and hardened `.tutorpack`/`.zip` archive validation (Zip-Slip, symlink, Windows reserved name, executable, and EBML/MP4 magic-byte checks) with HTTP 206 Range streaming.
- Standalone Python `.tutorpack` CLI toolchain (`tools/tutorpack/cli.py`), per-character 8-clip prompt sheets (`tools/tutorpack/prompts/characters/`), and ComfyUI start/end-frame workflow template.
- Local GPU Sidecar real-time avatar protocol proxy (`/api/v2/avatar-drivers/*`, loopback-first + explicit LAN allowlist, TSVA/TSVF WebSocket bridge), independent Apache-2.0 reference template (`sidecars/local-gpu-avatar/`), and `/settings#avatar` management panel with Tier 3 cloud-live budget guardrails.

### Changed

- Upgraded tutor catalog recipes to `schema_version = 3` with transparent `v2 -> v3` migration and deterministic fallback for retired VRM/legacy character IDs.
- All six active built-in anime tutors are now owner-verified under Apache-2.0 and included cleanly in both portable Windows and Docker builds.

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
- Four historical 2D portraits were excluded from portable and container artifacts until redistribution rights were verified (resolved in `1.0.0-rc.2` by replacing all built-in tutors with six owner-created Apache-2.0 anime tutors).
- Sherpa STT and its model weights are optional and are not bundled.
- Course analysis and live teaching quality, clean-Windows onboarding, and physical audio latency still require release validation.
