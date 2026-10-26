import { useEffect, useState } from "react";
import type { TranscriptImage } from "../../shared/protocol.ts";
import { CloseIcon, DownloadIcon, ExpandIcon, ImageIcon } from "../icons.tsx";
import { attempt, notify, setState, trivium, useStore } from "../store.ts";

async function save(path: string, image: TranscriptImage): Promise<void> {
	const saved = await attempt(() => trivium.saveImage(path, image.id, image.name));
	if (saved) notify(`Saved ${image.name}`, "info");
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
				<button type="button" aria-label={`Download ${image.name}`} title="Download" onClick={() => void save(path, image)}>
					<DownloadIcon size={13} />
				</button>
				<button type="button" aria-label={`Preview ${image.name}`} title="Preview" onClick={preview}>
					<ExpandIcon size={13} />
				</button>
			</div>
		</div>
	);
}

/** Small images scale up to fill the screen, but no more than this, so they stay sharp enough to read. */
const MAX_ZOOM = 2;

/**
 * The image enlarged over the app: scaled to fit the screen, or at actual size after a click.
 * Esc or the backdrop closes it.
 */
export function ImageLightbox() {
	const preview = useStore((s) => s.preview);
	const [src, setSrc] = useState<string>();
	const [actual, setActual] = useState(false);
	const [fitWidth, setFitWidth] = useState<number>();
	useEffect(() => {
		setSrc(undefined);
		setActual(false);
		setFitWidth(undefined);
		if (!preview) return;
		let current = true;
		void attempt(() => trivium.imageData(preview.path, preview.image.id)).then((data) => current && data && setSrc(data));
		const onKey = (event: KeyboardEvent) => event.key === "Escape" && setState({ preview: undefined });
		window.addEventListener("keydown", onKey);
		return () => {
			current = false;
			window.removeEventListener("keydown", onKey);
		};
	}, [preview]);
	if (!preview) return null;
	const close = () => setState({ preview: undefined });
	return (
		<div className="lightbox" role="dialog" aria-modal="true" aria-label={preview.image.name} onMouseDown={(event) => event.target === event.currentTarget && close()}>
			<div className="lightbox-bar">
				<span className="ellipsis">{preview.image.name}</span>
				<button type="button" className="lightbox-btn" onClick={() => void save(preview.path, preview.image)}>
					<DownloadIcon size={14} /> Download
				</button>
				<button type="button" className="lightbox-btn icon" aria-label="Close preview" onClick={close}>
					<CloseIcon size={14} />
				</button>
			</div>
			<div className={`lightbox-stage${actual ? " actual" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && close()}>
				{src ? (
					<img
						src={src}
						alt={preview.image.name}
						style={actual || !fitWidth ? undefined : { width: fitWidth }}
						onLoad={(event) => {
							const image = event.currentTarget;
							const stage = image.parentElement!.getBoundingClientRect();
							const scale = Math.min(MAX_ZOOM, (stage.width - 48) / image.naturalWidth, (stage.height - 28) / image.naturalHeight);
							setFitWidth(Math.round(image.naturalWidth * scale));
						}}
						onClick={() => setActual(!actual)}
					/>
				) : (
					preview.image.thumb && <img src={preview.image.thumb} alt="" className="loading" />
				)}
			</div>
		</div>
	);
}
