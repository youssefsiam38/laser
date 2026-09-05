import { createRoot } from "react-dom/client";
import "./globals.css";
import { migrateFormerBrowserStorage } from "./identity/storage-migration.js";
import { themeStore } from "./theme/store.js";
import { App } from "./App.js";

// Before the theme store, or anything else, reads a key: if this product was
// renamed, everything the browser remembers is still under the old prefix
// (MX-T7, D-36). With no former names this does nothing.
migrateFormerBrowserStorage();

// The inline script in index.html already painted the stored theme; this
// re-applies it through the real compiler (a no-op when identical) and starts
// following the OS scheme and other tabs.
themeStore.init();

createRoot(document.getElementById("root")!).render(<App />);
