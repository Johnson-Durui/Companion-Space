# Changelog

All notable changes to Companion Space are documented here.

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
- Four historical 2D portraits are excluded from portable and container artifacts until redistribution rights are verified.
- Sherpa STT and its model weights are optional and are not bundled.
- Course analysis and live teaching quality, clean-Windows onboarding, and physical audio latency still require release validation.

