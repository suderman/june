// A placeholder clanker, until the art lands (see the clanker threads in art.org): a round hovering body with one
// large eye in its harness's colour, two claws, an antenna and a hover glow, drawn on a 64-unit square. A mark in its
// corner says what it needs: "!" blocked, "?" asking, "new" for review.
import QtQuick
import "board.mjs" as Board

Item {
  id: clanker

  property string harness: "other"
  property string mark: ""
  property color markColor: "#b3311f"
  property bool claws: true
  property real size: 40

  width: size
  height: size

  readonly property var colours: Board.HARNESS[harness] ?? Board.HARNESS.other

  Canvas {
    id: canvas
    anchors.fill: parent
    antialiasing: true
    onPaint: {
      const ctx = getContext("2d");
      ctx.reset();
      ctx.scale(width / 64, height / 64);
      const ink = "#1b1a1f";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.strokeStyle = ink;
      // The hover glow under it.
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = clanker.colours.eye;
      ctx.beginPath(); ctx.ellipse(17, 56, 30, 6); ctx.fill();
      ctx.globalAlpha = 1;
      // Antenna and its tip.
      ctx.beginPath(); ctx.moveTo(32, 11); ctx.lineTo(32, 5); ctx.stroke();
      ctx.beginPath(); ctx.arc(32, 5, 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      if (clanker.claws) {
        ctx.beginPath(); ctx.moveTo(13, 30); ctx.quadraticCurveTo(6, 35, 9, 44); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(51, 30); ctx.quadraticCurveTo(58, 35, 55, 44); ctx.stroke();
      }
      // Body, band, and the one large eye.
      ctx.fillStyle = "#f3e3d3";
      ctx.beginPath(); ctx.arc(32, 31, 20, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = clanker.colours.band;
      ctx.beginPath(); ctx.ellipse(17, 40.5, 30, 9); ctx.fill(); ctx.stroke();
      ctx.fillStyle = ink;
      ctx.beginPath(); ctx.arc(34, 28, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = clanker.colours.eye;
      ctx.beginPath(); ctx.arc(34, 28, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fffcf5";
      ctx.beginPath(); ctx.arc(31, 25, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }
  onHarnessChanged: canvas.requestPaint()
  onClawsChanged: canvas.requestPaint()
  onWidthChanged: canvas.requestPaint()

  Rectangle {
    visible: clanker.mark !== ""
    anchors.right: parent.right
    anchors.top: parent.top
    anchors.rightMargin: -6
    anchors.topMargin: -6
    height: 18
    width: Math.max(18, markText.implicitWidth + 8)
    radius: 9
    color: clanker.markColor
    Text {
      id: markText
      anchors.centerIn: parent
      text: clanker.mark
      color: "#fffcf5"
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 11
    }
  }
}
