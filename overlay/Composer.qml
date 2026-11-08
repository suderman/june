// The user's balloon: Enter steers, Shift+Enter queues, Alt+Enter adds a line, Ctrl+C with nothing selected stops June.
// `send(text, followUp)` returns whether the words went (or were dropped as empty); the balloon clears only then.
// Pictures and files ride along (attach.mjs): Ctrl+V attaches a screenshot or copied files, else pastes words; + picks
// files; what is attached shows above the words, each removed with a click.
import QtQuick
import QtQuick.Controls

Rectangle {
  id: composer

  property var send: (text, followUp) => true
  property var stop: () => {}
  property alias text: input.text
  // What waits for the next message ({ kind, name, mimeType, data }), how to drop one, attach the clipboard (calling
  // `fallback` to paste words when it holds no picture or file), and pick files.
  property var attachments: []
  property var unattach: (index) => {}
  property var paste: (fallback) => fallback()
  property var pick: () => {}

  function clear() { input.clear(); }
  function focusInput() { input.forceActiveFocus(); }

  readonly property real shelf: attachments.length > 0 ? 54 : 0
  height: Math.min(input.contentHeight + 34, 220) + shelf
  radius: Theme.consoleLook ? 6 : Math.min(height / 2, 30)
  color: Theme.balloon
  border.color: Theme.consoleLook ? Theme.muted : Theme.ink
  border.width: Theme.consoleLook ? 1.5 : 3
  clip: true

  // Attached pictures as thumbnails and files by name, above the words.
  ListView {
    id: shelfView
    visible: composer.shelf > 0
    x: 26; y: 10
    width: composer.width - 52; height: 40
    orientation: ListView.Horizontal
    spacing: 8
    model: composer.attachments
    delegate: Rectangle {
      required property var modelData
      required property int index
      height: 40
      width: (modelData.kind === "picture" ? 40 : Math.min(180, label.implicitWidth + 16)) + 22
      radius: 6
      color: Theme.noteFill
      border.color: Theme.noteLine; border.width: 1.5
      Image {
        visible: modelData.kind === "picture"
        x: 3; y: 3; width: 34; height: 34
        fillMode: Image.PreserveAspectCrop
        source: modelData.kind === "picture" ? "data:" + modelData.mimeType + ";base64," + modelData.data : ""
        sourceSize.width: 96
        asynchronous: true
      }
      Text {
        id: label
        visible: modelData.kind !== "picture"
        x: 8; anchors.verticalCenter: parent.verticalCenter
        width: Math.min(180, implicitWidth)
        elide: Text.ElideMiddle
        text: modelData.name
        font.family: Theme.caption; font.pixelSize: 13; color: Theme.noteInk
      }
      Text {
        anchors.right: parent.right; anchors.rightMargin: 6; anchors.verticalCenter: parent.verticalCenter
        text: "✕"; font.pixelSize: 13; color: Theme.noteLine
      }
      MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: composer.unattach(index) }
    }
  }

  // Attach files from a picker.
  Text {
    id: plus
    x: 14
    anchors.bottom: parent.bottom; anchors.bottomMargin: (Math.min(input.contentHeight + 34, 220) - height) / 2
    text: "+"
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 22; color: Theme.muted
    MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: composer.pick() }
  }

  ScrollView {
    anchors.fill: parent
    anchors.leftMargin: 36
    anchors.rightMargin: 26
    anchors.topMargin: 10 + composer.shelf
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
        if (event.key === Qt.Key_V && (event.modifiers & Qt.ControlModifier)) {
          composer.paste(() => input.paste());
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
