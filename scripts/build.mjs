import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = `${root}dist/`;
await mkdir(dist, { recursive: true });

await Promise.all([
	// The pi SDK resolves its own package assets at runtime, so it stays external.
	build({
		entryPoints: [`${root}src/main/main.ts`],
		outfile: `${dist}main.mjs`,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		external: ["electron", "@earendil-works/*"],
		sourcemap: true,
	}),
	build({
		entryPoints: [`${root}src/preload/preload.ts`],
		outfile: `${dist}preload.cjs`,
		bundle: true,
		platform: "node",
		format: "cjs",
		external: ["electron"],
	}),
	build({
		entryPoints: [`${root}src/renderer/main.tsx`],
		outfile: `${dist}renderer.js`,
		bundle: true,
		platform: "browser",
		format: "esm",
		jsx: "automatic",
		sourcemap: true,
		define: { "process.env.NODE_ENV": '"development"' },
	}),
	copyFile(`${root}src/renderer/index.html`, `${dist}index.html`),
	copyFile(`${root}src/renderer/styles.css`, `${dist}styles.css`),
	copyFile(`${root}src/assets/trivium-icon.png`, `${dist}trivium-icon.png`),
	copyFile(`${root}src/assets/trivium-icon-research.png`, `${dist}trivium-icon-research.png`),
	copyFile(`${root}src/assets/trivium-icon-write.png`, `${dist}trivium-icon-write.png`),
	copyFile(`${root}src/assets/trivium-icon.ico`, `${dist}trivium-icon.ico`),
	copyFile(`${root}src/assets/trivium-icon-research.ico`, `${dist}trivium-icon-research.ico`),
	copyFile(`${root}src/assets/trivium-icon-write.ico`, `${dist}trivium-icon-write.ico`),
]);
