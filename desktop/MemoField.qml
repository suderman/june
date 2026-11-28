// A multi-line reply on a lined memo pad: a faint rule under every line and a margin line at the left, as a pad of
// paper has; in neon the rules glow faintly, in the console it is a framed "> " prompt. Ctrl+Enter says submitted().
import QtQuick
import QtQuick.Controls

Item {
  id: memo
  property alias text: area.text
  property string placeholder: ""
  property int lines: 3
  signal submitted()
  signal escaped()
  function focusField() { area.forceActiveFocus(); }
  function blurField() { area.focus = false; }
  width: parent ? parent.width : 0
  implicitHeight: Math.max(lines * Theme.type.body.line + 20, area.implicitHeight + 4)

  Inked { anchors.fill: parent; radius: 4; lift: Theme.consoleLook ? 0 : 2; lineWidth: Theme.neon ? 1.5 : 1.75 }
  Canvas {
    id: ruling
    anchors.fill: parent
    visible: !Theme.consoleLook
    onPaint: {
      const ctx = getContext("2d");
      ctx.reset();
      ctx.lineWidth = 1;
      ctx.strokeStyle = Theme.neon ? Theme.rule : Qt.alpha(Theme.noteLine, 0.28);
      for (let y = 10 + Theme.type.body.line; y < height - 4; y += Theme.type.body.line) {
        ctx.beginPath(); ctx.moveTo(4, y + 0.5); ctx.lineTo(width - 4, y + 0.5); ctx.stroke();
      }
      ctx.strokeStyle = Theme.neon ? Qt.alpha(Theme.accent, 0.45) : "#66d8432f";
      ctx.lineWidth = 1.25;
      ctx.beginPath(); ctx.moveTo(18.5, 2); ctx.lineTo(18.5, height - 2); ctx.stroke();
    }
    onHeightChanged: requestPaint()
    onWidthChanged: requestPaint()
  }
  Words {
    visible: Theme.consoleLook
    x: 8; y: 9
    role: "body"
    text: ">"
    color: Theme.surfaceMuted
  }
  TextArea {
    id: area
    anchors.fill: parent
    leftPadding: Theme.consoleLook ? 22 : 26
    rightPadding: 10; topPadding: 9; bottomPadding: 9
    wrapMode: TextEdit.Wrap
    placeholderText: memo.placeholder
    placeholderTextColor: Theme.surfaceMuted
    color: Theme.surfaceInk
    selectionColor: Qt.alpha(Theme.neon ? Theme.accent : Theme.edge, 0.3)
    font.family: Theme.type.body.family
    font.pixelSize: Theme.type.body.size
    background: null
    Keys.onPressed: event => {
      if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && (event.modifiers & Qt.ControlModifier)) {
        memo.submitted();
        event.accepted = true;
      } else if (event.key === Qt.Key_Escape) {
        area.focus = false;
        memo.escaped();
        event.accepted = true;
      }
    }
  }
}
