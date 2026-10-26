import { spawn } from "node:child_process";
import { watch } from "node:fs";
import { mkdir } from "node:fs/promises";
import { basename } from "node:path";
import { context } from "esbuild";
import { bundles, copyStatic, dist, statics } from "./bundles.mjs";
import { prepareRuntime, root } from "./runtime.mjs";

// Rebuilds on save. The app reloads its window when the renderer or preload changes (the selected
// session reopens), swaps the stylesheet in place, and this script restarts it when the main process changes.
await mkdir(dist, { recursive: true });
await Promise.all(statics.map(copyStatic));

let child;
let live = false;
let restarting = false;
const executable = await prepareRuntime();

function launch() {
	const env = { ...process.env, TRIVIUM_DEV: "1" };
	// Some terminals inherit this from another Electron host; this process is a desktop app, not Node.
	delete env.ELECTRON_RUN_AS_NODE;
	child = spawn(executable, [root, ...process.argv.slice(2)], { cwd: root, env, stdio: "inherit" });
	child.on("error", (error) => {
		console.error(`Could not start Trivium: ${error.message}`);
		process.exit(1);
	});
	child.on("exit", (code) => {
		if (restarting) {
			restarting = false;
			launch();
		} else {
			// Closing the window ends the dev session too.
			process.exit(code ?? 0);
		}
	});
}

function restart() {
	if (!child || child.exitCode !== null) return launch();
	restarting = true;
	child.kill();
}

const contexts = await Promise.all(
	Object.entries(bundles).map(async ([name, options]) => {
		let ready;
		const firstBuild = new Promise((resolve) => (ready = resolve));
		const ctx = await context({
			...options,
			logLevel: "warning",
			plugins: [{
				name: "trivium-dev",
				setup(build) {
					build.onEnd((result) => {
						ready(result);
						// esbuild has already printed any errors; the running app keeps the last good build.
						if (!live || result.errors.length) return;
						console.log(`[dev] rebuilt ${name}`);
						if (name === "main") restart();
					});
				},
			}],
		});
		await ctx.watch();
		return { name, ctx, firstBuild };
	}),
);

const failed = [];
for (const { name, firstBuild } of contexts) {
	if ((await firstBuild).errors.length) failed.push(name);
}
if (failed.length) {
	console.error(`[dev] the first build of ${failed.join(", ")} failed; fix it and run npm run dev again.`);
	await Promise.all(contexts.map(({ ctx }) => ctx.dispose()));
	process.exit(1);
}

// Editors often save by replacing the file, so watch the folders rather than the files.
for (const folder of new Set(statics.map((file) => file.from.slice(0, file.from.lastIndexOf("/"))))) {
	watch(folder, (_event, changed) => {
		const file = statics.find((candidate) => basename(candidate.from) === changed && candidate.from.startsWith(folder));
		// A file can be missing for a moment mid-save; the event for its new copy follows.
		if (file) copyStatic(file).catch((error) => error.code === "ENOENT" || console.error(`[dev] could not copy ${changed}: ${error.message}`));
	});
}

live = true;
launch();
console.log("[dev] watching src/ for changes");
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => {
		restarting = false;
		if (child?.exitCode === null) child.kill();
		process.exit(0);
	});
}
