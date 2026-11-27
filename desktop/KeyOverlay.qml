// Visual cues for modal keyboard navigation: a compact Which-Key-style bottom bar for the SPC leader, and a
// context-aware `?` cheatsheet modal (mirrors Jon's Emacs `SPC ?`). Driven entirely by keys.mjs.
import QtQuick
import "keys.mjs" as KeyNav

Item {
  id: overlay

  property bool leader: false
  property bool helpOpen: false
  property string surface: "window"
  property string column: "chat"
  property string sheet: ""
  signal closeHelp()

  z: 40
  visible: leader || helpOpen

  // Compact SPC leader strip along the bottom.
  Rectangle {
    visible: overlay.leader && !overlay.helpOpen
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 14
    width: Math.min(parent.width - 32, leaderRow.implicitWidth + 28)
    height: leaderRow.implicitHeight + 16
    radius: 8
    color: Theme.cardFill
    border.color: Theme.accent
    border.width: 1.5
    Flow {
      id: leaderRow
      anchors.centerIn: parent
      width: Math.min(overlay.width - 60, implicitWidth)
      spacing: 12
      Text {
        text: "SPC"
        font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 12
        color: Theme.accent
      }
      Repeater {
        model: KeyNav.LEADER_HINTS
        delegate: Row {
          required property var modelData
          spacing: 5
          Text { text: modelData.key; font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 12; color: Theme.cardBusy }
          Text { text: modelData.label; font.family: Theme.caption; font.pixelSize: 12; color: Theme.cardInk }
        }
      }
    }
  }

  // Context-aware `?` cheatsheet overlay.
  Rectangle {
    visible: overlay.helpOpen
    anchors.fill: parent
    color: Qt.rgba(0, 0, 0, 0.45)
    MouseArea { anchors.fill: parent; onClicked: overlay.closeHelp() }

    Rectangle {
      anchors.centerIn: parent
      width: Math.min(parent.width - 40, 560)
      height: Math.min(parent.height - 40, helpBody.implicitHeight + 36)
      radius: 10
      color: Theme.cardFill
      border.color: Theme.cardLine
      border.width: 1.5
      MouseArea { anchors.fill: parent }

      Column {
        id: helpBody
        anchors.fill: parent
        anchors.margins: 18
        spacing: 12

        Row {
          width: parent.width
          Text {
            text: "Keyboard · NORMAL mode"
            font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 15
            color: Theme.cardInk
          }
          Item { width: 12; height: 1 }
          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: "Tab toggles Insert ↔ Normal · ? or Esc closes"
            font.family: Theme.caption; font.pixelSize: 12
            color: Theme.muted
          }
        }

        Row {
          width: parent.width
          spacing: 20
          Repeater {
            model: KeyNav.helpSections(overlay.surface, overlay.column, overlay.sheet)
            delegate: Column {
              required property var modelData
              readonly property int sectionCount: Math.max(1, KeyNav.helpSections(overlay.surface, overlay.column, overlay.sheet).length)
              width: (helpBody.width - (sectionCount > 1 ? 20 : 0)) / sectionCount
              spacing: 6
              Text {
                text: modelData.title
                font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
                color: Theme.accent
              }
              Repeater {
                model: modelData.rows
                delegate: Row {
                  required property var modelData
                  width: parent.width
                  spacing: 8
                  Text {
                    width: 84
                    text: modelData[0]
                    font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 12
                    color: Theme.cardBusy
                  }
                  Text {
                    width: parent.width - 92
                    text: modelData[1]
                    elide: Text.ElideRight
                    font.family: Theme.caption; font.pixelSize: 12
                    color: Theme.cardInk
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
