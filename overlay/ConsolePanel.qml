// One exchange in the console look: the panel's lines (console.mjs) in a terminal style, prefix and words on one line,
// selectable for copying. While she works in the newest panel, a quiet status line says what she is doing. See "The
// console look" in docs/interfaces.org.
import QtQuick
import "console.mjs" as Console
import "strip.mjs" as Strip

Item {
  id: row

  required property string json
  property bool newest: false
  property string activity: ""
  // A link in June's words was clicked.
  signal link(string url)

  readonly property var p: JSON.parse(json)
  readonly property var out: Console.lines(p)

  height: column.implicitHeight + 6

  function colour(line) {
    if (line.kind === "user") return Theme.consoleUser;
    if (line.kind === "june") return Theme.consoleJune;
    if (line.kind === "tool") return line.status === "error" ? Theme.consoleFail : line.status === "running" ? Theme.consoleBusy : Theme.consoleOk;
    if (line.kind === "burst") return Theme.accent;
    return Theme.muted;
  }
  function escaped(text) { return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function body(line) {
    if (line.kind === "june") return Strip.markup(line.text, { stress: "font-weight:700; color:" + Theme.ink, code: "color:" + Theme.consoleJune, link: "color:" + Theme.noteLine }) + (line.streaming ? "<span style='color:" + Theme.accent + "'> ▍</span>" : "");
    const quiet = line.kind === "tool" || line.kind === "thought";
    return "<span style='color:" + (quiet ? Theme.muted : Theme.ink) + "'>" + escaped(line.text).replace(/\n/g, "<br>") + "</span>";
  }

  Column {
    id: column
    width: parent.width
    spacing: 6
    Repeater {
      model: row.out
      delegate: TextEdit {
        required property var modelData
        width: column.width
        readOnly: true
        selectByMouse: true
        wrapMode: TextEdit.Wrap
        textFormat: TextEdit.RichText
        text: (modelData.prefix === "" ? "" : "<span style='color:" + row.colour(modelData) + "; font-weight:700'>" + row.escaped(modelData.prefix) + "</span> ") + row.body(modelData)
        font.family: "monospace"
        font.pixelSize: modelData.kind === "tool" || modelData.kind === "thought" ? 13 : 15
        color: Theme.ink
        selectionColor: Theme.highlight
        selectedTextColor: Theme.ink
        onLinkActivated: url => row.link(url)
        HoverHandler { cursorShape: parent.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.IBeamCursor }
      }
    }
    Text {
      visible: row.p.live === true && row.activity !== ""
      text: "… " + row.activity
      font.family: "monospace"
      font.pixelSize: 13
      color: Theme.consoleBusy
    }
  }
}
