// A blank on a form: a printed LABEL over a ruled ink underline, no box; the console prompts "label> ". `mono` sets
// the value in the monospace face, for hosts, models and paths. Enter says accepted().
import QtQuick
import QtQuick.Controls

Item {
  id: field
  property string label: ""
  property alias text: input.text
  property string placeholder: ""
  property bool mono: false
  signal accepted()
  signal edited(string text)
  signal escaped()
  function focusField() { input.forceActiveFocus(); }
  function blurField() { input.focus = false; }
  width: parent ? parent.width : 0
  implicitHeight: Theme.consoleLook ? 28 : caption.implicitHeight + 30

  Words {
    id: caption
    visible: !Theme.consoleLook
    role: "label"
    text: field.label.toUpperCase()
    color: Theme.surfaceMuted
  }
  Words {
    id: prompt
    visible: Theme.consoleLook
    anchors.verticalCenter: input.verticalCenter
    role: "value"
    text: field.label.toLowerCase() + "> "
    color: Theme.surfaceMuted
  }
  TextField {
    id: input
    x: Theme.consoleLook ? prompt.implicitWidth : 0
    y: Theme.consoleLook ? 0 : caption.implicitHeight + 2
    width: field.width - x
    height: 28
    leftPadding: 0; rightPadding: 0; topPadding: 4; bottomPadding: 6
    placeholderText: Theme.consoleLook ? (field.placeholder !== "" ? field.placeholder : "_") : field.placeholder
    placeholderTextColor: Qt.alpha(Theme.surfaceMuted, 0.85)
    color: Theme.surfaceInk
    selectionColor: Qt.alpha(Theme.neon ? Theme.accent : Theme.edge, 0.3)
    font.family: field.mono ? "monospace" : Theme.type.value.family
    font.pixelSize: Theme.type.value.size
    onAccepted: field.accepted()
    onTextEdited: field.edited(text)
    Keys.onPressed: event => {
      if (event.key === Qt.Key_Escape) {
        input.focus = false;
        field.escaped();
        event.accepted = true;
      }
    }
    background: Rectangle {
      visible: !Theme.consoleLook
      anchors.bottom: parent.bottom
      width: parent.width
      height: input.activeFocus ? 2 : 1.5
      color: Theme.neon ? (input.activeFocus ? Theme.accent : Theme.edge) : Qt.alpha(Theme.surfaceInk, input.activeFocus ? 1 : 0.75)
    }
  }
}
