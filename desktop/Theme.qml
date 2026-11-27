// The strip's design tokens, until the theme system serves them (see "Themes" in docs/interfaces.org). Two looks, each
// light or dark, set by the shell: the comic strip, and the console (`consoleLook`), a terminal style for when June
// should look professional; `dark` follows the desktop's colour scheme unless the device holds to one. In the comic's
// dark (late night neon, `neon`) the page goes indigo-black and panels, balloons, notes and bursts darken to match,
// while `ink` stays dark for printed art details; text set on the page uses `pageInk`. Components draw from these tokens, so most follow the look without knowing it. The boards' own
// tokens (surface, rule, shadow, a colour per state and harness, the type scale) match the phone's Look.kt.
pragma Singleton
import QtQuick
import Quickshell
import "harnesses.mjs" as Harnesses

Singleton {
  property bool consoleLook: false
  property bool dark: false

  // A token by look and scheme: the comic's light and dark, the console's dark and light.
  function pick(comic, comicDark, console_, consoleLight) {
    return consoleLook ? (dark ? console_ : consoleLight) : (dark ? comicDark : comic);
  }

  readonly property color ink: pick("#1b1a1f", "#1b1a1f", "#d7dbe3", "#24292f")
  // Words and controls set straight on the page rather than inside a panel or balloon.
  readonly property color pageInk: pick("#1b1a1f", "#f4eeff", "#d7dbe3", "#24292f")
  readonly property color paper: pick("#f6f1e7", "#12101c", "#121418", "#f6f7f9")
  readonly property color muted: pick("#66636c", "#a8a0c8", "#8a93a5", "#636c76")
  readonly property color backdrop: pick("#b80a0c14", "#cc05070a", "#cc05070a", "#990a0c14")
  readonly property color accent: pick("#bf3a27", "#ff4fa3", "#ff8f80", "#cf222e")

  // June's balloons: warm cream with ink outlines in light; deep indigo with soft neon edges in dark.
  readonly property color balloon: pick("#fffcf5", "#1e1a33", "#1a1d23", "#ffffff")
  readonly property color balloonInk: pick("#1b1a1f", "#f4eeff", "#d7dbe3", "#24292f")
  readonly property color balloonLine: pick("#1b1a1f", "#9d7bff", "#5c6577", "#818b95")
  readonly property color highlight: pick("#ffe27a", "#5a2d6b", "#3a4150", "#dde3ea")
  readonly property color thoughtInk: pick("#4a4750", "#c4b9e6", "#8a93a5", "#636c76")
  // The user's notes: light blue in light, deep midnight cobalt in dark, tailless, from outside the frame.
  readonly property color noteFill: pick("#dbe7ff", "#162642", "#1a1d23", "#ffffff")
  readonly property color noteLine: pick("#5470b8", "#72b8ff", "#6d8fd6", "#0969da")
  readonly property color noteInk: pick("#1c2a52", "#e3efff", "#c9d7f5", "#0a3069")
  // Tools: one call as a lavender chip, several as a terminal status card.
  readonly property color chipFill: pick("#ebe5ff", "#2b214d", "#262a33", "#eef0f3")
  readonly property color chipLine: pick("#b0a4d8", "#8f6fd6", "#5c6577", "#818b95")
  readonly property color chipInk: pick("#3d3466", "#decfff", "#d7dbe3", "#24292f")
  readonly property color cardFill: "#1f2433"
  readonly property color codeFill: neon ? "#101322" : cardFill
  readonly property color cardLine: "#5b6683"
  readonly property color cardInk: "#e4e8f2"
  readonly property color cardOk: "#86e08f"
  readonly property color cardFail: "#ff8f80"
  readonly property color cardBusy: "#ffd36b"
  readonly property color burstFill: pick("#ffd6cf", "#3d1828", "#262a33", "#eef0f3")
  readonly property color burstLine: pick("#1b1a1f", "#ff5c7a", "#ff8f80", "#cf222e")
  readonly property color burstInk: pick("#1b1a1f", "#ffd8e0", "#ff8f80", "#cf222e")
  // Captions and toasts: a pale yellow box in light, deep warm amber in dark.
  readonly property color captionFill: pick("#fff3c4", "#332815", "#262a33", "#eef0f3")
  readonly property color captionInk: pick("#1b1a1f", "#ffecb3", "#d7dbe3", "#24292f")
  // File cards clipped to user notes.
  readonly property color fileCardFill: pick("#fbf8f1", "#1d2c4a", "#1a1d23", "#ffffff")
  readonly property color fileCardLine: pick("#1b1a1f", "#72b8ff", "#5c6577", "#818b95")
  readonly property color fileCardPage: pick("#ffffff", "#283c63", "#262a33", "#ffffff")
  // The console's own: her name, the user's prompt, and a tool line's status.
  readonly property color consoleJune: dark ? "#e9c46a" : "#9a6700"
  readonly property color consoleUser: dark ? "#8fb4ff" : "#0550ae"
  readonly property color consoleOk: dark ? "#86e08f" : "#1a7f37"
  readonly property color consoleFail: dark ? "#ff8f80" : "#cf222e"
  readonly property color consoleBusy: dark ? "#ffd36b" : "#9a6700"

  // Panel grounds, picked per panel so neighbours differ: dusk lilac, peach, sky, sage, sand (deepened in dark neon).
  readonly property var tints: neon
    ? ["#272038", "#34242d", "#1d293b", "#1f302a", "#332a1f"]
    : ["#e6d7ea", "#f6dccb", "#d7e4f2", "#dfead6", "#f2e3c8"]

  // ---- The boards: dockets, stubs and clanker cards, in paper and ink, neon, or the console. ----
  readonly property bool neon: !consoleLook && dark
  // A docket's or card's stock and the text on it; its edge, its ruled lines, and its hard shadow (paper) or glow (neon).
  readonly property color surface: pick("#fffcf5", "#1c1830", "#121418", "#f6f7f9")
  readonly property color surfaceInk: pick("#1b1a1f", "#f4eeff", "#d7dbe3", "#24292f")
  readonly property color surfaceMuted: pick("#66636c", "#ada5cc", "#8a93a5", "#636c76")
  readonly property color edge: pick("#1b1a1f", "#9d7bff", "#5c6577", "#818b95")
  readonly property color rule: pick("#261b1a1f", "#3a3258", "#2a2f38", "#d0d7de")
  readonly property color shadow: pick("#1b1a1f", "#ff4fa3", "transparent", "transparent")
  // Each state's meaning colour, as stamps and tags use it; each passes 4.5:1 on the surface.
  readonly property var tones: pick(
    { TODO: "#b3311f", PROG: "#1c4f8f", EVAL: "#5a3fa0", HOLD: "#7a5900", AUTO: "#0f6b5e", DONE: "#2f6b22" },
    { TODO: "#ff5c7a", PROG: "#3fe0f0", EVAL: "#b48cff", HOLD: "#ffc247", AUTO: "#4ff0c8", DONE: "#a8f05a" },
    { TODO: "#ff8f80", PROG: "#8fb4ff", EVAL: "#c9a8ff", HOLD: "#ffd36b", AUTO: "#6fd6c8", DONE: "#86e08f" },
    { TODO: "#cf222e", PROG: "#0550ae", EVAL: "#8250df", HOLD: "#9a6700", AUTO: "#1b7c83", DONE: "#1a7f37" })
  function tone(state) { return tones[state] ?? edge; }
  // Each clanker's frame colour by harness; the console has none, so its frames use the edge.
  readonly property var harnessTones: pick(Harnesses.HARNESS_TONES.paper, Harnesses.HARNESS_TONES.neon, {}, {})
  function harnessTone(name) { return harnessTones[name] ?? harnessTones.other ?? edge; }
  // The boards' type scale in pixels, the phone's in sp (Look.Type), so the boards keep the phone's proportions to the
  // strip, whose lettering already matches it. Each has its line height set: Zen Kaku Gothic New's own is nearly a line tall,
  // so a wrapped title would otherwise read as two rows. Words.qml sets a Text from a role.
  readonly property var type: ({
    masthead: { family: display, size: consoleLook ? 20 : 26, line: consoleLook ? 26 : 32, weight: consoleLook ? Font.Bold : Font.Normal, spacing: 0 },
    title: { family: caption, size: consoleLook ? 17 : 20, line: consoleLook ? 23 : 26, weight: Font.Bold, spacing: 0 },
    name: { family: display, size: consoleLook ? 16 : 18, line: consoleLook ? 21 : 23, weight: consoleLook ? Font.Bold : Font.Normal, spacing: 0 },
    row: { family: caption, size: consoleLook ? 14 : 15, line: 20, weight: Font.Bold, spacing: 0 },
    meta: { family: caption, size: 12.5, line: 17, weight: Font.Medium, spacing: 0 },
    label: { family: caption, size: 10.5, line: 14, weight: Font.Bold, spacing: 1.2 },
    section: { family: caption, size: 12, line: 16, weight: Font.Bold, spacing: 1.4 },
    button: { family: caption, size: 14, line: 18, weight: Font.Bold, spacing: 0 },
    value: { family: caption, size: 15, line: 20, weight: Font.Medium, spacing: 0 },
    body: { family: caption, size: 14, line: 20, weight: Font.Medium, spacing: 0 },
    lettering: { family: lettering, size: consoleLook ? 14 : 15, line: 20.5, weight: Font.Medium, spacing: 0 },
    number: { family: "monospace", size: 12, line: 16, weight: Font.Bold, spacing: 0.5 },
  })

  readonly property string lettering: consoleLook ? "monospace" : "Shantell Sans"
  readonly property string display: consoleLook ? "monospace" : "Dela Gothic One"
  readonly property string caption: consoleLook ? "monospace" : "Zen Kaku Gothic New"

  readonly property int stripWidth: 820
  // The bottom bars, the compose bar and the boards' section bars, as the phone has both: one height, a pill.
  readonly property int barHeight: 46
  readonly property real line: consoleLook ? 1.5 : 2.5

  function hash(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return h;
  }
  function tint(id) { return tints[Math.abs(hash(id)) % tints.length]; }
}
