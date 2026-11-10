// A panel's art actions. Only the right button is captured; left-button text selection and picture taps pass through.
import QtQuick
import QtQuick.Controls
import "compose.mjs" as Compose

MouseArea {
  id: area
  required property var panel
  property bool linked: true
  property var taking: ({})
  readonly property var actions: Compose.takeMenu(panel)
  signal chosen(var action)
  acceptedButtons: Qt.RightButton
  enabled: actions.length > 0
  onClicked: mouse => menu.popup(mouse.x, mouse.y)

  Menu {
    id: menu
    objectName: "takeMenu"
    width: 200
    font.family: Theme.caption
    font.pixelSize: 14
    palette.window: Theme.paper
    palette.text: Theme.pageInk
    palette.buttonText: Theme.pageInk
    palette.highlight: Theme.pageInk
    palette.highlightedText: Theme.paper
    background: Rectangle { color: Theme.paper; border.color: Theme.pageInk; radius: 6 }
    MenuItem {
      readonly property var choice: area.actions[0] ?? null
      text: choice ? choice.label : ""
      enabled: Boolean(choice && choice.enabled && area.linked && !area.taking[choice.reply])
      onTriggered: area.chosen(choice)
    }
    MenuItem {
      readonly property var choice: area.actions[1] ?? null
      text: choice ? choice.label : ""
      visible: choice !== null
      height: visible ? implicitHeight : 0
      enabled: Boolean(choice && choice.enabled && area.linked && !area.taking[choice.reply])
      onTriggered: area.chosen(choice)
    }
    MenuItem {
      readonly property var choice: area.actions[2] ?? null
      text: choice ? choice.label : ""
      visible: choice !== null
      height: visible ? implicitHeight : 0
      enabled: Boolean(choice && choice.enabled && area.linked && !area.taking[choice.reply])
      onTriggered: area.chosen(choice)
    }
  }
}
