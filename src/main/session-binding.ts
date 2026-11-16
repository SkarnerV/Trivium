import { registerRequiredChildExtensions } from "pi-subagents/required-child-extensions";
import type { AppId } from "../shared/protocol.ts";

/** The standalone permission gate children load, built beside main.mjs (scripts/bundles.mjs) and packaged with it. */
export const CHILD_GATE_FILE = "child-permissions.mjs";
export const CHILD_GATE_ID = "trivium-permissions";

/**
 * Binds a session's extensions, with Trivium's permission gate required in every native pi child a Code session
 * starts. Research and Write register nothing: their behavior does not change.
 *
 * The registration is made before binding, since `session_start` may revive detached children, which must find the
 * gate already required. It is made without `requireForAllRunners`: with it, pi-subagents refuses every launch on
 * an external CLI runner or a remote machine (they cannot load an extension), which broke the bundled external
 * agents. They launch as before, under their own tool's permissions.
 *
 * If registering or binding fails, the registration is released and `undo` takes the half-built session apart, so
 * nothing is left registered or listed as live. Returns what releases the registration when the session goes.
 */
export async function bindWithChildGate(options: {
	app: AppId;
	sessionId: string;
	gatePath: string;
	bind: () => Promise<void>;
	undo: () => void;
	register?: typeof registerRequiredChildExtensions;
}): Promise<() => void> {
	const register = options.register ?? registerRequiredChildExtensions;
	let registration: { dispose(): void } | undefined;
	try {
		if (options.app === "code") {
			registration = register({ sessionId: options.sessionId, extensions: [{ id: CHILD_GATE_ID, path: options.gatePath }] });
		}
		await options.bind();
	} catch (error) {
		registration?.dispose();
		options.undo();
		throw error;
	}
	return () => registration?.dispose();
}
