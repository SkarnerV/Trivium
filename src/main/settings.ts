import { existsSync, readFileSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import type { AppId, AppSettings, DeskSettings } from "../shared/protocol.ts";
import { APP_IDS } from "../shared/protocol.ts";

const emptyApp = (): AppSettings => ({ disabled: [], added: [] });

const DEFAULTS: DeskSettings = {
	textSize: 1,
	idleMinutes: 30,
	notifyDone: true,
	notifyWaiting: true,
	apps: { code: emptyApp(), research: emptyApp(), write: emptyApp() },
};

/** The app's own preferences in ~/.desk/settings.json. pi's settings stay in ~/.pi/agent. */
export class SettingsStore {
	private value: DeskSettings;
	private readonly file: string;
	private saving = Promise.resolve();

	constructor(file: string) {
		this.file = file;
		this.value = structuredClone(DEFAULTS);
		if (!existsSync(file)) return;
		try {
			const saved = JSON.parse(readFileSync(file, "utf8")) as Partial<DeskSettings>;
			this.value = { ...this.value, ...saved, apps: { ...this.value.apps } };
			for (const id of APP_IDS) this.value.apps[id] = { ...emptyApp(), ...saved.apps?.[id] };
		} catch {
			// Fall back to defaults; the next save rewrites the file.
		}
	}

	get(): DeskSettings {
		return this.value;
	}

	app(id: AppId): AppSettings {
		return this.value.apps[id];
	}

	update(patch: Partial<DeskSettings>): Promise<DeskSettings> {
		this.value = { ...this.value, ...patch, apps: { ...this.value.apps, ...patch.apps } };
		const contents = JSON.stringify(this.value, null, 2);
		this.saving = this.saving
			.catch(() => {})
			.then(async () => {
				await writeFile(`${this.file}.tmp`, contents, { mode: 0o600 });
				await rename(`${this.file}.tmp`, this.file);
			});
		return this.saving.then(() => this.value);
	}
}
