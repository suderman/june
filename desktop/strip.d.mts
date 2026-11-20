export function linkKind(url: string): "web" | "herdr" | "file" | "moment" | null;
export function momentOf(url: string): number | undefined;
export function emacsCall(url: string): string[];
export function dayLabel(date: string, today?: string): string;
export function dateKey(date: Date): string;
export function stepDay(days: readonly { date: string }[], date: string, direction: number, today?: string): string | null;
export function panelOf(list: readonly unknown[], id: string): string;
