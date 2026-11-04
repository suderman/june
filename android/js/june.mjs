// The decisions the phone shares with the desktop overlay, bundled into one script (june.js, a global `June`) for
// QuickJS: which panels the conversation makes, how each is laid out, how it is lit, what live June is doing, and the
// console look. The modules stay in overlay/, written in the plain JavaScript both QML and QuickJS run; see "What the
// phone shares with the desktop" in docs/interfaces.org.
export * as strip from "../../overlay/strip.mjs";
export * as compose from "../../overlay/compose.mjs";
export * as live from "../../overlay/live.mjs";
export * as light from "../../overlay/light.mjs";
export * as scenery from "../../overlay/scenery.mjs";
export * as looks from "../../overlay/console.mjs";
