import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { downArgs, downCommand, type DockerResult, type DockerRunner, InfraManager, projectName, upArgs } from "../src/main/compose.ts";
import { parseJsonc, readTasks, TasksFileError } from "../src/main/launch-config.ts";
import { isWithin, type LaunchHost, LaunchManager } from "../src/main/launch.ts";
import type { ServiceTracker } from "../src/main/services.ts";

const WS = process.platform === "win32" ? "C:\\work\\api" : "/work/api";

function tasksOf(tasks: unknown[], extra: Record<string, unknown> = {}) {
	return readTasks({ version: "2.0.0", tasks, ...extra }, WS, "linux");
}

const db = { label: "Database", type: "docker-compose", dockerCompose: { files: ["${workspaceFolder}/compose.yaml"], up: { services: ["db"], build: false, customOptions: "--wait" } } };
const api = { label: "API", type: "shell", command: "npm", args: ["run", "dev"], dependsOn: "Database", options: { cwd: "${workspaceFolder}", env: { PGHOST: "127.0.0.1" } }, problemMatcher: [] };

test("JSONC: comments and trailing commas parse; mistakes give line and column", () => {
	assert.deepEqual(parseJsonc('// top\n{ "a": [1, 2,], /* x */ "b": "c\\n", }\n'), { a: [1, 2], b: "c\n" });
	assert.deepEqual(parseJsonc('\uFEFF{"version": "2.0.0"}'), { version: "2.0.0" });
	assert.throws(
		() => parseJsonc('{\n  "a": 1\n  "b": 2\n}'),
		(error: unknown) => error instanceof TasksFileError && error.position?.line === 3 && error.position.column === 3,
	);
	assert.throws(() => parseJsonc('{ "a": 1 /* open'), /Unterminated comment/);
	assert.throws(() => parseJsonc('{ "a": tru }'), /line 1, column 8/);
});

test("the example file reads as an app that depends on its database", () => {
	const read = tasksOf([db, api, { label: "lint", type: "shell", command: "npm run lint" }, { label: "Test", type: "npm", script: "test" }]);
	const entry = read.apps.find((task) => task.label === "API")!;
	assert.equal(entry.error, undefined);
	assert.equal(entry.app!.command, "npm");
	assert.deepEqual(entry.app!.args, ["run", "dev"]);
	assert.equal(entry.app!.cwd, WS);
	assert.deepEqual(entry.infra!.services, ["db"]);
	assert.equal(entry.infra!.build, false);
	assert.equal(entry.infra!.files[0], join(WS, "compose.yaml"));
	// The npm task is hidden; Database is the app's infrastructure, not hidden.
	assert.equal(read.hidden, 1);
	assert.equal(read.apps.length, 2);
});

test("platform blocks replace the command and args, override cwd and merge env", () => {
	const task = { label: "A", type: "shell", command: "a", args: ["x"], options: { env: { A: "1", B: "1" } }, windows: { command: "a.cmd", args: ["y"], options: { cwd: "sub", env: { B: "2" } } } };
	const win = readTasks({ version: "2.0.0", tasks: [task] }, WS, "win32").apps[0]!.app!;
	assert.equal(win.command, "a.cmd");
	assert.deepEqual(win.args, ["y"]);
	assert.equal(win.cwd, join(WS, "sub"));
	assert.deepEqual(win.env, { A: "1", B: "2" });
	const linux = readTasks({ version: "2.0.0", tasks: [task] }, WS, "linux").apps[0]!.app!;
	assert.equal(linux.command, "a");
	assert.deepEqual(linux.env, { A: "1", B: "1" });
});

test("envFile wins over envFiles; otherwise the last of envFiles", () => {
	const compose = (extra: Record<string, unknown>) => tasksOf([{ ...db, dockerCompose: { ...db.dockerCompose, ...extra } }, api]).apps[0]!.infra!.envFile;
	assert.equal(compose({ envFiles: ["a.env", "b.env"] }), join(WS, "b.env"));
	assert.equal(compose({ envFiles: ["a.env"], envFile: "c.env" }), join(WS, "c.env"));
	assert.equal(compose({}), undefined);
	assert.equal(tasksOf([{ ...db, dockerCompose: { ...db.dockerCompose, up: { profiles: ["db"] } } }, api]).apps[0]!.infra!.build, true);
});

test("every unsupported field is refused by name", () => {
	const appError = (task: Record<string, unknown>) => tasksOf([db, { ...api, ...task }]).apps[0]!.error;
	assert.match(appError({ options: { shell: { executable: "zsh" } } })!, /options\.shell is not supported/);
	assert.match(appError({ command: "${env:HOME}/run" })!, /variable substitutions/);
	assert.match(appError({ args: ["$(rm)"] })!, /args\[0\]/);
	assert.match(appError({ dependsOn: ["Database", "Other"] })!, /one docker-compose task/);
	assert.match(appError({ dependsOn: "Nope" })!, /not a task/);
	assert.match(appError({ dependsOn: "lint" })!, /not a task|docker-compose/);
	assert.match(appError({ runWhen: "x" })!, /runWhen is not supported/);
	assert.match(tasksOf([db, { ...api, label: "API" }, { ...api }]).apps[0]!.error!, /More than one/);
	const infraError = (compose: Record<string, unknown>, top: Record<string, unknown> = {}) =>
		tasksOf([{ ...db, ...top, dockerCompose: { ...db.dockerCompose, ...compose } }, api]).apps[0]!.error;
	assert.match(infraError({ projectName: "x" })!, /projectName/);
	assert.match(infraError({ down: {} })!, /down/);
	assert.match(infraError({ up: { detached: false } })!, /detached/);
	assert.match(infraError({ up: { scale: { db: 2 } } })!, /scale/);
	assert.match(infraError({ up: { customOptions: "--pull always" } })!, /customOptions/);
	assert.match(infraError({ up: { services: ["db"], profiles: ["x"] } })!, /not both/);
	assert.match(infraError({ up: { services: ["--privileged"] } })!, /services\[0\]/);
	assert.match(infraError({}, { options: { cwd: "x" } })!, /options is not supported/);
	assert.throws(() => tasksOf([api], { options: { cwd: "x" } }), /file-level "options"/);
	assert.throws(() => readTasks({ version: "0.1.0", tasks: [] }, WS), /2\.0\.0/);
});

test("paths are inside the workspace by component, not by prefix", () => {
	assert.ok(isWithin(WS, join(WS, "a", "b")));
	assert.ok(isWithin(WS, WS));
	assert.ok(!isWithin(WS, `${WS}2`));
	assert.ok(!isWithin(WS, join(WS, "..", "other")));
	if (process.platform === "win32") assert.ok(!isWithin("C:\\work", "D:\\work\\x"));
});

test("the project name is stable, Trivium's own, and differs by home and folder", () => {
	const a = projectName("/home/.trivium", "/work/api", "/work/api");
	assert.equal(a, projectName("/home/.trivium", "/work/api", "/work/api"));
	assert.match(a, /^trivium-api-[0-9a-f]{10}$/);
	assert.notEqual(a, projectName("/other/.trivium", "/work/api", "/work/api"));
	assert.notEqual(a, projectName("/home/.trivium", "/work/api-wt", "/work/api"));
});

test("up waits detached once; down goes by project name, without -f or -v", () => {
	const args = upArgs("ctx", { project: "p", label: "D", files: ["/a.yaml", "/b.yaml"], envFile: "/e", profiles: ["x"], build: true, holder: "s" });
	assert.deepEqual(args, ["--context", "ctx", "compose", "-p", "p", "-f", "/a.yaml", "-f", "/b.yaml", "--env-file", "/e", "--profile", "x", "up", "-d", "--wait", "--build"]);
	assert.deepEqual(upArgs("ctx", { project: "p", label: "D", files: ["/a"], services: ["db"], build: false, holder: "s" }).slice(-4), ["-d", "--wait", "--", "db"]);
	const down = downArgs({ project: "p", dockerContext: "ctx" });
	assert.deepEqual(down, ["--context", "ctx", "compose", "-p", "p", "down"]);
	assert.ok(!down.includes("-v") && !down.includes("-f"));
	assert.equal(downCommand({ project: "p", dockerContext: "ctx" }), "docker --context ctx compose -p p down");
});

/** A Docker that answers from a table, and remembers what it was asked. */
function fakeDocker(options: { engine?: string | null; up?: DockerResult; left?: () => { containers: string; running: string; networks: string } } = {}) {
	const calls: string[][] = [];
	const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "", timedOut: false });
	const run: DockerRunner = async (args) => {
		calls.push(args);
		const left = options.left?.() ?? { containers: "", running: "", networks: "" };
		if (args[0] === "context") return ok("desktop-linux\n");
		if (args.includes("info")) return options.engine === null ? { code: 1, stdout: "", stderr: "Cannot connect", timedOut: false } : ok(`${options.engine ?? "ENGINE"}\n`);
		if (args.includes("up")) return options.up ?? ok("Container db Healthy\n");
		if (args.includes("logs")) return ok("db | FATAL: password missing\n");
		if (args.includes("down")) return ok();
		if (args.includes("network")) return ok(left.networks);
		if (args.includes("ps")) return ok(args.includes("-a") ? left.containers : left.running);
		return ok();
	};
	return { run, calls };
}

const spec = (holder: string) => ({ project: "trivium-api-0123456789", label: "Database", files: ["/w/compose.yaml"], services: ["db"], build: false, holder });

test("the record is on disk before up runs, and a failed up keeps output and logs", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-infra-"));
	const file = join(dir, "infra.json");
	let recordedBeforeUp = false;
	const docker = fakeDocker({ up: { code: 1, stdout: "", stderr: "dependency failed: db is unhealthy\n", timedOut: false } });
	const run: DockerRunner = async (args, ms) => {
		if (args.includes("up")) recordedBeforeUp = JSON.parse(readFileSync(file, "utf8"))[0].project === "trivium-api-0123456789";
		return docker.run(args, ms);
	};
	const infra = new InfraManager({ file, run, emit: () => {} });
	await assert.rejects(infra.up(spec("s1")), /unhealthy/);
	assert.ok(recordedBeforeUp);
	const info = infra.list()[0]!;
	assert.equal(info.state, "failed");
	assert.match(info.output, /unhealthy/);
	assert.match(info.logs, /FATAL/);
	const record = JSON.parse(readFileSync(file, "utf8"))[0];
	assert.deepEqual(Object.keys(record).sort(), ["dockerContext", "engineId", "files", "holders", "label", "project", "services", "startedAt"].sort());
});

test("two sessions share a project; it stops only when the last lets go, and down is verified", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-infra-"));
	let gone = false;
	const docker = fakeDocker({ left: () => (gone ? { containers: "", running: "", networks: "" } : { containers: "c1\n", running: "c1\n", networks: "n1\n" }) });
	const infra = new InfraManager({
		file: join(dir, "infra.json"),
		run: async (args, ms) => {
			if (args.includes("down")) gone = true;
			return docker.run(args, ms);
		},
		emit: () => {},
	});
	await infra.up(spec("s1"));
	await infra.up(spec("s2"));
	assert.deepEqual(infra.list()[0]!.holders, ["s1", "s2"]);
	assert.equal(await infra.release("trivium-api-0123456789", "s1"), false);
	assert.equal(await infra.release("trivium-api-0123456789", "s2"), true);
	await infra.stop("trivium-api-0123456789");
	assert.equal(infra.list().length, 0);
	const down = docker.calls.find((args) => args.includes("down"))!;
	assert.ok(!down.includes("-v") && !down.includes("-f"));
	await assert.rejects(infra.up({ ...spec("s3"), files: ["/w/other.yaml"] }).then(() => infra.up({ ...spec("s4"), files: ["/w/compose.yaml"] })), /other Compose files/);
});

test("recovery keeps what is left, drops what is gone, and marks an unreachable Docker unknown", async () => {
	const dir = mkdtempSync(join(tmpdir(), "trivium-infra-"));
	const file = join(dir, "infra.json");
	const record = (project: string) => ({ project, holders: ["s"], label: project, files: ["/w/c.yaml"], dockerContext: "ctx", engineId: "ENGINE", startedAt: 1 });
	writeFileSync(file, JSON.stringify([record("kept")]));
	// Only a network is left of a partial up: still shown, so it can be cleaned up.
	await (async () => {
		const infra = new InfraManager({ file, run: fakeDocker({ left: () => ({ containers: "", running: "", networks: "n\n" }) }).run, emit: () => {} });
		await infra.init();
		assert.equal(infra.list()[0]!.state, "failed");
	})();
	await (async () => {
		const infra = new InfraManager({ file, run: fakeDocker().run, emit: () => {} });
		await infra.init();
		assert.equal(infra.list().length, 0);
	})();
	writeFileSync(file, JSON.stringify([record("down")]));
	await (async () => {
		const infra = new InfraManager({ file, run: fakeDocker({ engine: null }).run, emit: () => {} });
		await infra.init();
		assert.equal(infra.list()[0]!.state, "unknown");
		await assert.rejects(infra.stop("down"), /reachable/);
		assert.equal(JSON.parse(readFileSync(file, "utf8")).length, 1);
	})();
	await (async () => {
		const docker = fakeDocker({ engine: "OTHER", left: () => ({ containers: "c\n", running: "c\n", networks: "" }) });
		const infra = new InfraManager({ file, run: docker.run, emit: () => {} });
		await infra.init();
		assert.equal(infra.list()[0]!.state, "unknown");
		await assert.rejects(infra.stop("down"), /different engine/);
		assert.ok(!docker.calls.some((args) => args.includes("down")));
	})();
});

/** A workspace with a tasks.json, and a launch manager whose services only record what they were asked to spawn. */
function setup(options: { denied?: boolean; files?: Record<string, string> } = {}) {
	const root = mkdtempSync(join(tmpdir(), "trivium-launch-"));
	const workspace = join(root, "api");
	mkdirSync(join(workspace, ".vscode"), { recursive: true });
	writeFileSync(join(workspace, ".vscode", "tasks.json"), `// tasks\n${JSON.stringify({ version: "2.0.0", tasks: [db, api, { label: "Solo", type: "shell", command: "node", args: ["server.js"] }] })}`);
	writeFileSync(join(workspace, "compose.yaml"), "services:\n  db:\n    image: postgres:16\n");
	for (const [name, text] of Object.entries(options.files ?? {})) writeFileSync(join(workspace, name), text);
	const spawned: string[] = [];
	const services = {
		launchApp: (o: { label: string }) => {
			spawned.push(o.label);
			return `svc-${o.label}`;
		},
		launched: () => undefined,
	} as unknown as ServiceTracker;
	const docker = fakeDocker();
	const host: LaunchHost = {
		session: () => ({ cwd: workspace, eligible: true, title: "Session" }),
		title: () => "Other",
		trustDenied: () => Boolean(options.denied),
	};
	const infra = new InfraManager({ file: join(root, "infra.json"), run: docker.run, emit: () => {} });
	const notices: string[] = [];
	const launch = new LaunchManager({ host, services, infra, triviumDir: join(root, "home"), emit: () => {}, notice: (message) => notices.push(message) });
	return { root, workspace, launch, spawned, docker, infra, notices };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test("a confirmed plan brings the database up, then spawns the app once; nothing runs before confirming", async () => {
	const { launch, spawned, docker } = setup();
	const plan = await launch.prepare("s1", "API");
	assert.deepEqual(plan.envNames, ["PGHOST"]);
	assert.ok(!JSON.stringify(plan).includes("127.0.0.1"), "environment values never reach the plan");
	assert.equal(docker.calls.length, 0);
	assert.equal(spawned.length, 0);
	await launch.start(plan.id);
	await settle();
	assert.deepEqual(spawned, ["API"]);
	assert.ok(docker.calls.some((args) => args.includes("up")));
	await assert.rejects(launch.start(plan.id), /out of date/);
});

test("trust denied, a cancelled confirmation, or a file that changed meanwhile spawns nothing", async () => {
	const denied = setup({ denied: true });
	await assert.rejects(denied.launch.prepare("s1", "API"), /not trusted/);
	assert.equal((await denied.launch.list("s1")).blocked, "This project is not trusted, so Launch is off.");
	assert.equal(denied.docker.calls.length + denied.spawned.length, 0);

	const cancelled = setup();
	const plan = await cancelled.launch.prepare("s1", "API");
	cancelled.launch.cancel(plan.id);
	await assert.rejects(cancelled.launch.start(plan.id), /out of date/);
	assert.equal(cancelled.docker.calls.length + cancelled.spawned.length, 0);

	const changed = setup();
	const next = await changed.launch.prepare("s1", "API");
	writeFileSync(join(changed.workspace, "compose.yaml"), "services: {}\n");
	await assert.rejects(changed.launch.start(next.id), /changed while the confirmation was open/);
	await settle();
	assert.equal(changed.docker.calls.length + changed.spawned.length, 0);
});

test("a Compose file reached through a link or junction out of the project is refused", async () => {
	const { root, workspace, launch } = setup();
	mkdirSync(join(root, "outside"));
	writeFileSync(join(root, "outside", "compose.yaml"), "services: {}\n");
	// A junction needs no extra rights on Windows; elsewhere it is a plain directory link.
	symlinkSync(join(root, "outside"), join(workspace, "linked"), "junction");
	const tasks = { version: "2.0.0", tasks: [{ ...db, dockerCompose: { ...db.dockerCompose, files: ["linked/compose.yaml"] } }, api] };
	writeFileSync(join(workspace, ".vscode", "tasks.json"), JSON.stringify(tasks));
	await assert.rejects(launch.prepare("s1", "API"), /outside the project folder/);
});

test("a second launch of the same app while it starts is refused; deleting the session cancels the spawn", async () => {
	const { launch, spawned } = setup();
	const first = await launch.prepare("s1", "API");
	const second = await launch.prepare("s1", "API");
	const started = launch.start(first.id);
	await assert.rejects(launch.start(second.id), /already starting/);
	await started;
	await launch.sessionDeleted("s1");
	await settle();
	assert.deepEqual(spawned, []);
});

test("the menu lists app tasks, and says when only launch.json is there", async () => {
	const { launch, workspace } = setup();
	const list = await launch.list("s1");
	assert.deepEqual(
		list.tasks.map((task) => [task.label, task.command, task.dependsOn]),
		[
			["API", "npm run dev", "Database"],
			["Solo", "node server.js", undefined],
		],
	);
	writeFileSync(join(workspace, ".vscode", "tasks.json"), '{ "version": "2.0.0", "tasks": [ }');
	assert.equal((await launch.list("s1")).error?.line, 1);
	const bare = setup();
	await import("node:fs/promises").then((fs) => fs.rm(join(bare.workspace, ".vscode", "tasks.json")));
	writeFileSync(join(bare.workspace, ".vscode", "launch.json"), "{}");
	const missing = await bare.launch.list("s1");
	assert.ok(missing.missing && missing.launchJson);
	await assert.rejects(bare.launch.prepare("s1", "API"), /Debug configurations aren't used/);
});

test("a launched app is a service from spawn: Stop works at once, and a non-zero exit is reported", async () => {
	const { ServiceTracker } = await import("../src/main/services.ts");
	const dir = mkdtempSync(join(tmpdir(), "trivium-launched-"));
	const tracker = new ServiceTracker({ file: join(dir, "services.json"), emit: () => {} });
	try {
		const failed = new Promise<{ code: number | null; tail: string; stopped: boolean }>((resolve) => {
			tracker.launchApp({ sessionPath: "s", label: "Bad", command: "echo starting; exit 3", cwd: dir, env: process.env, onExit: resolve });
		});
		const exit = await failed;
		assert.equal(exit.code, 3);
		assert.equal(exit.stopped, false);
		assert.match(exit.tail, /starting/);

		let ended: (value: { stopped: boolean }) => void = () => {};
		const stoppedExit = new Promise<{ stopped: boolean }>((resolve) => (ended = resolve));
		const id = tracker.launchApp({ sessionPath: "s", label: "Long", command: "sleep 30", cwd: dir, env: process.env, onExit: (end) => ended(end) });
		const listed = tracker.list().s ?? [];
		assert.ok(listed.some((service) => service.id === id && service.launch === "Long"), "listed before any process scan");
		assert.equal(tracker.launched("s", "Long"), id);
		await tracker.stop(id);
		assert.equal((await stoppedExit).stopped, true);
		assert.equal(tracker.launched("s", "Long"), undefined);
	} finally {
		tracker.dispose();
	}
});
