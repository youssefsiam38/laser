# @lasercode/desktop

The Electron shell: main process, tray, native notifications, keychain,
updater, and the packaged installers.

- Must not import Pi. It spawns the host from a bundled runtime.
- What the installer contains, and how a running generation is replaced, is a
  correctness concern here, not a build detail.
