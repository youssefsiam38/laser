# Ubuntu 23.10 and later will not give an unconfined program its own user
# namespace, which is the mechanism Chromium's sandbox is built out of. A
# program with a profile that grants `userns` is exempt; without one, the app is
# transitioned into Ubuntu's restrictive `unprivileged_userns` profile, which
# denies the capabilities the sandbox needs inside the namespace.
#
# `flags=(unconfined)` means this profile confines nothing else. It exists only
# to say "this program may make user namespaces", which is the same thing
# Chrome, Chromium and every other Electron app on the machine ship.
#
# The attachment path is the *real* Electron binary, not `/opt/…/${executable}`,
# which is the POSIX shell launcher that build/after-pack.cjs puts there. A
# profile attached to a shell script attaches to the shell, and the process that
# asks the kernel for a namespace is the one below.
abi <abi/4.0>,
include <tunables/global>

profile "${executable}" "/opt/${sanitizedProductName}/${executable}-bin" flags=(unconfined) {
  userns,

  # Site-specific additions and overrides. See local/README for details.
  include if exists <local/${executable}>
}
