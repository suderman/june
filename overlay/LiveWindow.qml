// Live June: the overlay's minimised form, in the focused screen's bottom-right corner. Her card shows what she is
// doing right now; it grows leftward to hold her latest reply or the user's input. It takes the keyboard only while the
// input is open, and only where it draws does it take the mouse. The shell decides the state (see live.mjs) and when
// she shows; see "Live June" in docs/interfaces.org.
import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Wayland
import "compose.mjs" as Compose

PanelWindow {
  id: win

  property bool shown: false
  property string liveState: "sipping"
  property var art: null
  property var reaction: null
  property string status: ""
  property string message: ""
  property bool messageShown: false
  property bool inputShown: false
  readonly property bool hovered: hover.hovered
  // The note's text, so a draft can move to the strip's input and back.
  property alias draft: field.text

  signal openStrip()
  signal submitted(string text, bool followUp)
  signal wantInput()
  signal dismissed()

  readonly property bool busy: cardBox.busy
  readonly property int card: 150
  readonly property int reach: 340

  visible: shown
  anchors { bottom: true; right: true }
  margins { bottom: 22; right: 22 }
  implicitWidth: card + reach + 14
  implicitHeight: card + 190
  exclusionMode: ExclusionMode.Ignore
  color: "transparent"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.namespace: "june-live"
  WlrLayershell.keyboardFocus: inputShown ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
  // Only what is drawn takes the mouse; the empty rest of the window lets clicks through to the desktop.
  mask: Region { item: hitArea }

  // The span of what is drawn: her card and status, and her reply or the user's note when one shows.
  Item {
    id: hitArea
    readonly property real spanLeft: balloon.visible ? balloon.x : note.visible ? note.x : cardBox.x
    readonly property real spanTop: Math.min(statusPill.visible ? statusPill.y : cardBox.y, balloon.visible ? balloon.y : cardBox.y, note.visible ? note.y : cardBox.y)
    x: spanLeft
    y: spanTop
    width: cardBox.x + cardBox.width - spanLeft
    height: cardBox.y + cardBox.height - spanTop
  }

  onInputShownChanged: if (inputShown) field.forceActiveFocus()

  HoverHandler { id: hover }

  // What she is doing, in a word, above her card.
  Rectangle {
    id: statusPill
    visible: win.status !== ""
    anchors.right: cardBox.right
    anchors.bottom: cardBox.top
    anchors.bottomMargin: 8
    width: statusText.implicitWidth + 20
    height: 24
    radius: 6
    color: Theme.cardFill
    border.color: Theme.cardLine
    border.width: 1.5
    Text { id: statusText; anchors.centerIn: parent; text: win.status; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: Theme.cardBusy }
  }

  // Her card: the same card the strip shows in this corner, so she does not move between the two.
  LiveCard {
    id: cardBox
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    width: win.card
    height: win.card
    liveState: win.liveState
    art: win.art
    reaction: win.reaction
    running: win.shown
    onClicked: win.openStrip()
  }

  // Her latest reply, growing out of her card, its tail toward her; above the user's note while they answer it. A click
  // answers it.
  Balloon {
    id: balloon
    visible: win.messageShown && win.message !== ""
    anchors.right: cardBox.left
    anchors.rightMargin: 18
    anchors.bottom: note.visible ? note.top : cardBox.bottom
    anchors.bottomMargin: note.visible ? 14 : 26
    maxWidth: win.reach - 18
    pixelSize: 16
    rich: false
    text: win.message
    // From the bottom edge near her, pointing right at her card; a one-line balloon has no straight side to spare.
    tail: ({ edge: "bottom", at: w - 26 - 11, base: 22, tip: { x: w + 16, y: h + 2 } })
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: win.wantInput() }
  }

  // The user's note to her, without the strip. Enter steers, Shift+Enter queues, Esc puts her away.
  Rectangle {
    id: note
    visible: win.inputShown
    anchors.right: cardBox.left
    anchors.rightMargin: 14
    anchors.bottom: cardBox.bottom
    anchors.bottomMargin: 16
    width: win.reach - 14
    height: Math.min(field.contentHeight + 26, 160)
    radius: 14
    color: Theme.noteFill
    border.color: Theme.noteLine
    border.width: 2
    Text { id: marker; x: 14; y: 12; text: "›"; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 16; color: Theme.noteLine }
    ScrollView {
      x: marker.x + marker.width + 8
      y: 8
      width: note.width - x - 12
      height: note.height - 14
      TextArea {
        id: field
        placeholderText: "to june…"
        wrapMode: TextEdit.Wrap
        font.family: Theme.caption
        font.weight: Font.Medium
        font.pixelSize: 16
        color: Theme.noteInk
        placeholderTextColor: "#7b88ad"
        background: null
        Keys.onPressed: event => {
          if (event.key === Qt.Key_Escape) { win.dismissed(); event.accepted = true; return; }
          if (event.key !== Qt.Key_Return && event.key !== Qt.Key_Enter) return;
          if (event.modifiers & Qt.AltModifier) { field.insert(field.cursorPosition, "\n"); event.accepted = true; return; }
          if (field.text.trim() !== "") { win.submitted(field.text, (event.modifiers & Qt.ShiftModifier) !== 0); field.clear(); }
          event.accepted = true;
        }
      }
    }
  }
}
