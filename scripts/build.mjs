import { mkdir } from "node:fs/promises";
import { build } from "esbuild";
import { bundles, copyStatic, dist, statics } from "./bundles.mjs";

await mkdir(dist, { recursive: true });
await Promise.all([...Object.values(bundles).map((options) => build(options)), ...statics.map(copyStatic)]);
