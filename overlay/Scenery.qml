// June's room behind her, back to front: the hour's sky with the sun or moon and stars, the season's view, rain or snow,
// all through the window; the room with its window cut out; the props the day brings out. The whole is graded by the
// hour as one print. scenery.mjs chooses and places; light.mjs gives the sky. See "Rooms, windows, and props" in
// docs/interfaces.org.
import QtQuick
import QtQuick.Effects
import QtQuick.Shapes
import "light.mjs" as Light

Item {
  id: scene

  required property var room
  // Where the room covers the panel (placeRoom), its window in panel coordinates.
  required property var place
  property var plate: null
  // The window's sky (skyLook).
  required property var sky
  // Placed props (placeProps).
  property var props: []
  required property var light
  property int seed: 0
  // Out of focus behind a close framing (focusBlur), 0 to 1.
  property real blur: 0

  readonly property var win: place ? place.window : null
  readonly property real sunR: win ? Math.max(8, Math.min(win.w, win.h) * 0.09) : 0
  readonly property var starAt: [[0.12, 0.2], [0.44, 0.1], [0.7, 0.26], [0.3, 0.36], [0.86, 0.12], [0.58, 0.4]]

  Item {
    id: content
    anchors.fill: parent
    visible: false
    layer.enabled: true

    Item {
      visible: scene.win !== null
      x: scene.win ? scene.win.x : 0
      y: scene.win ? scene.win.y : 0
      width: scene.win ? scene.win.w : 0
      height: scene.win ? scene.win.h : 0
      clip: true
      Rectangle {
        anchors.fill: parent
        gradient: Gradient {
          GradientStop { position: 0; color: scene.sky.top }
          GradientStop { position: 1; color: scene.sky.bottom }
        }
      }
      Repeater {
        model: scene.sky.stars > 0 ? scene.starAt : []
        delegate: Rectangle {
          required property var modelData
          x: modelData[0] * parent.width; y: modelData[1] * parent.height
          width: 3; height: 3; radius: 1.5
          color: "#ffffff"
          opacity: scene.sky.stars
        }
      }
      Rectangle {
        x: scene.sky.sunX * parent.width - scene.sunR
        y: scene.sky.sunY * parent.height - scene.sunR
        width: scene.sunR * 2; height: width; radius: scene.sunR
        color: scene.sky.sun
        opacity: scene.sky.sunOpacity
        visible: opacity > 0
      }
      Image {
        visible: scene.plate !== null
        source: scene.plate ? scene.plate.url : ""
        anchors.bottom: parent.bottom
        width: parent.width
        height: scene.plate ? Math.max(parent.height * 0.5, parent.width * scene.plate.height / scene.plate.width) : 0
        fillMode: Image.PreserveAspectCrop
        verticalAlignment: Image.AlignBottom
        sourceSize.width: Math.ceil(width)
        asynchronous: true
        smooth: true
      }
      Shape {
        anchors.fill: parent
        visible: scene.sky.falling !== null
        ShapePath {
          strokeColor: scene.sky.falling === "snow" ? "transparent" : "#c9d6e8"
          fillColor: scene.sky.falling === "snow" ? "#ffffff" : "transparent"
          strokeWidth: 2
          capStyle: ShapePath.RoundCap
          PathSvg { path: scene.sky.falling ? Light.fallingPath(scene.sky.falling, scene.win ? scene.win.w : 0, scene.win ? scene.win.h : 0, scene.seed) : "" }
        }
      }
    }

    Image {
      source: scene.room ? scene.room.url : ""
      x: scene.place ? scene.place.x : 0
      y: scene.place ? scene.place.y : 0
      width: scene.place ? scene.place.w : 0
      height: scene.place ? scene.place.h : 0
      mirror: scene.place ? scene.place.mirror : false
      sourceSize.width: Math.ceil(width)
      sourceSize.height: Math.ceil(height)
      asynchronous: true
      smooth: true
    }

    Repeater {
      model: scene.props
      delegate: Image {
        required property var modelData
        source: modelData.url
        x: modelData.x; y: modelData.y; width: modelData.w; height: modelData.h
        sourceSize.width: Math.ceil(width)
        sourceSize.height: Math.ceil(height)
        asynchronous: true
        smooth: true
      }
    }
  }

  MultiEffect {
    anchors.fill: content
    source: content
    colorization: scene.light.gradeAmount
    colorizationColor: scene.light.grade
    blurEnabled: scene.blur > 0
    blur: scene.blur
    blurMax: 24
  }
}
