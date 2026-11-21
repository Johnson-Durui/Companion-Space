<div align="center">

# Companion Space

**A local-first, video-call style anime AI 1-on-1 tutor**

Drop in your textbooks, slides, notes, and past exams — study live with six original animated anime tutors, a synchronized blackboard, instant interruptions, and FSRS spaced review on your own machine.

[简体中文](README.md) · [English](README.en.md) · [Changelog](CHANGELOG.md) · [Asset Licenses](assets/avatars/LICENSES.md)

[![CI](https://github.com/Johnson-Durui/Companion-Space/actions/workflows/ci.yml/badge.svg)](https://github.com/Johnson-Durui/Companion-Space/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Johnson-Durui/Companion-Space?include_prereleases&label=release)](https://github.com/Johnson-Durui/Companion-Space/releases)
[![License](https://img.shields.io/badge/License-Apache--2.0-2d6a4f.svg)](LICENSE)
[![Local-First](https://img.shields.io/badge/Local--First-127.0.0.1-1b4332.svg)](#local-first--privacy)

</div>

<p align="center">
  <img src="docs/images/classroom-showcase.png" alt="Companion Space live classroom: 9:16 video-call anime tutor paired with synchronized LaTeX formulas, function plots, and interactive checks" width="960" />
</p>

---

## Why Companion Space

Most AI study apps are just scrolling chat windows, while browser 3D VRM avatars burn GPU power and still feel stiff.

**Companion Space** takes a lighter, more human approach:

- **Feels like a 1-on-1 video call**: Tutors live inside a vertical **9:16 pure-video frame** (`<TutorVideoBox>`) with 180 ms dual-`<video>` crossfades and 150 ms micro-reactions when you answer right or wrong — zero WebGL/3D overhead.
- **Built around your own study materials**: Import PDF, PPTX, DOCX, images, Markdown, or plain text as textbooks, lecture notes, or past exams. Models build a source-linked course map that you can inspect and edit anytime, followed by a learner interview and study plan.
- **Synchronized blackboard + real-time interruptions**: Formulas (KaTeX), function plots, tables, and diagrams appear right as the tutor speaks. Interrupt mid-sentence to ask questions, switch teaching styles, or request an example — then lock in retention with **FSRS review cards** and mistake drills.
- **Runs locally on your machine**: Single-process loopback server (`127.0.0.1`), no mandatory cloud account, and full ownership over your data and model providers.

---

## Six Built-In Anime Tutors (Animated Out of the Box)

All six built-in tutors are original **Apache-2.0** creations shipping with **complete 8/8 silent VP9 motion loop packs** (`idle_breathe`, `listen_nod`, `think_chin`, `speak_explain_a/b`, `board_point`, `react_praise`, `react_comfort`) plus studio-dry normalized **24 kHz voice-clone reference WAVs** ([`assets/avatars/voices/`](assets/avatars/voices/voices_manifest.json)) ready for custom TTS / voice cloning pipelines.

<p align="center">
  <img src="docs/images/six-anime-tutors.jpg" alt="Six original built-in anime tutors: Xuechuan, Shenyan, Lanyue, Chutang, Qingheng, Lanyin" width="880" />
</p>

| Tutor | Persona & Specialty | Default Style | Signature Line | Bundled Assets |
| :--- | :--- | :--- | :--- | :--- |
| **雪川 (Xuechuan)** | Clear, patient astronomy TA who maps abstract concepts like star charts | Guided | *"Take your time — let's split this problem into a few anchor stars and connect them."* | 8/8 VP9 clips + 24 kHz ref WAV |
| **沈砚 (Shenyan)** | Decisive logic & strategy mentor focused on constraints and core conclusions | Direct | *"Check the boundary conditions first, then draw the conclusion straight to the core."* | 8/8 VP9 clips + 24 kHz ref WAV |
| **岚玥 (Lanyue)** | Graceful literature & imagery tutor who turns dense definitions into vivid mental pictures | Analogy | *"Place a tough definition inside a single image and you'll remember it at a glance."* | 8/8 VP9 clips + 24 kHz ref WAV |
| **初棠 (Chutang)** | Warm everyday study companion focused on encouragement and untangling tricky traps | Guided | *"No worries — you're already onto the key idea, let's take one small step forward together."* | 8/8 VP9 clips + 24 kHz ref WAV |
| **青衡 (Qingheng)** | Erudite humanities & deduction scholar emphasizing causal chains and solid proof | Rigorous | *"Everything follows a causal thread; once the reasoning lines up, it clicks."* | 8/8 VP9 clips + 24 kHz ref WAV |
| **澜音 (Lanyin)** | Sharp acoustics & exam-prep coach targeting high-frequency test signals and scoring points | Exam Prep | *"Catch the signal words in the prompt — that's right where points are won or lost."* | 8/8 VP9 clips + 24 kHz ref WAV |

---

## Interface Tour

<table>
  <tr>
    <td width="50%">
      <img src="docs/images/welcome-showcase.png" alt="Welcome page tutor roster and voice preview" />
      <p align="center"><sub><b>1. Welcome & Tutor Picker</b> — Switch between all six animated tutors, preview voices, or launch the built-in sample lesson with no API key</sub></p>
    </td>
    <td width="50%">
      <img src="docs/images/characters-showcase.png" alt="Character library with 8/8 slot badges, pose testing, and .tutorpack importer" />
      <p align="center"><sub><b>2. Tutor Library & <code>.tutorpack</code> Manager</b> — Inspect 8/8 motion slots, test all 7 classroom reactions, drop a single image to create a tutor, or import a <code>.tutorpack</code></sub></p>
    </td>
  </tr>
  <tr>
    <td colspan="2">
      <img src="docs/images/avatar-settings-showcase.png" alt="Avatar settings with local GPU sidecar drivers and budget guardrails" />
      <p align="center"><sub><b>3. Avatar Engine & Local GPU Sidecar Settings</b> — Connect local GPU neural drivers with zero per-minute cost, plus hard duration/budget guardrails for optional cloud live drivers</sub></p>
    </td>
  </tr>
</table>

---

## Three-Tier Pure-Video Avatar Architecture

Scales smoothly from an everyday laptop to a local GPU workstation:

| Tier | Mode | Best For | Hardware & Cost |
| :--- | :--- | :--- | :--- |
| **Tier 0** | Single-Image Static Portrait | Drop in any PNG / JPG / WebP to spin up a custom tutor instantly | Any browser · Free |
| **Tier 1 (Default)** | 8-Slot Video Loop Pack (`.tutorpack`) | Dual-`<video>` 180 ms seamless crossfade + 150 ms instant classroom reactions | Any browser · Zero per-minute cost |
| **Tier 2 (Optional)** | Local GPU Sidecar | Connect `sidecars/local-gpu-avatar/` to local open-source drivers (LivePortrait / Ditto / MuseTalk, etc.) | Your local GPU · Zero per-minute cost |

### Build Your Own `.tutorpack`

Use the standalone [`tools/tutorpack/`](tools/tutorpack/README.md) CLI alongside the bundled per-character 8-clip prompts and ComfyUI start/end-frame workflow:

```bash
# Validate a tutor pack directory (all 8 motion slots + manifest)
python tools/tutorpack/cli.py validate assets/avatars/packs/tutor-chutang

# Bundle into a shareable .tutorpack archive
python tools/tutorpack/cli.py pack ./my-tutor-dir -o my-tutor.tutorpack
```

---

## Quick Start

### Option 1: Run from Source (Recommended)

Requires **Python 3.12+** and **Node.js 24+**.

**Windows (PowerShell or double-click `start.bat`):**

```powershell
git clone https://github.com/Johnson-Durui/Companion-Space.git
cd Companion-Space
powershell -NoProfile -ExecutionPolicy Bypass -File .\start.ps1
```

**macOS / Linux:**

```bash
git clone https://github.com/Johnson-Durui/Companion-Space.git
cd Companion-Space
./start.sh
```

The browser opens `http://127.0.0.1:8000/welcome`:

1. **Try without an API key**: Click the sample lesson button to experience synchronized board playback, interactive checks, feedback, and recap right away.
2. **Study your own materials**: Open **Settings → Models**, configure any OpenAI-compatible or supported provider (with a quick filter for free-tier options), test the connection, and start importing your PDF / PPTX / DOCX / image / Markdown materials.

### Option 2: Single-Container Docker Compose

```bash
docker compose up --build -d
curl http://127.0.0.1:8000/healthz
```

Serves both the FastAPI backend and built web frontend in one container, persisting data in the `companion_data` volume and binding strictly to loopback (`127.0.0.1`).

### Optional Extras

- **Offline Speech Recognition (Sherpa STT)**: Online Edge TTS works with zero setup; to enable local in-memory speech recognition in a source install:
  ```bash
  pip install -r services/api/requirements-local-stt.txt
  ```
- **Windows Portable ZIP Builder**: Maintainers with Python 3.14 x64 can run `.\scripts\build-portable.ps1` and `.\scripts\smoke-portable.ps1` to generate a self-contained portable archive + SHA-256 checksum under `outputs/`.

---

## Local-First & Privacy

- **Loopback by default**: Binds to `127.0.0.1:8000` only. Do not expose it directly on `0.0.0.0`; if you need remote access, place it behind your own HTTPS reverse proxy with independent authentication.
- **You own your files**: Course databases, uploaded files, and settings live locally (`storage/` for source runs, or any custom directory via `COMPANION_DATA_DIR`), with an optional master-password vault protecting stored API keys.
- **Explicit external calls**: Only the text or image payloads needed for your active request are sent to the model or speech providers you choose to configure.

---

## Project Layout

```text
Companion-Space/
├── apps/web/                 # React 19 + TypeScript + Vite web application
├── packages/
│   ├── avatar-engine/        # <TutorVideoBox> pure-video choreographer & state machine
│   ├── board/                # Synchronized blackboard (KaTeX, function plots, Mermaid, tables)
│   └── api-client/           # OpenAPI-generated typed client
├── services/api/             # FastAPI backend (course analysis, live WS teaching, FSRS, avatars & voice)
├── assets/avatars/
│   ├── portraits/            # 6 original 9:16 anchor portraits (WebP)
│   ├── packs/                # 6 full 8/8 silent VP9 loop packs (48 .webm clips)
│   └── voices/               # 6 normalized 24 kHz dry voice-clone reference WAVs + manifest
├── tools/tutorpack/          # .tutorpack scaffold/validate/pack CLI, prompts & ComfyUI template
├── sidecars/local-gpu-avatar/# Independent Apache-2.0 local GPU real-time sidecar template
├── infra/docker/             # Single-service Dockerfile & smoke compose
└── docker-compose.yml        # Local single-container Docker Compose
```

---

## License & Assets

- All repository code plus the six original anime tutors (portraits, 48 VP9 video clips, and 6 voice-clone WAVs) are released under **Apache-2.0**. See [LICENSE](LICENSE), [NOTICE](NOTICE), [`assets/avatars/LICENSES.md`](assets/avatars/LICENSES.md), and [`assets/THIRD_PARTY_NOTICES.md`](assets/THIRD_PARTY_NOTICES.md).
- Issues and pull requests are welcome — please never attach real API keys, `vault.json`, or private course files to bug reports.
