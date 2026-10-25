import type { ReactNode } from "react";
import type { AppId } from "../shared/protocol.ts";

function Svg({ size = 16, width = 2, children }: { size?: number; width?: number; children: ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={width}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			{children}
		</svg>
	);
}

type IconProps = { size?: number; width?: number };

export const CodeIcon = (p: IconProps) => (
	<Svg width={2.4} {...p}>
		<path d="m8 7-5 5 5 5" />
		<path d="m16 7 5 5-5 5" />
	</Svg>
);
export const SearchIcon = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="11" cy="11" r="7" />
		<path d="m20 20-3.5-3.5" />
	</Svg>
);
export const PenIcon = (p: IconProps) => (
	<Svg width={2.4} {...p}>
		<path d="M12 20h9" />
		<path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
	</Svg>
);
export const PlusIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M12 5v14" />
		<path d="M5 12h14" />
	</Svg>
);
export const PanelIcon = (p: IconProps) => (
	<Svg {...p}>
		<rect x="3" y="4" width="18" height="16" rx="2.5" />
		<path d="M9 4v16" />
	</Svg>
);
export const GearIcon = (p: IconProps) => (
	<Svg {...p}>
		<circle cx="12" cy="12" r="3" />
		<path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
	</Svg>
);
export const CloseIcon = (p: IconProps) => (
	<Svg width={2.4} {...p}>
		<path d="M6 6l12 12" />
		<path d="M18 6 6 18" />
	</Svg>
);
export const Chevron = ({ open, size = 12, down = false }: { open: boolean; size?: number; down?: boolean }) => (
	<Svg size={size} width={2.4}>
		<path d={open ? (down ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6") : down ? "m6 9 6 6 6-6" : "m9 6 6 6-6 6"} />
	</Svg>
);
export const TrashIcon = (p: IconProps) => (
	<Svg size={13} {...p}>
		<path d="M4 7h16" />
		<path d="M10 11v6" />
		<path d="M14 11v6" />
		<path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
		<path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
	</Svg>
);
export const BackIcon = (p: IconProps) => (
	<Svg size={14} width={2.2} {...p}>
		<path d="m15 18-6-6 6-6" />
	</Svg>
);
export const SteerIcon = (p: IconProps) => (
	<Svg width={2.2} size={13} {...p}>
		<path d="M4 6h10a5 5 0 0 1 0 10H8" />
		<path d="m11 19-3-3 3-3" />
	</Svg>
);
export const QueueIcon = (p: IconProps) => (
	<Svg width={2.2} size={13} {...p}>
		<path d="M4 7h16" />
		<path d="M4 12h16" />
		<path d="M4 17h10" />
	</Svg>
);
export const FolderIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
	</Svg>
);
export const FolderOpenIcon = (p: IconProps) => (
	<Svg {...p}>
		<path d="M3 18V6a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v2" />
		<path d="M3 18l2.4-6.6A2 2 0 0 1 7.3 10H21a1 1 0 0 1 .95 1.3l-2 6.3A2 2 0 0 1 18 19H4a1 1 0 0 1-1-1z" />
	</Svg>
);
export const WarnIcon = (p: IconProps) => (
	<Svg width={2.4} size={12} {...p}>
		<path d="M12 3 2 21h20z" />
		<path d="M12 10v5" />
		<path d="M12 18h.01" />
	</Svg>
);
export const ExternalIcon = (p: IconProps) => (
	<Svg size={14} {...p}>
		<path d="M14 4h6v6" />
		<path d="M20 4 10 14" />
		<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
	</Svg>
);
export const SendIcon = () => (
	<Svg size={14} width={2.6}>
		<path d="M12 19V5" />
		<path d="m5 12 7-7 7 7" />
	</Svg>
);
export const StopIcon = () => (
	<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
		<rect width="10" height="10" rx="2" fill="currentColor" />
	</svg>
);

export function AppIcon({ app, size = 14 }: { app: AppId; size?: number }) {
	if (app === "research") return <SearchIcon size={size} width={2.4} />;
	if (app === "write") return <PenIcon size={size} />;
	return <CodeIcon size={size} />;
}
