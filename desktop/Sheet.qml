// A page of detail (a task, a clanker's card, a host) risen over its board as a layer, as the phone's Sheet.kt draws
// it. It goes away by its close button, a click on the board showing above it, a drag down on its handle, or Esc while
// the pointer is over the board (shell.qml and StripWindow.qml ask the board, which calls dismissed). Its content fills
// the panel below the handle.
import QtQuick

Item {
  id: sheet
  property bool open: false
  signal dismissed()
  // Risen all the way and still: the board under it can stop drawing, so none of its changes repaint over the sheet.
  readonly property bool covers: open && !pull.active && panel.y === panel.gap
  default property alias content: body.data

  visible: open || panel.y < height
  clip: true

  // The board above the sheet, dimmed; a click on it puts the sheet away.
  Rectangle {
    anchors.fill: parent
    color: Theme.pageInk
    opacity: sheet.open ? 0.22 : 0
    Behavior on opacity { NumberAnimation { duration: 180 } }
    MouseArea { anchors.fill: parent; enabled: sheet.open; onClicked: sheet.dismissed() }
  }

  Rectangle {
    id: panel
    readonly property real gap: 10
    width: parent.width
    // Taller than the board by its radius, so only its top corners are round.
    height: parent.height - gap + radius
    // How far the handle is dragged down; letting go far enough puts the sheet away, else it goes back.
    property real pulled: 0
    y: (sheet.open ? gap : sheet.height) + pulled
    Behavior on y { enabled: !pull.active; NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
    // Drawn as one layer, so nothing of the board under it shows through. The overlay's window is transparent, and
    // there the board's opaque parts were drawn over the sheet's.
    layer.enabled: sheet.visible
    color: Theme.paper
    radius: Theme.consoleLook ? 0 : 14
    border.color: Theme.pageInk
    border.width: 1.5

    // Clicks on the sheet stay on it, not the board behind.
    MouseArea { anchors.fill: parent; acceptedButtons: Qt.AllButtons; onWheel: wheel => wheel.accepted = true }

    Item {
      id: header
      width: parent.width
      height: 34
      HoverHandler { cursorShape: pull.active ? Qt.ClosedHandCursor : Qt.OpenHandCursor }
      DragHandler {
        id: pull
        target: null
        xAxis.enabled: false
        onTranslationChanged: panel.pulled = Math.max(0, translation.y)
        onActiveChanged: if (!active) {
          if (panel.pulled > 90) sheet.dismissed();
          panel.pulled = 0;
        }
      }
      Rectangle {
        visible: !Theme.consoleLook
        anchors.centerIn: parent
        width: 36; height: 4; radius: 2
        color: Theme.muted
        opacity: 0.6
      }
      PressTab {
        anchors.right: parent.right
        anchors.rightMargin: 8
        anchors.verticalCenter: parent.verticalCenter
        text: "close"
        kind: "quiet"; small: true
        onClicked: sheet.dismissed()
      }
    }

    Item {
      id: body
      anchors.top: header.bottom
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.leftMargin: 10
      anchors.rightMargin: 8
      height: sheet.height - panel.gap - header.height - 4
    }
  }
}
