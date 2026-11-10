import QtQuick
import QtQuick.Shapes

Item {
  id: icon
  property string name: "preview"
  property color ink: "#e4e8f2"
  width: 24; height: 24
  Shape {
    anchors.fill: parent
    ShapePath {
      strokeColor: icon.ink; strokeWidth: 1.7
      capStyle: ShapePath.RoundCap; joinStyle: ShapePath.RoundJoin
      fillColor: "transparent"
      PathSvg {
        path: ({
          preview: "M 2 12 Q 12 -1 22 12 Q 12 25 2 12 Z M 15.5 12 A 3.5 3.5 0 1 1 8.5 12 A 3.5 3.5 0 1 1 15.5 12 Z",
          copy: "M 8 8 H 20 V 21 H 8 Z M 16 8 V 3 H 4 V 16 H 8",
          check: "M 4 12 L 9 17 L 20 6",
          envelope: "M 3 5 H 21 V 19 H 3 Z M 3 6 L 12 13 L 21 6",
          chevron: "M 9 6 L 15 12 L 9 18"
        })[icon.name] || ""
      }
    }
  }
}
