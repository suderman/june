// The user's balloon: Enter steers, Shift+Enter queues, Alt+Enter adds a line, Ctrl+C with nothing selected stops June.
// `send(text, followUp)` returns whether the words went (or were dropped as empty); the balloon clears only then.
// Pictures and files ride along (attach.mjs): Ctrl+V or Shift+Insert attaches a screenshot or copied files, else pastes
// words; + picks
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
  // Tab and Esc in the text box: both drop from Insert to Normal mode.
  property var tabAction: null
  property var escAction: null
  // True when the host window is in NORMAL mode: dims caret/border and shows a compact NORMAL badge.
  property bool normalMode: false
  signal enteredInsert()

  function clear() { input.clear(); }
  function focusInput() { input.forceActiveFocus(); }
  function blurInput() { input.focus = false; }
  // Quick accent flash + micro-pop when Left Alt routes focus to an already-visible June window.
  property real flashStrength: 0
  function flash() { focusFlash.restart(); }
  SequentialAnimation {
    id: focusFlash
    NumberAnimation { target: composer; property: "flashStrength"; from: 0; to: 1; duration: 70; easing.type: Easing.OutCubic }
    PauseAnimation { duration: 60 }
    NumberAnimation { target: composer; property: "flashStrength"; from: 1; to: 0; duration: 380; easing.type: Easing.OutCubic }
  }
  transform: Scale {
    origin.x: composer.width / 2
    origin.y: composer.height / 2
    xScale: 1 + 0.018 * composer.flashStrength
    yScale: 1 + 0.06 * composer.flashStrength
  }

  readonly property real shelf: attachments.length > 0 ? 54 : 0
  // The phone's compose bar: Theme.barHeight for a line, as tall as the boards' section bars beside it, growing with
  // more; the section bars' fill and line, a pill.
  readonly property real words: Math.min(Math.max(Theme.barHeight, input.contentHeight + 24), 220)
  height: words + shelf
  radius: Theme.consoleLook ? 6 : Math.min(height / 2, Theme.barHeight / 2)
  color: Theme.surface
  border.color: !normalMode && input.activeFocus ? Theme.accent : Theme.rule
  border.width: !normalMode && input.activeFocus ? 1.5 : 1
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

  // Attach files from a picker: the phone's 36-pixel button at the bar's last line.
  Item {
    id: plus
    x: 5
    width: 36; height: 36
    anchors.bottom: parent.bottom; anchors.bottomMargin: 5
    Text {
      anchors.centerIn: parent
      text: "+"
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 22; color: Theme.muted
    }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: composer.pick() }
  }

  ScrollView {
    anchors.fill: parent
    anchors.leftMargin: 5 + 36 + 6
    anchors.rightMargin: composer.normalMode ? 78 : 18
    anchors.topMargin: 12 + composer.shelf
    anchors.bottomMargin: 12
    TextArea {
      id: input
      placeholderText: Theme.consoleLook ? "› message june" : "to june…"
      wrapMode: TextEdit.Wrap
      padding: 0
      font.family: Theme.lettering
      font.pixelSize: 15
      color: Theme.balloonInk
      placeholderTextColor: Theme.consoleLook || Theme.neon ? Theme.muted : "#9a958a"
      background: null
      onActiveFocusChanged: if (activeFocus && composer.normalMode) composer.enteredInsert()
      Keys.onPressed: event => {
        if (event.key === Qt.Key_Tab && composer.tabAction) { composer.tabAction(); event.accepted = true; return; }
        if (event.key === Qt.Key_Escape && composer.escAction) { composer.escAction(); event.accepted = true; return; }
        if (event.key === Qt.Key_C && (event.modifiers & Qt.ControlModifier) && input.selectedText === "") {
          composer.stop();
          event.accepted = true;
          return;
        }
        // Ctrl+V, or Shift+Insert (keyd sends it for Super+V on Jon's desktops).
        if ((event.key === Qt.Key_V && (event.modifiers & Qt.ControlModifier)) || (event.key === Qt.Key_Insert && (event.modifiers & Qt.ShiftModifier))) {
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

  // Compact NORMAL pill while navigating by keyboard, so mode is unmistakable at a glance.
  Rectangle {
    visible: composer.normalMode
    anchors.right: parent.right
    anchors.rightMargin: 10
    anchors.bottom: parent.bottom
    anchors.bottomMargin: 12
    width: normalLabel.implicitWidth + 12
    height: 20
    radius: 10
    color: Theme.cardFill
    border.color: Theme.accent
    border.width: 1
    Text {
      id: normalLabel
      anchors.centerIn: parent
      text: "NORMAL"
      font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 10
      color: Theme.cardBusy
    }
  }

  // Eye-catching beacon rim and wash drawn over the bar during focusFlash.
  Rectangle {
    anchors.fill: parent
    radius: composer.radius
    visible: composer.flashStrength > 0.001
    color: Qt.alpha(Theme.accent, 0.28 * composer.flashStrength)
    border.color: Qt.alpha(Theme.accent, 0.95 * composer.flashStrength)
    border.width: 2.5
    z: 2
  }
}
