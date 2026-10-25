import type { AppId } from "./protocol.ts";

// Keep this stable: Explorer caches taskbar branding by application identity.
export const APP_USER_MODEL_ID = "com.coresmos.trivium.desktop";
export const LEGACY_APP_USER_MODEL_IDS: readonly string[] = ["com.coresmos.trivium"];

export function appIconFilename(app: AppId, extension: "png" | "ico" = "png"): string {
	return `trivium-icon${app === "code" ? "" : `-${app}`}.${extension}`;
}
