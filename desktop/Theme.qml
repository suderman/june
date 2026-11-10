// The strip's design tokens, until the theme system serves them (see "Themes" in docs/interfaces.org). Two looks, each
// light or dark, set by the shell: the comic strip, and the console (`consoleLook`), a terminal style for when June
// should look professional; `dark` follows the desktop's colour scheme unless the device holds to one. In the comic's
// dark the page darkens while panels and balloons stay printed, so text set on the page uses `pageInk`. Components draw
// from these tokens, so most follow the look without knowing it.
pragma Singleton
import QtQuick
import Quickshell

Singleton {
  property bool consoleLook: false
  property bool dark: false

  // A token by look and scheme: the comic's light and dark, the console's dark and light.
  function pick(comic, comicDark, console_, consoleLight) {
    return consoleLook ? (dark ? console_ : consoleLight) : (dark ? comicDark : comic);
  }

  readonly property color ink: pick("#1b1a1f", "#1b1a1f", "#d7dbe3", "#24292f")
  // Words and controls set straight on the page rather than inside a panel or balloon.
  readonly property color pageInk: pick("#1b1a1f", "#ece6da", "#d7dbe3", "#24292f")
  readonly property color paper: pick("#f6f1e7", "#1c1b21", "#121418", "#f6f7f9")
  readonly property color muted: pick("#6d6a73", "#a39fab", "#7d8697", "#6e7781")
  readonly property color backdrop: pick("#b80a0c14", "#cc05070a", "#cc05070a", "#990a0c14")
  readonly property color accent: pick("#d8432f", "#ff7a66", "#ff8f80", "#cf222e")

  // June's balloons: warm cream with ink outlines; stressed words in bold on a highlighter stroke.
  readonly property color balloon: pick("#fffcf5", "#fffcf5", "#1a1d23", "#ffffff")
  readonly property color highlight: pick("#ffe27a", "#ffe27a", "#3a4150", "#dde3ea")
  // The user's notes: light blue, tailless, from outside the frame.
  readonly property color noteFill: pick("#dbe7ff", "#dbe7ff", "#1a1d23", "#ffffff")
  readonly property color noteLine: pick("#5470b8", "#5470b8", "#6d8fd6", "#0969da")
  readonly property color noteInk: pick("#1c2a52", "#1c2a52", "#c9d7f5", "#0a3069")
  // Tools: one call as a lavender chip, several as a terminal status card.
  readonly property color chipFill: "#ebe5ff"
  readonly property color chipInk: "#3d3466"
  readonly property color cardFill: "#1f2433"
  readonly property color cardLine: "#5b6683"
  readonly property color cardInk: "#e4e8f2"
  readonly property color cardOk: "#86e08f"
  readonly property color cardFail: "#ff8f80"
  readonly property color cardBusy: "#ffd36b"
  readonly property color burstFill: "#ffd6cf"
  // Captions and toasts: a pale yellow box, as a comic's narration.
  readonly property color captionFill: pick("#fff3c4", "#fff3c4", "#262a33", "#eef0f3")
  // The console's own: her name, the user's prompt, and a tool line's status.
  readonly property color consoleJune: dark ? "#e9c46a" : "#9a6700"
  readonly property color consoleUser: dark ? "#8fb4ff" : "#0550ae"
  readonly property color consoleOk: dark ? "#86e08f" : "#1a7f37"
  readonly property color consoleFail: dark ? "#ff8f80" : "#cf222e"
  readonly property color consoleBusy: dark ? "#ffd36b" : "#9a6700"

  // Panel grounds, picked per panel so neighbours differ: dusk lilac, peach, sky, sage, sand.
  readonly property var tints: ["#e6d7ea", "#f6dccb", "#d7e4f2", "#dfead6", "#f2e3c8"]

  readonly property string lettering: consoleLook ? "monospace" : "Shantell Sans"
  readonly property string display: consoleLook ? "monospace" : "Dela Gothic One"
  readonly property string caption: consoleLook ? "monospace" : "Zen Kaku Gothic New"

  readonly property int stripWidth: 820
  readonly property real line: consoleLook ? 1.5 : 2.5

  function hash(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return h;
  }
  function tint(id) { return tints[Math.abs(hash(id)) % tints.length]; }
}
