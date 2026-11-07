import { type ReactNode, useCallback, useEffect, useState } from "react";
import type { TranscriptImage } from "../../shared/protocol.ts";
import { CloseIcon, DownloadIcon, ExpandIcon, ImageIcon } from "../icons.tsx";
import { attempt, notify, setState, trivium, useStore } from "../store.ts";
import { t } from "../i18n.tsx";

async function save(path: string, image: TranscriptImage): Promise<void> {
	const saved = await attempt(() => trivium.saveImage(path, image.id, image.name));
	if (saved) notify(t("Saved {name}", { name: image.name }), "info");
}

/** A transcript image as a thumbnail; hovering shows Download and Preview. */
export function ImageTile({ image, size = "small" }: { image: TranscriptImage; size?: "small" | "large" }) {
	const path = useStore((s) => s.selected[s.app]);
	if (!path) return null;
	const preview = () => setState({ preview: { path, image } });
	return (
		<div className={`image-tile ${size}`} title={image.name}>
			{image.thumb ? (
				<img src={image.thumb} alt={image.name} onClick={preview} />
			) : (
				<button type="button" className="image-tile-blank" onClick={preview}>
					<ImageIcon size={18} />
					<span className="ellipsis">{image.name}</span>
				</button>
			)}
			<div className="image-tile-actions">
				<button type="button" aria-label={t("Download {name}", { name: image.name })} title={t("Download")} onClick={() => void save(path, image)}>
					<DownloadIcon size={13} />
				</button>
				<button type="button" aria-label={t("Preview {file}", { file: image.name })} title={t("Preview")} onClick={preview}>
					<ExpandIcon size={13} />
				</button>
			</div>
		</div>
	);
}

/** Small images scale up to fill the screen, but no more than this, so they stay sharp enough to read. */
const MAX_ZOOM = 2;

/**
 * An image enlarged over the app: scaled to fit the screen, or at actual size after a click.
 * Esc or the backdrop closes it. Until `src` arrives, `placeholder` shows blurred.
 */
function Lightbox({
	name,
	src,
	placeholder,
	maxZoom = MAX_ZOOM,
	className,
	actions,
	onClose,
}: {
	name: string;
	src: string | undefined;
	placeholder?: string;
	maxZoom?: number;
	className?: string;
	actions?: ReactNode;
	onClose: () => void;
}) {
	const [actual, setActual] = useState(false);
	const [fitWidth, setFitWidth] = useState<number>();
	useEffect(() => {
		setActual(false);
		setFitWidth(undefined);
	}, [src]);
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);
	return (
		<div className="lightbox" role="dialog" aria-modal="true" aria-label={name} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
			<div className="lightbox-bar">
				<span className="ellipsis">{name}</span>
				{actions}
				<button type="button" className="lightbox-btn icon" aria-label={t("Close preview")} onClick={onClose}>
					<CloseIcon size={14} />
				</button>
			</div>
			<div className={`lightbox-stage${actual ? " actual" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
				{src ? (
					<img
						src={src}
						alt={name}
						className={className}
						style={actual || !fitWidth ? undefined : { width: fitWidth }}
						onLoad={(event) => {
							const image = event.currentTarget;
							const stage = image.parentElement!.getBoundingClientRect();
							const scale = Math.min(maxZoom, (stage.width - 48) / image.naturalWidth, (stage.height - 28) / image.naturalHeight);
							setFitWidth(Math.round(image.naturalWidth * scale));
						}}
						onClick={() => setActual(!actual)}
					/>
				) : (
					placeholder && <img src={placeholder} alt="" className="loading" />
				)}
			</div>
		</div>
	);
}

/** The transcript image or drawn diagram open in the lightbox, if any. */
export function ImageLightbox() {
	const preview = useStore((s) => s.preview);
	const diagram = useStore((s) => s.diagram);
	const [src, setSrc] = useState<string>();
	useEffect(() => {
		setSrc(undefined);
		if (!preview) return;
		let current = true;
		void attempt(() => trivium.imageData(preview.path, preview.image.id)).then((data) => current && data && setSrc(data));
		return () => {
			current = false;
		};
	}, [preview]);
	const closePreview = useCallback(() => setState({ preview: undefined }), []);
	const closeDiagram = useCallback(() => setState({ diagram: undefined }), []);
	if (preview) {
		return (
			<Lightbox
				name={preview.image.name}
				src={src}
				placeholder={preview.image.thumb}
				onClose={closePreview}
				actions={
					<button type="button" className="lightbox-btn" onClick={() => void save(preview.path, preview.image)}>
						<DownloadIcon size={14} /> {t("Download")}
					</button>
				}
			/>
		);
	}
	// A diagram is drawn as vectors, so it can be scaled up further than a picture and stay sharp.
	if (diagram) return <Lightbox name={diagram.name} src={diagram.src} maxZoom={3} className="diagram" onClose={closeDiagram} />;
	return null;
}
