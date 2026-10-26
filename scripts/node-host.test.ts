import assert from "node:assert/strict";
import test from "node:test";
import { type NodeHost, routeSpawn } from "../src/main/node-host.ts";

const host = (hasNode: boolean): NodeHost => ({ execPath: "C:\\Apps\\Trivium\\Trivium.exe", env: { PATH: "C:\\bin" }, hasNode: () => hasNode });

test("spawning Trivium's own executable runs it as Node, keeping the environment", () => {
	const inherited = routeSpawn({ command: "C:\\Apps\\Trivium\\Trivium.exe", options: { stdio: "pipe" } }, host(true));
	assert.deepEqual(inherited, { command: "C:\\Apps\\Trivium\\Trivium.exe", options: { stdio: "pipe", env: { PATH: "C:\\bin", ELECTRON_RUN_AS_NODE: "1" } } });
	const given = routeSpawn({ command: "C:\\Apps\\Trivium\\Trivium.exe", options: { env: { HOME: "x" } } }, host(true));
	assert.deepEqual(given.options.env, { HOME: "x", ELECTRON_RUN_AS_NODE: "1" });
});

test("other commands, and anything run through a shell, are left as they are", () => {
	for (const command of ["bash", "C:\\Apps\\Code\\Code.exe", "git"]) {
		const target = { command, options: {} };
		assert.equal(routeSpawn(target, host(false)), target);
	}
	const shelled = { command: "C:\\Apps\\Trivium\\Trivium.exe", options: { shell: true } };
	assert.equal(routeSpawn(shelled, host(false)), shelled);
});

test("bare node uses the one on PATH, or Trivium as Node when there is none", () => {
	const target = { command: "node.exe", options: {} };
	assert.equal(routeSpawn(target, host(true)), target);
	assert.deepEqual(routeSpawn(target, host(false)), {
		command: "C:\\Apps\\Trivium\\Trivium.exe",
		options: { env: { PATH: "C:\\bin", ELECTRON_RUN_AS_NODE: "1" } },
	});
});

test("installed routes reach ESM imports, every call shape, and promisified execFile", async () => {
	const { installNodeHost } = await import("../src/main/node-host.ts");
	installNodeHost();
	const { execFile, execFileSync, spawn, spawnSync } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const probe = ["-e", "process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? 'unset')"];
	assert.equal(execFileSync(process.execPath, probe, { encoding: "utf8" }), "1");
	assert.equal(spawnSync(process.execPath, probe).stdout.toString(), "1");
	assert.equal((await promisify(execFile)(process.execPath, probe)).stdout, "1");
	const out = await new Promise<string>((done) => execFile(process.execPath, probe, (_error, stdout) => done(String(stdout))));
	assert.equal(out, "1");
	const child = spawn(process.execPath, probe);
	let spawned = "";
	child.stdout.on("data", (chunk) => (spawned += chunk));
	await new Promise((done) => child.on("close", done));
	assert.equal(spawned, "1");
	assert.equal(execFileSync(process.execPath, { encoding: "utf8", input: "process.stdout.write('stdin ' + process.env.ELECTRON_RUN_AS_NODE)" }), "stdin 1");
	assert.match(process.env.PI_SUBAGENTS_PI_CODING_AGENT_PACKAGE_ROOT ?? "", /pi-coding-agent$/);
});
