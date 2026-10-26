import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

assert.ok(process.argv[2], "Pass the packaged app executable to this script.");
const executable = resolve(process.argv[2]);
const directory = await mkdtemp(join(tmpdir(), "trivium-release-smoke-"));
const marker = "TRIVIUM_RELEASE_SMOKE_OK";
const env = {
	...process.env,
	TRIVIUM_HOME: join(directory, "trivium"),
	PI_CODING_AGENT_DIR: join(directory, "pi"),
	APPDATA: join(directory, "appdata"),
	TRIVIUM_CAPTURE: join(directory, "startup.png"),
	TRIVIUM_EVAL: `
		(async () => {
			const profiles = await window.trivium.profiles();
			if (profiles.length !== 3) throw new Error("Missing packaged app profiles");
			await window.trivium.getSettings();
			await window.trivium.listModels();
			for (let attempt = 0; attempt < 100; attempt++) {
				if (["Code", "Research", "Write"].every(name => document.querySelector('[aria-label="' + name + '"]'))) {
					console.log("${marker}");
					return;
				}
				await new Promise(done => setTimeout(done, 100));
			}
			throw new Error("Packaged renderer did not mount: " + document.body.innerText);
		})();`,
};
delete env.ELECTRON_RUN_AS_NODE;
const timeoutMs = Number(process.env.TRIVIUM_STARTUP_TIMEOUT_MS ?? 60_000);
assert.ok(Number.isFinite(timeoutMs) && timeoutMs > 0, "Startup timeout must be a positive number of milliseconds.");
const started = performance.now();
const child = spawn(executable, [], { env, cwd: directory, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
try {
	await new Promise((done, fail) => {
		const timer = setTimeout(() => fail(new Error(`Packaged startup exceeded ${timeoutMs} ms:\n${output}`)), timeoutMs);
		const finish = (error) => {
			clearTimeout(timer);
			error ? fail(error) : done();
		};
		const read = (data) => {
			output += data.toString();
			if (output.includes(marker)) finish();
		};
		child.stdout.on("data", read);
		child.stderr.on("data", read);
		child.once("error", finish);
		child.once("exit", (code) => finish(new Error(`Packaged app exited (${code}):\n${output}`)));
	});
	console.log(`Packaged startup: ${Math.round(performance.now() - started)} ms. Preload, profiles, settings, models and renderer passed.`);
} finally {
	if (child.pid && child.exitCode === null) {
		const stopped = new Promise(done => child.once("exit", done));
		if (process.platform === "win32") {
			const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true, stdio: "ignore" });
			await new Promise(done => killer.once("exit", done));
		} else child.kill("SIGTERM");
		await stopped;
	}
	await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
