# Native reminders

A reminder outside the window is an interruption of a person. It must follow
what the person has already acknowledged, and it must be withdrawn when it is.

## Only a top-level session may interrupt

Only a top-level session may interrupt a person outside the window (D-225): a
child agent's question or ending reaches its parent inside the conversation, so
the desktop shows no banner and the host sends no phone push for it. The host
tags `pi/session/attention` with the session's agent; the desktop's `shouldNotify`
refuses a child; `pi/ui/request` from a child sends no push. Test both.

## Withdrawal follows acknowledgement

Retain native notification handles by session and withdraw them when that session
is actually viewed. A host seen acknowledgement is distinct from attention:
viewing an unanswered approval must dismiss its OS reminder, not answer it.
Do not mark hidden, unfocused or Settings-covered transcripts read. Withdraw
before foreground/throttle guards; preserve anti-spam history. Test late native
delivery and replaced-handle close callbacks. On Linux, prove `CloseNotification`
and the server's application-dismissed signal; banner timeout alone is not proof
of removal from notification history or the dock's count.

Reconcile durable `seenAt` after reconnect, and withdraw owned handles on orderly
quit/relaunch. GNOME Dock derives counts from notification-centre objects;
`app.setBadgeCount(0)` is not a substitute. Never guess lost notification IDs or
change global dock preferences. Reminders orphaned by pre-fix processes or forced
termination may need one manual dismissal; the standard API cannot enumerate
their IDs. Test low-urgency finished notifications after their banner times out.
