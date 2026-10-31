import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { getLocale, resolveLocale, setLocale, t, TABLES } from "../src/shared/i18n.ts";
import { EXPOSURES } from "../src/shared/connectors.ts";
import { PERMISSION_MODES } from "../src/shared/permissions.ts";
import { RECOMMENDED } from "../src/shared/recommended.ts";

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) return entry.name === "locales" ? [] : sources(path);
		return /\.tsx?$/.test(entry.name) ? [path] : [];
	});
}

/**
 * Every string a t() or tx() call can look up: the literals its first argument can evaluate to, such as both
 * sides of `t(open ? "Hide" : "Show")`, but not the ones it only compares against.
 */
function keysInSource(): Map<string, string> {
	const keys = new Map<string, string>();
	for (const file of sources(SRC)) {
		const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
		const collect = (node: ts.Node, where: string): void => {
			if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
				if (node.text) keys.set(node.text, where);
			} else if (ts.isParenthesizedExpression(node)) collect(node.expression, where);
			else if (ts.isConditionalExpression(node)) {
				collect(node.whenTrue, where);
				collect(node.whenFalse, where);
			} else if (ts.isBinaryExpression(node) && (node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || node.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
				collect(node.left, where);
				collect(node.right, where);
			} else if (ts.isElementAccessExpression(node)) collect(node.expression, where);
			else if (ts.isObjectLiteralExpression(node)) {
				for (const property of node.properties) if (ts.isPropertyAssignment(property)) collect(property.initializer, where);
			}
		};
		const visit = (node: ts.Node) => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === "t" || node.expression.text === "tx") && node.arguments[0]) {
				const { line } = source.getLineAndCharacterOfPosition(node.getStart());
				collect(node.arguments[0], `${file.slice(SRC.length + 1)}:${line + 1}`);
			}
			ts.forEachChild(node, visit);
		};
		visit(source);
	}
	return keys;
}

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();

test("every text the code translates has a translation in each language", () => {
	const missing: string[] = [];
	for (const [key, where] of keysInSource()) {
		for (const [locale, table] of Object.entries(TABLES)) if (!(key in table)) missing.push(`${locale}: ${JSON.stringify(key)} (${where})`);
	}
	assert.deepEqual(missing, []);
});

test("text the shared lists hand to t() has a translation in each language", () => {
	const texts = [
		...EXPOSURES.flatMap((entry) => [entry.label, entry.hint]),
		...PERMISSION_MODES.flatMap((mode) => [mode.label, mode.hint]),
		...Object.values(RECOMMENDED).flatMap((list) => list.flatMap((item) => [item.adds, item.why, ...(item.note ? [item.note] : [])])),
	];
	for (const [locale, table] of Object.entries(TABLES)) {
		assert.deepEqual(texts.filter((text) => !(text in table)), [], locale);
	}
});

test("the languages translate the same texts, with the same placeholders", () => {
	const [first, ...rest] = Object.entries(TABLES);
	for (const [locale, table] of rest) assert.deepEqual(Object.keys(table).sort(), Object.keys(first![1]).sort(), `${locale} and ${first![0]}`);
	for (const [locale, table] of Object.entries(TABLES)) {
		for (const [key, value] of Object.entries(table)) {
			assert.deepEqual(placeholders(value), placeholders(key), `${locale}: ${JSON.stringify(key)}`);
			assert.ok(value.trim(), `${locale}: ${JSON.stringify(key)} is empty`);
		}
	}
});

test("the system's language picks a translation, or English when Trivium has none", () => {
	assert.equal(resolveLocale("system", ["zh-CN", "en-US"]), "zh-CN");
	assert.equal(resolveLocale("system", ["zh-TW"]), "zh-CN");
	assert.equal(resolveLocale("system", ["ja-JP"]), "ja");
	assert.equal(resolveLocale("system", ["fr-FR", "ja"]), "ja");
	assert.equal(resolveLocale("system", ["en-GB", "ja"]), "en");
	assert.equal(resolveLocale("system", ["de-DE"]), "en");
	assert.equal(resolveLocale(undefined, []), "en");
	assert.equal(resolveLocale("ja", ["zh-CN"]), "ja");
});

test("t() fills placeholders and falls back to English", () => {
	const before = getLocale();
	try {
		setLocale("ja");
		assert.equal(t("{n} files", { n: 3 }), "3 個のファイル");
		assert.equal(t("Text nobody translated, {name}", { name: "x" }), "Text nobody translated, x");
		setLocale("en");
		assert.equal(t("{n} files", { n: 3 }), "3 files");
	} finally {
		setLocale(before);
	}
});
