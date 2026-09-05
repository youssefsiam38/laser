import { createRoot } from "react-dom/client";
import "./globals.css";
import { themeStore } from "./theme/store.js";
import { App } from "./App.js";

// The inline script in index.html already painted the stored theme; this
// re-applies it through the real compiler (a no-op when identical) and starts
// following the OS scheme and other tabs.
themeStore.init();

createRoot(document.getElementById("root")!).render(<App />);
