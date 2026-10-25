import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { init } from "./store.ts";

if (navigator.userAgent.includes("Mac")) document.documentElement.classList.add("mac");
createRoot(document.getElementById("root")!).render(<App />);
void init();
