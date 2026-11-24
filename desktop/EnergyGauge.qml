// Energy (quota) as a gauge of ten cells, filled in its tone: high, mid, low or unknown. The console prints GAUGE,
// "[######----]". Matches the phone's EnergyGauge.
import QtQuick

Item {
  id: gauge
  property int level: -1
  property string tone: "unknown"
  property string gauge: ""
  property real cell: 5
  // A stale level (the last good read, kept over a failed one) is grey, as an unknown one is.
  readonly property color colour: tone === "high" ? Theme.tone("DONE") : tone === "mid" ? Theme.tone("HOLD") : tone === "low" ? Theme.tone("TODO") : Theme.surfaceMuted
  readonly property int cells: level < 0 ? 0 : Math.max(level > 0 ? 1 : 0, Math.min(10, Math.round(level / 10)))
  implicitWidth: Theme.consoleLook ? text.implicitWidth : cell * 10 + 1.5 * 9 + 10
  implicitHeight: Theme.consoleLook ? text.implicitHeight : cell * 2 + 2

  Words { id: text; visible: Theme.consoleLook; role: "number"; text: gauge.gauge !== "" ? gauge.gauge : "[??????????]"; color: gauge.colour }
  Item {
    visible: !Theme.consoleLook
    anchors.fill: parent
    Rectangle {
      width: parent.width - 3; height: parent.height
      radius: 3
      color: "transparent"
      border.color: Qt.alpha(Theme.surfaceInk, Theme.neon ? 0.45 : 1)
      border.width: Theme.neon ? 1.25 : 1.75
    }
    Rectangle { x: parent.width - 3; y: parent.height * 0.3; width: 3; height: parent.height * 0.4; radius: 1; color: Qt.alpha(Theme.surfaceInk, Theme.neon ? 0.45 : 1) }
    Row {
      x: 3; y: 3
      spacing: 1.5
      Repeater {
        model: 10
        delegate: Rectangle {
          required property int index
          width: gauge.cell; height: gauge.height - 6
          radius: 1
          // Unknown is not empty: every cell greyed, so an unread quota never looks spent.
          color: gauge.level < 0 ? Qt.alpha(Theme.surfaceMuted, 0.35) : index < gauge.cells ? gauge.colour : Theme.rule
          border.color: index < gauge.cells && Theme.neon ? Qt.alpha(gauge.colour, 0.5) : "transparent"
          border.width: Theme.neon ? 1 : 0
        }
      }
    }
  }
}
