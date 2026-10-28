/**
 * Levels for pi-permission-system's policy, which Code's settings write to its config file. Each keeps .env files
 * blocked; they differ in what asks first. A policy that matches none of them is the user's own and shows as custom.
 */

type Action = "allow" | "ask" | "deny";
export type PermissionPolicy = Record<string, Action | Record<string, Action>>;

export interface PermissionLevel {
	id: string;
	label: string;
	hint: string;
	permission: PermissionPolicy;
}

const ENV_BLOCKED = { "*": "allow", "*.env": "deny", "*.env.*": "deny", "*.env.example": "allow" } as const;

export const PERMISSION_LEVELS: PermissionLevel[] = [
	{
		id: "ask",
		label: "Always ask",
		hint: "Asks before each shell command, each file it edits or writes, and folders outside the project",
		permission: { "*": "allow", path: ENV_BLOCKED, bash: "ask", edit: "ask", write: "ask", external_directory: "ask" },
	},
	{
		id: "auto",
		label: "Approve for me",
		hint: "Runs most things itself; asks before rm -rf, sudo, git push and folders outside the project",
		permission: {
			"*": "allow",
			path: ENV_BLOCKED,
			bash: { "*": "allow", "rm -rf *": "ask", "sudo *": "ask", "git push": "ask", "git push *": "ask" },
			external_directory: "ask",
		},
	},
	{
		id: "bypass",
		label: "Bypass permissions",
		hint: "Runs everything without asking; .env files stay blocked",
		permission: { "*": "allow", path: ENV_BLOCKED, external_directory: "allow" },
	},
];

export const DEFAULT_PERMISSION_LEVEL = PERMISSION_LEVELS.find((level) => level.id === "auto")!;

/** Key order doesn't change a rule set's meaning, except within a surface, where the last match wins. */
function sameRules(a: unknown, b: unknown): boolean {
	if (typeof a !== "object" || typeof b !== "object" || !a || !b) return a === b;
	const left = Object.entries(a);
	const right = Object.entries(b);
	return left.length === right.length && left.every(([key, value], index) => right[index]?.[0] === key && sameRules(value, right[index]?.[1]));
}

function sameSurfaces(a: object, b: object): boolean {
	const keys = Object.keys(a);
	return keys.length === Object.keys(b).length && keys.every((key) => key in b && sameRules(a[key as keyof typeof a], b[key as keyof typeof b]));
}

/** Which level a config sets, or undefined when it is the user's own policy or turns on yolo mode. */
export function permissionLevelOf(config: { permission?: unknown; yoloMode?: unknown }): PermissionLevel | undefined {
	if (config.yoloMode === true || typeof config.permission !== "object" || !config.permission) return undefined;
	return PERMISSION_LEVELS.find((level) => sameSurfaces(level.permission, config.permission as object));
}

/** The config with a level's policy, keeping the user's other settings. Yolo mode would approve every ask, so it goes. */
export function withPermissionLevel(config: Record<string, unknown>, level: PermissionLevel): Record<string, unknown> {
	const { yoloMode: _yolo, ...rest } = config;
	return { ...rest, permission: level.permission };
}
