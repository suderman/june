// A state or status as a rubber stamp: TONE ink in a double border, tilted a little (paper); a small neon sign
// (neon); a bracketed tag (console). An OFF stamp, a choice not taken, has a faint dashed edge and no fill, its text
// still at full strength to read. With `clickable` it is a button. Matches the phone's Stamp.
import QtQuick
import QtQuick.Shapes

Item {
  id: stamp
  property string text: ""
  property color tone: Theme.edge
  property bool on: true
  property bool big: false
  property bool clickable: false
  // A slight, steady tilt from its text, within about two degrees either way.
  property real tilt: ((Math.abs(Theme.hash(text)) % 5) - 2) * 0.9
  signal clicked()

  readonly property string label: text.toUpperCase()
  readonly property color ink: on || !Theme.consoleLook ? tone : Theme.muted
  implicitWidth: words.implicitWidth + (Theme.consoleLook ? 0 : big ? 18 : 12)
  implicitHeight: Math.max(stamp.clickable ? 26 : 0, words.implicitHeight + (Theme.consoleLook ? 0 : big ? 8 : 4))

  Item {
    id: face
    anchors.centerIn: parent
    width: words.implicitWidth + (Theme.consoleLook ? 0 : stamp.big ? 18 : 12)
    height: words.implicitHeight + (Theme.consoleLook ? 0 : stamp.big ? 8 : 4)
    rotation: Theme.consoleLook ? 0 : stamp.tilt
    // Neon's glow, then the stamp's ink, its inner line, or the faint dashed edge of a choice not taken.
    Repeater {
      model: Theme.neon && stamp.on ? [[7, 0.10], [4, 0.22]] : []
      delegate: Rectangle {
        required property var modelData
        x: -modelData[0] / 2; y: -modelData[0] / 2
        width: face.width + modelData[0]; height: face.height + modelData[0]
        radius: 3 + modelData[0] / 2
        color: "transparent"; border.color: stamp.tone; border.width: modelData[0]; opacity: modelData[1]
      }
    }
    Rectangle {
      visible: !Theme.consoleLook && stamp.on
      anchors.fill: parent
      radius: 3
      color: Qt.alpha(stamp.tone, Theme.neon ? 0.14 : hover.containsMouse ? 0.14 : 0.07)
      border.color: stamp.ink
      border.width: Theme.neon ? 1.5 : 2
      Rectangle {
        visible: !Theme.neon
        anchors.fill: parent; anchors.margins: 3
        radius: 1.5
        color: "transparent"; border.color: Qt.alpha(stamp.ink, 0.55); border.width: 0.8
      }
    }
    Shape {
      visible: !Theme.consoleLook && !stamp.on
      anchors.fill: parent
      preferredRendererType: Shape.CurveRenderer
      ShapePath {
        strokeColor: Qt.alpha(stamp.ink, hover.containsMouse ? 0.9 : 0.45)
        strokeWidth: Theme.neon ? 1.1 : 1.5
        fillColor: hover.containsMouse ? Qt.alpha(stamp.tone, 0.08) : "transparent"
        strokeStyle: ShapePath.DashLine
        dashPattern: [3, 2]
        PathRectangle { x: 0.75; y: 0.75; width: face.width - 1.5; height: face.height - 1.5; radius: 3 }
      }
    }
    // The console's chosen tag is inverted; a neutral one inverts to the page's ink, which reads where grey would not.
    Rectangle {
      visible: Theme.consoleLook && stamp.on && stamp.clickable
      anchors.fill: parent
      color: Qt.colorEqual(stamp.tone, Theme.edge) ? Theme.pageInk : stamp.tone
    }
    Words {
      id: words
      anchors.centerIn: parent
      role: stamp.big ? "button" : "label"
      font.letterSpacing: Theme.type.label.spacing
      text: Theme.consoleLook ? "[" + stamp.label + "]" : stamp.label
      color: Theme.consoleLook && stamp.on && stamp.clickable ? Theme.paper : stamp.ink
    }
  }
  MouseArea {
    id: hover
    anchors.fill: parent
    enabled: stamp.clickable
    hoverEnabled: true
    cursorShape: Qt.PointingHandCursor
    onClicked: stamp.clicked()
  }
}
