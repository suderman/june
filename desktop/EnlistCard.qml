// One enlisted clanker in the roster list (board.mjs rosterView): portrait, name and service number, class and
// loadout, energy, and its service record when it has one; its status stamp only when it is not idle.
import QtQuick

Item {
  id: card
  property var entry
  signal clicked()
  width: parent ? parent.width : 0
  implicitHeight: Math.max(portrait.height, lines.implicitHeight) + 20
  readonly property color stampTone: entry.stamp === "ON DUTY" ? Theme.tone("PROG") : entry.stamp === "INVALID" ? Theme.tone("TODO") : Theme.muted

  Inked { anchors.fill: parent; lift: 3 }
  Rectangle { anchors.fill: parent; anchors.margins: 2; radius: 4; visible: hover.containsMouse; color: Qt.alpha(Theme.surfaceInk, 0.04) }
  Portrait {
    id: portrait
    visible: !Theme.consoleLook
    x: 10
    anchors.verticalCenter: parent.verticalCenter
    width: 52; height: 52
    harness: card.entry.clanker
    stamp: card.entry.stamp ?? ""
    art: 40
  }
  Words {
    id: glyph
    visible: Theme.consoleLook
    x: 10
    anchors.verticalCenter: parent.verticalCenter
    role: "number"
    text: "(o)"
    color: Theme.muted
  }
  Column {
    id: lines
    x: Theme.consoleLook ? glyph.x + glyph.implicitWidth + 10 : portrait.x + portrait.width + 10
    width: card.width - x - 10
    anchors.verticalCenter: parent.verticalCenter
    spacing: 2
    Item {
      width: parent.width
      height: name.implicitHeight
      // The status rides the portrait; the console, with no portrait, tags it after the name.
      Words { id: name; width: parent.width - number.width - (stamped.visible ? stamped.width + 6 : 0) - 6; role: "name"; elide: Text.ElideRight; text: card.entry.name }
      Stamp { id: stamped; visible: Theme.consoleLook && (card.entry.stamp ?? "") !== ""; anchors.right: number.left; anchors.rightMargin: 6; anchors.verticalCenter: parent.verticalCenter; text: card.entry.stamp ?? ""; tone: card.stampTone }
      Words { id: number; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; role: "number"; text: card.entry.serviceNo ?? ""; color: Theme.surfaceMuted }
    }
    Words {
      width: parent.width
      role: "meta"
      elide: Text.ElideRight
      textFormat: Text.StyledText
      text: "<b><font color='" + (Theme.consoleLook ? Theme.surfaceInk : Theme.harnessTone(card.entry.clanker)) + "'>" + (card.entry.harness !== "" ? card.entry.harness : "no class").toUpperCase() + "</font></b>"
        + ((card.entry.loadout ?? "") !== "" ? "  ·  " + card.entry.loadout : "")
      color: Theme.surfaceMuted
    }
    Row {
      visible: (card.entry.energyText ?? "") !== ""
      topPadding: 3
      spacing: 7
      EnergyGauge { id: energy; anchors.verticalCenter: parent.verticalCenter; level: card.entry.batteryLevel; tone: card.entry.batteryTone; gauge: card.entry.gauge ?? "" }
      Words {
        width: lines.width - energy.width - 7
        anchors.verticalCenter: parent.verticalCenter
        role: "meta"
        font.weight: card.entry.batteryLevel >= 0 ? Font.Bold : Font.Medium
        elide: Text.ElideRight
        text: card.entry.energyText ?? ""
        color: card.entry.batteryLevel >= 0 ? Theme.surfaceInk : Theme.surfaceMuted
      }
    }
    Words { visible: (card.entry.statsLine ?? "") !== ""; width: parent.width; role: "meta"; elide: Text.ElideRight; text: card.entry.statsLine ?? ""; color: Theme.surfaceMuted }
  }
  MouseArea { id: hover; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: card.clicked() }
}
