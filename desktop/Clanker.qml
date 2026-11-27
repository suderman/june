// A placeholder clanker, until the art lands (see the clanker threads in art.org): a round hovering body with one
// large eye in its harness's colour, two claws, an antenna and a hover glow, drawn on a 64-unit square. A mark in its
// corner says what it needs: "!" blocked, "?" asking, "new" for review. In neon it is drawn in its harness's light on
// a dark body; the console has no art, only a glyph.
import QtQuick
import "board.mjs" as Board

Item {
  id: clanker

  property string harness: "other"
  property string mark: ""
  property color markColor: "#b3311f"
  property bool claws: true
  property real size: 40
  // Horizontal gaze direction: 1 looks right, -1 looks left.
  property int facing: 1

  width: size
  height: size

  readonly property var colours: Board.HARNESS[harness] ?? Board.HARNESS.other

  Text {
    visible: Theme.consoleLook
    anchors.verticalCenter: parent.verticalCenter
    text: "(o)"
    font.family: "monospace"; font.pixelSize: 11; font.bold: true
    color: Theme.muted
  }
  Canvas {
    id: canvas
    visible: !Theme.consoleLook
    anchors.fill: parent
    antialiasing: true
    onPaint: {
      const ctx = getContext("2d");
      ctx.reset();
      ctx.scale(width / 64, height / 64);
      const neon = Theme.neon;
      const ink = neon ? Theme.harnessTone(clanker.harness) : "#1b1a1f";
      ctx.lineWidth = 2.5;
      ctx.lineCap = "round";
      ctx.strokeStyle = ink;
      // The hover glow under it.
      ctx.globalAlpha = neon ? 0.55 : 0.4;
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
      // Body, band, and the one large eye; neon adds a halo round the body.
      if (neon) { ctx.globalAlpha = 0.18; ctx.lineWidth = 5; ctx.beginPath(); ctx.arc(32, 31, 23, 0, Math.PI * 2); ctx.stroke(); ctx.globalAlpha = 1; ctx.lineWidth = 2.5; }
      ctx.fillStyle = neon ? "#2a2347" : "#f3e3d3";
      ctx.beginPath(); ctx.arc(32, 31, 20, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      ctx.fillStyle = clanker.colours.band;
      ctx.beginPath(); ctx.ellipse(17, 40.5, 30, 9); ctx.fill(); ctx.stroke();
      const eyeX = 32 + 2.5 * (clanker.facing < 0 ? -1 : 1);
      const glintX = eyeX - 2.5 * (clanker.facing < 0 ? -1 : 1);
      ctx.fillStyle = neon ? "#0e0b18" : ink;
      ctx.beginPath(); ctx.arc(eyeX, 28, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = clanker.colours.eye;
      ctx.beginPath(); ctx.arc(eyeX, 28, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fffcf5";
      ctx.beginPath(); ctx.arc(glintX, 25, 2.2, 0, Math.PI * 2); ctx.fill();
    }
  }
  onHarnessChanged: canvas.requestPaint()
  onClawsChanged: canvas.requestPaint()
  onFacingChanged: canvas.requestPaint()
  onWidthChanged: canvas.requestPaint()
  Connections { target: Theme; function onDarkChanged() { canvas.requestPaint(); } function onConsoleLookChanged() { canvas.requestPaint(); } }

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
