// Live June's card: her live loop on a tinted card, gently alive even when the art is a still. The same card is the
// corner's anchor in min mode and stays in the same place in max mode, so she never moves between them.
import QtQuick

Rectangle {
  id: cardBox

  property string liveState: "sipping"
  property var art: null
  property bool running: true

  signal clicked()

  readonly property bool busy: ["typing", "thinking", "digging", "delegating", "watching", "tidying", "listening", "speaking"].includes(liveState)

  width: 150
  height: 150
  radius: 22
  color: liveState === "offline" ? "#e7e2d6" : busy ? Theme.noteFill : "#f6dccb"
  border.color: Theme.ink
  border.width: 3
  clip: true

  Item {
    id: stage
    anchors.fill: parent
    anchors.margins: 3
    property real bob: 0
    SequentialAnimation on bob {
      running: cardBox.running && (!cardBox.art || cardBox.art.frames <= 1)
      loops: Animation.Infinite
      NumberAnimation { to: cardBox.liveState === "snoozing" ? 4 : 3; duration: cardBox.liveState === "snoozing" ? 1600 : cardBox.busy ? 380 : 900; easing.type: Easing.InOutSine }
      NumberAnimation { to: 0; duration: cardBox.liveState === "snoozing" ? 1600 : cardBox.busy ? 380 : 900; easing.type: Easing.InOutSine }
    }
    Image {
      visible: cardBox.art !== null && cardBox.art.frames <= 1
      y: stage.bob
      width: stage.width
      height: stage.height
      source: cardBox.art && cardBox.art.frames <= 1 ? cardBox.art.url : ""
      sourceSize.width: 288
      sourceSize.height: 288
      fillMode: Image.PreserveAspectFit
      smooth: true
    }
    Image { id: sheetSize; visible: false; source: cardBox.art && cardBox.art.frames > 1 ? cardBox.art.url : "" }
    AnimatedSprite {
      visible: cardBox.art !== null && cardBox.art.frames > 1
      anchors.fill: parent
      source: cardBox.art && cardBox.art.frames > 1 ? cardBox.art.url : ""
      frameCount: cardBox.art ? Math.max(1, cardBox.art.frames) : 1
      frameRate: cardBox.art && cardBox.art.fps > 0 ? cardBox.art.fps : 8
      frameWidth: cardBox.art && cardBox.art.frames > 1 ? sheetSize.sourceSize.width / cardBox.art.frames : 1
      frameHeight: sheetSize.sourceSize.height
      loops: cardBox.art && cardBox.art.play === "once" ? 1 : AnimatedSprite.Infinite
      running: cardBox.running && visible
      interpolate: false
    }
  }

  MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: cardBox.clicked() }
}
