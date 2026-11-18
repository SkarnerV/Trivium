import { createRoot } from "react-dom/client";
import { App } from "./components/App.tsx";
import { SubagentWindow } from "./components/SubagentSession.tsx";
import { init } from "./store.ts";

if (navigator.userAgent.includes("Mac")) document.documentElement.classList.add("mac");
if (navigator.userAgent.includes("Windows")) document.documentElement.classList.add("windows");
// A subagent's window shows that one session and nothing else.
if (location.hash.startsWith("#subagent=")) {
	createRoot(document.getElementById("root")!).render(<SubagentWindow />);
} else {
	createRoot(document.getElementById("root")!).render(<App />);
	void init();
}
