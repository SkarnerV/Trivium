import { randomUUID } from "node:crypto";
import type { ExtensionUIContext, ExtensionUIDialogOptions } from "@earendil-works/pi-coding-agent";
import type { DialogAnswer, DialogRequest, HostEvent } from "../shared/protocol.ts";

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
type DialogInput = DistributiveOmit<DialogRequest, "id" | "sessionPath">;

interface Pending {
	sessionPath: string;
	resolve: (answer: DialogAnswer | undefined) => void;
}

/** Routes extension dialogs (select, confirm, input, editor) to the renderer and back. */
export class DialogBroker {
	private pending = new Map<string, Pending>();
	private emit: (event: HostEvent) => void;

	constructor(emit: (event: HostEvent) => void) {
		this.emit = emit;
	}

	ask(sessionPath: string, input: DialogInput, opts?: ExtensionUIDialogOptions): Promise<DialogAnswer | undefined> {
		if (opts?.signal?.aborted) return Promise.resolve(undefined);
		const id = randomUUID();
		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (answer: DialogAnswer | undefined) => {
				if (!this.pending.delete(id)) return;
				if (timer) clearTimeout(timer);
				opts?.signal?.removeEventListener("abort", onAbort);
				this.emit({ type: "dialog_closed", id });
				resolve(answer);
			};
			const onAbort = () => finish(undefined);
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) timer = setTimeout(() => finish(undefined), opts.timeout);
			this.pending.set(id, { sessionPath, resolve: finish });
			this.emit({ type: "dialog", request: { ...input, id, sessionPath } as DialogRequest });
		});
	}

	answer(id: string, answer: DialogAnswer): void {
		this.pending.get(id)?.resolve(answer);
	}

	cancelAll(sessionPath?: string): void {
		for (const [, pending] of this.pending) {
			if (!sessionPath || pending.sessionPath === sessionPath) pending.resolve(undefined);
		}
	}
}

const valueOf = (answer: DialogAnswer | undefined) => (answer && "value" in answer ? answer.value : undefined);

// Extensions may format text with the TUI theme. The desktop shows plain text, so every style call is a no-op.
const plainTheme = new Proxy(
	{},
	{ get: () => (...args: unknown[]) => args.find((arg) => typeof arg === "string") ?? "" },
) as ExtensionUIContext["theme"];

/** The UI surface handed to extensions. TUI-only hooks are accepted and ignored. */
export function createUiContext(
	broker: DialogBroker,
	sessionPath: () => string,
	notify: (message: string, level: "info" | "warning" | "error") => void,
): ExtensionUIContext {
	let editorText = "";
	return {
		select: async (title, options, opts) =>
			valueOf(await broker.ask(sessionPath(), { kind: "select", title, options }, opts)),
		confirm: async (title, message, opts) => {
			const answer = await broker.ask(sessionPath(), { kind: "confirm", title, message }, opts);
			return Boolean(answer && "confirmed" in answer && answer.confirmed);
		},
		input: async (title, placeholder, opts) =>
			valueOf(await broker.ask(sessionPath(), { kind: "input", title, placeholder }, opts)),
		editor: async (title, prefill) => valueOf(await broker.ask(sessionPath(), { kind: "editor", title, prefill })),
		notify: (message, type) => notify(message, type ?? "info"),
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: (text) => {
			editorText += text;
		},
		setEditorText: (text) => {
			editorText = text;
		},
		getEditorText: () => editorText,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return plainTheme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "Themes are not supported in the desktop app" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}
