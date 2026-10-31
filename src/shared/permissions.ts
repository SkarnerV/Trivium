/**
 * Code's permission modes, which Trivium's own gate enforces. Each hint is the whole rule: the gate asks about
 * nothing a hint doesn't name, and every mode blocks .env files.
 */

export type PermissionModeId = "ask" | "edits" | "auto" | "bypass";

export interface PermissionMode {
	id: PermissionModeId;
	label: string;
	hint: string;
}

export const PERMISSION_MODES: PermissionMode[] = [
	{
		id: "ask",
		label: "Always ask",
		hint: "Asks before each edit, each command and anything outside the project. Reading the project and commands that only read, like ls or git status, run without asking.",
	},
	{
		id: "edits",
		label: "Accept edits",
		hint: "Edits files in the project without asking. Asks before commands, except ones that only read, and before anything outside the project.",
	},
	{
		id: "auto",
		label: "Approve for me",
		hint: "Runs most things itself. Asks before rm -r, sudo and git push, and before changing files outside the project.",
	},
	{
		id: "bypass",
		label: "Bypass permissions",
		hint: "Runs everything without asking. .env files stay blocked.",
	},
];

export const DEFAULT_PERMISSION_MODE: PermissionModeId = "auto";

export const isPermissionMode = (value: unknown): value is PermissionModeId => PERMISSION_MODES.some((mode) => mode.id === value);
