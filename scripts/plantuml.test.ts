import assert from "node:assert/strict";
import { join, posix, win32 } from "node:path";
import test from "node:test";
import { plantUmlCommand, plantUmlSource } from "../src/main/plantuml.ts";

const ARGS = ["-tsvg", "-pipe", "-charset", "UTF-8"];

test("PlantUML runs the jar PLANTUML_JAR names with Java, from JAVA_HOME when it is set", () => {
	const jar = join("tools", "plantuml.jar");
	assert.deepEqual(plantUmlCommand({ PLANTUML_JAR: jar }, "linux", () => false), {
		command: "java",
		args: ["-Djava.awt.headless=true", "-jar", jar, ...ARGS],
		shell: false,
	});
	const home = join("opt", "jdk");
	assert.equal(plantUmlCommand({ PLANTUML_JAR: jar, JAVA_HOME: home }, "win32", () => false)?.command, join(home, "bin", "java"));
});

test("PlantUML is otherwise the first plantuml on the PATH", () => {
	const installed = new Set(["/opt/homebrew/bin/plantuml", "/usr/bin/plantuml"]);
	assert.deepEqual(plantUmlCommand({ PATH: "/usr/local/bin:/opt/homebrew/bin:/usr/bin" }, "darwin", (file) => installed.has(file)), {
		command: posix.join("/opt/homebrew/bin", "plantuml"),
		args: ARGS,
		shell: false,
	});
	assert.equal(plantUmlCommand({ PATH: "/usr/local/bin" }, "linux", (file) => installed.has(file)), undefined);
});

test("on Windows, PlantUML is found by PATHEXT, and a .cmd or .bat runs through a shell", () => {
	const env = { Path: "C:\\tools;C:\\scoop\\shims", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
	const shim = win32.join("C:\\scoop\\shims", "plantuml.exe");
	assert.deepEqual(plantUmlCommand(env, "win32", (file) => file === shim), { command: shim, args: ARGS, shell: false });
	const script = win32.join("C:\\tools", "plantuml.cmd");
	assert.deepEqual(plantUmlCommand(env, "win32", (file) => file === script), { command: script, args: ARGS, shell: true });
	assert.equal(plantUmlCommand(env, "win32", () => false), undefined);
});

test("a fenced diagram without @startuml gets one, and one that has its own is left alone", () => {
	assert.equal(plantUmlSource("Alice -> Bob: hi"), "@startuml\nAlice -> Bob: hi\n@enduml\n");
	const mindmap = "@startmindmap\n* root\n@endmindmap";
	assert.equal(plantUmlSource(mindmap), mindmap);
	assert.equal(plantUmlSource("  @startuml\nA -> B\n@enduml"), "  @startuml\nA -> B\n@enduml");
});
