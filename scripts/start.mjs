import { spawn } from "node:child_process";
import { prepareRuntime, root } from "./runtime.mjs";

const executable = await prepareRuntime();
const env = { ...process.env };
// Some terminals inherit this from another Electron host; this process is a desktop app, not Node.
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(executable, [root, ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit" });
child.on("error", (error) => {
	console.error(`Could not start Trivium: ${error.message}`);
	process.exitCode = 1;
});
child.on("exit", (code) => { process.exitCode = code ?? 1; });
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
}
