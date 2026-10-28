import { sentences, t } from "../shared/i18n.ts";
import type { LimitNotice } from "../shared/protocol.ts";

/**
 * Explains a provider's usage-limit, quota or balance error in plain words, with where to check or top up.
 * Providers word these for developers ("Ask the user to try again…") or bury them in JSON; the original
 * stays available as the notice's detail. Unrecognized errors return undefined and show as they are.
 */

const pick = () => t("Pick another model to keep going.");

interface Body {
	code: string;
	type: string;
	message: string;
}

/** The error object in a provider's JSON body, when the message carries one, as in `429: {"error": {…}}`. */
function bodyOf(text: string): Body {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
			const error = (parsed.error && typeof parsed.error === "object" ? parsed.error : parsed) as Record<string, unknown>;
			return {
				code: error.code === undefined ? "" : String(error.code),
				type: typeof error.type === "string" ? error.type : "",
				message: typeof error.message === "string" ? error.message : "",
			};
		} catch {
			// Not JSON after all; the text alone decides.
		}
	}
	return { code: "", type: "", message: "" };
}

/** The HTTP status at the start of the message: "402 Insufficient Balance", "429: {…}" or "OpenAI API error (429): …". */
function statusOf(text: string): number | undefined {
	const match = /^[^\d{]{0,40}?\b([1-5]\d\d)\b/.exec(text);
	return match ? Number(match[1]) : undefined;
}

function resetsIn(minutes: number): string {
	if (minutes < 2) return t("It resets in a minute or so.");
	if (minutes < 90) return t("It resets in about {n} minutes.", { n: minutes });
	return t("It resets in about {n} hours.", { n: Math.round(minutes / 60) });
}

/** `seen` is the text plus the JSON error type, which some providers name the limit with. */
function chatgpt(text: string, seen: string): LimitNotice | undefined {
	if (/subscription_sharing_workplace_individual_usage_limit_exceeded|workspace's usage limit/i.test(seen)) {
		return {
			message: sentences(t("You've reached the ChatGPT usage limit your workspace admin set. Only an admin can raise it."), pick()),
			link: { label: t("Workspace usage limits"), url: "https://admin.openai.com" },
			detail: text,
		};
	}
	if (/subscription.?sharing.?usage.?limit|usage_limit_reached|hit your ChatGPT usage limit/i.test(seen)) {
		const minutes = /try again in ~(\d+) min/i.exec(seen)?.[1];
		const when = minutes ? resetsIn(Number(minutes)) : t("It resets after a while; your usage page shows when.");
		return {
			message: sentences(t("You've reached your ChatGPT plan's usage limit."), when, pick()),
			link: { label: t("ChatGPT usage"), url: "https://chatgpt.com/settings/usage" },
			detail: text,
		};
	}
	if (/insufficient_quota|exceeded your current quota/i.test(seen)) {
		return {
			message: t("Your OpenAI API account has run out of credit. Add credit in OpenAI's billing settings, or pick another model to keep going."),
			link: { label: t("OpenAI billing"), url: "https://platform.openai.com/settings/organization/billing/overview" },
			detail: text,
		};
	}
	return undefined;
}

function opencode(text: string, seen: string, provider: string): LimitNotice | undefined {
	const link = { label: t("OpenCode Go limits"), url: "https://opencode.ai/docs/go/" };
	if (/FreeUsageLimitError|free usage exceeded/i.test(seen)) {
		return { message: t("You've used up OpenCode's free usage. Subscribe to OpenCode Go, or pick another model to keep going."), link, detail: text };
	}
	const go = /GoUsageLimitError|Go usage limit/i.test(seen);
	if (go || (provider.startsWith("opencode") && /usage limit reached|available balance|quota exceeded/i.test(seen))) {
		return {
			message: sentences(
				t("You've reached an OpenCode Go usage limit. Go has 5-hour, weekly and monthly limits; it can fall back to your Zen balance if you turn that on in OpenCode."),
				pick(),
			),
			link,
			detail: text,
		};
	}
	return undefined;
}

function deepseek(text: string, provider: string, status: number | undefined): LimitNotice | undefined {
	if (!provider.startsWith("deepseek") && !/deepseek/i.test(text)) return undefined;
	if (status !== 402 && !/insufficient.?balance/i.test(text)) return undefined;
	return {
		message: t("Your DeepSeek balance has run out. Top it up, or pick another model to keep going."),
		link: { label: t("Top up DeepSeek"), url: "https://platform.deepseek.com/top_up" },
		detail: text,
	};
}

/** Z.ai's GLM Coding Plan and Zhipu's BigModel share their business error codes. */
const ZAI_CODES = /^(1113|1308|1309|1310|1311|1313|131[6-9]|132[01])$/;

function zai(text: string, provider: string, body: Body): LimitNotice | undefined {
	const zaiProvider = /^(zai|zhipu|bigmodel|glm)/.test(provider);
	const code =
		(ZAI_CODES.test(body.code) ? body.code : undefined) ??
		(zaiProvider || /z\.ai|bigmodel|glm coding plan/i.test(text) ? zaiCodeFromText(text) : undefined);
	if (!code) return undefined;
	const china = provider === "zai-coding-cn" || provider.startsWith("bigmodel") || provider.startsWith("zhipu");
	const link = china
		? { label: "GLM Coding Plan", url: "https://bigmodel.cn/glm-coding" }
		: { label: "GLM Coding Plan", url: "https://z.ai/subscribe" };
	const said = body.message || text;
	const reset = /resets? at ([0-9]{4}-[0-9]{2}-[0-9]{2}[ T][0-9:]{5,8})/i.exec(said)?.[1];
	const when = reset && t("It resets at {time}.", { time: reset });
	switch (code) {
		case "1113":
			return { message: t("Your Z.ai account has no balance or resource package left. Recharge it, or pick another model to keep going."), link, detail: text };
		case "1309":
			return { message: t("Your GLM Coding Plan has expired. Renew it, or pick another model to keep going."), link, detail: text };
		case "1311":
			return { message: sentences(t("Your GLM Coding Plan doesn't include this model."), pick()), link, detail: text };
		case "1313":
			return {
				message: sentences(t("Z.ai has slowed your requests under its Fair Usage Policy, and asks for a request on its site to restore access."), pick()),
				link,
				detail: text,
			};
	}
	const window = { "1316": "5-hour", "1317": "weekly", "1318": "5-hour", "1319": "weekly", "1320": "5-hour", "1321": "weekly" }[code];
	const hours = /for (\d+) ?hours?\b/i.exec(said)?.[1];
	const span = window ? t(window) : code === "1310" ? t("weekly or monthly") : hours ? t("{n}-hour", { n: hours }) : "";
	const extra =
		code === "1316" || code === "1317"
			? t("Your balance can't cover extra usage.")
			: /^13(1[89]|2[01])$/.test(code)
				? t("Extra usage is blocked by your monthly spend limit.")
				: "";
	return {
		message: sentences(
			span ? t("You've reached your GLM Coding Plan's {span} usage limit.", { span }) : t("You've reached your GLM Coding Plan's usage limit."),
			when,
			extra,
			pick(),
		),
		link,
		detail: text,
	};
}

/** The code behind Z.ai's wording, for messages that carry the text without the JSON. */
function zaiCodeFromText(text: string): string | undefined {
	if (/insufficient balance or no resource package/i.test(text)) return "1113";
	if (/weekly\/monthly limit exhausted/i.test(text)) return "1310";
	if (/past 5 hours.*insufficient balance/is.test(text)) return "1316";
	if (/past 7 days.*insufficient balance/is.test(text)) return "1317";
	if (/usage limit reached for/i.test(text)) return "1308";
	if (/coding plan.*expired|package has expired/is.test(text)) return "1309";
	if (/does not yet include access to/i.test(text)) return "1311";
	return undefined;
}

function xiaomi(text: string, provider: string, status: number | undefined, body: Body): LimitNotice | undefined {
	if (!provider.startsWith("xiaomi") && !/xiaomimimo/i.test(text)) return undefined;
	const link = { label: t("Xiaomi MiMo console"), url: "https://platform.xiaomimimo.com/" };
	if (status === 402 || /insufficient.?balance/i.test(text)) {
		return { message: t("Your Xiaomi MiMo balance has run out. Recharge it, or pick another model to keep going."), link, detail: text };
	}
	if (status !== 429) return undefined;
	if (/quota|token.?plan/i.test(body.message || text)) {
		return { message: sentences(t("Your Xiaomi MiMo Token Plan quota is used up."), pick()), link, detail: text };
	}
	// MiMo answers 429 both for requests sent too fast and for a used-up Token Plan.
	return {
		message: t(
			provider.includes("token-plan")
				? "Xiaomi MiMo turned the request away: either requests came too fast, or your Token Plan quota is used up. Wait a minute and try again; if it keeps happening, check your quota, or pick another model to keep going."
				: "Xiaomi MiMo is limiting how fast requests can be sent. Wait a minute and try again.",
		),
		link,
		detail: text,
	};
}

export function explainLimit(error: string, provider = ""): LimitNotice | undefined {
	const text = error.trim();
	if (!text) return undefined;
	const body = bodyOf(text);
	const status = statusOf(text);
	const seen = `${text}\n${body.type}`;
	return (
		chatgpt(text, seen) ??
		opencode(text, seen, provider) ??
		zai(text, provider, body) ??
		deepseek(text, provider, status) ??
		xiaomi(text, provider, status, body)
	);
}
