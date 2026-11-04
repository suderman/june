// The strip's design tokens, until the theme system serves them (see "Themes" in docs/interfaces.org).
pragma Singleton
import QtQuick
import Quickshell

Singleton {
  readonly property color ink: "#1b1a1f"
  readonly property color paper: "#f6f1e7"
  readonly property color muted: "#6d6a73"
  readonly property color backdrop: "#b80a0c14"
  readonly property color accent: "#d8432f"

  // June's balloons: warm cream with ink outlines; stressed words in bold on a highlighter stroke.
  readonly property color balloon: "#fffcf5"
  readonly property color highlight: "#ffe27a"
  // The user's notes: light blue, tailless, from outside the frame.
  readonly property color noteFill: "#dbe7ff"
  readonly property color noteLine: "#5470b8"
  readonly property color noteInk: "#1c2a52"
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
  readonly property color captionFill: "#fff3c4"

  // Panel grounds, picked per panel so neighbours differ: dusk lilac, peach, sky, sage, sand.
  readonly property var tints: ["#e6d7ea", "#f6dccb", "#d7e4f2", "#dfead6", "#f2e3c8"]

  readonly property string lettering: "Shantell Sans"
  readonly property string display: "Dela Gothic One"
  readonly property string caption: "Zen Kaku Gothic New"

  readonly property int stripWidth: 820
  readonly property real line: 2.5

  function hash(id) {
    let h = 0;
    for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
    return h;
  }
  function tint(id) { return tints[Math.abs(hash(id)) % tints.length]; }
}
