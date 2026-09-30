/**
 * pi-caveman — Caveman lite mode for the pi coding agent.
 *
 * Applies the "lite" level of caveman (https://github.com/JuliusBrussee/caveman,
 * Apache-2.0) to pi: the model answers in tight, professional prose — no filler,
 * no hedging, no tool-call narration — while code, commands, file paths, and
 * error strings stay exact. Prior art: https://github.com/v2nic/pi-caveman (MIT).
 *
 * Commands:
 *   /caveman on      Turn caveman lite on
 *   /caveman off     Turn it off
 *   /caveman saved   Estimated token savings (session + lifetime), styled like
 *                    /session's token block; rendered as a transcript card
 *   /caveman status  Show current mode (also bare /caveman)
 *   /caveman reset   Zero the lifetime savings counters
 *
 * Savings are an estimate: caveman lite shortens what the model writes, so the
 * extension credits a configurable fraction (default 30%) of the output tokens
 * — and their output cost — produced while the mode was active. Mode toggles
 * are recorded as custom entries on the session branch, so per-session numbers
 * survive restarts, forks, and compaction; lifetime totals live in
 * ~/.pi/agent/caveman.json (override the path with PI_CAVEMAN_STATE).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { Box, Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODE_ENTRY = "caveman-mode";
const SAVINGS_ENTRY = "caveman-savings";
const STATUS_KEY = "caveman";
const STATUS_TEXT = "🪨 caveman lite";

/**
 * Output-token reduction credited to lite mode. Caveman's own measurements
 * span ~8.5% (JetBrains study, skill only) to ~50% (repo eval); 30% sits in
 * the middle. Override with "savingsRate" in the state file.
 */
const DEFAULT_SAVINGS_RATE = 0.3;

/**
 * Caveman lite rules, adapted from the project's SKILL.md (Apache-2.0):
 * "No filler/hedging. Keep articles + full sentences. Professional but tight."
 */
const LITE_PROMPT = `

## Caveman lite mode (ACTIVE until the user turns it off)

Answer in tight, professional prose for every response this session. Drop filler, hedging, pleasantries ("sure", "of course", "happy to"), and tool-call narration. Keep articles and complete sentences. One idea per sentence, target 20 words max, active voice, imperative instructions ("Run X", not "X should be run"). Use the same term for the same thing every time.

Compression must never grow the output: if a shorter phrasing would not actually be shorter, write it plainly, and never invent abbreviations. Code blocks, commands, file paths, API names, technical terms, and error strings stay exact and unchanged. Never drop or alter negations (not, never, no, only); numbers and units stay exact. Security warnings and irreversible-action confirmations revert to full normal prose, then resume the terse style afterward.

No preamble before tool calls, no announcing next steps, no decorative tables or emoji, no restating the question, no meta commentary about this mode, no mode-change acknowledgments — just answer in the style.
`;

const STATE_FILE = process.env.PI_CAVEMAN_STATE ?? join(homedir(), ".pi", "agent", "caveman.json");

interface Lifetime {
	turns: number;
	outputTokens: number;
	savedTokens: number;
	savedCost: number;
}

interface CavemanState {
	version: 1;
	enabled: boolean;
	savingsRate: number;
	lifetime: Lifetime;
}

/** The subset of a provider usage object this extension reads. */
interface UsageLike {
	output?: number;
	cost?: { output?: number } | null;
}

interface SavingsSnapshot {
	replies: number;
	outputTokens: number;
	savedTokens: number;
	savedCost: number;
}

interface SavingsData {
	at: string;
	mode: "on" | "off";
	rate: number;
	session: SavingsSnapshot;
	lifetime: Lifetime;
}

interface ModeEntryData {
	enabled: boolean;
	at: string;
	restored?: boolean;
}

function defaultState(): CavemanState {
	return {
		version: 1,
		enabled: false,
		savingsRate: DEFAULT_SAVINGS_RATE,
		lifetime: { turns: 0, outputTokens: 0, savedTokens: 0, savedCost: 0 },
	};
}

function loadState(): CavemanState {
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<CavemanState>;
		const life = raw.lifetime ?? {};
		return {
			version: 1,
			enabled: raw.enabled === true,
			savingsRate:
				typeof raw.savingsRate === "number" && raw.savingsRate >= 0 && raw.savingsRate <= 0.95
					? raw.savingsRate
					: DEFAULT_SAVINGS_RATE,
			lifetime: {
				turns: life.turns ?? 0,
				outputTokens: life.outputTokens ?? 0,
				savedTokens: life.savedTokens ?? 0,
				savedCost: life.savedCost ?? 0,
			},
		};
	} catch {
		return defaultState();
	}
}

function saveState(state: CavemanState): void {
	try {
		mkdirSync(dirname(STATE_FILE), { recursive: true });
		writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
	} catch {
		// Stats persistence is best effort; the session must never break over it.
	}
}

function fmt(n: number): string {
	return Math.round(n).toLocaleString("en-US");
}

function money(n: number): string {
	return n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
}

function pct(rate: number): string {
	return `${(rate * 100).toFixed(0)}%`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error" = "info"): void {
	try {
		ctx.ui.notify(message, level);
	} catch {
		// Non-interactive modes may have no UI at all.
	}
}

function applyStatus(ctx: ExtensionContext, enabled: boolean): void {
	try {
		ctx.ui.setStatus(STATUS_KEY, enabled ? STATUS_TEXT : undefined);
	} catch {
		// Status bar is TUI-only; ignore elsewhere.
	}
}

/**
 * Walk the active branch summing output tokens (and their output cost) from
 * assistant replies produced while caveman was on. Toggle markers recorded via
 * appendEntry make this exact across restarts, forks, and branch switches.
 */
function computeSession(ctx: ExtensionContext): { replies: number; outputTokens: number; outputCost: number } {
	let on = false;
	let replies = 0;
	let outputTokens = 0;
	let outputCost = 0;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
			on = (entry.data as ModeEntryData | undefined)?.enabled === true;
			continue;
		}
		if (!on || entry.type !== "message" || entry.message.role !== "assistant") continue;
		const usage = (entry.message as { usage?: UsageLike }).usage;
		if (!usage) continue;
		replies += 1;
		outputTokens += usage.output ?? 0;
		outputCost += usage.cost?.output ?? 0;
	}
	return { replies, outputTokens, outputCost };
}

/** Whether the branch currently records caveman as on (regardless of global state). */
function reconstructEnabled(ctx: ExtensionContext): boolean {
	let on = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
			on = (entry.data as ModeEntryData | undefined)?.enabled === true;
		}
	}
	return on;
}

export default function cavemanExtension(pi: ExtensionAPI) {
	let state = defaultState();
	/** True when the current agent run started with the prompt injected. */
	let turnActive = false;

	pi.registerCommand("caveman", {
		description: "Toggle caveman lite mode and show estimated token savings",
		getArgumentCompletions: (prefix: string) =>
			(
				[
					["on", "Turn caveman lite on"],
					["off", "Turn caveman lite off"],
					["saved", "Show estimated token savings"],
					["status", "Show current mode"],
					["reset", "Reset lifetime savings"],
				] as const
			)
				.filter(([value]) => value.startsWith(prefix))
				.map(([value, description]) => ({ value, label: value, description })),
		handler: async (args: string, ctx: ExtensionContext) => {
			const arg = args.trim().toLowerCase();
			switch (arg === "" ? "status" : arg) {
				case "on": {
					state.enabled = true;
					saveState(state);
					applyStatus(ctx, true);
					pi.appendEntry<ModeEntryData>(MODE_ENTRY, { enabled: true, at: new Date().toISOString() });
					notify(ctx, `🪨 Caveman lite ON. Tight prose, full accuracy. /caveman off | saved`);
					break;
				}
				case "off": {
					state.enabled = false;
					saveState(state);
					applyStatus(ctx, false);
					pi.appendEntry<ModeEntryData>(MODE_ENTRY, { enabled: false, at: new Date().toISOString() });
					notify(ctx, "Caveman lite off. Full prose restored.");
					break;
				}
				case "saved":
				case "stats": {
					const rate = state.savingsRate;
					const session = computeSession(ctx);
					const data: SavingsData = {
						at: new Date().toISOString(),
						mode: state.enabled ? "on" : "off",
						rate,
						session: {
							...session,
							savedTokens: Math.round(session.outputTokens * rate),
							savedCost: session.outputCost * rate,
						},
						lifetime: { ...state.lifetime },
					};
					pi.appendEntry<SavingsData>(SAVINGS_ENTRY, data);
					if (ctx.mode !== "tui") {
						notify(
							ctx,
							`Caveman savings (est.): session ${fmt(data.session.savedTokens)} tok / ${money(data.session.savedCost)}, lifetime ${fmt(data.lifetime.savedTokens)} tok / ${money(data.lifetime.savedCost)} (rate ${pct(rate)})`,
						);
					}
					break;
				}
				case "reset": {
					state.lifetime = { turns: 0, outputTokens: 0, savedTokens: 0, savedCost: 0 };
					saveState(state);
					notify(ctx, "Lifetime caveman savings reset.");
					break;
				}
				case "status": {
					notify(
						ctx,
						state.enabled
							? `🪨 Caveman lite: ON — answers tight. /caveman off, saved.`
							: "Caveman lite: off. /caveman on",
					);
					break;
				}
				default:
					notify(ctx, "Usage: /caveman on | off | saved | status | reset", "warning");
			}
		},
	});

	// Render savings cards as transcript blocks that never reach the model.
	pi.registerEntryRenderer<SavingsData>(SAVINGS_ENTRY, (entry, _renderCtx, theme) => {
		const d = (entry.data ?? {}) as Partial<SavingsData>;
		const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
		const row = (label: string, value: string) =>
			box.addChild(new Text(`  ${theme.fg("dim", label.padEnd(20))}${value}`, 0, 0));

		box.addChild(new Text(theme.fg("accent", "🪨 Caveman savings (estimate)"), 0, 0));
		box.addChild(
			new Text(
				theme.fg("dim", `Basis: ${pct(d.rate ?? DEFAULT_SAVINGS_RATE)} of output tokens while caveman lite is active`),
				0,
				0,
			),
		);
		box.addChild(new Text("", 0, 0));
		box.addChild(new Text(theme.bold("This session"), 0, 0));
		row("Replies while on:", String(d.session?.replies ?? 0));
		row("Output while on:", `${fmt(d.session?.outputTokens ?? 0)} tokens`);
		row("Saved (est.):", `${fmt(d.session?.savedTokens ?? 0)} tokens ≈ ${money(d.session?.savedCost ?? 0)}`);
		box.addChild(new Text("", 0, 0));
		box.addChild(new Text(theme.bold("Lifetime"), 0, 0));
		row("Turns while on:", String(d.lifetime?.turns ?? 0));
		row("Output while on:", `${fmt(d.lifetime?.outputTokens ?? 0)} tokens`);
		row("Saved (est.):", `${fmt(d.lifetime?.savedTokens ?? 0)} tokens ≈ ${money(d.lifetime?.savedCost ?? 0)}`);
		return box;
	});

	pi.on("session_start", (_event, ctx) => {
		state = loadState();
		applyStatus(ctx, state.enabled);
		// Align the session's own record with the persisted mode so per-session
		// accounting stays correct after restarts and branch switches.
		if (reconstructEnabled(ctx) !== state.enabled) {
			pi.appendEntry<ModeEntryData>(MODE_ENTRY, {
				enabled: state.enabled,
				at: new Date().toISOString(),
				restored: true,
			});
		}
	});

	// Append the lite rules to the system prompt for this run. The string is
	// deterministic, so the provider's cached prompt prefix survives turn to
	// turn while the mode stays on; only the on/off transition re-bills once.
	pi.on("before_agent_start", (event) => {
		turnActive = state.enabled;
		if (!state.enabled) return undefined;
		return { systemPrompt: event.systemPrompt + LITE_PROMPT };
	});

	// Charge the turn's output to the estimate while the prompt was active.
	pi.on("agent_end", (event) => {
		if (!turnActive) return;
		turnActive = false;
		let outputTokens = 0;
		let outputCost = 0;
		for (const message of event.messages) {
			if (message.role !== "assistant") continue;
			const usage = (message as { usage?: UsageLike }).usage;
			if (!usage) continue;
			outputTokens += usage.output ?? 0;
			outputCost += usage.cost?.output ?? 0;
		}
		if (outputTokens === 0 && outputCost === 0) return;
		state.lifetime.turns += 1;
		state.lifetime.outputTokens += outputTokens;
		state.lifetime.savedTokens += Math.round(outputTokens * state.savingsRate);
		state.lifetime.savedCost += outputCost * state.savingsRate;
		saveState(state);
	});
}
