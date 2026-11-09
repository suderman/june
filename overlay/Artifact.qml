// A copy-ready beat on the code preview's dark ground. The full source never passes through rich text or elision.
import QtQuick
import "Code.mjs" as Code

Rectangle {
  id: artifact
  property var content: ({ text: "", language: "text", lines: null })
  property real maxWidth: 400
  signal preview(var item)
  signal copyText(string text)
  readonly property real w: Math.min(maxWidth, 460)
  readonly property real h: 112 + Math.min(body.implicitHeight, 144)
  readonly property var short: Code.excerpt(content)
  width: w; height: h
  radius: 8
  color: Theme.cardFill
  border.color: Theme.ink; border.width: Theme.line

  // Tapping the excerpt opens the same modal as attachments. Copy is a separate target above it.
  MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: artifact.open() }
  function open() { preview({ kind: "artifact", name: content.language === "text" ? "Copy text" : content.language, text: content.text, lines: content.lines }); }
  Text {
    x: 14; y: 19
    width: artifact.w - copy.width - 42
    text: artifact.content.language === "text" ? "Copy text" : artifact.content.language
    textFormat: Text.PlainText
    elide: Text.ElideRight
    font.family: Theme.caption; font.pixelSize: 14; font.bold: true
    color: Theme.cardInk
  }
  ArtifactButton {
    id: copy
    objectName: "copy"
    anchors.top: parent.top; anchors.topMargin: 8
    anchors.right: parent.right; anchors.rightMargin: 10
    label: copied.running ? "Copied" : "Copy"
    onClicked: { artifact.copyText(artifact.content.text); copied.restart(); }
  }
  Timer { id: copied; interval: 1600 }
  onContentChanged: copied.stop()
  Item {
    x: 14; y: 56
    width: artifact.w - 28; height: Math.min(body.implicitHeight, 144)
    clip: true
    Text {
      id: body
      objectName: "excerpt"
      width: parent.width
      text: artifact.short.lines ? Code.html(artifact.short.lines) : artifact.short.text
      textFormat: artifact.short.lines ? Text.RichText : Text.PlainText
      wrapMode: Text.WrapAnywhere
      font.family: "monospace"; font.pixelSize: 14
      color: Theme.cardInk
    }
  }
  ArtifactButton {
    objectName: "expand"
    anchors.bottom: parent.bottom; anchors.bottomMargin: 8
    anchors.left: parent.left; anchors.leftMargin: 10
    label: artifact.short.truncated || body.implicitHeight > 144 ? "… Preview full text" : "Preview full text"
    onClicked: artifact.open()
  }
}
