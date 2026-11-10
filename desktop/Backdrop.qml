// What stands behind June in a panel, under the hour's grade: the panel's tint (her room's ground; the room itself is
// Scenery.qml, drawn over it), the calm ground, a procedural abstract background, or a cutaway of the work she is doing.
// light.mjs decides which and draws the paths; this file only paints them. A cutaway is never graded: it is the work on
// kit, lit by its own screens. See "Light and backgrounds" in docs/interfaces.org.
import QtQuick
import QtQuick.Shapes
import "light.mjs" as Light

Item {
  id: back

  required property var spec
  required property var light
  // The room's tint, from Theme.
  required property string tint
  // Her face's centre, in this item's coordinates, for focus lines and a burst.
  property var centre: null
  property int seed: 0
  // Her words and face, which a cutaway's panes and drawers keep clear of.
  property var clear: []

  readonly property var pattern: spec.kind === "abstract" ? Light.PATTERNS[spec.pattern] : null
  readonly property var scene: spec.kind === "cutaway" ? Light.cutaway(spec, width, height, seed, clear) : null
  function g(c) { return c === "transparent" ? c : Light.graded(c, light); }
  readonly property string ground: scene ? scene.ground
    : g(spec.kind === "calm" ? Light.CALM_GROUND : pattern ? pattern.ground : tint)

  Rectangle {
    anchors.fill: parent
    color: back.ground
    Behavior on color { ColorAnimation { duration: 220 } }
  }

  Shape {
    anchors.fill: parent
    opacity: back.pattern ? back.pattern.opacity : 0
    visible: opacity > 0
    Behavior on opacity { NumberAnimation { duration: 220 } }
    preferredRendererType: Shape.CurveRenderer
    ShapePath {
      strokeColor: back.pattern ? back.g(back.pattern.stroke) : "transparent"
      fillColor: back.pattern ? back.g(back.pattern.fill) : "transparent"
      strokeWidth: back.pattern ? back.pattern.width : 0
      fillRule: ShapePath.WindingFill
      capStyle: ShapePath.RoundCap
      joinStyle: ShapePath.RoundJoin
      PathSvg { path: back.pattern ? Light.patternPath(back.spec.pattern, back.width, back.height, back.centre, back.seed) : "" }
    }
  }

  // Delegating: a pane per brief, named as its call narrates it, and the run's calls as a chain coloured by status.
  Item {
    anchors.fill: parent
    visible: back.scene !== null && back.spec.scene === "delegating"
    Repeater {
      model: back.scene && back.spec.scene === "delegating" ? back.scene.panes : []
      delegate: Rectangle {
        id: pane
        required property var modelData
        x: modelData.x
        y: modelData.y
        width: modelData.w
        height: 24 + 3 * 11 + 12
        rotation: modelData.r
        radius: 8
        color: "#2b3247"
        border.color: "#5b6683"
        border.width: 2
        clip: true
        Rectangle {
          x: 2; y: 2; width: parent.width - 4; height: 22
          color: "#353d56"
          Rectangle { x: 8; anchors.verticalCenter: parent.verticalCenter; width: 8; height: 8; radius: 4; color: pane.modelData.dot }
          Text {
            x: 22; anchors.verticalCenter: parent.verticalCenter
            width: parent.width - 30
            elide: Text.ElideRight
            text: pane.modelData.name
            color: "#e4e8f2"
            font.family: "monospace"
            font.pixelSize: 11
          }
        }
        Column {
          x: 10; y: 32; spacing: 5
          Repeater {
            model: pane.modelData.lines
            delegate: Rectangle { required property var modelData; width: (pane.width - 20) * modelData / 100; height: 6; radius: 3; color: "#7c8aa8"; opacity: 0.7 }
          }
        }
      }
    }
    Shape {
      anchors.fill: parent
      preferredRendererType: Shape.CurveRenderer
      ShapePath {
        strokeColor: "#86e08f"
        strokeWidth: 3
        fillColor: "transparent"
        PathSvg { path: back.scene && back.scene.path ? back.scene.path : "" }
      }
    }
    Repeater {
      model: back.scene && back.spec.scene === "delegating" ? back.scene.nodes : []
      delegate: Rectangle {
        required property var modelData
        x: modelData.x - 14; y: modelData.y - 14; width: 28; height: 28; radius: 14
        color: modelData.fill
        border.color: Theme.ink
        border.width: 2.5
      }
    }
  }

  // Digging: the places her calls looked, as labelled drawers on archive shelves.
  Item {
    anchors.fill: parent
    visible: back.scene !== null && back.spec.scene === "digging"
    Repeater {
      model: 3
      delegate: Rectangle { required property int index; x: 0; width: back.width; y: back.height * (index + 1) / 4; height: 3; color: "#cbbda6" }
    }
    Repeater {
      model: back.scene && back.spec.scene === "digging" ? back.scene.drawers : []
      delegate: Item {
        required property var modelData
        x: modelData.x
        y: modelData.y
        width: modelData.w
        height: modelData.w * 0.69
        rotation: modelData.r
        Rectangle {
          x: 14; y: -14; width: 60; height: 18; radius: 6
          color: modelData.fill
          border.color: Theme.ink
          border.width: 2.5
        }
        Rectangle {
          anchors.fill: parent
          radius: 6
          color: modelData.fill
          border.color: Theme.ink
          border.width: 2.5
          Text {
            x: 12; y: 14
            width: parent.width - 24
            elide: Text.ElideRight
            text: modelData.label
            color: Theme.ink
            font.family: "monospace"
            font.pixelSize: 12
            font.bold: true
          }
          Rectangle { x: 12; y: parent.height * 0.42; width: parent.width - 26; height: 6; radius: 3; color: Theme.ink; opacity: 0.25 }
          Rectangle { x: 12; y: parent.height * 0.56; width: parent.width - 52; height: 6; radius: 3; color: Theme.ink; opacity: 0.25 }
        }
      }
    }
  }
}
