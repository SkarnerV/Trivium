/** Where pi's package gallery lists packages; a page's path is the npm package name. */
export const PACKAGE_GALLERY = "https://pi.dev/packages";

/**
 * Turns what the user typed into a pi package source: a gallery link or a bare npm name becomes "npm:…",
 * "host/owner/repo" becomes "git:…", and sources pi already understands pass through unchanged.
 */
export function packageSource(input: string): string {
	const text = input.trim();
	if (!text) throw new Error("Enter an npm package, a git repository or a URL.");
	const gallery = /^https?:\/\/(?:www\.)?pi\.dev\/packages\/((?:@[^/\s]+\/)?[^/\s?#]+)\/?(?:[?#].*)?$/i.exec(text);
	if (gallery) return `npm:${decodeURIComponent(gallery[1]!)}`;
	if (/^(?:npm:|git:|https?:\/\/|ssh:\/\/|git@)/i.test(text)) return text;
	if (/^[a-z0-9.-]+\.[a-z]{2,}\/[\w.-]+\/[\w.-]+/i.test(text)) return `git:${text}`;
	if (/^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:@[\w.^~<>=*|+ -]+)?$/i.test(text)) return `npm:${text}`;
	throw new Error(`"${text}" is not an npm package, a git repository or a URL.`);
}
