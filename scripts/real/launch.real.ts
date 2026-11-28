/**
 * Launch's Docker ownership against a real Docker engine: label-based `down` without -f or -v, named volumes that
 * survive Stop, sharing between sessions, and leaving the developer's own Compose projects alone.
 *
 * Needs Docker running and postgres:16 and alpine:3.20 already pulled (the Compose file says never to pull):
 *   node --experimental-strip-types --test scripts/real/launch.real.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InfraManager, projectName } from "../../src/main/compose.ts";

const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const lines = (text: string) => text.split(/\r?\n/).filter(Boolean);
const label = (project: string) => `label=com.docker.compose.project=${project}`;

test("real Docker: data survives Stop, sharing holds, down works without the files, the developer's own project stays", { timeout: 300_000 }, async () => {
	const root = mkdtempSync(join(tmpdir(), "trivium-real-launch-"));
	const workspace = join(root, "api");
	const home = join(root, "home");
	mkdirSync(workspace, { recursive: true });
	const compose = join(workspace, "compose.yaml");
	writeFileSync(
		compose,
		[
			"services:",
			"  db:",
			"    image: postgres:16",
			"    pull_policy: never",
			"    environment:",
			"      POSTGRES_PASSWORD: example",
			"    volumes: [\"pgdata:/var/lib/postgresql/data\"]",
			"    healthcheck:",
			"      test: [\"CMD-SHELL\", \"pg_isready -U postgres\"]",
			"      interval: 2s",
			"      timeout: 3s",
			"      retries: 30",
			"volumes:",
			"  pgdata: {}",
			"",
		].join("\n"),
	);
	const project = projectName(home, workspace, workspace);
	const own = `trivium-real-own-${Date.now()}`;
	const ownFile = join(root, "own.yaml");
	writeFileSync(ownFile, "services:\n  idle:\n    image: alpine:3.20\n    pull_policy: never\n    command: sleep 600\n");
	const infra = new InfraManager({ file: join(home, "launch", "infra.json"), emit: () => {} });
	const spec = (holder: string) => ({ project, label: "Database", files: [compose], services: ["db"], build: false, holder });
	const psql = (sql: string) => docker("compose", "-p", project, "-f", compose, "exec", "-T", "db", "psql", "-U", "postgres", "-tAc", sql);
	try {
		docker("compose", "-p", own, "-f", ownFile, "up", "-d");

		await infra.up(spec("s1"));
		assert.equal(infra.get(project)?.state, "running");
		psql("CREATE TABLE IF NOT EXISTS kept (v text); INSERT INTO kept VALUES ('still here');");

		// Stop: down by name only; the named volume and its data stay.
		await infra.stop(project);
		assert.equal(lines(docker("ps", "-a", "-q", "--filter", label(project))).length, 0);
		assert.equal(lines(docker("network", "ls", "-q", "--filter", label(project))).length, 0);
		assert.ok(lines(docker("volume", "ls", "-q", "--filter", label(project))).length > 0, "named volume kept");

		await infra.up(spec("s1"));
		assert.equal(psql("SELECT v FROM kept;"), "still here");

		// Two sessions share it: the first letting go keeps it up.
		await infra.up(spec("s2"));
		assert.equal(await infra.release(project, "s1"), false);
		assert.equal(lines(docker("ps", "-q", "--filter", label(project))).length, 1);
		assert.equal(await infra.release(project, "s2"), true);

		// Down after the Compose file is gone, with an exited container and an extra project network left behind.
		docker("compose", "-p", project, "-f", compose, "stop");
		docker("network", "create", "--label", `com.docker.compose.project=${project}`, "--label", "com.docker.compose.network=extra", `${project}_extra`);
		rmSync(compose);
		await infra.stop(project);
		assert.equal(lines(docker("ps", "-a", "-q", "--filter", label(project))).length, 0);
		assert.equal(lines(docker("network", "ls", "-q", "--filter", label(project))).length, 0);

		// The developer's own project was never touched.
		assert.equal(lines(docker("ps", "-q", "--filter", label(own))).length, 1);
	} finally {
		try {
			docker("compose", "-p", own, "-f", ownFile, "down");
		} catch {}
		try {
			docker("compose", "-p", project, "down", "-v");
		} catch {}
		for (const volume of lines(docker("volume", "ls", "-q", "--filter", label(project)))) docker("volume", "rm", volume);
		rmSync(root, { recursive: true, force: true });
	}
});
