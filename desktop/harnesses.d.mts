export type Provider = "openai" | "anthropic" | "google";
export type HarnessName = "claude" | "codex" | "pi" | "opencode" | "agy";

export type EffortCli =
	| { readonly kind: "flag"; readonly flag: string }
	| { readonly kind: "config"; readonly flag: string; readonly key: string; readonly maxAs?: string };

export type InstructionsCli =
	| { readonly kind: "flag"; readonly flag: string }
	| { readonly kind: "config"; readonly flag: string; readonly key: string }
	| { readonly kind: "prepend-prompt" };

export type ResumeSpec =
	| { readonly kind: "flag"; readonly flag: string }
	| { readonly kind: "subcommand"; readonly subcommand: string }
	| { readonly kind: "session-file"; readonly flag: string };

export type HarnessSpec = {
	readonly provider: Provider;
	readonly aliases?: readonly string[];
	readonly colours: { readonly eye: string; readonly band: string; readonly paper: string; readonly neon: string };
	readonly account: {
		readonly env?: string;
		readonly base: string;
		readonly subdir?: string;
		readonly own: readonly string[];
		readonly extraEnv?: Readonly<Record<string, string>>;
		readonly command: string;
	};
	readonly cli: {
		readonly modelFlag: string;
		readonly modelPrefix?: string;
		readonly effort?: EffortCli;
		readonly instructions?: InstructionsCli;
		readonly nameFlag?: string;
		readonly promptFlag?: string;
	};
	readonly dispatch:
		| {
			readonly launchable: true;
			readonly flags: readonly string[];
			readonly defaultModelEnv?: boolean;
			readonly sessionIdFlag?: string;
			readonly resume: ResumeSpec;
			readonly sessionLookup: string;
		}
		| { readonly launchable: false };
};

export const HARNESSES: Record<HarnessName, HarnessSpec>;
export const OTHER_HARNESS_COLOURS: { readonly eye: string; readonly band: string; readonly paper: string; readonly neon: string };
export const HARNESS_NAMES: readonly HarnessName[];
export const LAUNCHABLE_HARNESSES: readonly HarnessName[];
export const HARNESS_ALIASES: Readonly<Record<string, HarnessName>>;
export const HARNESS_TONES: {
	readonly paper: Readonly<Record<HarnessName | "other", string>>;
	readonly neon: Readonly<Record<HarnessName | "other", string>>;
};
