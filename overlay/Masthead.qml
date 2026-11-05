// The strip's masthead: June's name, the connection or what she is doing, and a "meanwhile" card while briefs run.
import QtQuick

Row {
  id: masthead

  property bool linked: false
  property int refusals: 0
  property string host: ""
  property int background: 0
  // What she is doing in plain words, and the tasks she follows for a click (strip.mjs status).
  property string status: ""
  property var detail: []
  property bool detailOpen: false
  // Do not disturb: she stays down until summoned.
  property bool quiet: false

  height: 30
  spacing: 12
  // The follow list hangs below over the strip.
  z: 5
  Text { text: "june"; font.family: Theme.display; font.pixelSize: 22; color: Theme.pageInk; anchors.verticalCenter: parent.verticalCenter }
  Text {
    id: said
    anchors.verticalCenter: parent.verticalCenter
    text: (!masthead.linked ? (masthead.refusals >= 2 ? "pairing needed: check this device's token" : "reconnecting to " + masthead.host + "…") : masthead.status) + (masthead.quiet ? " · do not disturb" : "") + (masthead.linked && masthead.detail.length > 0 ? (masthead.detailOpen ? "  ▴" : "  ▾") : "")
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
    color: masthead.linked && !masthead.detail.some(f => f.needsYou) ? Theme.muted : Theme.accent
    MouseArea {
      anchors.fill: parent
      enabled: masthead.detail.length > 0
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: masthead.detailOpen = !masthead.detailOpen
    }
    // What she follows: each task and where it stands, a click on the line away.
    Rectangle {
      visible: masthead.detailOpen && masthead.linked && masthead.detail.length > 0
      y: parent.height + 8
      width: Math.max(260, follows.implicitWidth + 24)
      height: follows.implicitHeight + 16
      radius: 6
      color: Theme.cardFill
      border.color: Theme.cardLine
      border.width: 1.5
      Column {
        id: follows
        x: 12; y: 8
        spacing: 4
        Repeater {
          model: masthead.detail
          delegate: Text {
            required property var modelData
            text: modelData.title + "  ·  " + modelData.state
            font.family: Theme.caption; font.pixelSize: 12; font.weight: modelData.needsYou ? Font.Bold : Font.Normal
            color: modelData.needsYou ? Theme.accent : Theme.pageInk
          }
        }
      }
    }
  }
  // Background briefs: a small inked "meanwhile" card, the comic's cutaway to work going on elsewhere.
  Rectangle {
    visible: masthead.linked && masthead.background > 0
    anchors.verticalCenter: parent.verticalCenter
    width: meanwhile.implicitWidth + 20
    height: 26
    radius: 6
    color: Theme.cardFill
    border.color: Theme.cardLine
    border.width: 1.5
    Text {
      id: meanwhile
      anchors.centerIn: parent
      text: "meanwhile, on " + masthead.host + " · " + (masthead.background === 1 ? "1 brief" : masthead.background + " briefs")
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
      color: Theme.cardBusy
    }
  }
}
