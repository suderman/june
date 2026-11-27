// The strip itself: the panels newest at the bottom, with momentum scrolling (scroll.mjs) and paging, staying on the
// newest panel unless the reader has scrolled away. The desktop client and the windowed app each hold one over the same model.
import QtQuick
import QtQuick.Controls
import "scroll.mjs" as Scroll

ListView {
  id: list

  property string activity: ""
  property var poses: []
  property real now: Date.now()
  property real hourOverride: -1
  property var scenery: ({ rooms: [], plates: [], props: [] })
  property var sky: null
  // Where the pictures the user's messages brought are served, for their polaroids.
  property string attached: ""
  property bool linked: true
  property var taking: ({})
  signal take(var action)
  // A picture or file a panel asks to show over the strip: { kind, url, name }.
  signal preview(var item)
  signal copyText(string text)
  // A link in June's words was clicked, in either look.
  signal link(string url)
  // The console look instead of the comic strip.
  property bool consoleLook: Theme.consoleLook

  // The panel holding a moment opened from June's history, outlined until another day opens; "" for none.
  property string marked: ""

  // Whether to stay on the newest panel, and the wheel's momentum.
  property bool follow: true
  property var scrollState: Scroll.rest()

  verticalLayoutDirection: ListView.BottomToTop
  spacing: 14
  clip: true
  opacity: linked ? 1 : 0.5
  // Stay on the newest panel as panels arrive and settle their height, unless the user has scrolled away.
  onContentHeightChanged: if (follow) Qt.callLater(list.positionViewAtBeginning)
  onCountChanged: if (follow) Qt.callLater(list.positionViewAtBeginning)
  onMovementEnded: follow = atYEnd

  function scrollBy(dy) {
    const top = originY;
    const bottom = originY + Math.max(0, contentHeight - height);
    const next = Math.max(top, Math.min(bottom, contentY + dy));
    if (next === top || next === bottom) scrollState = Scroll.halt();
    contentY = next;
  }
  // Momentum scrolling: a wheel notch glides, a touchpad coasts on when the fingers lift.
  WheelHandler {
    target: null
    onWheel: event => {
      list.follow = false;
      const r = Scroll.wheel(list.scrollState, { angleY: event.angleDelta.y, pixelY: event.pixelDelta.y, now: Date.now() });
      list.scrollState = r.state;
      if (r.dy !== 0) list.scrollBy(r.dy);
      glider.running = true;
      event.accepted = true;
    }
  }
  FrameAnimation {
    id: glider
    running: false
    onTriggered: {
      const r = Scroll.step(list.scrollState, frameTime, Date.now());
      list.scrollState = r.state;
      if (r.dy !== 0) list.scrollBy(r.dy);
      if (r.done) { running = false; list.follow = list.atYEnd; }
    }
  }
  NumberAnimation {
    id: paging
    target: list
    property: "contentY"
    duration: 260
    easing.type: Easing.OutCubic
    onFinished: list.follow = list.atYEnd
  }
  /** Page toward newer panels (1) or earlier ones (-1). */
  function page(direction) {
    // The user is moving: stop following the newest panel first, or the follow snaps back as panels come into view.
    follow = false;
    scrollState = Scroll.rest();
    glider.running = false;
    paging.stop();
    paging.from = contentY;
    paging.to = Scroll.pageTarget(contentY, height, originY, originY + Math.max(0, contentHeight - height), direction);
    paging.start();
  }
  // Opening lands on the newest panel; panels measure themselves a moment later, so land again once they have.
  Timer { id: settle; interval: 120; onTriggered: if (list.follow) list.positionViewAtBeginning() }
  function landOnNewest() {
    follow = true;
    scrollState = Scroll.rest();
    glider.running = false;
    positionViewAtBeginning();
    settle.restart();
  }
  // A day just opened: its newest panel, or with `panel`, that panel in the middle of the view, landing again once the
  // panels around it have measured themselves.
  property string landing: ""
  Timer { id: settleOnPanel; interval: 120; onTriggered: list.showPanel(list.landing) }
  function showPanel(panel) {
    for (let i = 0; i < count; i++) {
      if (model.get(i).pid !== panel) continue;
      positionViewAtIndex(i, ListView.Center);
      return;
    }
  }
  function land(panel) {
    if (panel === "") { landing = ""; landOnNewest(); return; }
    follow = false;
    scrollState = Scroll.rest();
    glider.running = false;
    paging.stop();
    landing = panel;
    Qt.callLater(showPanel, panel);
    settleOnPanel.restart();
  }

  // A thin scrub bar on the right, shown while the pointer is over the strip or the bar is held, to sweep through a long
  // day quickly (Jon, 2026-11-27). Holding it stops following the newest panel; letting go at the bottom follows again.
  HoverHandler { id: stripHover }
  ScrollBar.vertical: ScrollBar {
    id: scrub
    policy: ScrollBar.AsNeeded
    minimumSize: 0.04
    padding: 2
    onPressedChanged: {
      if (pressed) {
        list.follow = false;
        list.scrollState = Scroll.rest();
        glider.running = false;
        paging.stop();
      } else {
        list.follow = list.atYEnd;
      }
    }
    contentItem: Rectangle {
      implicitWidth: 6
      radius: Theme.consoleLook ? 0 : 3
      color: scrub.pressed ? Theme.pageInk : Theme.muted
      opacity: scrub.pressed ? 0.9 : scrub.hovered ? 0.75 : stripHover.hovered ? 0.45 : 0
      Behavior on opacity { NumberAnimation { duration: 140 } }
    }
    background: null
  }

  // Back to the newest panel in one click, whenever the strip is scrolled up at all.
  Rectangle {
    id: toNewest
    parent: list
    z: 20
    readonly property bool wanted: !list.follow && !list.atYEnd && list.count > 0
    anchors.right: parent.right
    anchors.bottom: parent.bottom
    anchors.rightMargin: 14
    anchors.bottomMargin: 12
    width: 36
    height: 36
    radius: Theme.consoleLook ? 4 : 18
    color: Theme.surface
    border.color: newestHover.hovered ? Theme.pageInk : Theme.rule
    border.width: 1
    opacity: wanted ? 1 : 0
    visible: opacity > 0
    Behavior on opacity { NumberAnimation { duration: 140 } }
    Text {
      anchors.centerIn: parent
      text: "↓"
      font.family: Theme.caption
      font.weight: Font.Bold
      font.pixelSize: 18
      color: Theme.pageInk
    }
    HoverHandler { id: newestHover; cursorShape: Qt.PointingHandCursor }
    TapHandler { onTapped: { list.landing = ""; list.landOnNewest(); } }
  }

  // A comic panel, or the same exchange as console lines.
  delegate: Loader {
    id: cell
    required property int index
    required property string json
    required property string pid
    width: list.width
    sourceComponent: list.consoleLook ? consoleCell : comicCell
    // The moment opened from June's history.
    Rectangle {
      // Inside the panel's edge: the list clips anything wider.
      anchors.fill: parent
      z: 9
      visible: list.marked !== "" && cell.pid === list.marked
      color: "transparent"
      border.color: Theme.accent
      border.width: 4
    }
    TakeMenu {
      anchors.fill: parent
      z: 10
      panel: JSON.parse(cell.json)
      linked: list.linked
      taking: list.taking
      onChosen: action => list.take(action)
    }
    Component {
      id: comicCell
      Panel {
        json: cell.json
        width: list.width
        newest: cell.index === 0
        activity: list.activity
        poses: list.poses
        now: list.now
        hourOverride: list.hourOverride
        scenery: list.scenery
        sky: list.sky
        attached: list.attached
        onPreview: item => list.preview(item)
        onCopyText: text => list.copyText(text)
        onLink: url => list.link(url)
      }
    }
    Component {
      id: consoleCell
      ConsolePanel {
        json: cell.json
        width: list.width
        newest: cell.index === 0
        activity: list.activity
        onPreview: item => list.preview(item)
        onCopyText: text => list.copyText(text)
        onLink: url => list.link(url)
      }
    }
  }
}
