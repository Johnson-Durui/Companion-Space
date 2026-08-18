# Privacy and Data Handling

## Local-First Default

Companion Space is intended to run on a machine the owner controls. The default privacy posture is:

- browser session state stays local
- provider keys stay server-side only
- uploaded materials stay on local storage
- raw audio should not persist by default

## Data Categories

### Persistent by design

- uploaded materials
- final transcripts
- summaries and review items
- memory candidates or approved memory items
- container and proxy configuration

### Ephemeral by design

- live audio buffers
- partial ASR results
- streaming LLM deltas
- streaming TTS chunks

## Sensitive Data Rules

- Never store API keys in browser local storage.
- Never commit `.env`, `storage/`, or local CA material.
- Redact credentials and bearer tokens from logs.
- Treat imported character packs and uploaded files as untrusted.
- Confirming a memory item authorizes the backend to include that item in later prompts sent to the chat model assigned to the same study space. Sensitive candidates are not used this way before explicit confirmation, and deleting a confirmed item stops future inclusion.
- Memory and review context must remain scoped to one study space and must stay separate from material citations.

## Backup Guidance

- If you back up `storage/`, assume it contains private study materials and transcripts.
- If you back up `infra/caddy/data`, treat the local CA keys as sensitive.
- Prefer encrypted backups whenever data leaves the host machine.

## Current State

Provider credentials are now stored in the server-side encrypted vault. Keep browser storage free of keys, and treat unlock/reset/wipe behavior as release-critical flows that should be re-verified whenever the vault schema changes.
