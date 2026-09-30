# pi-caveman

Caveman lite mode for [pi](https://github.com/earendil-works/pi): the model writes
tight, professional prose — no filler, no hedging, no tool-call narration — while
code, commands, file paths, and error strings stay exact. Shorter answers cost
fewer output tokens, and `/caveman saved` shows how many you are saving.

The style rules come from [caveman](https://github.com/JuliusBrussee/caveman)'s
**lite** level: *"No filler/hedging. Keep articles + full sentences. Professional
but tight."* Unlike caveman's full/ultra levels, lite never touches grammar —
it reads like a senior engineer writing under deadline, not like a caveman.

## Commands

| Command | What it does |
|---|---|
| `/caveman on` | Turn caveman lite on (status bar shows 🪨) |
| `/caveman off` | Turn it off, full prose restored |
| `/caveman saved` | Estimated token savings — this session and lifetime — rendered as a card in the transcript, styled like `/session`'s token block |
| `/caveman status` | Show current mode (bare `/caveman` works too) |
| `/caveman reset` | Zero the lifetime savings counters |

The mode survives restarts: it is persisted in `~/.pi/agent/caveman.json` and
re-applied on the next session, with a note in the transcript so per-session
accounting stays correct.

## How the savings estimate works

Caveman lite shortens what the model *writes*, so the estimate credits a fixed
fraction of the **output tokens** (and their output cost) produced while the
mode was active:

```
saved ≈ Σ output_tokens(assistant replies while on) × savingsRate
```

The default rate is **30%**. Caveman's own measurements span roughly 8.5%
(JetBrains study, skill only) to 50% (repo eval), so treat the number as an
estimate, not a meter reading — the card says so right on it. Change the rate
in `~/.pi/agent/caveman.json`:

```json
{
  "savingsRate": 0.3
}
```

Only output tokens are counted. The lite instruction itself is ~170 input
tokens, appended to the system prompt — and because the appended text is
identical every turn, your provider's prompt cache keeps serving it for
almost free.

Per-session numbers are reconstructed from toggle markers on the session
branch, so they survive restarts, forks, and branch switches. Lifetime totals
live in the state file. Toggle markers and savings cards are custom entries:
they never reach the model, so the extension costs your context nothing.

## Install

```bash
pi install git:github.com/hakergeniusz/pi-caveman
```

Try it without installing:

```bash
pi -e https://github.com/hakergeniusz/pi-caveman
```

Or copy `index.ts` anywhere and load it with `pi -e ./index.ts`.

## State file

`~/.pi/agent/caveman.json` (override the path with the `PI_CAVEMAN_STATE` env
var):

```json
{
  "version": 1,
  "enabled": true,
  "savingsRate": 0.3,
  "lifetime": {
    "turns": 12,
    "outputTokens": 45230,
    "savedTokens": 13569,
    "savedCost": 0.21
  }
}
```

## Credits

- [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) — the
  original project. The lite-mode rules in this extension are adapted from its
  `SKILL.md` (Apache-2.0); the token-saving numbers quoted above come from its
  benchmarks. Go there for the full/ultra levels, the wenyan modes, and the
  compression proxy.
- [v2nic/pi-caveman](https://github.com/v2nic/pi-caveman) — an earlier
  `/caveman` toggle for pi that showed the shape of this kind of extension.
  This one differs by implementing caveman's actual *lite* level, persisting
  the mode, and tracking savings.

## License

[MIT](LICENSE)
