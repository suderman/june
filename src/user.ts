// The person June serves, by name, for her prompts and tools. The code names nobody: the daemon sets this once from
// config.user.name, and until then, or without one, she says "the user".
let name = "the user";

/** The user's name, or "the user". */
export const user = () => name;
/** The same at the start of a sentence. */
export const User = () => name.charAt(0).toUpperCase() + name.slice(1);

export function setUser(given: string | undefined): void {
	name = given?.trim() || "the user";
}
