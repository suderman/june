// Persistent clanker shelf: shows working clankers patrolling along the bottom of the focused monitor, even while
// minimised June is dismissed below the screen. Resting in Hyprland's 20 px bottom margin gap, each clanker shrinks to
// a compact hovering orb (revealing its name and task on hover, click to visit). When minimised June rises, the same
// shelf glides smoothly up onto the top of her panel and expands to full size without interrupting patrol motion.
// Uses its own layer namespace ("june-shelf") so Hyprland's june_showing() check for long-press Alt stays untouched.
import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland
import "live.mjs" as Live

PanelWindow {
  id: win

  // Each working session from agentsView.working ({ key, name, agent, harness, title }).
  property var shelf: []
  // Whether this shelf should be shown at all (enabled, overlay closed, not over a fullscreen window).
  property bool active: false
  // Whether minimised June is currently up, so the shelf perches atop her panel instead of the bottom screen gap.
  property bool perched: false
  // Height from the screen's bottom edge to the top of LiveWindow's panel (plus gap) when perched.
  property real perchBottom: 0
  // True while mini June is in NORMAL mode: shows 1–9 jump badges on working clankers.
  property bool showKeyBadges: false

  signal visit(string host, string terminal)

  function visitIndex(idx) {
    if (idx < 0 || idx >= shelfModel.count) return false;
    const row = shelfModel.get(idx);
    if (!row || row.leaving) return false;
    const at = String(row.key).split("|");
    if (at.length !== 2) return false;
    win.visit(at[0], at[1]);
    return true;
  }

  readonly property int margin: 16
  readonly property int halo: 28
  readonly property real stripSpan: Math.min(Theme.stripWidth, (win.screen ? win.screen.width : Theme.stripWidth + 32) - 32)
  readonly property real side: Math.max(0, Math.min(halo, ((win.screen ? win.screen.width : stripSpan) - stripSpan) / 2))
  readonly property real trackWidth: Math.max(120, stripSpan - 2 * margin - 20)
  // True while any clanker on the shelf is hovered (keeps the mask tall enough for the tooltip above the bot).
  property int hoverCount: 0
  readonly property bool anyHovered: hoverCount > 0

  visible: active && shelfModel.count > 0

  anchors { bottom: true }
  // Smoothly ride up with minimised June's panel and glide back into Hyprland's bottom gap when she sinks.
  margins.bottom: perched ? Math.round(perchBottom) : 0
  Behavior on margins.bottom { NumberAnimation { duration: 190; easing.type: Easing.OutCubic } }

  implicitWidth: stripSpan + 2 * side
  // Tall enough for perched bots (54 px) + tooltip above + shadow halo without covering the middle of the screen.
  implicitHeight: 92
  exclusionMode: ExclusionMode.Ignore
  color: "transparent"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.namespace: "june-shelf"
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

  // Only the bottom strip where bots actually hover takes pointer events; empty gap above passes clicks through.
  mask: Region { item: drawn }
  Item {
    id: drawn
    readonly property real activeHeight: win.anyHovered ? win.height : (win.perched ? 58 : 26)
    x: win.side + win.margin
    y: win.height - activeHeight
    width: win.stripSpan - 2 * win.margin
    height: activeHeight
  }

  // Keep delegates alive by session key across periodic agentsBoard refreshes so patrol positions never reset.
  // Departing bots stay in the model with `leaving: true` long enough to hop down below the shelf/screen edge.
  ListModel { id: shelfModel }
  function removeByKey(k) {
    for (let i = shelfModel.count - 1; i >= 0; i--) {
      const row = shelfModel.get(i);
      if (row.key === k && row.leaving) shelfModel.remove(i);
    }
  }
  function pruneLeaving() {
    for (let i = shelfModel.count - 1; i >= 0; i--) {
      if (shelfModel.get(i).leaving) shelfModel.remove(i);
    }
  }
  onVisibleChanged: if (!visible) pruneLeaving()
  function syncShelf() {
    const list = Array.isArray(shelf) ? shelf : [];
    const wanted = {};
    for (let i = 0; i < list.length; i++) {
      const k = String(list[i].key ?? "");
      if (k !== "") wanted[k] = list[i];
    }
    for (let i = shelfModel.count - 1; i >= 0; i--) {
      const row = shelfModel.get(i);
      if (!wanted[row.key]) {
        if (!win.visible) shelfModel.remove(i);
        else if (!row.leaving) shelfModel.setProperty(i, "leaving", true);
      }
    }
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      const k = String(item.key ?? "");
      if (k === "") continue;
      const name = String(item.name || item.agent || item.harness || "");
      const harness = String(item.harness || "other");
      const title = String(item.title || "");
      let found = -1;
      for (let j = 0; j < shelfModel.count; j++) {
        if (shelfModel.get(j).key === k) { found = j; break; }
      }
      if (found >= 0) {
        if (shelfModel.get(found).name !== name) shelfModel.setProperty(found, "name", name);
        if (shelfModel.get(found).harness !== harness) shelfModel.setProperty(found, "harness", harness);
        if (shelfModel.get(found).title !== title) shelfModel.setProperty(found, "title", title);
        if (shelfModel.get(found).leaving) shelfModel.setProperty(found, "leaving", false);
      } else {
        shelfModel.append({ key: k, name: name, harness: harness, title: title, leaving: false });
      }
    }
  }
  onShelfChanged: syncShelf()
  Component.onCompleted: syncShelf()

  // Clip cleanly at the window's bottom floor (screen edge or mini June's panel top) so clankers hop up out of it
  // and dive back below it without clipping shadows at the sides or top.
  Item {
    anchors.fill: parent
    clip: true

    Item {
      id: track
      x: win.side + win.margin + 10
      width: win.trackWidth
      anchors.top: parent.top
      anchors.bottom: parent.bottom

      Repeater {
        model: shelfModel
        delegate: Item {
          id: bot
          required property string key
          required property string name
          required property string harness
          required property string title
          required property bool leaving
          required property int index

          readonly property bool expanded: win.perched || botHover.hovered
          readonly property real botSize: expanded ? 30 : 21
          property int facing: 1
          property bool cruising: false
          property int step: 0
          // Vertical hop offset for arrive/leave: > 0 tucks the bot below the shelf/screen edge.
          property real hopY: 72

          z: botHover.hovered ? 2 : 0
          width: Math.max(expanded ? 34 : 24, expanded ? tag.width : 24)
          height: expanded ? 54 : 24
          anchors.bottom: parent.bottom
          anchors.bottomMargin: win.perched ? 0 : 1
          Behavior on height { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
          Behavior on anchors.bottomMargin { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
          transform: Translate { y: bot.hopY }

          Component.onCompleted: {
            x = Live.patrolStartX(bot.key, track.width, 40);
            arriveAnim.restart();
          }
          Component.onDestruction: if (botHover.hovered) win.hoverCount = Math.max(0, win.hoverCount - 1)

          onLeavingChanged: {
            if (leaving) {
              arriveAnim.stop();
              moveAnim.stop();
              patrolPause.stop();
              bot.cruising = false;
              leaveAnim.restart();
            } else {
              leaveAnim.stop();
              arriveAnim.restart();
            }
          }

          SequentialAnimation {
            id: arriveAnim
            NumberAnimation { target: bot; property: "hopY"; to: -10; duration: 220; easing.type: Easing.OutCubic }
            NumberAnimation { target: bot; property: "hopY"; to: 0; duration: 150; easing.type: Easing.InOutSine }
            onFinished: {
              if (win.visible && !bot.leaving && !botHover.hovered) {
                patrolPause.interval = 250 + (Live.patrolSeed(bot.key) % 700);
                patrolPause.restart();
              }
            }
          }
          SequentialAnimation {
            id: leaveAnim
            // Quick cartoon hop up before diving below the shelf/screen edge.
            NumberAnimation { target: bot; property: "hopY"; to: -12; duration: 110; easing.type: Easing.OutQuad }
            NumberAnimation { target: bot; property: "hopY"; to: 72; duration: 230; easing.type: Easing.InCubic }
            onFinished: win.removeByKey(bot.key)
          }

          function startNextLeg() {
            if (!win.visible || bot.leaving || botHover.hovered) return;
            const next = Live.nextPatrolStep(bot.key, bot.x, track.width, Math.max(bot.width, 40), bot.step);
            bot.step += 1;
            bot.facing = next.facing;
            bot.cruising = true;
            moveAnim.to = next.targetX;
            moveAnim.duration = next.durationMs;
            patrolPause.interval = next.pauseMs;
            moveAnim.restart();
          }

          NumberAnimation {
            id: moveAnim
            target: bot
            property: "x"
            easing.type: Easing.InOutSine
            onFinished: {
              bot.cruising = false;
              if (win.visible && !bot.leaving && !botHover.hovered) patrolPause.restart();
            }
          }
          Timer {
            id: patrolPause
            onTriggered: bot.startNextLeg()
          }
          Connections {
            target: win
            function onVisibleChanged() {
              if (win.visible) {
                if (!bot.leaving && !botHover.hovered && !arriveAnim.running && !moveAnim.running && !patrolPause.running) {
                  patrolPause.interval = 400 + (Live.patrolSeed(bot.key) % 700);
                  patrolPause.restart();
                }
              } else {
                moveAnim.stop();
                patrolPause.stop();
                bot.cruising = false;
              }
            }
          }
          Connections {
            target: track
            function onWidthChanged() {
              const maxX = Math.max(0, track.width - Math.max(bot.width, 40));
              if (bot.x > maxX) bot.x = maxX;
            }
          }

          // Soft local shadow behind just this clanker (and its pill when expanded).
          RectangularShadow {
            anchors.fill: parent
            anchors.topMargin: 2
            radius: 16
            blur: bot.expanded ? 16 : 10
            spread: 0
            color: Qt.rgba(0, 0, 0, bot.expanded ? 0.24 : 0.20)
          }

          Clanker {
            id: art
            harness: bot.harness
            size: bot.botSize
            Behavior on size { NumberAnimation { duration: 180; easing.type: Easing.OutCubic } }
            claws: true
            facing: bot.facing
            anchors.horizontalCenter: parent.horizontalCenter
            // Lean subtly into the direction of travel while cruising, straighten when paused or hovered.
            rotation: bot.cruising && !botHover.hovered ? (bot.facing * 9) : 0
            Behavior on rotation { NumberAnimation { duration: 220; easing.type: Easing.OutCubic } }
            SequentialAnimation on y {
              running: win.visible && !bot.leaving
              loops: Animation.Infinite
              PauseAnimation { duration: (Math.max(0, bot.index) * 370) % 900 }
              NumberAnimation { from: bot.expanded ? 6 : 2; to: 0; duration: 1300; easing.type: Easing.InOutSine }
              NumberAnimation { from: 0; to: bot.expanded ? 6 : 2; duration: 1300; easing.type: Easing.InOutSine }
            }
          }

          Rectangle {
            id: tag
            anchors.bottom: parent.bottom
            anchors.horizontalCenter: parent.horizontalCenter
            width: tagText.implicitWidth + 12
            height: 16
            radius: 8
            opacity: bot.expanded ? 1 : 0
            visible: opacity > 0.01
            Behavior on opacity { NumberAnimation { duration: 160 } }
            color: Theme.cardFill
            border.color: Theme.cardLine
            border.width: 1
            Text {
              id: tagText
              anchors.centerIn: parent
              text: bot.name
              font.family: Theme.caption
              font.weight: Font.Bold
              font.pixelSize: 11
              color: Theme.cardBusy
            }
          }

          // Numeric keycap badge (1–9) while mini June is in NORMAL mode.
          Rectangle {
            visible: win.showKeyBadges && !bot.leaving && bot.index >= 0 && bot.index < 9
            x: -4; y: -2
            width: 16; height: 16; radius: 4
            color: Theme.accent
            Text {
              anchors.centerIn: parent
              text: String(bot.index + 1)
              font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 10
              color: "#fffcf5"
            }
          }

          // Task tooltip above the hovered clanker, clamped horizontally inside the track so it never clips off-edge.
          Rectangle {
            id: tip
            visible: botHover.hovered && !bot.leaving && bot.title !== ""
            width: Math.min(botLabel.implicitWidth + 16, Math.min(360, track.width))
            height: 24
            y: -height - 6
            x: Math.max(-bot.x, Math.min(track.width - bot.x - width, (bot.width - width) / 2))
            radius: 6
            color: Theme.cardFill
            border.color: Theme.cardLine
            border.width: 1.5
            Text {
              id: botLabel
              anchors.centerIn: parent
              width: parent.width - 14
              elide: Text.ElideRight
              text: bot.title
              font.family: Theme.caption
              font.weight: Font.Bold
              font.pixelSize: 12
              color: Theme.cardBusy
            }
          }

          HoverHandler {
            id: botHover
            enabled: !bot.leaving
            cursorShape: Qt.PointingHandCursor
            onHoveredChanged: {
              if (hovered) {
                win.hoverCount += 1;
                if (moveAnim.running) moveAnim.pause();
                patrolPause.stop();
                bot.cruising = false;
              } else {
                win.hoverCount = Math.max(0, win.hoverCount - 1);
                if (bot.leaving) return;
                if (moveAnim.paused) {
                  bot.cruising = true;
                  moveAnim.resume();
                } else if (win.visible && !arriveAnim.running) {
                  patrolPause.interval = 600;
                  patrolPause.restart();
                }
              }
            }
          }
          TapHandler {
            enabled: !bot.leaving
            onTapped: {
              const at = bot.key.split("|");
              console.info("shelf: visit", bot.key);
              if (at.length === 2) win.visit(at[0], at[1]);
            }
          }
        }
      }
    }
  }
}
