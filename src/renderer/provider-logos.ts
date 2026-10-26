// Logos for pi's providers, keyed by provider ID. See src/assets/providers/NOTICE.md for where they come from.
import antgroup from "../assets/providers/antgroup-color.svg";
import anthropic from "../assets/providers/anthropic.svg";
import azure from "../assets/providers/azure-color.svg";
import baseten from "../assets/providers/baseten.svg";
import bedrock from "../assets/providers/bedrock-color.svg";
import cerebras from "../assets/providers/cerebras-color.svg";
import cloudflare from "../assets/providers/cloudflare-color.svg";
import codex from "../assets/providers/codex-color.svg";
import deepseek from "../assets/providers/deepseek-color.svg";
import fireworks from "../assets/providers/fireworks-color.svg";
import githubcopilot from "../assets/providers/githubcopilot.svg";
import google from "../assets/providers/google-color.svg";
import groq from "../assets/providers/groq.svg";
import huggingface from "../assets/providers/huggingface-color.svg";
import kimi from "../assets/providers/kimi-color.svg";
import lmstudio from "../assets/providers/lmstudio.svg";
import meta from "../assets/providers/meta-color.svg";
import minimax from "../assets/providers/minimax-color.svg";
import mistral from "../assets/providers/mistral-color.svg";
import moonshot from "../assets/providers/moonshot.svg";
import nvidia from "../assets/providers/nvidia-color.svg";
import ollama from "../assets/providers/ollama.svg";
import openai from "../assets/providers/openai.svg";
import opencode from "../assets/providers/opencode.svg";
import openrouter from "../assets/providers/openrouter.svg";
import qwen from "../assets/providers/qwen-color.svg";
import together from "../assets/providers/together-color.svg";
import vercel from "../assets/providers/vercel.svg";
import vertexai from "../assets/providers/vertexai-color.svg";
import vllm from "../assets/providers/vllm-color.svg";
import workersai from "../assets/providers/workersai-color.svg";
import xai from "../assets/providers/xai.svg";
import xiaomimimo from "../assets/providers/xiaomimimo.svg";
import zai from "../assets/providers/zai.svg";

const BY_ID: Record<string, string> = {
	"amazon-bedrock": bedrock,
	"ant-ling": antgroup,
	anthropic,
	azure,
	baseten,
	cerebras,
	"cloudflare-ai-gateway": cloudflare,
	"cloudflare-workers-ai": workersai,
	deepseek,
	fireworks,
	"github-copilot": githubcopilot,
	google,
	"google-vertex": vertexai,
	groq,
	huggingface,
	"kimi-coding": kimi,
	meta,
	minimax,
	"minimax-cn": minimax,
	mistral,
	moonshotai: moonshot,
	"moonshotai-cn": moonshot,
	nvidia,
	openai,
	"openai-codex": codex,
	opencode,
	"opencode-go": opencode,
	openrouter,
	"qwen-token-plan": qwen,
	"qwen-token-plan-cn": qwen,
	"qwen-token-plan-individual": qwen,
	together,
	"vercel-ai-gateway": vercel,
	xai,
	xiaomi: xiaomimimo,
	"xiaomi-token-plan-ams": xiaomimimo,
	"xiaomi-token-plan-cn": xiaomimimo,
	"xiaomi-token-plan-sgp": xiaomimimo,
	zai,
	"zai-coding-cn": zai,
};

/** Local servers people add as custom endpoints, recognised by a word in the endpoint's ID or name. */
const LOCAL: [RegExp, string][] = [
	[/ollama/i, ollama],
	[/lm ?studio/i, lmstudio],
	[/vllm/i, vllm],
];

const urls = new Map<string, string>();

/** A data URL of the provider's logo, or undefined when Trivium has none. */
export function providerLogo(id: string, name = ""): string | undefined {
	const svg = BY_ID[id] ?? LOCAL.find(([pattern]) => pattern.test(id) || pattern.test(name))?.[1];
	if (!svg) return undefined;
	let url = urls.get(svg);
	if (!url) {
		url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
		urls.set(svg, url);
	}
	return url;
}
