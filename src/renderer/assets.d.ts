// esbuild loads SVG files as their text.
declare module "*.svg" {
	const svg: string;
	export default svg;
}
