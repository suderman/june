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
  property var hints: []
  property string hintTyped: ""
  signal closeHelp()

  z: 40
  visible: leader || helpOpen || (hints && hints.length > 0)

  // Avy / Vimium-style `f` hint badges positioned over visible links, files, artifacts, and tool chips.
  Repeater {
    model: overlay.hints && !overlay.helpOpen ? overlay.hints : []
    delegate: Rectangle {
      required property var modelData
      readonly property bool matches: overlay.hintTyped === "" || String(modelData.code ?? "").indexOf(overlay.hintTyped) === 0
      x: Math.max(6, Math.min(overlay.width - width - 6, modelData.x))
      y: Math.max(6, Math.min(overlay.height - height - 48, modelData.y))
      width: Math.max(22, codeText.implicitWidth + 10)
      height: 20
      radius: 4
      color: Theme.accent
      border.color: Theme.paper
      border.width: 1.5
      opacity: matches ? 0.96 : 0.22
      Text {
        id: codeText
        anchors.centerIn: parent
        text: String(modelData.code ?? "").toUpperCase()
        font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 11
        color: Theme.paper
      }
    }
  }

  // Bottom legend strip for active `f` hint mode so every letter clearly identifies its target.
  Rectangle {
    visible: overlay.hints && overlay.hints.length > 0 && !overlay.helpOpen
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 10
    width: Math.min(parent.width - 24, 620)
    height: hintLegend.implicitHeight + 16
    radius: 8
    color: Theme.cardFill
    border.color: Theme.accent
    border.width: 1.5
    Flow {
      id: hintLegend
      anchors.centerIn: parent
      width: parent.width - 24
      spacing: 10
      Text {
        text: overlay.hintTyped !== "" ? "HINT " + overlay.hintTyped.toUpperCase() : "HINT"
        font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 12
        color: Theme.accent
      }
      Repeater {
        model: overlay.hints ? overlay.hints.slice(0, 12) : []
        delegate: Row {
          required property var modelData
          readonly property bool matches: overlay.hintTyped === "" || String(modelData.code ?? "").indexOf(overlay.hintTyped) === 0
          visible: matches
          spacing: 4
          Text { text: "[" + String(modelData.code ?? "") + "]"; font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 11; color: Theme.cardBusy }
          Text {
            text: String(modelData.label ?? "").length > 26 ? String(modelData.label ?? "").slice(0, 25) + "…" : String(modelData.label ?? "")
            font.family: Theme.caption; font.pixelSize: 11
            color: Theme.cardInk
          }
        }
      }
      Text { text: "Esc cancel"; font.family: Theme.caption; font.pixelSize: 11; color: Theme.muted }
    }
  }

  // Compact SPC leader strip along the bottom.
  Rectangle {
    visible: overlay.leader && !overlay.helpOpen
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 10
    width: Math.min(parent.width - 24, 620)
    height: leaderRow.implicitHeight + 16
    radius: 8
    color: Theme.cardFill
    border.color: Theme.accent
    border.width: 1.5
    Flow {
      id: leaderRow
      anchors.centerIn: parent
      width: parent.width - 24
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
      width: Math.min(parent.width - 24, 560)
      height: Math.min(parent.height - 24, helpBody.implicitHeight + 28)
      radius: 10
      color: Theme.cardFill
      border.color: Theme.cardLine
      border.width: 1.5
      clip: true
      MouseArea { anchors.fill: parent }

      Flickable {
        anchors.fill: parent
        anchors.margins: 14
        contentHeight: helpBody.implicitHeight
        clip: true
        boundsBehavior: Flickable.StopAtBounds

      Column {
        id: helpBody
        width: parent.width
        spacing: 10

        Row {
          width: parent.width
          Text {
            text: "Keyboard · NORMAL mode"
            font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 14
            color: Theme.cardInk
          }
          Item { width: 10; height: 1 }
          Text {
            anchors.verticalCenter: parent.verticalCenter
            text: "i Insert · Esc Normal · ? closes"
            font.family: Theme.caption; font.pixelSize: 12
            color: Theme.muted
          }
        }

        Row {
          width: parent.width
          spacing: 16
          Repeater {
            model: KeyNav.helpSections(overlay.surface, overlay.column, overlay.sheet)
            delegate: Column {
              required property var modelData
              readonly property int sectionCount: Math.max(1, KeyNav.helpSections(overlay.surface, overlay.column, overlay.sheet).length)
              width: (helpBody.width - (sectionCount > 1 ? 16 : 0)) / sectionCount
              spacing: 5
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
                  spacing: 6
                  Text {
                    width: 78
                    text: modelData[0]
                    font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 12
                    color: Theme.cardBusy
                  }
                  Text {
                    width: parent.width - 84
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
}
