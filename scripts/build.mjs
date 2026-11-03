import { mkdir, rm } from "node:fs/promises";
import { build } from "esbuild";
import { bundles, copyStatic, dist, statics } from "./bundles.mjs";

// Chunk names carry a hash, so an earlier build's chunks would pile up.
await rm(`${dist}chunks`, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await Promise.all([...Object.values(bundles).map((options) => build(options)), ...statics.map(copyStatic)]);
