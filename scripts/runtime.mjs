import { createHash } from "node:crypto";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Data, NtExecutable, NtExecutableResource, Resource } from "resedit";

const require = createRequire(import.meta.url);
export const root = fileURLToPath(new URL("../", import.meta.url));

/** Brand a copy, never the installed Electron binary. Development executables are unsigned. */
export function brandWindowsExecutable(binary, icon, metadata) {
	const executable = NtExecutable.from(binary, { ignoreCert: true });
	const resources = NtExecutableResource.from(executable);
	const images = Data.IconFile.from(icon).icons.map((image) => image.data);
	const groups = Resource.IconGroupEntry.fromEntries(resources.entries);
	if (!groups.length || !images.length) throw new Error("Missing executable or Trivium icon resources.");
	for (const group of groups) {
		Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, images);
	}
	const versions = Resource.VersionInfo.fromEntries(resources.entries);
	if (!versions.length) throw new Error("Missing executable version resources.");
	for (const version of versions) {
		for (const language of version.getAllLanguagesForStringValues()) {
			version.setStringValues(language, {
				CompanyName: "Coresmos",
				FileDescription: metadata.productName,
				InternalName: metadata.productName,
				OriginalFilename: `${metadata.productName}.exe`,
				ProductName: metadata.productName,
			});
			version.setFileVersion(metadata.version, language.lang);
			version.setProductVersion(metadata.version, language.lang);
		}
		version.outputToResourceEntries(resources.entries);
	}
	resources.outputResource(executable);
	return Buffer.from(executable.generate());
}

/** Cache a private runtime so Windows can use Trivium's executable icon, even before a window opens. */
export async function prepareRuntime() {
	const electron = require("electron");
	if (process.platform !== "win32") return electron;
	const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
	const electronVersion = require("electron/package.json").version;
	const icon = await readFile(join(root, "src/assets/trivium-icon.ico"));
	const source = await stat(electron);
	const fingerprint = createHash("sha256")
		.update(await readFile(fileURLToPath(import.meta.url)))
		.update(icon)
		.update(JSON.stringify([metadata.productName, metadata.version, electronVersion, process.arch, source.size, source.mtimeMs]))
		.digest("hex").slice(0, 16);
	const cache = join(root, "dist/runtime");
	const runtime = join(cache, `win32-${process.arch}-${electronVersion}-${fingerprint}`);
	const executable = join(runtime, `${metadata.productName}.exe`);
	try {
		await access(join(runtime, ".ready"));
		await access(executable);
		return executable;
	} catch {
		// Publish only a complete runtime. A new fingerprint also avoids replacing a running executable.
	}
	await mkdir(cache, { recursive: true });
	const staging = await mkdtemp(join(cache, ".prepare-"));
	try {
		await cp(dirname(electron), staging, { recursive: true });
		const original = join(staging, "electron.exe");
		const branded = join(staging, `${metadata.productName}.exe`);
		await writeFile(branded, brandWindowsExecutable(await readFile(original), icon, metadata));
		await rm(original);
		await writeFile(join(staging, ".ready"), `${fingerprint}\n`);
		try {
			await rename(staging, runtime);
		} catch (error) {
			// Another launcher may have prepared the same runtime in parallel.
			await access(join(runtime, ".ready")).catch(() => { throw error; });
		}
		return executable;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
