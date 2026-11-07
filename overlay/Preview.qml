// A picture the user's message brought, shown over the strip rather than in another app: fitted to the window on a dark
// ground, with its name, "open in browser" to hand it to the desktop's app, and a close. Esc (the window's shortcut),
// the close, or a click outside the picture closes it. See "Previewing what a message brought" in docs/interfaces.org.
import QtQuick

Item {
  id: preview
  // { url, name } of the picture shown, or null when closed.
  property var what: null
  readonly property bool open: what !== null
  // Asks the window to open the url with the desktop's app.
  signal external(string url)
  visible: open
  z: 100

  function show(item) { what = item; }
  function close() { what = null; }

  Rectangle { anchors.fill: parent; color: "#000000"; opacity: 0.86 }
  // A click on the ground closes it; one on the picture or the buttons does not.
  MouseArea { objectName: "ground"; anchors.fill: parent; onClicked: preview.close() }

  Image {
    id: picture
    objectName: "picture"
    anchors.fill: parent
    anchors.topMargin: 64; anchors.bottomMargin: 56; anchors.leftMargin: 24; anchors.rightMargin: 24
    fillMode: Image.PreserveAspectFit
    asynchronous: true
    source: preview.open ? preview.what.url : ""
    sourceSize.width: 2400
    sourceSize.height: 2400
    Item {
      anchors.centerIn: parent
      width: picture.paintedWidth; height: picture.paintedHeight
      MouseArea { anchors.fill: parent }
    }
  }

  Text {
    objectName: "status"
    anchors.centerIn: parent
    visible: picture.status !== Image.Ready
    text: picture.status === Image.Error ? "It could not be loaded. June's inbox may have dropped it." : "loading…"
    font.family: Theme.caption; font.pixelSize: 16; color: "#ffffff"
  }

  Text {
    anchors.bottom: parent.bottom; anchors.bottomMargin: 18; anchors.horizontalCenter: parent.horizontalCenter
    width: Math.min(implicitWidth, parent.width - 48)
    elide: Text.ElideMiddle
    text: preview.open ? (preview.what.name ?? "") : ""
    font.family: Theme.caption; font.pixelSize: 15; color: "#ffffff"
  }

  Row {
    anchors.top: parent.top; anchors.topMargin: 16; anchors.right: parent.right; anchors.rightMargin: 16
    spacing: 10
    Button { objectName: "external"; label: "open in browser"; onClicked: preview.external(preview.what.url) }
    Button { objectName: "close"; label: "✕"; onClicked: preview.close() }
  }

  component Button: Rectangle {
    id: button
    property string label: ""
    signal clicked()
    width: text.implicitWidth + 28
    height: 34
    radius: 17
    color: "#ffffff"
    opacity: area.containsMouse ? 1 : 0.88
    Text {
      id: text
      anchors.centerIn: parent
      text: button.label
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 14; color: Theme.ink
    }
    MouseArea { id: area; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: button.clicked() }
  }
}
