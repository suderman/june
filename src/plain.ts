// June's typography as Jon reads it: what a keyboard types. Models reach for curly quotes and em dashes whatever her
// voice rules say, so her replies pass through this on the way to the terminal, Telegram, and patter.
import type { TelegramPort } from "pi-durable-telegram";

/** Straight quotes and apostrophes, and a comma where an em dash was. En dashes stay: they mark ranges. */
export function plain(text: string): string {
	return text
		.replace(/[‘’‚‛]/g, "'")
		.replace(/[“”„‟]/g, '"')
		.replace(/[ \t]*—[ \t]*/g, ", ")
		.replace(/^, /gm, "");
}

/** The port the Telegram channel sends through, with every outgoing text made plain. */
export function plainPort(port: TelegramPort): TelegramPort {
	const caption = (text: string | undefined) => (text === undefined ? undefined : plain(text));
	return {
		getFile: port.getFile.bind(port),
		downloadFile: port.downloadFile.bind(port),
		answerCallbackQuery: port.answerCallbackQuery.bind(port),
		sendChatAction: port.sendChatAction.bind(port),
		setMyCommands: port.setMyCommands.bind(port),
		sendMessage: (chatId, text, options, signal) => port.sendMessage(chatId, plain(text), options, signal),
		editMessageText: (chatId, messageId, text, options, signal) => port.editMessageText(chatId, messageId, plain(text), options, signal),
		sendDraft: (chatId, draftId, markdown, signal) => port.sendDraft(chatId, draftId, plain(markdown), signal),
		sendPhoto: (chatId, path, text, signal) => port.sendPhoto(chatId, path, caption(text), signal),
		sendDocument: (chatId, path, text, signal) => port.sendDocument(chatId, path, caption(text), signal),
	};
}
