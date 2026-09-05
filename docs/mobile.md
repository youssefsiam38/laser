# laser on a phone

The phone client is the same web bundle the desktop uses, installed as a PWA
(D-9: no native shell, ever). This page is the honest version: how to install
it, what it does, and exactly where the platforms stop us.

## Install

laser must be opened from a **secure address**. Your desktop's LAN address
(`http://192.168.1.20:41441`) is not one: browsers refuse a service worker,
push, the microphone and installing on plain `http`. Two ways to get a secure
address:

1. **The relay link** (normal). The relay hands the phone an `https://…`
   address, and everything below works; traffic is end-to-end encrypted and
   the relay forwards bytes it cannot read (docs/security.md). **Not built
   yet:** there is no pairing screen in the app (M6). Until it lands, use a
   trusted certificate, below.
2. **A trusted certificate on the phone** for the LAN address, if you run your
   own. Then open the `https://` form of the same address.

If you open the LAN address anyway, the app runs — read-only conveniences
aside, everything works — and a notice above the composer says what is off
and why. Dismiss it once per address.

### iPhone / iPad (Safari)

1. Open the address in **Safari** (not an in-app browser).
2. Tap **Share** (the square with the arrow) in the toolbar.
3. Choose **Add to Home Screen**, then **Add**.
4. Open laser **from the home screen**. Notifications can only be turned on
   from there — Safari itself cannot deliver them.

### Android (Chrome, Edge, Samsung Internet)

1. Open the address.
2. When laser offers it, tap **Install**; or use the browser menu →
   **Install app** / **Add to Home screen**.

### Desktop browsers

The same bundle works in a tab. Chromium browsers offer **Install** in the
address bar; there is nothing to gain from it beyond a window without tabs.

## What the phone does

| | iOS (installed) | Android (installed) | Any browser tab |
| --- | --- | --- | --- |
| Full-screen, safe areas, keyboard-aware composer | yes | yes | yes |
| App shell saved for offline start | yes | yes | Chromium/Firefox yes, Safari tab yes |
| Survives lock/unlock with no lost output | yes | yes | yes |
| One-hand approvals (card above the composer) | yes | yes | yes (mobile width) |
| Notifications when a session needs you | **yes, home screen only** | yes | Chromium/Firefox yes; Safari tab **no** |
| Allow / Deny buttons on the notification | **no** — one tap opens the question | yes | Chromium yes |
| Dictation into the composer | yes; mic permission asked **each launch** | yes | yes on https |
| Install prompt | Safari steps shown | browser sheet | browser dependent |

### Offline

The service worker caches **only the app shell** — `index.html`, the hashed
bundle, the manifest, the icons and the two typefaces. Nothing from any session
is ever cached; every transcript comes over the encrypted socket, and nothing
cross-origin is fetched at all, so the offline shell renders in the real
typeface rather than a fallback stack. Offline, the app opens instantly and
says it is offline; it reconnects and resumes when the network returns.

### Reconnect and resume

iOS closes WebSockets on lock, sometimes without telling the page. The client
never trusts an open socket after a pause: on every return to the foreground,
back-forward restore, network change and on a slow heartbeat, it probes the
host with a cheap request and forces a fresh socket when nothing comes back in
four seconds. Every open session then re-issues `session/load { fromSeq }`
with the last sequence number it saw, so a background of any length loses no
output.

### Keyboard

The composer sits on the keyboard, driven by `visualViewport` (never `dvh`,
which ignores keyboards; never `+` with the safe area, always `max()`). Two
WebKit bugs (322900, 323322) can leave an installed PWA's viewport short after
the first keyboard show; the app re-measures on `pageshow`, `visibilitychange`,
focus changes and orientation changes, over the ~400 ms the keyboard animates.
Inputs are 16 px on touch so Safari never zooms.

### Approvals with one hand

A question that blocks the turn is a **card directly above the composer**, on
every width — the same component the desktop shows, with a bigger budget on a
coarse pointer (D-24). There is no phone-only approval surface: one component
means one mapping from Pi's dialogs and one place where "No" has somewhere to
go.

On touch the controls become full-width 48 px rows at 14 px, stacked, with the
primary answer nearest the thumb. **No is never a dead end** — it opens a field
whose text reaches the agent as `Declined: …` right after the declined result.
Options that change how the session asks from now on ("Always allow", "Don't
ask again") say so under the option. When several questions are waiting, the
oldest is the card and the rest are counted under it as `+N more waiting behind
this one`.

Two questions go elsewhere, because the placement table says so
(docs/ux-panels.md): one that blocks a single tool call renders inside that
tool's row, and one that blocks the whole session takes a sheet.

### Notifications

Turn them on from the hint under an approval, or from Settings →
Notifications (the same row). The host generates VAPID keys on first run into
`~/.pi/agent/piorbit/push.json` and stores each device's subscription next to
them. One notification document is sent per waiting decision; it is the
Declarative Web Push shape (`web_push: 8030`), so Safari renders it without
waking a worker and Chromium's worker renders the same JSON. Tapping opens the
exact question; on Android, **Allow** answers it if it is still pending and
**Deny…** opens the card with the reason field ready.

### Dictation

The microphone button records with `MediaRecorder` (webm/opus on Android and
desktop, mp4 on iOS), shows a live level meter and the elapsed time, and on
stop sends the audio to the host in relay-sized chunks over the same socket.
The host's transcription backend answers with text, which lands at the caret.
Recordings are capped at 90 s.

## Limitations, plainly

- **iOS: no push without Add to Home Screen.** Safari tabs cannot receive
  web push. There is no way around this.
- **iOS: no notification buttons.** Safari ignores `actions`. Every
  notification is one tap-to-open; the app then shows the question with Allow
  and Deny.
- **iOS: every push must show a notification.** There is no silent push, so
  the host sends one only when a session actually waits for you.
- **iOS: no Background Sync, Periodic Sync or Background Fetch.** A locked
  phone learns about new work only through a notification.
- **iOS: the microphone permission is asked on every launch** of an installed
  web app. This is Safari's policy for installed PWAs, not ours.
- **iOS: keyboard bugs.** WebKit 322900 and 323322 are open; the re-measure
  above works around them but a pathological case can still leave a gap
  under the composer until the next focus change.
- **LAN `http://` addresses** cannot install, notify, record or work offline.
  Use the relay link.
- **The dock does not exist on a phone.** Panels that would be watched in a
  dock open as sheets; the island strip above the composer is the panel bar.
- **Push payloads are capped** at about 3.9 KB by the push services; the
  document carries a title, one clipped line and a link, never a transcript.
- **Notification buttons cannot answer by themselves.** A service worker has
  no session with the host, so a button opens or focuses the app, which
  answers. On a locked phone this is one unlock plus zero further taps for
  Allow.

## Verifying on a device

1. Desktop: `pnpm -r build && pnpm sandbox` (or the real host) and pair a phone
   through the relay.
2. Phone: install as above; open from the home screen; note the status bar
   is translucent over the app's ground and the composer clears the home
   indicator.
3. In the sandbox session run `/confirm`: the card appears above the composer
   with full-width controls, **No** opens the reason field, and **Send and
   decline** sends both. Panels that would be watched in a dock appear as
   pills above the card; tapping one opens it as a sheet with a close control
   in its header.
4. Lock the phone for ten minutes with a turn streaming; unlock: the
   transcript catches up with no gap and no duplicate.
5. Settings → Notifications → **Turn on**, then **Send a test**: the
   notification arrives; tapping it opens the app.
6. Tap the microphone, speak, tap stop: the text appears at the caret.

Anything in this list that fails on your device is a bug; file it with the
platform and OS version.
