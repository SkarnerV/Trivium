import { copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
export const dist = `${root}dist/`;

export const bundles = {
	// The pi SDK resolves its own package assets at runtime, so it stays external.
	main: {
		entryPoints: [`${root}src/main/main.ts`],
		outfile: `${dist}main.mjs`,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: ["electron", "@earendil-works/*"],
		sourcemap: true,
	},
	preload: {
		entryPoints: [`${root}src/preload/preload.ts`],
		outfile: `${dist}preload.cjs`,
		bundle: true,
		platform: "node",
		format: "cjs",
		external: ["electron"],
	},
	renderer: {
		entryPoints: [`${root}src/renderer/main.tsx`],
		outfile: `${dist}renderer.js`,
		bundle: true,
		platform: "browser",
		format: "esm",
		jsx: "automatic",
		sourcemap: true,
		define: { "process.env.NODE_ENV": '"development"' },
	},
};

/** Files copied into dist as they are, keyed by their source path. */
export const statics = [
	"src/renderer/index.html",
	"src/renderer/styles.css",
	"src/assets/trivium-icon.png",
	"src/assets/trivium-icon-research.png",
	"src/assets/trivium-icon-write.png",
	"src/assets/trivium-icon.ico",
	"src/assets/trivium-icon-research.ico",
	"src/assets/trivium-icon-write.ico",
].map((path) => ({ from: `${root}${path}`, to: `${dist}${path.split("/").pop()}` }));

export const copyStatic = (file) => copyFile(file.from, file.to);
