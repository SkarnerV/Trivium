import type { GitHistoryCommit } from "../shared/protocol.ts";

/** How many colors the graph cycles through; styles.css has one for each. */
export const GRAPH_COLORS = 6;

/** A line in the graph: which column it is in, and which color it is drawn. */
export interface GraphLine {
	lane: number;
	color: number;
}

/** One commit's row of the graph. */
export interface GraphRow {
	/** The column the commit's dot is in. */
	lane: number;
	color: number;
	/** Lines from the row above that end at this commit. */
	into: GraphLine[];
	/** Lines running straight past it, to commits further down. */
	through: GraphLine[];
	/** Lines from this commit down to its parents. */
	out: GraphLine[];
}

export interface Graph {
	rows: GraphRow[];
	/** Columns the widest row needs. */
	lanes: number;
}

/**
 * Places commits, listed children first, in columns. A column holds the line to one commit it is waiting for. A
 * first parent stays in its child's column even when another column is waiting for it too, so a branch runs down
 * to the commit it forked from and joins there; a merge's other parents share a column that already leads to them.
 */
export function layoutGraph(commits: Pick<GitHistoryCommit, "id" | "parents">[]): Graph {
	const columns: ({ id: string; color: number } | undefined)[] = [];
	const rows: GraphRow[] = [];
	let colors = 0;
	let lanes = 0;
	const nextColor = () => colors++ % GRAPH_COLORS;
	const freeColumn = () => {
		const free = columns.findIndex((column) => !column);
		return free < 0 ? columns.length : free;
	};
	for (const commit of commits) {
		const into: GraphLine[] = [];
		columns.forEach((column, lane) => {
			if (column?.id !== commit.id) return;
			into.push({ lane, color: column.color });
			columns[lane] = undefined;
		});
		const lane = into[0]?.lane ?? freeColumn();
		const color = into[0]?.color ?? nextColor();
		const through = columns.flatMap((column, at) => (column ? [{ lane: at, color: column.color }] : []));
		const out: GraphLine[] = [];
		commit.parents.forEach((parent, index) => {
			if (index === 0) {
				columns[lane] = { id: parent, color };
				out.push({ lane, color });
				return;
			}
			const existing = columns.findIndex((column) => column?.id === parent);
			if (existing >= 0) {
				out.push({ lane: existing, color: columns[existing]!.color });
				return;
			}
			const at = freeColumn();
			const merged = nextColor();
			columns[at] = { id: parent, color: merged };
			out.push({ lane: at, color: merged });
		});
		lanes = Math.max(lanes, lane + 1, columns.length);
		rows.push({ lane, color, into, through, out });
	}
	return { rows, lanes };
}

/** The lines still running below a row, which the space under an open commit has to carry on. */
export function linesBelow(row: GraphRow): GraphLine[] {
	const seen = new Set(row.through.map((line) => line.lane));
	return [...row.through, ...row.out.filter((line) => !seen.has(line.lane))];
}
