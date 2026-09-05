/**
 * Mobile surfaces (M7). Mount `<MobileSurfaces />` once inside
 * `<LaserProvider>`; everything else here is a piece of it that other
 * surfaces may also want (the notifications row in settings, the dictate
 * button in the composer).
 */
export { MobileSurfaces } from "./MobileSurfaces.js";
export { DictateButton } from "./DictateButton.js";
export { InstallPrompt } from "./InstallPrompt.js";
export { NotificationsSetting } from "./NotificationsSetting.js";
export { InsecureOriginNotice, NotifyHint, OfflineNotice, UpdateReady } from "./Notices.js";
export { MobileStack, StackRow } from "./MobileStack.js";
export { useFooterAnchor, type FooterAnchor } from "./use-footer-anchor.js";
export { FORTNIGHT_MS, INSECURE_KEY, INSTALL_KEY, NOTIFY_HINT_KEY, dismiss, isDismissed, undismiss, useDismissed } from "./remembered.js";
