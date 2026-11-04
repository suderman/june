// The part of ws 8 that June uses. ws ships no types, and @types/ws would be one more package for these few lines.
declare module "ws" {
	import type { EventEmitter } from "node:events";
	import type { IncomingMessage } from "node:http";
	import type { AddressInfo } from "node:net";
	import type { Duplex } from "node:stream";

	export class WebSocket extends EventEmitter {
		static readonly OPEN: 1;
		constructor(address: string, options?: { maxPayload?: number; headers?: Record<string, string>; autoPong?: boolean });
		readonly readyState: 0 | 1 | 2 | 3;
		readonly bufferedAmount: number;
		send(data: string | Buffer, callback?: (error?: Error) => void): void;
		ping(): void;
		close(code?: number, reason?: string): void;
		terminate(): void;
		on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
		on(event: "close", listener: (code: number, reason: Buffer) => void): this;
		on(event: "open" | "pong", listener: () => void): this;
		on(event: "error", listener: (error: Error) => void): this;
		once(event: "message", listener: (data: Buffer, isBinary: boolean) => void): this;
		once(event: "close", listener: (code: number, reason: Buffer) => void): this;
		once(event: "open" | "pong", listener: () => void): this;
		once(event: "error", listener: (error: Error) => void): this;
	}

	export class WebSocketServer extends EventEmitter {
		constructor(options: { host?: string; port?: number; noServer?: boolean; maxPayload?: number; clientTracking?: boolean });
		readonly clients: Set<WebSocket>;
		handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, callback: (socket: WebSocket, request: IncomingMessage) => void): void;
		address(): AddressInfo | string | null;
		close(callback?: (error?: Error) => void): void;
		on(event: "connection", listener: (socket: WebSocket, request: IncomingMessage) => void): this;
		on(event: "listening", listener: () => void): this;
		on(event: "error", listener: (error: Error) => void): this;
		once(event: "listening", listener: () => void): this;
		once(event: "error", listener: (error: Error) => void): this;
	}
}
