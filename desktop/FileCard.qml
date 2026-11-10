// A file the user's message brought, clipped to their note: a page with its corner folded, the file's name and size.
// A click asks to open it (Panel opens it with the desktop's app for its type) while June's inbox keeps it; once it has
// expired the card is greyed and closed.
import QtQuick
import QtQuick.Shapes

Item {
  id: card
  // { n, name, size, expired } from Strip.noteFiles.
  property var file: ({})
  // Where the daemon serves it, or "" before the hello says where files are.
  property string url: ""
  readonly property bool openable: !file.expired && url !== ""
  signal chosen(string url)
  height: 26
  rotation: file.n % 2 === 0 ? -1 : 1
  opacity: file.expired ? 0.5 : 1
  Rectangle { anchors.fill: parent; color: "#fbf8f1"; border.color: Theme.ink; border.width: 1.5; radius: 3 }
  Shape {
    x: 8; y: 4; width: 14; height: 18
    preferredRendererType: Shape.CurveRenderer
    ShapePath {
      strokeColor: Theme.ink; strokeWidth: 1.5; fillColor: "#ffffff"; joinStyle: ShapePath.RoundJoin
      PathSvg { path: "M 0 0 L 9 0 L 14 5 L 14 18 L 0 18 Z M 9 0 L 9 5 L 14 5" }
    }
  }
  Text {
    id: size
    objectName: "size"
    anchors.right: parent.right; anchors.rightMargin: 8; anchors.verticalCenter: parent.verticalCenter
    text: card.file.expired ? "expired" : (card.file.size ?? "")
    font.family: Theme.caption; font.pixelSize: 12; color: Theme.noteLine
  }
  Text {
    objectName: "name"
    x: 28; anchors.verticalCenter: parent.verticalCenter
    width: size.x - 8 - x
    text: card.file.name ?? ""
    elide: Text.ElideMiddle
    font.family: Theme.caption; font.weight: Font.Medium; font.pixelSize: 14; color: Theme.noteInk
  }
  MouseArea {
    anchors.fill: parent
    enabled: card.openable
    cursorShape: Qt.PointingHandCursor
    onClicked: card.chosen(card.url)
  }
}
