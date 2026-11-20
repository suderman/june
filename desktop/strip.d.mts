export function linkKind(url: string): "web" | "herdr" | "file" | "moment" | null;
export function momentOf(url: string): number | undefined;
export function emacsCall(url: string): string[];
