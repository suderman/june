// The five-icon Muse-style bottom bar for narrow desktop windows and overlays: Terminal, Agents, Chat, Projects,
// Editor. The three middle icons switch tabs; the outer two focus or launch Herdr and Emacs.
import QtQuick
import QtQuick.Controls

Item {
  id: bar

  property string tab: "chat"
  property int needs: 0
  signal chooseTab(string name)
  signal launch(string app)

  implicitHeight: 48
  height: 48

  readonly property var items: [
    { kind: "terminal", tip: "Terminal (Alt+1)", app: "terminal" },
    { kind: "agents", tip: "Agents (Alt+2)", page: "agents" },
    { kind: "chat", tip: "Chat (Alt+3)", page: "chat" },
    { kind: "projects", tip: "Projects (Alt+4)", page: "projects" },
    { kind: "editor", tip: "Editor (Alt+5)", app: "editor" },
  ]

  Rectangle {
    anchors.top: parent.top
    anchors.left: parent.left
    anchors.right: parent.right
    height: 1
    color: Theme.pageInk
    opacity: 0.12
  }

  Row {
    anchors.fill: parent
    Repeater {
      model: bar.items
      delegate: Item {
        required property var modelData
        readonly property bool selected: Boolean(modelData.page) && bar.tab === modelData.page
        width: bar.width / bar.items.length
        height: bar.height

        Rectangle {
          anchors.centerIn: parent
          width: 44
          height: 36
          radius: 10
          color: Theme.pageInk
          opacity: hover.containsMouse ? 0.08 : 0
        }

        TabIcon {
          anchors.centerIn: parent
          width: 24
          height: 24
          kind: modelData.kind
          on: selected
          ink: selected || hover.containsMouse ? Theme.pageInk : Theme.muted
          paper: Theme.paper
        }

        Rectangle {
          visible: modelData.kind === "agents" && bar.needs > 0
          anchors.horizontalCenter: parent.horizontalCenter
          anchors.verticalCenter: parent.verticalCenter
          anchors.horizontalCenterOffset: 12
          anchors.verticalCenterOffset: -10
          width: Math.max(16, countText.implicitWidth + 8)
          height: 16
          radius: 8
          color: Theme.accent
          Text {
            id: countText
            anchors.centerIn: parent
            text: String(bar.needs)
            font.family: Theme.caption
            font.weight: Font.Bold
            font.pixelSize: 10
            color: Theme.paper
          }
        }

        MouseArea {
          id: hover
          anchors.fill: parent
          hoverEnabled: true
          cursorShape: Qt.PointingHandCursor
          onClicked: {
            if (modelData.page) bar.chooseTab(modelData.page);
            else if (modelData.app) bar.launch(modelData.app);
          }
        }

        ToolTip.visible: hover.containsMouse
        ToolTip.delay: 500
        ToolTip.text: modelData.tip
      }
    }
  }
}
