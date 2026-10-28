export const IS_MAC = navigator.userAgent.includes("Mac");
export const IS_WINDOWS = navigator.userAgent.includes("Windows");

/** The key Trivium's shortcuts are pressed with: ⌘ on macOS, Ctrl elsewhere. */
export const commandKey = (event: { metaKey: boolean; ctrlKey: boolean }) => (IS_MAC ? event.metaKey : event.ctrlKey);

/** Keys are written with macOS's symbols; elsewhere they go by their names. */
const NAMES: Record<string, string> = { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift", "↵": "Enter", esc: "Esc", tab: "Tab", home: "Home", end: "End" };

/** A key as this platform writes it. */
export const keyName = (key: string) => (IS_MAC ? key : (NAMES[key] ?? key));

/** Keys pressed together, as written in running text: ⌥↵ on macOS, Alt+Enter elsewhere. */
export const keyCombo = (keys: string[]) => (IS_MAC ? keys.join("") : keys.map(keyName).join("+"));
