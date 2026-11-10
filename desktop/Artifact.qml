// Display clipping never changes the source used for preview or copy.
import QtQuick
import "Code.mjs" as Code

Rectangle {
  id: artifact
  property var content: ({ text: "", language: "text", lines: null })
  property real maxWidth: 400
  signal preview(var item)
  signal copyText(string text)
  readonly property real w: Math.min(maxWidth, 460)
  readonly property real h: 80 + Math.min(body.implicitHeight, 144) + (overflow ? 48 : 0)
  readonly property var short: Code.excerpt(content)
  readonly property bool overflow: short.truncated || body.implicitHeight > 144
  readonly property int hiddenLines: Math.max(0, content.text.split("\n").length - short.text.split("\n").length)
  width: w; height: h
  radius: 15
  color: "#252836"
  border.color: "#b9a4d8"; border.width: 1

  Rectangle {
    anchors.fill: parent; anchors.margins: 3
    color: "transparent"; radius: 12
    border.color: "#e8dfd5"; border.width: 1.5
  }
  MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: artifact.open() }
  function open() { preview({ kind: "artifact", name: content.language === "text" ? "Copy text" : content.language, text: content.text, lines: content.lines }); }
  ArtifactIcon {
    visible: artifact.content.language === "text"
    x: 16; y: 16; name: "envelope"; ink: "#cfb9f0"
  }
  Rectangle {
    id: language
    visible: artifact.content.language !== "text"
    x: 16; y: 14
    width: Math.min(title.implicitWidth + 20, artifact.w - 132); height: 28
    radius: 14; color: "#49405c"
  }
  Text {
    id: title
    objectName: "title"
    x: artifact.content.language === "text" ? 48 : 26
    y: 18
    width: artifact.w - x - 116
    text: artifact.content.language === "text" ? "Copy text" : artifact.content.language
    textFormat: Text.PlainText; elide: Text.ElideRight
    font.family: Theme.caption; font.pixelSize: 14; font.weight: Font.DemiBold
    color: artifact.content.language === "text" ? "#e4e8f2" : "#e3cef9"
  }
  ArtifactButton {
    objectName: "expand"
    x: parent.width - 108; y: 4
    label: "Preview full text"; icon: "preview"
    onClicked: artifact.open()
  }
  Rectangle { x: parent.width - 59; y: 18; width: 1; height: 20; color: "#685c7b" }
  ArtifactButton {
    objectName: "copy"
    x: parent.width - 55; y: 4
    label: copied.running ? "Copied" : "Copy full text"
    icon: copied.running ? "check" : "copy"
    ink: copied.running ? "#c3e88d" : "#e4e8f2"
    onClicked: { artifact.copyText(artifact.content.text); copied.restart(); }
  }
  Timer { id: copied; interval: 1600 }
  onContentChanged: copied.stop()
  Rectangle { x: 5; y: 55; width: parent.width - 10; height: 1; color: "#685c7b" }
  Item {
    x: 16; y: 68
    width: artifact.w - 32; height: Math.min(body.implicitHeight, 144)
    clip: true
    Text {
      id: body
      objectName: "excerpt"
      width: parent.width
      text: artifact.short.lines ? Code.html(artifact.short.lines) : artifact.short.text
      textFormat: artifact.short.lines ? Text.RichText : Text.PlainText
      wrapMode: Text.Wrap
      font.family: "monospace"; font.pixelSize: 14
      color: "#e4e8f2"
    }
  }
  Rectangle {
    visible: artifact.overflow
    x: 5; y: artifact.h - 51; width: parent.width - 10; height: 46
    radius: 10; color: "#383346"
    Rectangle { width: parent.width; height: 10; color: parent.color }
    Rectangle { width: parent.width; height: 1; color: "#685c7b" }
    ArtifactButton {
      objectName: "more"
      anchors.fill: parent
      label: "Show more" + (artifact.hiddenLines > 0 && body.implicitHeight <= 144 ? " (" + artifact.hiddenLines + (artifact.hiddenLines === 1 ? " line)" : " lines)") : "")
      icon: "chevron"; showLabel: true; ink: "#cfb9f0"
      onClicked: artifact.open()
    }
  }
}
