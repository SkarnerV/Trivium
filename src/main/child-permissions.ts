import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_PERMISSION_MODE, isPermissionMode, type PermissionModeId } from "../shared/permissions.ts";
import { decide, noApprovals } from "./permission-gate.ts";

/**
 * Detached children have no host closure; settings are read afresh for every tool call. A profile that has saved
 * no setting yet has no file, and runs in the default mode as the main agent does. A file that cannot be read or
 * parsed fails closed.
 */
export function permissionModeFromDisk(file: string): PermissionModeId {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? DEFAULT_PERMISSION_MODE : "ask";
	}
	try {
		const value = JSON.parse(text).permissionMode;
		return isPermissionMode(value) ? value : DEFAULT_PERMISSION_MODE;
	} catch {
		return "ask";
	}
}

export default function childPermissions(pi: ExtensionAPI) {
	pi.on("tool_call", (event, ctx) => {
		const file = join(process.env.TRIVIUM_HOME ?? join(homedir(), ".trivium"), "settings.json");
		const decision = decide(permissionModeFromDisk(file), event.toolName, event.input as Record<string, unknown>, ctx.cwd, noApprovals());
		if (decision.action === "allow") return undefined;
		return { block: true, reason: decision.action === "deny" ? decision.reason : "Blocked: this needs the user's approval, and no one can answer here." };
	});
}
