// One panel of the strip, composed on a single canvas: June's art framed like a hero image, the marks that suit her
// pose, and the words in reading order. compose.mjs decides every position from the words' measured sizes; this file
// measures and draws. See "Look: a comic strip" in docs/interfaces.org.
import QtQuick
import QtQuick.Effects
import QtQuick.Shapes
import "strip.mjs" as Strip
import "compose.mjs" as Compose
import "light.mjs" as Light
import "scenery.mjs" as Scenery

Item {
  id: panel
  // A picture or file the user's message brought, to show over the strip: { kind, url, name } (Preview.qml).
  signal preview(var item)
  // A link in June's words was clicked.
  signal link(string url)

  required property string json
  property bool newest: false
  property string activity: ""
  // Every pose the shell loaded, for a tall stand-in when the words run long.
  property var poses: []
  // The clock, for a panel without message times, and an hour that overrides every panel's, for previewing the light.
  property real now: Date.now()
  property real hourOverride: -1
  // Rooms, window views, and props from every avatar set (mergeScenery), and the daemon's sky: home's location and
  // the weather now.
  property var scenery: ({ rooms: [], plates: [], props: [] })
  property var sky: null

  // The panel's elements, June's side, and her pose, from the shell (see sync() in shell.qml).
  readonly property var p: JSON.parse(json)
  readonly property var m: Compose.metrics(width)
  // Measured sizes, in element order, as the layout engine reads them.
  property var sizes: []
  // Planned with the panel's pose first; if the words run long enough to need an inset, a pose of the same expression
  // drawn tall takes over and she fills the panel instead (see panelLayout in compose.mjs).
  readonly property var laid: Compose.panelLayout({ panel: p, width: width, sizes: sizes, poses: poses })
  readonly property var pose: laid.pose
  readonly property var layout: laid.layout

  implicitHeight: layout.height
  clip: true

  // Where the pictures the user's messages brought are served (the hello's `attached` on the daemon's host), or "".
  property string attached: ""
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

  // The hour its words were written, its light, and what stands behind her: her room, its window and props, or a
  // backdrop (panelScene in scenery.mjs, shared with the phone).
  readonly property var scene: Scenery.panelScene({ panel: p, layout: layout, pose: pose, sizes: sizes, width: width, now: now, hourOverride: hourOverride, sky: sky, scenery: scenery })
  readonly property var light: scene.light
  readonly property var backdrop: scene.backdrop
  readonly property var faceCentre: scene.faceCentre
  readonly property int seed: scene.seed
  readonly property var room: scene.room
  readonly property var roomPlace: scene.roomPlace

  Backdrop {
    anchors.fill: parent
    spec: panel.backdrop
    light: panel.light
    tint: Theme.tint(panel.p.id)
    centre: panel.faceCentre
    seed: panel.seed
    clear: panel.scene.clear
  }

  Scenery {
    anchors.fill: parent
    visible: panel.roomPlace !== null
    room: panel.room
    place: panel.roomPlace
    plate: panel.scene.plate
    sky: panel.scene.sky
    props: panel.scene.props
    light: panel.light
    seed: panel.seed
    blur: panel.scene.blur
  }

  // The lamp after dark: a warm pool of light behind her, over the graded room.
  Shape {
    anchors.fill: parent
    visible: opacity > 0
    opacity: panel.backdrop.kind === "cutaway" || !panel.faceCentre ? 0 : panel.light.lampOn
    preferredRendererType: Shape.CurveRenderer
    readonly property real r: Math.max(width, height) * 0.45
    ShapePath {
      strokeColor: "transparent"
      fillGradient: RadialGradient {
        centerX: panel.faceCentre ? panel.faceCentre.x : 0
        centerY: panel.faceCentre ? panel.faceCentre.y + 40 : 0
        centerRadius: Math.max(panel.width, panel.height) * 0.45
        focalX: centerX
        focalY: centerY
        GradientStop { position: 0; color: "#8cffc478" }
        GradientStop { position: 1; color: "#00ffc478" }
      }
      PathSvg { path: "M 0 0 L " + panel.width + " 0 L " + panel.width + " " + panel.height + " L 0 " + panel.height + " Z" }
    }
  }

  // June, framed into the panel or, when the words run long, into an inset at the top of her side. Two layers, so a new
  // pose loads unseen and is revealed only when it is ready: never a blank frame. A change in the newest panel, once it
  // is on screen, is a beat of the comic (see present()); everywhere else the page is printed: the final face, still.
  readonly property var art: layout.art && pose ? { url: pose.url, x: layout.art.x, y: layout.art.y, w: layout.art.w, h: layout.art.h, mirror: layout.mirror, face: layout.face, plain: ["serious", "gentle"].includes(pose.expression) || Boolean(pose.activity) } : null
  property bool presented: false
  property int front: 0
  property bool revealing: false
  // Marks wait a beat after the face lands, so the reaction reads face first, emphasis second.
  property bool marksShown: true
  onArtChanged: present()
  Component.onCompleted: present()

  function layerAt(i) { return i === 0 ? layerA : layerB; }
  // A layer keeps its art's rectangle (`box`, in panel coordinates) and positions itself against the layout's clip by
  // binding, so any re-layout finds it right. Set once here, a position read the clip before it caught up and shifted
  // her by the clip's offset: in a stacked panel, by everything above her band.
  function place(layer, a) {
    layer.source = a.url;
    layer.box = { x: a.x, y: a.y, w: a.w, h: a.h };
    layer.mirror = a.mirror;
    layer.focusX = a.face ? a.face.x + a.face.w / 2 - a.x : a.w / 2;
    layer.focusY = a.face ? a.face.y + a.face.h / 2 - a.y : a.h / 3;
  }
  function present() {
    const a = art;
    const shown = layerAt(front);
    if (a === null) { shown.source = ""; return; }
    // The same pose re-laid (the panel grew as she wrote): move it, no beat.
    if (shown.source.toString() === a.url && !revealing) { place(shown, a); return; }
    const back = layerAt(1 - front);
    reveal.stop();
    revealing = true;
    // Hidden before the source is set: a cached image is ready at once, and lands inside place().
    back.opacity = 0;
    back.settle = 1;
    place(back, a);
    if (back.status === Image.Ready) land();
  }
  // The new pose is ready: printed, cut, or revealed as a reaction.
  function land() {
    if (!revealing) return;
    const back = layerAt(1 - front);
    const shown = layerAt(front);
    const beat = presented && panel.newest;
    revealing = false;
    if (!beat) {
      back.opacity = 1;
      shown.opacity = 0;
      front = 1 - front;
      presented = true;
      return;
    }
    const plain = art && art.plain;
    fadeIn.target = back;
    fadeOut.target = shown;
    settleIn.target = back;
    back.settle = plain ? 1 : 1.03;
    settleIn.duration = plain ? 0 : 220;
    marksShown = plain;
    reveal.start();
    front = 1 - front;
    if (!plain) marksBeat.restart();
  }
  ParallelAnimation {
    id: reveal
    NumberAnimation { id: fadeIn; property: "opacity"; to: 1; duration: 120; easing.type: Easing.OutQuad }
    NumberAnimation { id: fadeOut; property: "opacity"; to: 0; duration: 120; easing.type: Easing.InQuad }
    NumberAnimation { id: settleIn; property: "settle"; to: 1; duration: 220; easing.type: Easing.OutCubic }
  }
  Timer { id: marksBeat; interval: 220; onTriggered: panel.marksShown = true }

  Item {
    id: artBox
    visible: panel.layout.art !== null
    x: panel.layout.clip.x
    y: panel.layout.clip.y
    width: panel.layout.clip.w
    height: panel.layout.clip.h
    clip: true
    Rectangle { anchors.fill: parent; visible: panel.layout.clip.inset; color: Light.graded(Qt.darker(Theme.tint(panel.p.id), 1.06).toString(), panel.light) }
    // Her two layers, drawn once into a texture so the hour can grade them together and the key light can follow her
    // outline. She takes the room's grade more gently, so her face stays readable at any hour.
    Item {
      id: figure
      anchors.fill: parent
      visible: false
      layer.enabled: true
    Image {
      id: layerA
      property var box: null
      x: box ? box.x - panel.layout.clip.x : 0
      y: box ? box.y - panel.layout.clip.y : 0
      width: box ? box.w : 0
      height: box ? box.h : 0
      property real settle: 1
      property real focusX: 0
      property real focusY: 0
      transform: Scale { origin.x: layerA.focusX; origin.y: layerA.focusY; xScale: layerA.settle; yScale: layerA.settle }
      sourceSize.width: Math.ceil(width)
      sourceSize.height: Math.ceil(height)
      smooth: true
      asynchronous: true
      onStatusChanged: if (status === Image.Ready && panel.front === 1) panel.land()
    }
    Image {
      id: layerB
      property var box: null
      x: box ? box.x - panel.layout.clip.x : 0
      y: box ? box.y - panel.layout.clip.y : 0
      width: box ? box.w : 0
      height: box ? box.h : 0
      opacity: 0
      property real settle: 1
      property real focusX: 0
      property real focusY: 0
      transform: Scale { origin.x: layerB.focusX; origin.y: layerB.focusY; xScale: layerB.settle; yScale: layerB.settle }
      sourceSize.width: Math.ceil(width)
      sourceSize.height: Math.ceil(height)
      smooth: true
      asynchronous: true
      onStatusChanged: if (status === Image.Ready && panel.front === 0) panel.land()
    }
    }
    MultiEffect {
      anchors.fill: figure
      source: figure
      colorization: panel.light.figureGrade
      colorizationColor: panel.light.grade
      brightness: panel.light.figureBrightness - 1
      saturation: panel.light.figureSaturation - 1
    }
    // The key light, from the open side of the panel, clipped to her outline.
    Rectangle {
      id: keyFill
      anchors.fill: parent
      visible: false
      layer.enabled: true
      readonly property string clear: "#00" + panel.light.key.slice(1)
      gradient: Gradient {
        orientation: Gradient.Horizontal
        GradientStop { position: 0; color: panel.p.side === "left" ? keyFill.clear : panel.light.key }
        GradientStop { position: 1; color: panel.p.side === "left" ? panel.light.key : keyFill.clear }
      }
    }
    MultiEffect {
      anchors.fill: parent
      source: keyFill
      opacity: panel.light.keyStrength * 0.4
      maskEnabled: true
      maskSource: figure
      maskThresholdMin: 0.02
      maskSpreadAtMin: 0.2
    }
  }
  Rectangle {
    visible: panel.layout.clip.inset
    x: artBox.x; y: artBox.y; width: artBox.width; height: artBox.height
    color: "transparent"
    border.color: Theme.ink
    border.width: Theme.line
  }

  // Marks that reinforce her pose, drawn beside her face, never baked into the art; in a reveal they land a beat late.
  Repeater {
    model: panel.marksShown ? panel.layout.marks : []
    delegate: Shape {
      id: mark
      required property var modelData
      x: modelData.x
      y: modelData.y
      width: 100
      height: 100
      scale: modelData.size / 100
      transformOrigin: Item.TopLeft
      readonly property var shape: Compose.MARK_SHAPES[modelData.kind] ?? { stroke: "ink", fill: "transparent", path: "" }
      readonly property var look: ({ stroke: shape.stroke === "ink" ? Theme.ink : shape.stroke, fill: shape.fill, path: shape.path })
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
      sourceComponent: kind === "user" ? note : kind === "shown" ? shownCard : kind === "june" ? speech : kind === "thought" ? thought : kind === "chip" ? chip : kind === "card" ? card : kind === "burst" ? burst : null
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

  // What June showed with her show tool: a card in her balloon's colours on her side, the pictures as polaroids fanned
  // across it and the other files as document cards below. A click opens any of them in the preview, which steps
  // through everything she showed.
  Component {
    id: shownCard
    Rectangle {
      id: shownBox
      property var element
      property var box
      readonly property var files: element && element.files ? element.files : []
      readonly property var pictures: files.filter(f => f.preview === "picture")
      readonly property var documents: files.filter(f => f.preview !== "picture")
      readonly property int drawn: Math.min(pictures.length, 3)
      readonly property real photos: drawn > 0 ? 62 + (drawn - 1) * 16 + (pictures.length > 3 ? 34 : 0) : 0
      readonly property real cardW: Math.min(260, panel.m.textWidth - 28)
      readonly property real cardsTop: drawn > 0 ? 96 : 12
      readonly property real w: Math.ceil(Math.min(Math.max(photos, documents.length > 0 ? cardW : 0) + 28, panel.m.textWidth))
      readonly property real h: Math.ceil(cardsTop + documents.length * 32 + (documents.length > 0 ? 4 : 0))
      function url(file) { return panel.attached && file ? panel.attached + file.id + "/file/" + file.n : ""; }
      function opened(file) {
        const set = files.map(f => ({ kind: f.preview ?? "file", url: url(f), name: f.name }));
        const at = Math.max(0, files.indexOf(file));
        return { kind: set[at].kind, url: set[at].url, name: set[at].name, set: set, at: at };
      }
      width: w
      height: h
      radius: 14
      color: Theme.balloon
      border.color: Theme.ink
      border.width: Theme.line
      Repeater {
        model: shownBox.drawn
        delegate: Item {
          id: shot
          required property int index
          readonly property var file: shownBox.pictures[index]
          x: 14 + index * 16
          y: 12 + index * 3
          width: 62; height: 74
          rotation: [-4, 5, -2][index]
          z: shownBox.drawn - index
          Rectangle { anchors.fill: parent; color: "#fbf8f1"; border.color: Theme.ink; border.width: 1.5; radius: 2 }
          Rectangle {
            x: 5; y: 5; width: 52; height: 52
            color: "#cfd6e3"
            clip: true
            Image { anchors.fill: parent; source: shownBox.url(shot.file); fillMode: Image.PreserveAspectCrop; asynchronous: true; sourceSize.width: 160 }
          }
          MouseArea {
            anchors.fill: parent
            enabled: shownBox.url(shot.file) !== ""
            cursorShape: Qt.PointingHandCursor
            onClicked: panel.preview(shownBox.opened(shot.file))
          }
        }
      }
      // More pictures than the fan shows: how many more, all of them a click away in the preview.
      Text {
        visible: shownBox.pictures.length > 3
        x: 14 + 62 + 2 * 16 + 10
        y: 40
        text: "+" + (shownBox.pictures.length - 3)
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 15; color: Theme.ink
        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: panel.preview(shownBox.opened(shownBox.pictures[3])) }
      }
      Repeater {
        model: shownBox.documents
        delegate: FileCard {
          required property var modelData
          required property int index
          file: modelData
          url: shownBox.url(modelData)
          onChosen: panel.preview(shownBox.opened(modelData))
          x: 14
          y: shownBox.cardsTop + index * 32
          width: shownBox.w - 28
        }
      }
    }
  }

  // The user's note: light blue, rounded, no tail; it enters June's world from outside the frame.
  Component {
    id: note
    Rectangle {
      id: noteBox
      property var element
      property var box
      readonly property var item: element ? element.item : null
      // Pictures it brought, as polaroids clipped to the note after the words, fanned when there are several.
      readonly property int pictures: element ? Math.min(element.pictures ?? 0, 3) : 0
      readonly property bool said: body.text.length > 0
      readonly property real photos: pictures > 0 ? 62 + (pictures - 1) * 16 + (said ? 12 : 0) : 0
      // Files it brought, as document cards clipped on below the words, a row each.
      readonly property var files: element && element.files ? element.files : []
      readonly property real cardW: Math.min(260, panel.m.textWidth - 28)
      readonly property real cardsTop: Math.max(body.height, marker.height, pictures > 0 ? 78 : 0) + 16
      // Everything the message brought for the preview to step through, every picture (not only the three drawn) then
      // every file, opened at `at`.
      function brought(at) {
        const base = panel.attached && item ? panel.attached + item.id + "/" : "";
        const count = element ? element.pictures ?? 0 : 0;
        const set = [];
        for (let i = 0; i < count; i++) set.push({ kind: "picture", url: base + i, name: count > 1 ? "picture " + (i + 1) + " of " + count : "picture" });
        for (const file of files) set.push({ kind: file.preview ?? "file", url: base + "file/" + file.n, name: file.name });
        const shown = set[Math.min(at, set.length - 1)];
        return { kind: shown.kind, url: shown.url, name: shown.name, set: set, at: Math.min(at, set.length - 1) };
      }
      readonly property real w: Math.ceil(Math.min(Math.max(marker.implicitWidth + 8 + (said || (pictures === 0 && files.length === 0) ? body.width : 0) + photos, files.length > 0 ? cardW : 0) + 28, panel.m.textWidth))
      readonly property real h: Math.ceil(Math.max(body.height, marker.height, pictures > 0 ? 78 : 0) + 20 + (files.length > 0 ? files.length * 32 : 0))
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
        width: Math.min(natural.implicitWidth + 2, panel.m.textWidth - 28 - marker.implicitWidth - 8 - noteBox.photos)
        readOnly: true
        selectByMouse: true
        wrapMode: TextEdit.Wrap
        textFormat: TextEdit.PlainText
        text: noteBox.element ? (noteBox.element.text ?? noteBox.item.text) : ""
        font.family: Theme.caption
        font.weight: Font.Medium
        font.pixelSize: 16
        color: Theme.noteInk
        selectionColor: Theme.highlight
      }
      Repeater {
        model: noteBox.pictures
        delegate: Item {
          id: polaroid
          required property int index
          readonly property string url: panel.attached && noteBox.item ? panel.attached + noteBox.item.id + "/" + index : ""
          x: noteBox.w - 14 - 62 - (noteBox.pictures - 1 - index) * 16
          y: 12 + index * 3
          width: 62; height: 74
          rotation: [-6, 5, -2][index]
          z: noteBox.pictures - index
          Rectangle { anchors.fill: parent; color: "#fbf8f1"; border.color: Theme.ink; border.width: 1.5; radius: 2 }
          Rectangle {
            x: 5; y: 5; width: 52; height: 52
            color: "#cfd6e3"
            clip: true
            Image { anchors.fill: parent; source: polaroid.url; fillMode: Image.PreserveAspectCrop; asynchronous: true; sourceSize.width: 160 }
          }
          MouseArea {
            anchors.fill: parent
            enabled: polaroid.url !== ""
            cursorShape: Qt.PointingHandCursor
            onClicked: panel.preview(noteBox.brought(polaroid.index))
          }
          // The paperclip over the frame's top edge, on the front picture only.
          Shape {
            visible: polaroid.index === 0
            x: 34; y: -12
            preferredRendererType: Shape.CurveRenderer
            ShapePath {
              strokeColor: "#8d929c"; strokeWidth: 2.5; fillColor: "transparent"; capStyle: ShapePath.RoundCap
              PathSvg { path: "M 4 26 L 4 6 A 4 4 0 0 1 12 6 L 12 30 A 6 6 0 0 1 0 30 L 0 10" }
            }
          }
        }
      }
      Repeater {
        model: noteBox.files
        delegate: FileCard {
          required property var modelData
          required property int index
          file: modelData
          // Every file opens in the preview, which shows what it can and offers the browser.
          onChosen: url => panel.preview(noteBox.brought((noteBox.element.pictures ?? 0) + index))
          url: panel.attached && noteBox.item ? panel.attached + noteBox.item.id + "/file/" + modelData.n : ""
          x: 14
          y: noteBox.cardsTop + index * 32
          width: noteBox.w - 28
        }
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
      onLink: url => panel.link(url)
      // Paths and commands read as a terminal, as the tool card does: smaller, light on dark.
      text: element ? Strip.markup(element.text, { stress: "font-weight:800; background-color:" + Theme.highlight, code: "font-family:monospace; font-size:" + Math.round(pixelSize * 0.8) + "px; color:" + Theme.cardInk + "; background-color:" + Theme.cardFill, codePad: true, link: "color:" + Theme.noteLine }) + (element.streaming ? "<span style='color:" + Theme.accent + "'> ▍</span>" : "") : ""
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
