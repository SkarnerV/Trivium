import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { init } from "./store.ts";

if (navigator.userAgent.includes("Mac")) document.documentElement.classList.add("mac");
if (navigator.userAgent.includes("Windows")) document.documentElement.classList.add("windows");
createRoot(document.getElementById("root")!).render(<App />);
void init();
