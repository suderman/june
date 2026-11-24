// A clanker's portrait window: a frame in its harness colour over a screentone wash of the same, the clanker in it,
// and its status STAMP across it when it is not idle. The console shows a framed glyph.
import QtQuick

Item {
  id: portrait
  property string harness: "other"
  property string stamp: ""
  property real art: 40
  readonly property color frame: Theme.consoleLook ? Theme.edge : Theme.harnessTone(harness)
  readonly property color stampTone: stamp === "ON DUTY" ? Theme.tone("PROG") : stamp === "INVALID" ? Theme.tone("TODO") : Theme.muted

  Inked { anchors.fill: parent; radius: 4; edge: portrait.frame; fill: Qt.tint(Theme.surface, Qt.alpha(portrait.frame, 0.10)); lift: 0; lineWidth: 2.5 }
  Item {
    anchors.fill: parent; anchors.margins: 2.5
    clip: true
    Screentone { anchors.fill: parent; tint: portrait.frame; density: Theme.neon ? 0.22 : 0.2 }
  }
  Clanker { anchors.centerIn: parent; size: portrait.art; harness: portrait.harness }
  Stamp {
    visible: portrait.stamp !== ""
    anchors.horizontalCenter: parent.horizontalCenter
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 5
    text: portrait.stamp
    tone: portrait.stampTone
    tilt: -3
    // A small portrait's stamp shrinks to stay inside its frame.
    scale: Math.min(1, (portrait.width - 4) / Math.max(1, implicitWidth))
    transformOrigin: Item.Bottom
  }
}
