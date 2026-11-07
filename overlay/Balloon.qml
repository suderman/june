// June's speech balloon: real, selectable text inside one outline that includes the tail, so the tail joins without a
// seam. `tail` comes from the layout engine (edge, position, base, tip), or is null for no tail; `w` and `h` are the
// balloon's size without it.
import QtQuick
import QtQuick.Shapes
import "compose.mjs" as Compose

Item {
  id: balloon

  property string text: ""
  property bool rich: true
  property real maxWidth: 400
  property int pixelSize: 17
  property real weight: Theme.line
  property var tail: null
  // A link in the words was clicked: its address, for the window to open (Strip.linkKind says how).
  signal link(string url)

  readonly property real padX: 22
  readonly property real padY: 14
  // Never smaller than this, so a reply just starting has straight edges enough for its tail to join cleanly.
  readonly property real w: Math.ceil(Math.max(words.width + padX * 2, 120))
  readonly property real h: Math.ceil(Math.max(words.height + padY * 2, 58))

  width: w
  height: h

  Shape {
    width: balloon.w
    height: balloon.h
    preferredRendererType: Shape.CurveRenderer
    ShapePath {
      strokeColor: Theme.ink
      strokeWidth: balloon.weight
      fillColor: Theme.balloon
      joinStyle: ShapePath.RoundJoin
      PathSvg { path: Compose.balloonPath(balloon.w, balloon.h, balloon.tail) }
    }
  }

  // The natural width of the words, so short lines make a snug balloon; the visible text wraps within it.
  Text {
    id: natural
    visible: false
    text: balloon.text
    textFormat: balloon.rich ? Text.RichText : Text.PlainText
    font: words.font
  }

  TextEdit {
    id: words
    x: (balloon.w - width) / 2 > balloon.padX ? (balloon.w - width) / 2 : balloon.padX
    y: (balloon.h - height) / 2
    width: Math.min(natural.implicitWidth + 2, balloon.maxWidth - balloon.padX * 2)
    readOnly: true
    selectByMouse: true
    wrapMode: TextEdit.Wrap
    textFormat: balloon.rich ? TextEdit.RichText : TextEdit.PlainText
    text: balloon.text
    font.family: Theme.lettering
    font.weight: Font.Medium
    font.pixelSize: balloon.pixelSize
    color: Theme.ink
    selectionColor: Theme.highlight
    selectedTextColor: Theme.ink
    onLinkActivated: url => balloon.link(url)
    HoverHandler { cursorShape: words.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.IBeamCursor }
  }
}
