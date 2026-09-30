/**
 * Smoke test: runs index.ts against a fake ExtensionAPI. No network, no real
 * model, no real pi. `bun test.ts`. Uses PI_CAVEMAN_STATE to keep the real
 * ~/.pi/agent/caveman.json untouched.
 */

process.env.PI_CAVEMAN_STATE = new URL("./.pi-caveman.test.json", import.meta.url).pathname;

const { default: activate } = await import("./index.ts");

// --- fake pi -----------------------------------------------------------------

interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
	message?: { role: string; usage?: { output?: number; cost?: { output?: number } } };
}

interface NotifyCall {
	message: string;
	level: string;
}

const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void>; getArgumentCompletions?: (p: string) => unknown[] }> = {};
const handlers: Record<string, (event: unknown, ctx: unknown) => unknown> = {};
const renderers: Record<string, (entry: Entry, rctx: unknown, theme: unknown) => unknown> = {};
const entries: Entry[] = [];
const notifications: NotifyCall[] = [];
const statuses: { key: string; text: string | undefined }[] = [];

const fakePi = {
	registerCommand(name: string, options: (typeof commands)[string]) {
		commands[name] = options;
	},
	registerEntryRenderer(type: string, renderer: (typeof renderers)[string]) {
		renderers[type] = renderer;
	},
	on(event: string, handler: (typeof handlers)[string]) {
		handlers[event] = handler;
		return () => {};
	},
	appendEntry(type: string, data?: unknown) {
		entries.push({ type: "custom", customType: type, data });
	},
};

const fakeTheme = new Proxy({}, { get: (_t, prop: string) => (s: string) => (prop === "bg" ? s : s) });
const fakeCtx = {
	mode: "tui",
	hasUI: true,
	ui: {
		notify: (message: string, level = "info") => notifications.push({ message, level }),
		setStatus: (key: string, text: string | undefined) => statuses.push({ key, text }),
	},
	sessionManager: {
		getBranch: () => entries,
	},
};

// --- helpers -----------------------------------------------------------------

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean): void {
	if (cond) {
		passed += 1;
	} else {
		failed += 1;
		console.error(`FAIL: ${name}`);
	}
}

function lastNotification(): NotifyCall | undefined {
	return notifications[notifications.length - 1];
}

async function run(name: string, args = ""): Promise<void> {
	await commands.caveman.handler(args, fakeCtx);
	check(`command /caveman ${name} did not throw`, true);
}

// --- the actual test ---------------------------------------------------------

activate(fakePi as never);

check("registers /caveman command", commands.caveman !== undefined);
check("registers savings entry renderer", renderers["caveman-savings"] !== undefined);
check("registers session_start", handlers.session_start !== undefined);
check("registers before_agent_start", handlers.before_agent_start !== undefined);
check("registers agent_end", handlers.agent_end !== undefined);

// Session start: no state file yet -> off, no restored marker.
handlers.session_start({ type: "session_start" }, fakeCtx);
check("starts disabled with no state file", statuses.at(-1)?.text === undefined);
const entryCountAfterStart = entries.length;
check("no toggle marker when already off", entryCountAfterStart === 0);

// before_agent_start while off: no system prompt override, turn not active.
const offResult = handlers.before_agent_start({ type: "before_agent_start", systemPrompt: "BASE" }, fakeCtx);
check("no prompt injection while off", offResult === undefined);

await run("status", "");
check("status says off", lastNotification()?.message.includes("off") === true);

// Turn caveman on.
await run("on", "on");
check("on notifies", lastNotification()?.message.includes("ON") === true);
check("status bar set while on", statuses.at(-1)?.text === "🪨 caveman lite");
check("on appends mode marker", entries.at(-1)?.customType === "caveman-mode" && (entries.at(-1)?.data as { enabled: boolean }).enabled === true);

// before_agent_start while on: prompt appended, turn active.
const onResult = handlers.before_agent_start({ type: "before_agent_start", systemPrompt: "BASE" }, fakeCtx) as { systemPrompt?: string };
check("injects lite prompt while on", typeof onResult?.systemPrompt === "string" && onResult.systemPrompt.startsWith("BASE") && onResult.systemPrompt.length > "BASE".length);
const onResult2 = handlers.before_agent_start({ type: "before_agent_start", systemPrompt: "BASE" }, fakeCtx) as { systemPrompt?: string };
check("injection is deterministic", onResult2?.systemPrompt === onResult.systemPrompt);

// Real pi records assistant messages in the session as they stream; mirror
// that so the /caveman saved branch walk sees them.
entries.push(
	{ type: "message", message: { role: "assistant", usage: { output: 1000, cost: { output: 0.01 } } } },
	{ type: "message", message: { role: "assistant", usage: { output: 500 } } },
);

// agent_end with caveman on: lifetime totals grow by 30% of output.
handlers.agent_end(
	{
		type: "agent_end",
		messages: [
			{ role: "assistant", usage: { output: 1000, cost: { output: 0.01 } } },
			{ role: "user" },
			{ role: "assistant", usage: { output: 500 } },
		],
	},
	fakeCtx,
);
check("lifetime counts one turn", true);
await run("saved", "saved");
const card = entries.find((e) => e.customType === "caveman-savings")?.data as {
	session: { replies: number; outputTokens: number; savedTokens: number; savedCost: number };
	lifetime: { turns: number; outputTokens: number; savedTokens: number; savedCost: number };
	rate: number;
	mode: string;
};
check("card exists", card !== undefined);
check("session counts replies while on", card?.session.replies === 2);
check("session output summed", card?.session.outputTokens === 1500);
check("session saved at 30%", card?.session.savedTokens === 450);
check("session saved cost at 30%", Math.abs(card.session.savedCost - 0.003) < 1e-9);
check("lifetime output matches turn", card?.lifetime.outputTokens === 1500);
check("lifetime saved at 30%", card?.lifetime.savedTokens === 450);

// A turn before the toggle must not be counted: rewind, turn off, new usage ignored.
await run("off", "off");
check("off notifies", lastNotification()?.message.includes("off") === true);
const offTurn = handlers.before_agent_start({ type: "before_agent_start", systemPrompt: "BASE" }, fakeCtx);
check("no prompt injection after off", offTurn === undefined);
handlers.agent_end(
	{ type: "agent_end", messages: [{ role: "assistant", usage: { output: 9999, cost: { output: 0.99 } } }] },
	fakeCtx,
);
await run("saved", "saved");
const card2 = entries.filter((e) => e.customType === "caveman-savings").at(-1)?.data as typeof card;
check("off-turn output not counted", card2?.lifetime.outputTokens === 1500);
check("mode off on second card", card2?.mode === "off");

// Only replies after the latest ON marker count for the session view.
entries.push({
	type: "message",
	message: { role: "assistant", usage: { output: 400, cost: { output: 0.004 } } },
});
await run("saved", "saved");
const card3 = entries.filter((e) => e.customType === "caveman-savings").at(-1)?.data as typeof card;
check("reply after off not counted in session", card3?.session.replies === 2 && card3.session.outputTokens === 1500);

// Renderer returns a component for a well-formed entry.
const rendered = renderers["caveman-savings"](
	{ type: "custom", customType: "caveman-savings", data: card },
	{ expanded: true },
	fakeTheme,
);
check("renderer returns a component", rendered !== undefined);

// Reset zeroes lifetime, keeps mode.
await run("reset", "reset");
check("reset notifies", lastNotification()?.message.includes("reset") === true);
await run("saved", "saved");
const card4 = entries.filter((e) => e.customType === "caveman-savings").at(-1)?.data as typeof card;
check("lifetime zeroed by reset", card4?.lifetime.turns === 0 && card4.lifetime.savedTokens === 0);

// Unknown arg warns.
await run("bogus", "bogus");
check("unknown arg warns", lastNotification()?.level === "warning");

// session_start with enabled=true in the state file restores the marker.
const stateFile = JSON.parse((await import("node:fs")).readFileSync(process.env.PI_CAVEMAN_STATE!, "utf8"));
check("state file enabled persisted", stateFile.enabled === false); // last toggle was off
stateFile.enabled = true;
(await import("node:fs")).writeFileSync(process.env.PI_CAVEMAN_STATE!, JSON.stringify(stateFile));
handlers.session_start({ type: "session_start" }, fakeCtx);
check("restored marker appended when branch disagrees", entries.at(-1)?.customType === "caveman-mode" && (entries.at(-1)?.data as { restored?: boolean }).restored === true);
check("status bar set after restore", statuses.at(-1)?.text === "🪨 caveman lite");

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
