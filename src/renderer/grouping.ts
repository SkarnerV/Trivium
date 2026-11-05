import { t } from "../shared/i18n.ts";
import type { SessionSummary } from "../shared/protocol.ts";
import { baseName } from "./format.ts";

export interface WorkspaceGroup {
	cwd: string;
	name: string;
	/** Conversations started without a project. */
	chat: boolean;
	sessions: SessionSummary[];
}

/** Sessions by the folder they ran in. Workspaces come in the order their first session does, and sessions keep theirs. */
export function byWorkspace(sessions: SessionSummary[]): WorkspaceGroup[] {
	const groups = new Map<string, WorkspaceGroup>();
	for (const session of sessions) {
		let group = groups.get(session.cwd);
		if (!group) {
			group = {
				cwd: session.cwd,
				name: session.chat ? t("Chats") : baseName(session.cwd) || t("No project"),
				chat: session.chat,
				sessions: [],
			};
			groups.set(session.cwd, group);
		}
		group.sessions.push(session);
	}
	return [...groups.values()];
}
