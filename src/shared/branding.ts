import type { AppId } from "./protocol.ts";

export function appIconFilename(app: AppId, extension: "png" | "ico" = "png"): string {
	return `trivium-icon${app === "code" ? "" : `-${app}`}.${extension}`;
}
