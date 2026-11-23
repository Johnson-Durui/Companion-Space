# Privacy and Data Handling

Companion Space is built around a strict **local-first** principle: your textbooks, past exams, study progress, and API credentials stay on your own computer.

## Default Privacy Posture

- **Loopback-only server**: Runs on `127.0.0.1:8000` with no telemetry, analytics beacons, or mandatory cloud accounts.
- **Server-side encrypted credentials**: API keys are stored only in the backend encrypted vault (`vault.json`), never in browser `localStorage` or frontend state.
- **Explicit external requests**: Network calls occur only when you actively analyze materials, chat/study in a live lesson, test a connection, or synthesize/transcribe speech through a provider you configured.

## Data Categories

### Stored Locally on Disk (`COMPANION_DATA_DIR`, default `./storage`)

- **Course materials & parsed index**: Uploaded PDF, PPTX, DOCX, Markdown, plain-text, and image files alongside extracted chunks, page references, and course maps.
- **Verified item bank & study plans**: Extracted/generated check items, verification status, learner interview preferences, placement results, and versioned study plans.
- **Learning evidence & FSRS cards**: Objective/rubric grading records, per-knowledge-point mastery probabilities, review flashcards, mistake cards, lesson events, and recaps.
- **Settings & custom tutors**: Partitioned user preferences, imported portraits / `.tutorpack` archives, and the encrypted `vault.json` credential store.

### Kept Strictly Ephemeral in Memory (Never Persisted to Disk)

- **Raw microphone audio**: Live `16 kHz` PCM16 voice buffers and Silero VAD frames exist only in memory during active speech capture and are discarded immediately after transcription.
- **Live classroom transcript drawer (`Shift+T`)**: The real-time interleaved speech/input transcript inside an active classroom session stays strictly in browser memory and is never written to disk or server logs.
- **Streaming deltas & audio chunks**: Partial LLM token streams, TTS audio buffers, and short-lived owner session tokens.

## Cross-Course Isolation

All course data is partitioned by `space_id` in SQLite. Context retrieved during analysis, lesson preparation, or live teaching for one course never reads materials, notes, or evidence belonging to another course.

## Backup & Deletion

- Deleting a course from **Course Hub → More → Delete Course** removes its materials, chunks, plans, lessons, and review records from your local data directory.
- If you back up `storage/` (or `companion_data` in Docker), treat the backup archive as confidential personal data and prefer encrypted storage if copying it off your machine.
