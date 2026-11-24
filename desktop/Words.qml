// Text in one of the boards' type roles (Theme.type): masthead, title, name, row, meta, label, section, button,
// value, body, lettering or number, each with its face, size, weight, spacing and a fixed line height.
import QtQuick

Text {
  property string role: "body"
  readonly property var spec: Theme.type[role] ?? Theme.type.body
  font.family: spec.family
  font.pixelSize: spec.size
  font.weight: spec.weight
  font.letterSpacing: spec.spacing
  lineHeightMode: Text.FixedHeight
  lineHeight: spec.line
  color: Theme.surfaceInk
}
