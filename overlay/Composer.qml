// The user's balloon: Enter steers, Shift+Enter queues, Alt+Enter adds a line, Ctrl+C with nothing selected stops June.
// `send(text, followUp)` returns whether the words went (or were dropped as empty); the balloon clears only then.
import QtQuick
import QtQuick.Controls

Rectangle {
  id: composer

  property var send: (text, followUp) => true
  property var stop: () => {}
  property alias text: input.text

  function clear() { input.clear(); }
  function focusInput() { input.forceActiveFocus(); }

  height: Math.min(input.contentHeight + 34, 220)
  radius: Theme.consoleLook ? 6 : Math.min(height / 2, 30)
  color: Theme.balloon
  border.color: Theme.consoleLook ? Theme.muted : Theme.ink
  border.width: Theme.consoleLook ? 1.5 : 3
  clip: true

  ScrollView {
    anchors.fill: parent
    anchors.leftMargin: 26
    anchors.rightMargin: 26
    anchors.topMargin: 10
    anchors.bottomMargin: 10
    TextArea {
      id: input
      placeholderText: Theme.consoleLook ? "› message june" : "your balloon…"
      wrapMode: TextEdit.Wrap
      font.family: Theme.lettering
      font.pixelSize: Theme.consoleLook ? 15 : 19
      color: Theme.ink
      placeholderTextColor: Theme.consoleLook ? Theme.muted : "#9a958a"
      background: null
      Keys.onPressed: event => {
        if (event.key === Qt.Key_C && (event.modifiers & Qt.ControlModifier) && input.selectedText === "") {
          composer.stop();
          event.accepted = true;
          return;
        }
        if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter) return;
        if (event.modifiers & Qt.AltModifier) { input.insert(input.cursorPosition, "\n"); event.accepted = true; return; }
        if (composer.send(input.text, Boolean(event.modifiers & Qt.ShiftModifier))) input.clear();
        event.accepted = true;
      }
    }
  }
}
