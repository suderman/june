// One host's page in its sheet (board.mjs agentsView hosts), as the phone's HostDetail draws it: whether it answers
// and its load, its harnesses with the quota each would spend, its sessions (each opens where it runs), and the
// clankers that work there.
import QtQuick

Item {
  id: page
  property var host: null
  signal open(string link)

  readonly property bool ok: host?.ok ?? false
  readonly property var sessions: host?.sessions ?? []
  readonly property var clankers: host?.clankers ?? []
  readonly property var harnesses: host?.harnesses ?? []

  Words {
    visible: page.host === null
    width: parent.width
    role: "lettering"
    wrapMode: Text.Wrap
    text: "That host is no longer on the board."
    color: Theme.muted
  }

  Flickable {
    visible: page.host !== null
    anchors.fill: parent
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width - 4
      spacing: 10

      Column {
        width: parent.width
        Words { role: "masthead"; text: page.host?.host ?? ""; color: Theme.pageInk }
        Words {
          role: "meta"
          text: page.ok ? "online · " + (page.host?.working ?? 0) + " working" : "offline"
          color: page.ok ? Theme.muted : Theme.tone("TODO")
        }
        Words { visible: (page.host?.loadText ?? "") !== ""; role: "number"; text: page.host?.loadText ?? ""; color: Theme.pageInk }
        Words {
          visible: (page.host?.error ?? "") !== ""
          width: parent.width
          role: "meta"
          wrapMode: Text.Wrap
          maximumLineCount: 4
          elide: Text.ElideRight
          text: page.host?.error ?? ""
          color: Theme.muted
        }
      }

      SectionRule { visible: page.harnesses.length > 0; text: "HARNESSES · " + page.harnesses.length }
      Pad {
        visible: page.harnesses.length > 0
        Repeater {
          model: page.harnesses
          delegate: Item {
            id: harnessRow
            required property var modelData
            required property int index
            width: parent ? parent.width : 0
            height: Math.max(48, harnessText.implicitHeight + 16)
            Rectangle { visible: harnessRow.index > 0; x: 12; width: parent.width - 24; height: 1; color: Theme.rule }
            Clanker { id: harnessArt; x: 12; anchors.verticalCenter: parent.verticalCenter; harness: harnessRow.modelData.clanker; size: 26; claws: false }
            Column {
              id: harnessText
              anchors.left: harnessArt.right; anchors.leftMargin: 10; anchors.right: parent.right; anchors.rightMargin: 12
              anchors.verticalCenter: parent.verticalCenter
              spacing: 3
              Words { role: "row"; text: harnessRow.modelData.harness; color: Theme.surfaceInk }
              EnergyGauge { level: harnessRow.modelData.batteryLevel; tone: harnessRow.modelData.batteryTone; gauge: harnessRow.modelData.gauge }
              Words {
                width: parent.width
                role: "meta"
                elide: Text.ElideRight
                text: (harnessRow.modelData.energyText || "unknown") + (harnessRow.modelData.batteryAccount ? " · " + harnessRow.modelData.batteryAccount : "")
                color: Theme.surfaceMuted
              }
            }
          }
        }
      }

      SectionRule { text: "SESSIONS · " + page.sessions.length }
      Words {
        visible: page.sessions.length === 0
        role: "lettering"
        text: page.ok ? "No sessions." : "Out of reach."
        color: Theme.muted
      }
      Pad {
        visible: page.sessions.length > 0
        Repeater {
          model: page.sessions
          delegate: StubRow {
            required property var modelData
            required property int index
            first: index === 0
            title: modelData.title; meta: modelData.where + " · " + modelData.status
            harness: modelData.harness; artSize: 26
            opens: (modelData.link ?? "") !== ""
            onClicked: if ((modelData.link ?? "") !== "") page.open(modelData.link)
          }
        }
      }

      SectionRule { text: "CLANKERS · " + page.clankers.length }
      Words {
        width: parent.width
        role: "lettering"
        wrapMode: Text.Wrap
        text: page.clankers.length ? page.clankers.join(", ") : "None work here."
        color: page.clankers.length ? Theme.pageInk : Theme.muted
      }
    }
  }
}
