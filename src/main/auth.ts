import { randomUUID } from "node:crypto";
import type { AuthPrompt, AuthEvent } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { LoginEvent, ProviderInfo } from "../shared/protocol.ts";

type AuthLike = {
	apiKey?: { name: string; login?: unknown };
	oauth?: { name: string; loginLabel?: string };
};

function describeSource(status: ReturnType<ModelRuntime["getProviderAuthStatus"]>, oauth: boolean): string {
	if (!status.configured) return "Not set up";
	switch (status.source) {
		case "stored":
			return oauth ? "Logged in" : "Key saved in pi";
		case "environment":
			return status.label ? `Key from ${status.label}` : "Key from the environment";
		case "models_json_key":
		case "models_json_command":
			return "Configured in models.json";
		case "runtime":
			return "Set for this run";
		default:
			return "Configured";
	}
}

/** `custom` holds the providers the user added in models.json, which are edited rather than logged in to. */
export function listProviders(runtime: ModelRuntime, custom: Set<string> = new Set()): ProviderInfo[] {
	const providers = runtime.getProviders().map((provider) => {
		const auth = provider.auth as AuthLike;
		const status = runtime.getProviderAuthStatus(provider.id);
		const oauth = runtime.isUsingOAuth(provider.id);
		const logins: ProviderInfo["logins"] = [];
		if (auth.oauth) logins.push({ type: "oauth", label: auth.oauth.loginLabel ?? `Log in with ${auth.oauth.name}` });
		if (auth.apiKey?.login) logins.push({ type: "api_key", label: "Enter API key" });
		return {
			id: provider.id,
			name: provider.name,
			configured: status.configured,
			how: describeSource(status, oauth),
			logins,
			canLogout: status.configured && status.source === "stored",
			models: runtime.getAllModels(provider.id).length,
			custom: custom.has(provider.id) || undefined,
		};
	});
	return providers.sort((a, b) => Number(b.configured) - Number(a.configured) || a.name.localeCompare(b.name));
}

/**
 * Runs one provider login at a time, turning pi's prompts and notices into
 * events for the login dialog. Secrets typed there go straight to pi's auth storage.
 */
export class LoginFlow {
	private pending = new Map<string, (value: string | undefined) => void>();
	private abort: AbortController | undefined;
	private readonly emit: (event: LoginEvent) => void;
	private readonly openUrl: (url: string) => void;
	private readonly getDeviceId: () => string;

	constructor(emit: (event: LoginEvent) => void, openUrl: (url: string) => void, getDeviceId: () => string) {
		this.emit = emit;
		this.openUrl = openUrl;
		this.getDeviceId = getDeviceId;
	}

	async start(runtime: ModelRuntime, providerId: string, type: "api_key" | "oauth"): Promise<void> {
		this.cancel();
		const abort = new AbortController();
		this.abort = abort;
		try {
			await runtime.login(
				providerId,
				type,
				{
					signal: abort.signal,
					prompt: (prompt) => this.ask(prompt, abort.signal),
					notify: (event) => this.notify(event),
				},
				{ getDeviceId: this.getDeviceId },
			);
			this.emit({ type: "done", ok: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.emit({ type: "done", ok: false, error: abort.signal.aborted ? undefined : message });
		} finally {
			if (this.abort === abort) this.abort = undefined;
		}
	}

	answer(id: string, value: string | undefined): void {
		const resolve = this.pending.get(id);
		if (!resolve) return;
		this.pending.delete(id);
		if (value === undefined) this.cancel();
		else resolve(value);
	}

	cancel(): void {
		this.abort?.abort();
		this.pending.clear();
	}

	private ask(prompt: AuthPrompt, signal: AbortSignal): Promise<string> {
		const id = randomUUID();
		return new Promise((resolve, reject) => {
			signal.addEventListener("abort", () => reject(new Error("Login cancelled")), { once: true });
			this.pending.set(id, (value) => resolve(value ?? ""));
			this.emit({
				type: "prompt",
				prompt:
					prompt.type === "select"
						? { id, type: "select", message: prompt.message, options: [...prompt.options] }
						: { id, type: prompt.type, message: prompt.message, placeholder: prompt.placeholder },
			});
		});
	}

	private notify(event: AuthEvent): void {
		if (event.type === "auth_url") {
			this.openUrl(event.url);
			this.emit({ type: "info", message: event.instructions ?? "Continue in your browser.", url: event.url });
		} else if (event.type === "device_code") {
			this.emit({ type: "device_code", code: event.userCode, url: event.verificationUri });
		} else if (event.type === "info") {
			this.emit({ type: "info", message: event.message, url: event.links?.[0]?.url });
		} else {
			this.emit({ type: "info", message: event.message });
		}
	}
}
