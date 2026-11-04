// The strip's design tokens, until the theme system serves them (see "Themes" in docs/interfaces.org). Two looks: the
// comic strip, and the console (`consoleLook`, set by the shell), a terminal style for when June should look professional.
// Components draw from these tokens, so most follow the look without knowing it.
pragma Singleton
import QtQuick
import Quickshell

Singleton {
  property bool consoleLook: false

  readonly property color ink: consoleLook ? "#d7dbe3" : "#1b1a1f"
  readonly property color paper: consoleLook ? "#121418" : "#f6f1e7"
  readonly property color muted: consoleLook ? "#7d8697" : "#6d6a73"
  readonly property color backdrop: consoleLook ? "#cc05070a" : "#b80a0c14"
  readonly property color accent: consoleLook ? "#ff8f80" : "#d8432f"

  // June's balloons: warm cream with ink outlines; stressed words in bold on a highlighter stroke.
  readonly property color balloon: consoleLook ? "#1a1d23" : "#fffcf5"
  readonly property color highlight: consoleLook ? "#3a4150" : "#ffe27a"
  // The user's notes: light blue, tailless, from outside the frame.
  readonly property color noteFill: consoleLook ? "#1a1d23" : "#dbe7ff"
  readonly property color noteLine: consoleLook ? "#6d8fd6" : "#5470b8"
  readonly property color noteInk: consoleLook ? "#c9d7f5" : "#1c2a52"
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
  readonly property color captionFill: consoleLook ? "#262a33" : "#fff3c4"
  // The console's own: her name, the user's prompt, and quiet lines.
  readonly property color consoleJune: "#e9c46a"
  readonly property color consoleUser: "#8fb4ff"

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
