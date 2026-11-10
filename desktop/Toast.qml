// A short caption over the bottom of the strip: a command's reply, an error, or why a balloon was kept.
import QtQuick

Rectangle {
  id: toast
  property string text: ""

  visible: text !== ""
  width: Math.min(toastText.implicitWidth + 28, (parent ? parent.width : 400) - 48)
  height: toastText.height + 14
  color: Theme.captionFill
  border.color: Theme.ink
  border.width: 2
  Text {
    id: toastText
    anchors.centerIn: parent
    width: Math.min(implicitWidth, toast.width - 28)
    wrapMode: Text.Wrap
    text: toast.text
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
    color: Theme.ink
  }
}
