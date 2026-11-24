// A board's pages as folder tabs standing on the rule under its masthead, the current one lifted and filled. TABS
// are { id, label }; picking one says its id. The console draws "[current]  other" over a one-pixel rule.
import QtQuick

Column {
  id: tabs
  property var tabs: []
  property string current: ""
  signal picked(string id)
  width: parent ? parent.width : 0

  Row {
    spacing: Theme.consoleLook ? 12 : 4
    height: 32
    Repeater {
      model: tabs.tabs
      delegate: Item {
        id: tab
        required property var modelData
        readonly property bool on: modelData.id === tabs.current
        width: words.implicitWidth + (Theme.consoleLook ? 4 : 26)
        height: 32
        Rectangle {
          visible: !Theme.consoleLook
          anchors.bottom: parent.bottom
          width: parent.width
          height: tab.on ? 30 : 26
          topLeftRadius: 7; topRightRadius: 7
          color: tab.on ? (Theme.neon ? Theme.surface : Theme.edge) : hover.containsMouse ? Qt.alpha(Theme.pageInk, 0.06) : Theme.paper
          border.color: Theme.neon ? (tab.on ? Theme.accent : Theme.rule) : Theme.edge
          border.width: 2
        }
        Rectangle {
          visible: Theme.consoleLook && tab.on
          anchors.centerIn: words
          width: words.implicitWidth + 2; height: words.implicitHeight
          color: Theme.pageInk
        }
        Words {
          id: words
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.bottom: parent.bottom
          anchors.bottomMargin: Theme.consoleLook ? 6 : tab.on ? 8 : 5
          role: "button"
          text: Theme.consoleLook ? (tab.on ? "[" + tab.modelData.label + "]" : tab.modelData.label) : tab.modelData.label
          color: Theme.consoleLook ? (tab.on ? Theme.paper : Theme.muted)
            : tab.on ? (Theme.neon ? Theme.accent : Theme.surface) : Theme.neon ? Theme.muted : Theme.pageInk
        }
        MouseArea { id: hover; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: tabs.picked(tab.modelData.id) }
      }
    }
  }
  Rectangle { width: tabs.width; height: Theme.consoleLook ? 1 : 2.5; color: Theme.neon ? Theme.accent : Theme.edge }
}
