// One table for every coding harness June knows: imported directly by Node, QML, and Android's esbuild bundle,
// and parsed as JSON (the object literal after `export const HARNESSES = `) by Emacs in org/dispatch/org-dispatch.el.
// Keep the HARNESSES literal strict JSON so Emacs parses it with json-parse-buffer without a JavaScript parser.
export const HARNESSES = {
	"claude": {
		"provider": "anthropic",
		"aliases": ["claude-code"],
		"colours": { "eye": "#f08a3e", "band": "#d9692a", "paper": "#b4531c", "neon": "#ff9a4d" },
		"account": {
			"env": "CLAUDE_CONFIG_DIR",
			"base": ".claude",
			"own": [".credentials.json", ".claude.json"],
			"command": "claude-direct"
		},
		"cli": {
			"modelFlag": "--model",
			"effort": { "kind": "flag", "flag": "--effort" },
			"instructions": { "kind": "flag", "flag": "--append-system-prompt" },
			"nameFlag": "--name"
		},
		"dispatch": {
			"launchable": true,
			"flags": ["--dangerously-skip-permissions", "--settings", "{\"env\":{\"CLAUDE_CODE_DISABLE_TERMINAL_TITLE\":\"\"}}"],
			"sessionIdFlag": "--session-id",
			"resume": { "kind": "flag", "flag": "--resume" },
			"sessionLookup": "claude"
		}
	},
	"codex": {
		"provider": "openai",
		"colours": { "eye": "#4a7fd4", "band": "#355fa3", "paper": "#355fa3", "neon": "#6fa8ff" },
		"account": {
			"env": "CODEX_HOME",
			"base": ".codex",
			"own": ["auth.json", "auth.json.lock", "auth.lock", "models_cache.json"],
			"command": "codex"
		},
		"cli": {
			"modelFlag": "--model",
			"effort": { "kind": "config", "flag": "-c", "key": "model_reasoning_effort", "maxAs": "xhigh" },
			"instructions": { "kind": "config", "flag": "-c", "key": "developer_instructions" }
		},
		"dispatch": {
			"launchable": true,
			"flags": ["--dangerously-bypass-approvals-and-sandbox"],
			"resume": { "kind": "subcommand", "subcommand": "resume" },
			"sessionLookup": "codex"
		}
	},
	"pi": {
		"provider": "openai",
		"colours": { "eye": "#1fa89a", "band": "#2a8f84", "paper": "#1f7f75", "neon": "#2ee6d2" },
		"account": {
			"env": "PI_CODING_AGENT_DIR",
			"base": ".pi/agent",
			"own": ["auth.json", "settings.json"],
			"command": "pi"
		},
		"cli": {
			"modelFlag": "--model",
			"modelPrefix": "openai-codex/",
			"effort": { "kind": "flag", "flag": "--thinking" },
			"instructions": { "kind": "flag", "flag": "--append-system-prompt" },
			"nameFlag": "--name"
		},
		"dispatch": {
			"launchable": true,
			"flags": ["--no-approve"],
			"defaultModelEnv": true,
			"sessionIdFlag": "--session-id",
			"resume": { "kind": "session-file", "flag": "--session" },
			"sessionLookup": "pi"
		}
	},
	"opencode": {
		"provider": "openai",
		"colours": { "eye": "#4c9e5b", "band": "#367842", "paper": "#367842", "neon": "#7ce38b" },
		"account": {
			"env": "XDG_DATA_HOME",
			"base": ".local/share/opencode",
			"subdir": "opencode",
			"own": ["auth.json", "opencode.db", "opencode.db-shm", "opencode.db-wal"],
			"extraEnv": { "OPENCODE_DB": "$HOME/.local/share/opencode/opencode.db" },
			"command": "opencode"
		},
		"cli": {
			"modelFlag": "--model",
			"modelPrefix": "openai/",
			"instructions": { "kind": "prepend-prompt" },
			"promptFlag": "--prompt"
		},
		"dispatch": {
			"launchable": false
		}
	},
	"agy": {
		"provider": "google",
		"aliases": ["antigravity"],
		"colours": { "eye": "#8b63d9", "band": "#6a45b3", "paper": "#6a45b3", "neon": "#b48cff" },
		"account": {
			"base": ".gemini",
			"own": [],
			"command": "agy"
		},
		"cli": {
			"modelFlag": "--model",
			"effort": { "kind": "flag", "flag": "--effort" },
			"instructions": { "kind": "prepend-prompt" },
			"promptFlag": "--prompt-interactive"
		},
		"dispatch": {
			"launchable": true,
			"flags": [],
			"resume": { "kind": "flag", "flag": "--conversation" },
			"sessionLookup": "agy"
		}
	}
};

/** Fallback colours for an unrecognised harness name. */
export const OTHER_HARNESS_COLOURS = { "eye": "#e0b419", "band": "#b8911a", "paper": "#8a6d10", "neon": "#ffd84d" };

/** Every known harness name, in roster editor order. */
export const HARNESS_NAMES = Object.keys(HARNESSES);

/** Harnesses the Org dispatcher can launch. */
export const LAUNCHABLE_HARNESSES = HARNESS_NAMES.filter((name) => HARNESSES[name].dispatch.launchable);

/** Lowercase alias -> canonical harness name, built from HARNESSES. */
export const HARNESS_ALIASES = (() => {
	const map = {};
	for (let i = 0; i < HARNESS_NAMES.length; i++) {
		const name = HARNESS_NAMES[i];
		map[name] = name;
		const aliases = HARNESSES[name].aliases || [];
		for (let j = 0; j < aliases.length; j++) map[aliases[j]] = name;
	}
	return map;
})();

/** Per-look frame colours by harness for Theme.qml (paper and neon). */
export const HARNESS_TONES = (() => {
	const paper = {};
	const neon = {};
	for (let i = 0; i < HARNESS_NAMES.length; i++) {
		const name = HARNESS_NAMES[i];
		const c = HARNESSES[name].colours;
		paper[name] = c.paper;
		neon[name] = c.neon;
	}
	paper.other = OTHER_HARNESS_COLOURS.paper;
	neon.other = OTHER_HARNESS_COLOURS.neon;
	return { paper: paper, neon: neon };
})();
