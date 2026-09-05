/**
 * Runs before React, injected into the HTML by `vite-plugin.ts`.
 *
 * Three things must happen this early: `beforeinstallprompt` fires once and
 * is lost if nobody is listening; the notification deep link has to be read
 * before the app's own hash handling rewrites the URL; and the service worker
 * should be registering while the bundle is still parsing. The viewport
 * guards go here too so `--vvh` exists before the first paint.
 */
import { rememberDecisionLink } from "./deep-link.js";
import { captureInstallPrompt } from "./environment.js";
import { registerServiceWorker } from "./register.js";
import { installViewportGuards } from "./viewport.js";

captureInstallPrompt();
rememberDecisionLink(window.location);
installViewportGuards();

if (import.meta.env.PROD) {
  void registerServiceWorker();
} else if ("serviceWorker" in navigator) {
  // Dev server: make sure no production worker is still controlling this origin.
  void navigator.serviceWorker.getRegistrations().then((regs) => Promise.all(regs.map((r) => r.unregister()))).catch(() => {});
}
