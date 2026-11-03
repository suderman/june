// One panel of the strip, composed on a single canvas: June's art framed like a hero image, the marks that suit her
// pose, and the words in reading order. compose.mjs decides every position from the words' measured sizes; this file
// measures and draws. See "Look: a comic strip" in docs/interfaces.org.
import QtQuick
import QtQuick.Shapes
import "strip.mjs" as Strip
import "compose.mjs" as Compose

Item {
  id: panel

  required property string json
  property bool newest: false
  property string activity: ""
  // Every pose the shell loaded, for a tall stand-in when the words run long.
  property var poses: []

  // The panel's elements, June's side, and her pose, from the shell (see sync() in shell.qml).
  readonly property var p: JSON.parse(json)
  readonly property var m: Compose.metrics(width)
  // Measured sizes, in element order, as the layout engine reads them.
  property var sizes: []
  // Planned with the panel's pose first; if the words run long enough to need an inset, a pose of the same expression
  // drawn tall takes over and she fills the panel instead (see tallFor in compose.mjs).
  readonly property var first: Compose.plan({ width: width, side: p.side, pose: p.pose, elements: sizes, framing: p.framing })
  readonly property var tall: first.clip.inset ? Compose.tallFor(poses, p.pose) : null
  readonly property var pose: tall ?? p.pose
  readonly property var layout: tall ? Compose.plan({ width: width, side: p.side, pose: tall, elements: sizes, framing: p.framing }) : first

  implicitHeight: layout.height
  clip: true

  readonly property var sources: ({ tui: "terminal", kitty: "terminal", apk: "phone", telegram: "telegram", cli: "command line" })

  function kindOf(e) { return e.kind === "tools" ? (e.items.length > 1 ? "card" : "chip") : e.kind; }
  function measure() {
    const out = [];
    for (let i = 0; i < elements.count; i++) {
      const slot = elements.itemAt(i);
      const item = slot ? slot.item : null;
      out.push({ kind: slot ? slot.kind : "june", w: item ? item.w : 0, h: item ? item.h : 0 });
    }
    sizes = out;
  }

  // The panel's ground.
  Rectangle { anchors.fill: parent; color: Theme.tint(panel.p.id) }

  // June, framed into the panel or, when the words run long, into an inset at the top of her side.
  Item {
    id: artBox
    visible: panel.layout.art !== null
    x: panel.layout.clip.x
    y: panel.layout.clip.y
    width: panel.layout.clip.w
    height: panel.layout.clip.h
    clip: true
    Rectangle { anchors.fill: parent; visible: panel.layout.clip.inset; color: Qt.darker(Theme.tint(panel.p.id), 1.06) }
    Image {
      readonly property var r: panel.layout.art ?? ({ x: 0, y: 0, w: 1, h: 1 })
      x: r.x - artBox.x
      y: r.y - artBox.y
      width: r.w
      height: r.h
      source: panel.pose ? panel.pose.url : ""
      mirror: panel.layout.mirror
      sourceSize.width: Math.ceil(r.w)
      sourceSize.height: Math.ceil(r.h)
      smooth: true
      asynchronous: true
    }
  }
  Rectangle {
    visible: panel.layout.clip.inset
    x: artBox.x; y: artBox.y; width: artBox.width; height: artBox.height
    color: "transparent"
    border.color: Theme.ink
    border.width: Theme.line
  }

  // Marks that reinforce her pose, drawn beside her face, never baked into the art.
  Repeater {
    model: panel.layout.marks
    delegate: Shape {
      id: mark
      required property var modelData
      x: modelData.x
      y: modelData.y
      width: 100
      height: 100
      scale: modelData.size / 100
      transformOrigin: Item.TopLeft
      readonly property var look: ({
        sparkle: { stroke: "#f2b81c", fill: "transparent", path: "M 50 8 L 50 34 M 20 22 L 34 40 M 80 22 L 66 40 M 8 56 L 30 58 M 92 56 L 70 58" },
        emphasis: { stroke: Theme.ink, fill: "transparent", path: "M 10 30 L 34 44 M 18 8 L 38 34 M 46 2 L 50 30 M 74 8 L 62 34 M 92 30 L 68 44" },
        heart: { stroke: "#e2557a", fill: "#ffb3c7", path: "M 50 86 C 18 64 6 46 14 28 C 22 12 44 12 50 30 C 56 12 78 12 86 28 C 94 46 82 64 50 86 Z" },
        sweat: { stroke: "#3a7bc8", fill: "#bfe0ff", path: "M 50 6 C 66 34 78 50 78 66 C 78 82 64 94 50 94 C 36 94 22 82 22 66 C 22 50 34 34 50 6 Z" },
        vein: { stroke: "#d0342c", fill: "transparent", path: "M 14 38 Q 38 38 38 14 M 62 14 Q 62 38 86 38 M 86 62 Q 62 62 62 86 M 38 86 Q 38 62 14 62" },
        steam: { stroke: "#7b7f8c", fill: "#ffffff", path: "M 20 70 C 4 70 4 46 22 46 C 22 28 46 24 54 38 C 64 22 92 30 86 52 C 100 58 94 80 76 78 C 70 92 44 92 40 80 C 32 86 20 82 20 70 Z" },
      })[modelData.kind] ?? { stroke: Theme.ink, fill: "transparent", path: "" }
      ShapePath {
        strokeColor: mark.look.stroke
        fillColor: mark.look.fill
        strokeWidth: 7
        capStyle: ShapePath.RoundCap
        joinStyle: ShapePath.RoundJoin
        PathSvg { path: mark.look.path }
      }
    }
  }

  // The words, in reading order, each placed by the layout engine once measured.
  Repeater {
    id: elements
    // Count, not the array: delegates survive a streaming update and only their element changes.
    model: panel.p.elements.length
    delegate: Loader {
      id: slot
      required property int index
      readonly property var element: panel.p.elements[index] ?? null
      readonly property string kind: element ? panel.kindOf(element) : ""
      readonly property var box: panel.layout.elements[index] ?? null
      x: box ? box.x : 0
      y: box ? box.y : 0
      visible: box !== null
      sourceComponent: kind === "user" ? note : kind === "june" ? speech : kind === "thought" ? thought : kind === "chip" ? chip : kind === "card" ? card : kind === "burst" ? burst : null
      onLoaded: Qt.callLater(panel.measure)
      onKindChanged: Qt.callLater(panel.measure)
      Binding { target: slot.item; property: "element"; value: slot.element; when: slot.status === Loader.Ready }
      Binding { target: slot.item; property: "box"; value: slot.box; when: slot.status === Loader.Ready }
      Connections {
        target: slot.item
        ignoreUnknownSignals: true
        function onWChanged() { Qt.callLater(panel.measure); }
        function onHChanged() { Qt.callLater(panel.measure); }
      }
    }
  }
  onWidthChanged: Qt.callLater(panel.measure)

  // The panel's frame, over everything it holds.
  Rectangle { anchors.fill: parent; color: "transparent"; border.color: Theme.ink; border.width: 3 }

  // The user's note: light blue, rounded, no tail; it enters June's world from outside the frame.
  Component {
    id: note
    Rectangle {
      id: noteBox
      property var element
      property var box
      readonly property var item: element ? element.item : null
      readonly property real w: Math.ceil(Math.min(marker.implicitWidth + 8 + body.width + 28, panel.m.textWidth))
      readonly property real h: Math.ceil(Math.max(body.height, marker.height) + 20)
      width: w
      height: h
      radius: 14
      color: Theme.noteFill
      border.color: Theme.noteLine
      border.width: 2
      Text {
        id: marker
        x: 14; y: 10
        text: (noteBox.item && noteBox.item.source && noteBox.item.source !== "gui" ? (panel.sources[noteBox.item.source] ?? noteBox.item.source) + " " : "") + "›"
        font.family: Theme.caption
        font.weight: Font.Bold
        font.pixelSize: 16
        color: Theme.noteLine
      }
      Text { id: natural; visible: false; text: body.text; font: body.font }
      TextEdit {
        id: body
        x: marker.x + marker.implicitWidth + 8
        y: 10
        width: Math.min(natural.implicitWidth + 2, panel.m.textWidth - 28 - marker.implicitWidth - 8)
        readOnly: true
        selectByMouse: true
        wrapMode: TextEdit.Wrap
        textFormat: TextEdit.PlainText
        text: noteBox.item ? noteBox.item.text : ""
        font.family: Theme.caption
        font.weight: Font.Medium
        font.pixelSize: 16
        color: Theme.noteInk
        selectionColor: Theme.highlight
      }
    }
  }

  // June's speech: a balloon whose tail the layout aims at her mouth.
  Component {
    id: speech
    Balloon {
      property var element
      property var box
      maxWidth: panel.m.textWidth
      pixelSize: panel.newest ? 19 : 17
      weight: panel.newest ? 3 : Theme.line
      tail: box ? (box.tail ?? null) : null
      text: element ? Strip.markup(element.text, { stress: "font-weight:800; background-color:" + Theme.highlight, code: "font-family:monospace" }) + (element.streaming ? "<span style='color:" + Theme.accent + "'> ▍</span>" : "") : ""
      transformOrigin: panel.p.side === "left" ? Item.Left : Item.Right
      NumberAnimation on scale { id: pop; running: false; from: 0.9; to: 1; duration: 220; easing.type: Easing.OutBack }
      Component.onCompleted: if (panel.newest) pop.start()
    }
  }

  // Patter: a quiet thought cloud, its trail of circles drifting from its nearest corner toward her face.
  Component {
    id: thought
    Item {
      id: thoughtBox
      property var element
      property var box
      // Scallops about 48 px apart that bulge only 5 px: a cloud, but a quiet one.
      readonly property real bump: 24
      readonly property real depth: 5
      readonly property real w: Math.ceil(words.width + (depth + 18) * 2)
      readonly property real h: Math.ceil(words.height + (depth + 12) * 2)
      // From the layout; null when every corner is boxed in, and then the cloud goes without a trail.
      readonly property var trail: box ? (box.trail ?? null) : null
      width: w
      height: h
      Shape {
        width: thoughtBox.w
        height: thoughtBox.h
        preferredRendererType: Shape.CurveRenderer
        ShapePath {
          strokeColor: Theme.ink
          strokeWidth: 2
          fillColor: Theme.balloon
          joinStyle: ShapePath.RoundJoin
          PathSvg { path: Compose.cloudPath(thoughtBox.w, thoughtBox.h, thoughtBox.bump, thoughtBox.depth) }
        }
      }
      Text {
        id: words
        x: thoughtBox.depth + 18
        y: thoughtBox.depth + 12
        width: Math.min(implicitWidth, panel.m.textWidth - (thoughtBox.depth + 18) * 2)
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        text: thoughtBox.element ? thoughtBox.element.item.text : ""
        font.family: Theme.lettering
        font.italic: true
        font.pixelSize: 14
        color: "#4a4750"
      }
      Repeater {
        model: thoughtBox.trail ? Compose.TRAIL : []
        delegate: Rectangle {
          required property var modelData
          x: thoughtBox.trail.x + thoughtBox.trail.dx * modelData.at - modelData.size / 2
          y: thoughtBox.trail.y + thoughtBox.trail.dy * modelData.at - modelData.size / 2
          width: modelData.size
          height: modelData.size
          radius: modelData.size / 2
          color: Theme.balloon
          border.color: Theme.ink
          border.width: 2
        }
      }
    }
  }

  // One tool call: a small lavender chip. A click shows its whole summary.
  Component {
    id: chip
    Rectangle {
      id: chipBox
      property var element
      property var box
      property bool open: false
      readonly property var call: element ? element.items[0] : null
      readonly property real w: Math.ceil(Math.min(label.implicitWidth + 24, panel.m.textWidth))
      readonly property real h: Math.ceil(label.height + 10)
      width: w
      height: h
      radius: open ? 12 : h / 2
      color: call && call.status === "error" ? Theme.burstFill : Theme.chipFill
      border.color: Qt.darker(color, 1.25)
      border.width: 1.5
      Text {
        id: label
        x: 12; y: 5
        width: Math.min(implicitWidth, panel.m.textWidth - 24)
        elide: chipBox.open ? Text.ElideNone : Text.ElideRight
        wrapMode: chipBox.open ? Text.Wrap : Text.NoWrap
        textFormat: Text.PlainText
        text: chipBox.call ? "∴ " + Strip.caption(chipBox.call) + (chipBox.call.status === "running" ? " …" : "") : ""
        font.family: Theme.caption
        font.weight: Font.Bold
        font.pixelSize: 13
        color: Theme.chipInk
      }
      MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: chipBox.open = !chipBox.open }
    }
  }

  // Several tool calls: a terminal status card, one line each, the latest five. A click opens it: every call, each
  // summary in full.
  Component {
    id: card
    Rectangle {
      id: cardBox
      property var element
      property var box
      property bool open: false
      readonly property var calls: element ? element.items : []
      readonly property real limit: Math.min(open ? 560 : 460, panel.m.textWidth)
      readonly property real w: Math.ceil(Math.min(Math.max(lines.implicitWidth + 28, 180), limit))
      readonly property real h: Math.ceil(lines.implicitHeight + 24)
      width: w
      height: h
      radius: 10
      color: Theme.cardFill
      border.color: open ? Theme.cardBusy : Theme.cardLine
      border.width: 2
      Column {
        id: lines
        x: 14; y: 12
        spacing: 5
        Repeater {
          model: cardBox.open ? cardBox.calls : cardBox.calls.slice(-5)
          delegate: Row {
            required property var modelData
            spacing: 8
            Text {
              id: mark
              text: modelData.status === "error" ? "✗" : modelData.status === "running" ? "…" : "✓"
              color: modelData.status === "error" ? Theme.cardFail : modelData.status === "running" ? Theme.cardBusy : Theme.cardOk
              font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 13
            }
            Text {
              width: Math.min(implicitWidth, cardBox.limit - 28 - mark.width - 8)
              elide: cardBox.open ? Text.ElideNone : Text.ElideRight
              wrapMode: cardBox.open ? Text.Wrap : Text.NoWrap
              textFormat: Text.PlainText
              text: Strip.caption(modelData)
              color: Theme.cardInk
              font.family: "monospace"; font.pixelSize: 12
            }
          }
        }
        Text {
          visible: !cardBox.open && cardBox.calls.length > 5
          text: "+" + (cardBox.calls.length - 5) + " earlier · click to open"
          color: "#9aa3b8"
          font.family: "monospace"; font.pixelSize: 11
        }
      }
      MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: cardBox.open = !cardBox.open }
    }
  }

  // A notice or a failed reply: a jagged burst sized to its words.
  Component {
    id: burst
    Item {
      id: burstItem
      property var element
      property var box
      readonly property real spike: 9
      readonly property real pad: spike + 14
      readonly property real w: Math.ceil(words.width + pad * 2)
      readonly property real h: Math.ceil(words.height + pad * 2)
      width: w
      height: h
      Shape {
        width: burstItem.w; height: burstItem.h
        ShapePath {
          strokeColor: Theme.ink; strokeWidth: Theme.line; fillColor: Theme.burstFill
          joinStyle: ShapePath.MiterJoin
          PathSvg { path: Compose.jagged(burstItem.w, burstItem.h, burstItem.spike) }
        }
      }
      Text {
        id: words
        x: burstItem.pad
        y: burstItem.pad
        width: Math.min(implicitWidth, panel.m.textWidth - burstItem.pad * 2)
        wrapMode: Text.Wrap
        textFormat: Text.PlainText
        text: burstItem.element ? (burstItem.element.item.error ?? burstItem.element.item.text ?? "") : ""
        font.family: Theme.lettering
        font.weight: Font.Bold
        font.pixelSize: 15
        color: Theme.ink
      }
    }
  }
}
