/**
 * The scripted model and throwaway folders, for trying a built or packaged Trivium by hand: `npm run real:live`, then
 * start the app with the environment it prints. See README.md here for what to do and what to look for.
 */
import { prepare } from "./harness.ts";
import { messageText, type ModelMessage, type Step } from "./model-server.ts";

const folders = await prepare();
const { model } = folders;
const call = (name: string, input: Record<string, unknown>): Step => () => ({ tools: [{ name, input }] });
const say = (text: string, delayMs?: number): Step => () => ({ text, delayMs });
const script = (name: string, ...steps: Step[]) => model.scripts.set(name, steps);
const reply = (message: string): Step => (messages: ModelMessage[]) => {
	const id = [...messages.map(messageText).join("\n").matchAll(/replyTo: \\?"([\w-]+)\\?"/g)].at(-1)?.[1];
	const answered = JSON.stringify(messages).includes(`Replied to supervisor request ${id}`);
	return id && !answered ? { tools: [{ name: "subagent_supervisor", input: { action: "reply", replyTo: id, message } }] } : { text: "Noted." };
};

script("gate", call("subagent", { agent: "scout", task: "@@look@@", async: false, options: { gate: "git push" } }), say("The gate was settled."));
script("look", say("looked"));
script("workflow", call("subagent", { workflow: "release", async: false }), say("Settled."));
script("ask", call("subagent", { agent: "worker", task: "@@asker@@", async: true, options: { context: "fork", timeoutMs: 3_600_000 } }), say("Started the writer."));
script("detach", call("subagent", { agent: "worker", task: "@@asker@@", async: false }), say("It is asking."));
script("asker", call("contact_supervisor", { reason: "need_decision", message: "May I push to origin?" }), call("bash", { command: "git push origin main" }), say("finished after the reply", 2000));
script("approve", reply("approved, push it"));
script("write", call("subagent", { agent: "worker", task: "@@slow-writer@@", async: true, options: { context: "fork", timeoutMs: 3_600_000 } }), say("Started the writer."));
script("slow-writer", say("Working.", 60_000), say("wrote it"));
script("edit", call("write", { path: "src/mine.ts", content: "mine\n" }), call("subagent", { agent: "worker", task: "@@look@@", async: true }), call("subagent", { agent: "scout", task: "@@look@@", async: true }), say("Tried an edit, a second writer and a scout."));
script("attribution", call("subagent", { agent: "worker", task: "@@child-edit@@", async: true }), say("Started. Edit src/app.ts yourself now."));
script("child-edit", call("write", { path: "src/child.ts", content: "child\n" }), say("wrote src/child.ts", 45_000));

const windows = process.platform === "win32";
console.log(`Project: ${folders.project}\n`);
for (const [name, value] of Object.entries(folders.env)) console.log(windows ? `$env:${name} = "${value}"` : `export ${name}="${value}"`);
console.log(`\nStart Trivium from that shell (npm start, or the packaged app), open the project, and send one of:\n${[...model.scripts.keys()].filter((name) => !["look", "asker", "slow-writer", "child-edit"].includes(name)).map((name) => `  @@${name}@@`).join("\n")}\n\nCtrl+C ends this and deletes the folders. Quit the app first.`);
process.on("SIGINT", () => void folders.close().finally(() => process.exit()));
