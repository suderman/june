// A board's sections as a sub-navbar at its bottom, as the phone's SectionBar draws it in the compose bar's place: each
// section's name, the showing one filled. A click on a section goes there; on the one showing, it resets it.
import QtQuick

Rectangle {
  id: bar
  // [{ id, label, badge }]
  property var sections: []
  property string current: ""
  signal picked(string id)

  readonly property int at: Math.max(0, sections.findIndex(s => s.id === current))
  readonly property real cell: (width - 8) / Math.max(1, sections.length)

  // The compose bar's height, fill and line, so the bottom bars line up across the columns as on the phone.
  implicitHeight: Theme.barHeight
  radius: Theme.consoleLook ? 0 : height / 2
  color: Theme.surface
  border.color: Theme.rule
  border.width: 1

  // The fill under the showing section, sliding when it changes.
  Rectangle {
    x: 4 + bar.at * bar.cell
    y: 4
    width: bar.cell
    height: bar.height - 8
    radius: Theme.consoleLook ? 0 : height / 2
    color: Theme.pageInk
    Behavior on x { NumberAnimation { duration: 160; easing.type: Easing.OutCubic } }
  }

  Row {
    x: 4; y: 4
    Repeater {
      model: bar.sections
      delegate: Item {
        id: cellItem
        required property var modelData
        required property int index
        readonly property bool on: index === bar.at
        width: bar.cell
        height: bar.height - 8
        Row {
          anchors.centerIn: parent
          spacing: 4
          Words {
            anchors.verticalCenter: parent.verticalCenter
            role: "button"
            text: Theme.consoleLook && cellItem.on ? "[" + cellItem.modelData.label + "]" : cellItem.modelData.label
            color: cellItem.on ? Theme.paper : (hover.hovered ? Theme.pageInk : Theme.muted)
          }
          // What needs the user, after the name, as the tab bar counts it.
          Rectangle {
            visible: (cellItem.modelData.badge ?? 0) > 0
            anchors.verticalCenter: parent.verticalCenter
            width: Math.max(16, badgeText.implicitWidth + 8); height: 16; radius: 8
            color: Theme.accent
            Words { id: badgeText; anchors.centerIn: parent; role: "number"; text: String(cellItem.modelData.badge ?? 0); color: Theme.paper }
          }
        }
        HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: bar.picked(cellItem.modelData.id) }
      }
    }
  }
}
