import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getShellConfig } from "@earendil-works/pi-coding-agent";
import {
	groupProcesses,
	MARKER,
	OutputTail,
	parseLsof,
	parseMarkerLines,
	parseNetstat,
	parsePs,
	parseWindowsProcesses,
	type ProcessProbe,
	type ProcessRow,
	rootsOf,
	serviceUrl,
	ServiceTracker,
	splitByRoot,
	startsDetached,
} from "../src/main/services.ts";
import type { ServiceInfo } from "../src/shared/protocol.ts";

const row = (pid: number, ppid: number, extra: Partial<ProcessRow> = {}): ProcessRow => ({ pid, ppid, name: `p${pid}`, ...extra });

test("a service is the processes carrying its id, and their children", () => {
	const rows = [
		row(1, 0),
		row(10, 1, { marker: "a", created: 5000 }),
		row(11, 10, { created: 5100 }),
		row(12, 11, { created: 5200 }),
		row(20, 1, { marker: "b", created: 6000 }),
		row(30, 1),
	];
	const groups = groupProcesses(rows, [
		{ id: "a", startedAt: 5000 },
		{ id: "b", startedAt: 6000 },
		{ id: "gone", startedAt: 6000 },
	]);
	assert.deepEqual(groups.get("a")?.map((r) => r.pid), [10, 11, 12]);
	assert.deepEqual(groups.get("b")?.map((r) => r.pid), [20]);
	assert.equal(groups.has("gone"), false);
});

test("a child older than the service is a reused process id, not its child", () => {
	const rows = [row(10, 1, { marker: "a", created: 5000 }), row(11, 10, { created: 1000 })];
	assert.deepEqual(groupProcesses(rows, [{ id: "a", startedAt: 5000 }]).get("a")?.map((r) => r.pid), [10]);
});

test("on macOS and Linux the shell's process group counts even without the id", () => {
	const rows = [row(50, 1, { pgid: 40 }), row(51, 50, { pgid: 40 }), row(60, 1, { pgid: 60 })];
	assert.deepEqual(groupProcesses(rows, [{ id: "a", startedAt: 0, shellPid: 40 }]).get("a")?.map((r) => r.pid), [50, 51]);
});

test("a detached command's programs count once their launcher has exited", () => {
	const command = 'powershell.exe -Command \'Start-Process -FilePath "uv" -ArgumentList "run","app"; Start-Process -FilePath "npm.cmd" -ArgumentList "run","dev"\'';
	const rows = [
		row(1, 0),
		// Started by the command's PowerShell, which has exited.
		row(10, 99, { name: "uv", created: 5100 }),
		row(11, 10, { name: "python", created: 5200 }),
		row(20, 99, { name: "cmd", created: 5150 }),
		row(21, 20, { name: "node", created: 5300 }),
		// An orphan the command does not name, one from before it, and a named one whose parent lives.
		row(30, 98, { name: "updater", created: 5100 }),
		row(40, 97, { name: "uv", created: 1000 }),
		row(50, 1, { name: "uv", created: 5100 }),
	];
	const groups = groupProcesses(rows, [{ id: "a", startedAt: 5000, detached: { command, endedAt: 6000 } }]);
	assert.deepEqual(groups.get("a")?.map((r) => r.pid), [10, 11, 20, 21]);
	// Without the detached launch, the same processes are not the command's.
	assert.equal(groupProcesses(rows, [{ id: "a", startedAt: 5000 }]).has("a"), false);
});

test("Start-Process and cmd's start launch detached; npm start does not", () => {
	assert.equal(startsDetached('powershell -Command "Start-Process node server.js"'), true);
	assert.equal(startsDetached("cmd /c start /b node server.js"), true);
	assert.equal(startsDetached("cd app && start node server.js"), true);
	assert.equal(startsDetached("npm run dev"), false);
	assert.equal(startsDetached("npm start -- --port 3000"), false);
});

test("a command's processes split into one program per root, each with everything under it", () => {
	const parts = splitByRoot([row(10, 1), row(11, 10), row(12, 11), row(20, 2), row(21, 20)]);
	assert.deepEqual(parts.map((part) => part.map((r) => r.pid)), [
		[10, 11, 12],
		[20, 21],
	]);
	assert.deepEqual(splitByRoot([]), []);
});

test("the roots are the processes whose parent is not in the group", () => {
	assert.deepEqual(rootsOf([row(10, 1), row(11, 10), row(20, 7)]).map((r) => r.pid), [10, 20]);
});

test("Windows' process list reads one process or many", () => {
	assert.deepEqual(parseWindowsProcesses('{"ProcessId":4,"ParentProcessId":0,"Name":"System","Created":null}'), [
		{ pid: 4, ppid: 0, name: "System", created: undefined },
	]);
	const rows = parseWindowsProcesses('[{"ProcessId":10,"ParentProcessId":4,"Name":"node.exe","Created":1700000000000},{"ProcessId":11,"ParentProcessId":10,"Name":"cmd.exe","Created":1700000000100}]');
	assert.deepEqual(rows.map((r) => [r.pid, r.ppid, r.name, r.created]), [
		[10, 4, "node", 1700000000000],
		[11, 10, "cmd", 1700000000100],
	]);
	assert.deepEqual(parseWindowsProcesses(""), []);
});

test("Git Bash's marker lines map Windows process ids to command ids", () => {
	const markers = parseMarkerLines("36592\tabc123\r\n20216\tdef456\nnot a line\n\n");
	assert.deepEqual([...markers], [
		[36592, "abc123"],
		[20216, "def456"],
	]);
});

test("ps lines give the process group and the id from the environment after the command", () => {
	const rows = parsePs(
		[
			"    1     0     1 /sbin/launchd",
			`  812     1   790 /usr/local/bin/node /app/node_modules/.bin/vite PATH=/usr/bin HOME=/Users/me ${MARKER}=9f3e2a`,
			`  813   812   790 /usr/local/bin/esbuild --service ${MARKER}=9f3e2a`,
			"",
		].join("\n"),
	);
	assert.deepEqual(rows.map((r) => [r.pid, r.ppid, r.pgid, r.name, r.marker]), [
		[1, 0, 1, "launchd", undefined],
		[812, 1, 790, "node", "9f3e2a"],
		[813, 812, 790, "esbuild", "9f3e2a"],
	]);
});

test("netstat's listening sockets have no remote end, whatever language the state is in", () => {
	const ports = parseNetstat(
		[
			"Active Connections",
			"",
			"  Proto  Local Address          Foreign Address        State           PID",
			"  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4120",
			"  TCP    127.0.0.1:9229         0.0.0.0:0              ABHÖREN         4120",
			"  TCP    [::]:5173              [::]:0                 LISTENING       4120",
			"  TCP    127.0.0.1:5173         127.0.0.1:50122        ESTABLISHED     4120",
			"  TCP    [::1]:8080             [::]:0                 LISTENING       77",
			"  UDP    0.0.0.0:5353           *:*                                    900",
		].join("\r\n"),
	);
	assert.deepEqual([...ports], [
		[4120, [5173, 9229]],
		[77, [8080]],
	]);
});

test("lsof's field output gives each process's listening ports", () => {
	const ports = parseLsof(["p812", "f23", "n*:5173", "f24", "n[::1]:5173", "p900", "f5", "n127.0.0.1:3000", ""].join("\n"));
	assert.deepEqual([...ports], [
		[812, [5173]],
		[900, [3000]],
	]);
});

test("a service's address is one it printed on a port it listens on", () => {
	const vite = "\x1b[32m  VITE v5.0.0\x1b[39m  ready in 300 ms\n\n  ➜  Local:   \x1b[36mhttp://localhost:\x1b[1m5173\x1b[22m/\x1b[39m\n  ➜  Network: use --host to expose\n";
	assert.equal(serviceUrl(vite, [5173]), "http://localhost:5173/");
	assert.equal(serviceUrl("Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...", [8000]), "http://localhost:8000/");
	assert.equal(serviceUrl("Debugger listening on ws://127.0.0.1:9229/abc\nServer at http://127.0.0.1:3000.", [3000, 9229]), "http://127.0.0.1:3000");
	assert.equal(serviceUrl("no address printed", [4000, 4001]), "http://localhost:4000");
	assert.equal(serviceUrl("see http://localhost:8080/docs", []), "http://localhost:8080/docs");
	assert.equal(serviceUrl("see https://example.com:8443/", []), undefined);
	assert.equal(serviceUrl("", []), undefined);
});

test("the output tail keeps the end, without colors, with redrawn lines at their latest", () => {
	const tail = new OutputTail(20);
	tail.append("first line that falls off\n");
	tail.append("\x1b[1mbuild 10%\rbuild 100%\x1b[0m\r\nok\n");
	assert.equal(tail.read(), "build 100%\nok\n");
});

/** A process table the test edits, standing in for the system's. */
function fakeProbe() {
	const probe = {
		rows: [] as ProcessRow[],
		ports: new Map<number, number[]>(),
		killed: [] as number[][],
		async list() {
			return probe.rows;
		},
		async listening() {
			return probe.ports;
		},
		async kill(rows: ProcessRow[]) {
			probe.killed.push(rows.map((r) => r.pid));
			const gone = new Set(rows.map((r) => r.pid));
			probe.rows = probe.rows.filter((r) => !gone.has(r.pid) && !gone.has(r.ppid));
		},
		killSync(rows: ProcessRow[]) {
			probe.killed.push(rows.map((r) => r.pid));
		},
	} satisfies ProcessProbe & Record<string, unknown>;
	return probe;
}

function hasShell(): boolean {
	try {
		getShellConfig();
		return true;
	} catch {
		return false;
	}
}

test("a command that leaves a process running becomes a service until it is stopped", { skip: !hasShell() && "no bash" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-services-"));
	const probe = fakeProbe();
	const emitted: Record<string, ServiceInfo[]>[] = [];
	const tracker = new ServiceTracker({ file: join(dir, "services.json"), emit: (list) => emitted.push(list), probe, pollMs: 60_000 });
	try {
		let output = "";
		// The command prints its own id, so the fake table can list a process carrying it.
		const result = await tracker.bashOperations(() => "/sessions/a.jsonl").exec(`echo "id=$${MARKER}"`, dir, { onData: (data) => (output += data) });
		assert.equal(result.exitCode, 0);
		const id = /id=(\w+)/.exec(output)?.[1];
		assert.ok(id, output);
		await tracker.refresh();
		assert.equal(tracker.count(), 0, "nothing was left running yet");

		// The same again, now with a process left carrying the id.
		output = "";
		const run = tracker.bashOperations(() => "/sessions/a.jsonl").exec(`echo "id=$${MARKER}"; echo "Local: http://localhost:5173/"`, dir, {
			onData: (data) => {
				output += data;
				const next = /id=(\w+)/.exec(output)?.[1];
				if (next && !probe.rows.length) {
					probe.rows = [row(500, 1, { marker: next, name: "node" }), row(501, 500, { name: "esbuild" })];
					probe.ports.set(500, [5173]);
				}
			},
		});
		await run;
		await tracker.refresh();
		const [service] = tracker.list()["/sessions/a.jsonl"] ?? [];
		assert.ok(service, "the service is listed under its session");
		assert.match(service.command, /^echo "id=\$TRIVIUM_COMMAND_ID"/);
		assert.deepEqual(service.processes, [
			{ pid: 500, name: "node" },
			{ pid: 501, name: "esbuild" },
		]);
		assert.deepEqual(service.ports, [5173]);
		assert.equal(service.url, "http://localhost:5173/");
		assert.ok(emitted.at(-1)?.["/sessions/a.jsonl"]?.length, "the window heard about it");

		// A restart after a crash finds it again from the saved list.
		const again = new ServiceTracker({ file: join(dir, "services.json"), emit: () => {}, probe, pollMs: 60_000 });
		await again.init();
		assert.equal(again.list()["/sessions/a.jsonl"]?.[0]?.id, service.id);
		again.dispose();
		probe.killed.length = 0;

		await tracker.stop(service.id);
		assert.deepEqual(probe.killed[0], [500, 501]);
		assert.equal(tracker.count(), 0);
		assert.deepEqual(emitted.at(-1), {});
	} finally {
		tracker.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a command that leaves two programs running lists two services, each stopped on its own", { skip: !hasShell() && "no bash" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-services-"));
	const probe = fakeProbe();
	const tracker = new ServiceTracker({ file: join(dir, "services.json"), emit: () => {}, probe, pollMs: 60_000 });
	try {
		let output = "";
		let id = "";
		await tracker.bashOperations(() => "s").exec(`echo "id=$${MARKER}"; echo "Local: http://localhost:5173/"`, dir, {
			onData: (data) => {
				output += data;
				id = /id=(\w+)/.exec(output)?.[1] ?? "";
				if (id && !probe.rows.length) {
					probe.rows = [
						row(500, 1, { marker: id, name: "node" }),
						row(501, 500, { name: "esbuild" }),
						row(600, 1, { marker: id, name: "uv" }),
						row(601, 600, { name: "python" }),
					];
					probe.ports.set(500, [5173]);
					probe.ports.set(601, [8000]);
				}
			},
		});
		await tracker.refresh();
		const services = tracker.list()["s"] ?? [];
		assert.deepEqual(
			services.map((service) => [service.id, service.processes.map((p) => p.pid), service.ports, service.url]),
			[
				[`${id}:500`, [500, 501], [5173], "http://localhost:5173/"],
				[`${id}:600`, [600, 601], [8000], "http://localhost:8000"],
			],
		);
		assert.equal(tracker.count(), 2);

		await tracker.stop(`${id}:600`);
		assert.deepEqual(probe.killed[0], [600, 601]);
		// The frontend keeps running, now the command's only program.
		assert.deepEqual(
			(tracker.list()["s"] ?? []).map((service) => [service.id, service.ports]),
			[[id, [5173]]],
		);
		assert.equal(tracker.count(), 1);
	} finally {
		tracker.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a stopped or timed-out command ends with everything it started", { skip: !hasShell() && "no bash" }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-services-"));
	const tracker = new ServiceTracker({ file: join(dir, "services.json"), emit: () => {}, probe: fakeProbe(), pollMs: 60_000 });
	try {
		const ops = tracker.bashOperations(() => "s");
		await assert.rejects(ops.exec("sleep 30", dir, { onData: () => {}, timeout: 0.5 }), /^Error: timeout:0.5$/);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		await assert.rejects(ops.exec("sleep 30", dir, { onData: () => {}, signal: controller.signal }), /aborted/);
		const failed = await ops.exec("exit 3", dir, { onData: () => {} });
		assert.equal(failed.exitCode, 3);
	} finally {
		tracker.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});

function portFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer()
			.once("error", () => resolve(false))
			.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	});
}

async function until<T>(read: () => T | undefined, ms: number): Promise<T | undefined> {
	const end = Date.now() + ms;
	for (;;) {
		const value = read();
		if (value !== undefined || Date.now() > end) return value;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
}

test("a real server left running shows with its port, and Stop frees the port", { skip: !hasShell() && "no bash", timeout: 60_000 }, async () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-services-"));
	const tracker = new ServiceTracker({ file: join(dir, "services.json"), emit: () => {}, pollMs: 500 });
	const port = 20000 + Math.floor(Math.random() * 20000);
	const node = process.execPath.replace(/\\/g, "/");
	const server = `require('http').createServer((q, s) => s.end('hi')).listen(${port}, '127.0.0.1', () => console.log('Listening on http://127.0.0.1:${port}/'))`;
	try {
		let output = "";
		await tracker.bashOperations(() => "real").exec(`"${node}" -e "${server}" &\nsleep 1`, dir, { onData: (data) => (output += data) });
		assert.match(output, /Listening on/);
		const service = await until(() => tracker.list().real?.find((entry) => entry.ports.includes(port)), 20_000);
		assert.ok(service, `the server shows as a service: ${JSON.stringify(tracker.list())}`);
		assert.equal(service.url, `http://127.0.0.1:${port}/`);
		assert.equal(await portFree(port), false);
		await tracker.stop(service.id);
		assert.equal(tracker.count(), 0);
		let free = false;
		for (let i = 0; i < 25 && !free; i++) {
			free = await portFree(port);
			if (!free) await new Promise((resolve) => setTimeout(resolve, 200));
		}
		assert.equal(free, true, "the port is free again");
	} finally {
		tracker.dispose();
		rmSync(dir, { recursive: true, force: true });
	}
});
