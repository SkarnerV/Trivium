import type { AppId } from "./protocol.ts";

export interface Recommendation {
	/** npm package name; installed as "npm:<name>". */
	name: string;
	/** What it adds, in the user's terms. */
	adds: string;
	/** Why it suits this app. */
	why: string;
	/** What works differently in Trivium, or what installing it does, when that matters. */
	note?: string;
	/** Ships with Trivium and loads in this app unless removed. */
	builtIn?: true;
}

/**
 * pi gallery packages suited to each app, checked against their source: each is an MIT-licensed pi package,
 * and what it relies on works in Trivium unless the note says otherwise. Built-in ones are Trivium dependencies,
 * pinned in package.json; the rest install from npm when chosen.
 */
export const RECOMMENDED: Record<AppId, Recommendation[]> = {
	code: [
		{
			name: "@gotgenes/pi-permission-system",
			builtIn: true,
			adds: "Allow, ask or deny rules for tools, bash commands and file paths",
			why: "Code runs bash and edits files without asking. This asks first for what you choose and blocks files like .env.",
			note: "Starts with a policy that blocks .env files and asks before rm -rf, sudo, git push and folders outside the project. Edit it in ~/.pi/agent/extensions/pi-permission-system/config.json.",
		},
		{
			name: "@pify/memory",
			builtIn: true,
			adds: "memory_write, memory_search, memory_read and /memory",
			why: "Remembers how each project builds and runs, and the corrections you give, across sessions.",
			note: "Keeps each project's memory in .pi/memory/MEMORY.md, and asks once per project before loading it. Refuses to save secrets.",
		},
		{
			name: "pi-lens",
			adds: "Type-checking, linters and language-server diagnostics after each edit",
			why: "The agent sees the errors its edits caused right away, instead of finishing with broken code.",
			note: "A large download, about 25 MB.",
		},
		{
			name: "@narumitw/pi-plan-mode",
			builtIn: true,
			adds: "A read-only /plan mode",
			why: "Agree on an approach before any file changes, then implement it in this session or a fresh one.",
			note: "Its status indicator doesn't show in Trivium; /plan itself works.",
		},
		{
			name: "pi-subagents",
			builtIn: true,
			adds: "A subagent tool with scout, reviewer and researcher agents",
			why: "Hands side tasks such as exploring the codebase or reviewing a change to a separate agent, keeping this session's context focused.",
			note: "Its live progress widget doesn't show in Trivium.",
		},
		{
			name: "pi-simplify",
			adds: "A /simplify review of uncommitted, staged or chosen changes",
			why: "Checks recent changes for clarity and consistency before you keep them.",
		},
	],
	research: [
		{
			name: "pi-web-access",
			adds: "web_search, fetch_content, PDF extraction, GitHub cloning and YouTube understanding",
			why: "Research can't reach the web on its own. This is the gallery's most used web package.",
		},
		{
			name: "pi-web-search",
			adds: "web_search and url_context through your model provider",
			why: "A lighter alternative: uses your provider's own search, so it needs no extra API key.",
		},
		{
			name: "pi-docparser",
			builtIn: true,
			adds: "document_parse, document_search and document_screenshot",
			why: "Reads and searches the PDFs and documents you already have, locally.",
		},
		{
			name: "@pify/memory",
			builtIn: true,
			adds: "memory_write, memory_search, memory_read and /memory",
			why: "Keeps findings across sessions, with search, so last week's research can be found again.",
			note: "Keeps global memory in ~/.pi/agent/memory and each project's in .pi/memory/MEMORY.md.",
		},
		{
			name: "pi-subagents",
			builtIn: true,
			adds: "A subagent tool with researcher and evidence-auditor agents",
			why: "Investigates several questions in parallel and checks that claims are backed by their sources.",
			note: "Its researcher needs a web package such as pi-web-access. Live progress doesn't show in Trivium.",
		},
	],
	write: [
		{
			name: "@pify/memory",
			builtIn: true,
			adds: "memory_write, memory_search, memory_read and /memory",
			why: "Remembers your style, terms and the corrections you give, across documents and sessions.",
			note: "Shares memory with Code and Research. Keeps each project's in .pi/memory/MEMORY.md.",
		},
		{
			name: "pi-web-search",
			adds: "web_search and url_context through your model provider",
			why: "Fact-checking while writing, with no extra API key.",
		},
		{
			name: "pi-quiver",
			adds: "doc_to_md, which turns PDF, DOCX and PPTX into Markdown",
			why: "Brings existing drafts into Markdown, where Write's Review panel can mark each change.",
			note: "A personal toolkit that also adds Slack and fetch tools.",
		},
		{
			name: "pi-markdown-preview",
			builtIn: true,
			adds: "/preview-pdf and /preview-browser, with LaTeX",
			why: "Exports a finished piece to PDF.",
			note: "PDF export needs Pandoc and LaTeX installed.",
		},
		{
			name: "@narumitw/pi-plan-mode",
			adds: "A read-only /plan mode",
			why: "Outline and agree on structure before the agent starts editing the document.",
			note: "Its status indicator doesn't show in Trivium; /plan itself works.",
		},
	],
};

/** Packages Trivium ships for an app, by npm name. */
export const builtInPackages = (app: AppId): string[] => RECOMMENDED[app].filter((item) => item.builtIn).map((item) => item.name);
