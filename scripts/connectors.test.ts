import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConnectorStore, entryFor, parseImport } from "../src/main/connectors.ts";
import { joinCommand, parsePairs, splitCommand } from "../src/shared/connectors.ts";
import type { ConnectorInput } from "../src/shared/protocol.ts";

const filesystem: ConnectorInput = {
	name: "filesystem",
	transport: "stdio",
	command: "npx",
	args: ["-y", "@modelcontextprotocol/server-filesystem", "~/My Documents"],
	env: {},
	url: "",
	headers: {},
	description: "",
};

const store = async () => {
	const dir = await mkdtemp(join(tmpdir(), "trivium-mcp-"));
	return { dir, store: new ConnectorStore(dir, () => {}) };
};

test("command lines split like a shell's words and join back the same", () => {
	assert.deepEqual(splitCommand(`npx -y "@scope/server" '~/My Documents' a\\ b ""`), ["npx", "-y", "@scope/server", "~/My Documents", "a b", ""]);
	const words = ["uvx", "tool", "it's here", "${HOME}/x", ""];
	assert.deepEqual(splitCommand(joinCommand(words)), words);
});

test("pairs: one per line, values keep their separators, a line without one is refused", () => {
	assert.deepEqual(parsePairs("A=1\n\nB = x=y\n", "="), { A: "1", B: "x=y" });
	assert.deepEqual(parsePairs("Authorization: Bearer ${T}", ":"), { Authorization: "Bearer ${T}" });
	assert.throws(() => parsePairs("oops", "="), /NAME=value/);
});

test("import: Claude's and VS Code's blocks, a bare map, one named entry, and a pair cut from a file", () => {
	const entry = { command: "npx", args: ["x"] };
	assert.deepEqual(parseImport(JSON.stringify({ mcpServers: { a: entry } })), { a: entry });
	assert.deepEqual(parseImport(JSON.stringify({ servers: { b: entry } })), { b: entry });
	assert.deepEqual(parseImport(JSON.stringify({ c: entry })), { c: entry });
	assert.deepEqual(parseImport(JSON.stringify(entry), "d"), { d: entry });
	assert.throws(() => parseImport(JSON.stringify(entry)), /Give it a name/);
	assert.deepEqual(parseImport(`"e": ${JSON.stringify(entry)},`), { e: entry });
	assert.throws(() => parseImport("{"), /valid JSON/);
});

test("an edit keeps what the page doesn't show, and drops what the other transport can't use", () => {
	const previous = { command: "old", cwd: "~/x", exposure: "direct", timeout: 5, oauth: { clientId: "c" } };
	assert.deepEqual(entryFor(filesystem, previous), {
		command: "npx",
		args: filesystem.args,
		cwd: "~/x",
		exposure: "direct",
		timeout: 5,
	});
	assert.deepEqual(entryFor({ ...filesystem, transport: "http", url: " https://x.dev/mcp ", description: "Docs" }, previous), {
		url: "https://x.dev/mcp",
		description: "Docs",
		exposure: "direct",
		timeout: 5,
		oauth: { clientId: "c" },
	});
});

test("servers are added, renamed, switched and removed in pi's mcp.json, keeping other content", async () => {
	const { dir, store: connectors } = await store();
	const path = join(dir, "mcp.json");
	await writeFile(path, JSON.stringify({ autoEnableCodemode: false, mcpServers: {} }, null, "\t"));

	let view = await connectors.save(filesystem);
	assert.equal(view.servers.length, 1);
	assert.equal(view.servers[0].exposure, "codemode");
	assert.equal(view.servers[0].state, undefined);
	await assert.rejects(connectors.save(filesystem), /exists already/);
	await assert.rejects(connectors.save({ ...filesystem, name: "bad name" }), /letters, digits/);
	await assert.rejects(connectors.save({ ...filesystem, name: "x", command: "" }), /command/);

	view = await connectors.set("filesystem", { enabled: false, exposure: "direct" });
	assert.equal(view.servers[0].state, "disabled");
	assert.equal(view.servers[0].exposure, "direct");

	view = await connectors.save({ ...filesystem, name: "files", description: "My files" }, "filesystem");
	assert.deepEqual(
		view.servers.map((server) => [server.name, server.enabled, server.exposure, server.description]),
		[["files", false, "direct", "My files"]],
	);
	const written = JSON.parse(await readFile(path, "utf8"));
	assert.equal(written.autoEnableCodemode, false);
	assert.match(await readFile(path, "utf8"), /^\t"autoEnableCodemode"/m);

	const { added } = await connectors.import(JSON.stringify({ mcpServers: { docs: { url: "https://docs.example/mcp" } } }));
	assert.deepEqual(added, ["docs"]);
	await assert.rejects(connectors.import(JSON.stringify({ mcpServers: { docs: { url: "https://x" }, ok: { url: "https://y" } } })), /exists already/);
	await assert.rejects(connectors.import(JSON.stringify({ mcpServers: { fine: { url: "https://y" }, broken: { sse: true } } })));
	view = await connectors.view();
	assert.deepEqual(
		view.servers.map((server) => server.name),
		["files", "docs"],
	);
	const docs = view.servers.find((server) => server.name === "docs")!;
	assert.equal(docs.transport, "http");
	assert.equal(docs.oauth, true);

	view = await connectors.remove("files");
	assert.deepEqual(
		view.servers.map((server) => server.name),
		["docs"],
	);
});

test("a tool's own exposure is written only where it differs from its server or a matching pattern", async () => {
	const { dir, store: connectors } = await store();
	const path = join(dir, "mcp.json");
	await writeFile(path, JSON.stringify({ mcpServers: { gh: { url: "https://gh.example/mcp", exposure: "deferred", toolExposure: { "delete_*": "hidden" } } } }));
	await connectors.setToolExposure("gh", "search_code", "direct");
	await connectors.setToolExposure("gh", "delete_repo", "deferred");
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")).mcpServers.gh.toolExposure, {
		"delete_*": "hidden",
		search_code: "direct",
		delete_repo: "deferred",
	});
	await connectors.setToolExposure("gh", "search_code", "deferred");
	await connectors.setToolExposure("gh", "delete_repo", "hidden");
	assert.deepEqual(JSON.parse(await readFile(path, "utf8")).mcpServers.gh.toolExposure, { "delete_*": "hidden" });
});

test("a check connects as pi mcp list does and reports a server that can't start", async () => {
	const { dir, store: connectors } = await store();
	await writeFile(
		join(dir, "mcp.json"),
		JSON.stringify({ mcpServers: { missing: { command: join(dir, "no-such-server") }, off: { command: "x", enabled: false } } }),
	);
	const view = await connectors.check();
	const missing = view.servers.find((server) => server.name === "missing")!;
	assert.equal(missing.state, "failed");
	assert.ok(missing.error);
	assert.equal(view.servers.find((server) => server.name === "off")!.state, "disabled");
	assert.ok(view.checked);
});
