// One host's page in its sheet (board.mjs agentsView hosts), as the phone's HostDetail draws it: whether it answers,
// its sessions (each opens where it runs), and the clankers that work there.
import QtQuick

Item {
  id: page
  property var host: null
  signal open(string link)

  readonly property bool ok: host?.ok ?? false
  readonly property var sessions: host?.sessions ?? []
  readonly property var clankers: host?.clankers ?? []

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
