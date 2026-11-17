# Mobile HTTPS And Device Pairing

Companion Space now includes an opt-in Capacitor mobile client for Android and
iOS. The mobile client loads the existing server-hosted Next.js UI, while its
local launcher owns server selection, device pairing, and secure credential
refresh. The original v0.1 same-machine browser release remains supported.

## Network And Certificate Requirement

The phone must reach a **real HTTPS origin that it trusts**. The default
`https://companion.localhost` address is intentionally only for the host
computer; `.localhost` resolves to the device itself and is not a phone address.

Recommended production-like setup:

1. Point a DNS name you control at the Companion host.
2. Open or forward TCP ports 80 and 443 to Caddy.
3. Set `APP_HOST` to that DNS name.
4. Leave API and realtime browser URLs on their same-origin defaults (`/` and
   `/api/v1/sessions/:sessionId/realtime`).
5. Build the mobile client with that exact HTTPS origin in
   `COMPANION_MOBILE_TRUSTED_ORIGINS`.

The current `Caddyfile` uses `tls internal` for every `APP_HOST`. Public DNS
names do **not** automatically receive a publicly trusted ACME certificate.
Local names and IP addresses also use Caddy's internal CA; every phone then
needs that CA installed and trusted. The application never bypasses TLS
validation. Changing this to public ACME is a future Caddyfile change, not a
`.env`-only switch.

Example server `.env`:

```env
APP_HOST=companion.example.com
ALLOWED_ORIGINS=https://companion.example.com
NEXT_PUBLIC_API_BASE_URL=/
NEXT_PUBLIC_REALTIME_WS_URL=/api/v1/sessions/:sessionId/realtime
```

Example mobile build:

```powershell
$env:COMPANION_MOBILE_TRUSTED_ORIGINS='https://companion.example.com'
npm run build:mobile
npm run cap:sync --workspace @companion-space/mobile
```

The build rejects an absent origin, wildcards, credentials in URLs, paths,
queries, fragments, and production HTTP. A development-only localhost HTTP
exception must be enabled explicitly and does not enable arbitrary Android
cleartext traffic.

## Pair A Device

1. Open Companion Space in the **local owner browser** and unlock the Vault.
2. Open **Settings → Mobile devices**.
3. Select **Generate pairing code**. The code lasts five minutes and permits at
   most five failed attempts.
4. Open the iOS or Android app. Enter the approved server origin, the copied
   eight-digit code, and a device name. Generating a newer code invalidates the
   previous code, so no long challenge identifier or cross-device clipboard is
   required.
5. The app exchanges the one-time challenge, stores the refresh credential in
   Keychain/Keystore, and enters the existing Companion Space UI.

Only a local owner session can generate codes, list devices, revoke devices, or
rotate the Vault password. A mobile access token cannot create another trusted
device or manage existing devices.

## Credential Lifecycle

- Access token: 15 minutes, held only in native memory.
- Refresh token: 30 days, stored in iOS Keychain or encrypted with Android
  Keystore AES-GCM.
- Refresh rotation: one-use tokens with a 30-second, exactly-once recovery slot
  so a lost HTTP response does not permanently de-pair a device.
- Pairing exchange: challenge consumption, trusted-device creation, and initial
  owner session creation commit in one SQLite `BEGIN IMMEDIATE` transaction.
- Pairing verifier: SQLite stores a domain-separated HMAC produced with the
  unlocked Vault key, never a raw or unsalted hash of the eight-digit code.
- Vault lock invalidates active owner sessions and realtime tickets. The mobile
  launcher retains its refresh credential and can recover after the local owner
  unlocks the Vault.
- Device revocation, Vault reset, and password rotation invalidate the relevant
  mobile credentials.

Raw access/refresh tokens are never stored in SQLite, logs, URLs, Preferences,
or browser storage. The database stores only domain-separated token hashes.

When the app or browser tab enters the background, realtime capture, WebSocket
audio, PCM playback, and browser speech are stopped. Returning to the foreground
never reopens the microphone automatically; the owner explicitly reconnects.

## Native Build Boundary

- Android debug builds and lint/tests can run on Windows or Linux with Node 24,
  JDK 21, Android SDK 36, and Build Tools 36.0.0.
- iOS source generation is cross-platform, but compilation requires macOS and
  Xcode 26 or newer. CI performs an unsigned simulator build.
- App Store/TestFlight and Play Store distribution still require the owner's
  Apple/Google signing identities, store records, privacy declarations, and
  release review.

Do not expose `web` or `api` directly. Caddy remains the only public edge, and
WebSocket sessions continue to use the existing one-time session-bound ticket.
