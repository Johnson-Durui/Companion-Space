# Mobile Store Disclosure Worksheet

Status date: 2026-08-13

Use this worksheet to prepare Apple App Privacy and Google Play Data safety answers for the current mobile source. It records repository evidence, not legal advice or a final store declaration. The publisher must confirm the production build, hosting arrangement, provider configuration, support process and privacy-policy URL before submission.

## Processing Model

- The iOS/Android app is a Capacitor client for a Companion Server selected by the user from the origins approved in the build. It does not contain a first-party Companion cloud endpoint.
- Pairing, authenticated requests, conversations, files and realtime audio go to that user-controlled or publisher-operated Companion Server.
- The server owner chooses the model providers. Depending on those assignments, the server may process data locally or send prompt/audio content to a third-party provider.
- Repository code contains no advertising or cross-app tracking SDK. Product metrics are stored in the Companion Server's local SQLite database; they are not a third-party analytics feed.
- This separation matters for store answers: “processed by a self-hosted server,” “accessible to the publisher,” and “shared with a model provider” depend on the production service offered to users, not only on the app binary.

## Data Flow Inventory

| Data or source | App and server behavior | Persistence and deletion | Store-answer working decision |
| --- | --- | --- | --- |
| Server origin | The user selects an exact, build-approved HTTPS origin. The app stores it in Capacitor Preferences; browser preview falls back to `localStorage`. It is used to reach the selected server. | Device-local until changed, app data is cleared or the app is removed. It is not a secret. | Treat as app configuration unless the publisher separately receives or logs it. Confirm whether production support/telemetry collects it. |
| Pairing code and device name | The app sends the one-time code and user-entered device name to the selected server. The server exchanges them for device credentials and keeps a trusted-device record. | Pairing challenges expire or are consumed. The server owner can revoke a trusted device. Vault reset removes trusted devices and pairing challenges. | Device name may be user-provided data collected by the server. Confirm whether Apple/Google require it under “User IDs” or another account/device category for the offered deployment. |
| Refresh/access credentials | Refresh credentials are stored in Android Keystore-backed AES-GCM storage or iOS Keychain (`AfterFirstUnlockThisDeviceOnly`). Access credentials remain in native memory. Credentials are not placed in URLs, Preferences or `localStorage`. | Unpair/revocation clears long-lived credentials; access state is cleared on expiry or rejection. Removing the app clears its app-bound storage subject to platform behavior. The server stores token hashes, not the raw refresh token. | Authentication data is used for app functionality/security. Do not describe it as advertising or tracking data. Confirm publisher access and retention for server-side device records. |
| Microphone audio | With permission, live PCM audio is streamed to the selected server for speech recognition. The default server setting disables raw-audio persistence. The assigned STT provider may be local or may receive audio if the owner configures a remote provider. | Live buffers are ephemeral by design; raw audio should not persist when `audio_persist_enabled` remains false. Final recognized text can become a persistent transcript. | Likely “Audio Data” collected for app functionality if the production service receives it. Declare third-party sharing when the configured STT service receives audio. Confirm the production setting and provider path. |
| Text messages and final transcripts | User text and recognized speech are processed by the server. Conversation history, relevant material excerpts, confirmed memory and review context can be included in requests to the assigned chat/analysis model. Final user and assistant turns are stored server-side. | Transcripts persist in SQLite until the containing study space is deleted. Space deletion cascades database records and removes that space's stored files. The repository does not expose a separate session-delete route. | Likely “Other User Content” collected for app functionality. Declare sharing with external LLM providers when configured. State the actual retention period in the privacy policy; the code supplies user-triggered deletion, not a time-based retention promise. |
| Imported files, notes and character assets | The user can upload study materials and character content through the server-hosted UI. Material text is parsed/chunked for retrieval; relevant excerpts may enter model prompts. | Uploaded materials are stored under the server's local `storage/` tree and indexed in SQLite. Individual material deletion removes its file and related database records; space deletion removes the whole space. Backups may retain copies outside application deletion. | Likely “User Content / Files and Docs” when offered as a hosted service. For owner-operated self-hosting, confirm how the store questionnaire treats data sent only to the user's chosen server. Declare model-provider sharing when excerpts leave that server. |
| Memory, summaries and review items | The server creates session summaries, memory candidates and review items. Only confirmed memory is injected into later prompts for that study space; sensitive candidates require explicit confirmation. | These records persist in SQLite. Memory and review items have individual delete endpoints; deleting confirmed memory stops future prompt inclusion. Space deletion cascades them. | Likely “Other User Content” for app functionality/personalization. Confirm whether the store form's “Personalization” purpose applies to the published experience. |
| Provider configuration and API credentials | The server owner configures model endpoints, assignments and credentials. Provider keys stay in the encrypted server-side vault and are not stored in the mobile app. | Provider connection metadata persists in SQLite; secrets persist in the encrypted vault. Connections can be removed, and vault reset/wipe behavior is controlled by the server owner. | Not app-collected end-user data in the current mobile flow. Do not imply keys are sent to the app. Publisher must disclose subprocessors used by its own hosted deployment. |
| Local operational metrics | The server records bounded events such as route/status, session/material identifiers, provider kind, failures and latency/FPS values. Payload validation rejects prompts, transcripts, secrets and other content fields. | Metrics persist in the server's local SQLite database. No third-party analytics export is present in the repository. | Not tracking. Confirm whether publisher-operated hosting makes these “Diagnostics” or “App Interactions” collected by the developer and document retention/deletion. |
| Synthesized audio | Text may be sent to a local TTS service or the owner-selected TTS provider; generated audio is streamed back for playback. | TTS chunks are ephemeral by design unless a provider independently retains requests or output under its terms. | Declare sharing of user/assistant text with a remote TTS provider when configured. Generated playback alone is not microphone collection. |

## Access, Sharing and Control Decisions

| Question | Repository-backed answer | Publisher confirmation required |
| --- | --- | --- |
| Does the app developer automatically receive user content? | No first-party developer endpoint is hard-coded. Data goes to the selected Companion Server. | **Yes.** If the publisher operates, administers, backs up or supports that server, the publisher may have access and must answer the store forms accordingly. |
| Is data shared with third parties? | The server supports owner-selected model providers. Prompt context, audio or text can leave the server when a remote LLM/STT/TTS provider is assigned. | **Yes.** List the providers actually enabled in production, their purposes and retention terms. Do not list only the providers used in development. |
| Is data used for tracking or ads? | No ads SDK, tracking SDK, tracking domain or cross-app profiling path is present. `PrivacyInfo.xcprivacy` sets `NSPrivacyTracking` to false. Local metrics stay on the selected server. | **Yes.** Confirm the release binary, website, SDK transitive dependencies and production infrastructure preserve this state. If any advertising, attribution or cross-service profiling is added, this answer changes. |
| Can users delete data? | Individual materials, memory and review items can be deleted; deleting a study space removes its related database records and files. Devices can be revoked. | **Yes.** Define how users request deletion when the publisher operates the server, how backups age out and whether account deletion is required by the store. |
| Is collection optional? | Microphone use is optional; text chat remains available. File import, memory confirmation and provider choices are feature-driven user/owner actions. Pairing and credentials are required for mobile server access. | **Yes.** Confirm the exact onboarding copy, permission timing and whether any production feature changes this behavior. |

## Store Questionnaire Working Answers

These are review prompts, not boxes to copy blindly into a store form.

### Apple App Privacy

- Tracking: working answer **No**, subject to release-binary and production-service confirmation.
- Data linked to the user: decide after defining whether the publisher runs the Companion Server and how device names, transcripts, files, memory, diagnostics and audio relate to an identifiable account or device.
- Data not linked to the user: do not select merely because the product can be self-hosted; linkage depends on the actual published service and identifiers.
- Third-party sharing: include each production model provider that receives audio, text, prompt context or material excerpts.
- Privacy policy URL: **not present in the repository; publisher must supply a public final URL.**

### Google Play Data Safety

- Data collected: decide separately for audio, files/docs, other user content, device/user identifiers and diagnostics based on the production server operator.
- Data shared: include remote model providers and any publisher service provider that receives the data; distinguish local/self-hosted processing from transfer to another organization.
- Purposes: app functionality is supported by the code. Security/fraud prevention may apply to pairing and credentials. Personalization may apply to confirmed memory. Publisher must confirm every selected purpose.
- Security practices: data is sent only to build-approved HTTPS origins in production; mobile refresh credentials use platform-secure storage. Do not claim independent certification or universal encryption at rest from this evidence.
- Deletion: describe the in-product delete/revoke paths and the publisher's backup/account-deletion process. Do not claim automatic deletion deadlines that are not implemented.
- Privacy policy URL: **not present in the repository; publisher must supply a public final URL.**

## Pre-Submission Checklist

- [ ] Record the production Companion Server operator: user self-hosted, publisher-hosted or both.
- [ ] Confirm whether publisher staff, support vendors or infrastructure providers can access server data or backups.
- [ ] Freeze the production provider list for LLM, analysis, STT, TTS and embeddings; record what each receives and its retention terms.
- [ ] Verify `audio_persist_enabled` is false in the production deployment or disclose raw-audio retention accurately.
- [ ] Confirm the release binary has no ads, attribution, tracking or third-party analytics SDK and no tracking domains.
- [ ] Test microphone denial, text-only fallback, device revocation, material deletion, memory deletion and study-space deletion on release builds.
- [ ] Define transcript, material, memory, metric, device-record and backup retention periods in operator policy.
- [ ] Decide how hosted users request account/data deletion and who fulfills the request.
- [ ] Publish and enter the final privacy-policy URL in both stores; ensure it names the server operator and production subprocessors.
- [ ] Reconcile the final Apple and Google answers with the signed AAB/IPA, production environment and policy; retain screenshots/exported answers with release evidence.

## Repository Evidence

- Mobile pairing, origin preference and credential handoff: `apps/mobile/src/index.ts`
- Android secure credential storage and refresh: `apps/mobile/android/app/src/main/java/space/companion/mobile/CompanionAuthPlugin.java`
- iOS Keychain storage and refresh: `apps/mobile/ios/App/App/CompanionAuthPlugin.swift`
- Mobile permissions: `apps/mobile/android/app/src/main/AndroidManifest.xml`, `apps/mobile/ios/App/App/Info.plist`
- iOS tracking declaration: `apps/mobile/ios/App/App/PrivacyInfo.xcprivacy`
- Pairing, devices, materials, sessions, memory and deletion endpoints: `services/api/app/api/v1.py`
- Server persistence and cascade rules: `services/api/app/services/repository.py`
- Material file deletion: `services/api/app/services/spaces.py`
- Prompt assembly and confirmed-memory boundary: `services/api/app/services/companion.py`
- Provider registry and vault: `services/api/app/services/provider_registry.py`, `services/api/app/services/vault.py`
- Raw-audio default: `services/api/app/core/config.py`
- Local metrics fields and content rejection: `services/api/app/services/metrics.py`
- Existing privacy boundary: `docs/privacy-and-data.md`
