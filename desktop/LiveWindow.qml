// Live June: the desktop client's minimised form, the bottom of the strip on its own (see "Live June, the minimised
// form" in docs/interfaces.org). Her newest panel, the strip's own at the strip's width, sits at the middle of the focused
// screen's bottom; summoned, the strip's compose bar is under it, where the strip has it, so neither moves when the full
// strip grows up out of them. Above the panel, a shelf holds one small clanker for each session at work. She rises from
// below the screen's edge when she shows and sinks back into it. Only what is drawn takes the mouse; the keyboard only
// while the compose bar is open, where Tab opens the full strip. The shell decides when she shows (see live.mjs).
import QtQuick
import QtQuick.Effects
import Quickshell
import Quickshell.Wayland
import "keys.mjs" as KeyNav

PanelWindow {
  id: win

  property bool shown: false
  // The strip's newest panel (shell.qml strip.get(0).json), and what Panel draws it with.
  property string panelJson: ""
  property string activity: ""
  property var poses: []
  property real now: Date.now()
  property real hourOverride: -1
  property var scenery: ({ rooms: [], plates: [], props: [] })
  property var sky: null
  property string attached: ""
  property bool inputShown: false
  // The compose bar's hooks, as the strip's has them.
  property var send: (text, followUp) => true
  property var stop: () => {}
  property var attachments: []
  property var unattach: (index) => {}
  property var paste: (fallback) => fallback()
  property var pick: () => {}
  readonly property bool hovered: hover.hovered
  // Height from the screen's bottom edge to the top of June's panel, for ShelfWindow to perch right on it.
  readonly property real panelTopFromBottom: (cell.item ? panel.height : 0) + (inputShown ? gap + composer.height : 0) + dock + gap
  // The draft, so it moves to the strip's compose bar and back.
  property alias draft: composer.text
  // Modal keyboard state: INSERT (typing) ↔ NORMAL (navigating mini June & jumping to shelf clankers 1–9).
  property bool normalMode: false
  property bool leader: false
  property bool helpOpen: false
  property var hints: []
  property string hintTyped: ""

  signal openStrip()
  signal openStripNormal()
  signal dismissed()
  signal copyText(string text)
  signal openLink(string url)
  signal visitShelf(int index)
  signal leaderCommand(string action, string arg)

  function enterNormal() {
    normalMode = true;
    leader = false;
    hints = [];
    hintTyped = "";
    composer.blurInput();
    normalCatcher.forceActiveFocus();
  }
  function enterInsert() {
    normalMode = false;
    leader = false;
    helpOpen = false;
    hints = [];
    hintTyped = "";
    composer.focusInput();
  }
  function clearHints() { hints = []; hintTyped = ""; }
  function activateHint(h) {
    if (!h) return;
    if (h.kind === "link" && h.url) openLink(h.url);
    else if (h.kind === "toggleTool" && typeof h.toggle === "function") h.toggle();
    else openStripNormal();
  }
  function keyEv(event) {
    const k = event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab ? "Tab"
      : event.key === Qt.Key_Escape ? "Escape"
      : event.key === Qt.Key_Return || event.key === Qt.Key_Enter ? "Return"
      : event.key === Qt.Key_Space ? "Space"
      : event.key === Qt.Key_Up ? "Up"
      : event.key === Qt.Key_Down ? "Down"
      : event.key === Qt.Key_Left ? "Left"
      : event.key === Qt.Key_Right ? "Right" : "";
    return {
      key: k,
      text: event.text || "",
      shift: Boolean(event.modifiers & Qt.ShiftModifier),
      ctrl: Boolean(event.modifiers & Qt.ControlModifier),
      alt: Boolean(event.modifiers & Qt.AltModifier),
    };
  }
  function handleNormalKey(event) {
    const ev = keyEv(event);
    if (hints.length > 0) {
      event.accepted = true;
      if (ev.key === "Escape") { clearHints(); return; }
      if (event.key === Qt.Key_Backspace) { hintTyped = hintTyped.slice(0, -1); return; }
      if (ev.text && ev.text.length === 1 && /^[a-zA-Z]$/.test(ev.text)) {
        const next = hintTyped + ev.text.toLowerCase();
        const m = KeyNav.matchHint(hints, next);
        if (m.kind === "exact") { clearHints(); activateHint(m.hint); }
        else if (m.kind === "prefix") hintTyped = next;
        else clearHints();
        return;
      }
      clearHints();
      return;
    }
    const res = KeyNav.dispatchNormalKey(ev, {
      surface: "mini",
      column: "chat",
      leader: leader,
      helpOpen: helpOpen,
      previewOpen: false,
    });
    if (!res) return;
    event.accepted = true;
    if (res.action === "noop") return;
    if (res.action === "closeHelp") { helpOpen = false; return; }
    if (res.action === "toggleHelp") { helpOpen = !helpOpen; leader = false; return; }
    if (res.action === "openHelp") { helpOpen = true; leader = false; return; }
    if (res.action === "openLeader") { leader = true; return; }
    if (res.action === "cancelLeader") { leader = false; return; }
    leader = false;
    if (res.action === "enterInsert") { enterInsert(); return; }
    if (res.action === "back") { dismissed(); return; }
    if (res.action === "expandOverlay") { openStripNormal(); return; }
    if (res.action === "hint") {
      if (cell.item && typeof cell.item.collectHints === "function") {
        const raw = cell.item.collectHints(panel, win.attached);
        const codes = KeyNav.hintLabels(raw.length);
        for (let i = 0; i < raw.length; i++) raw[i].code = codes[i];
        if (raw.length > 0) { hints = raw; hintTyped = ""; }
      }
      return;
    }
    if (res.action === "copyNewest") {
      try {
        const p = JSON.parse(panelJson);
        const txt = KeyNav.panelCopyText(p);
        if (txt !== "") copyText(txt);
      } catch (e) {}
      return;
    }
    if (res.action === "activateNewest") {
      try {
        const p = JSON.parse(panelJson);
        const acts = KeyNav.panelActions(p, attached);
        const link = acts.find(a => a.kind === "link");
        if (link) { openLink(link.url); return; }
      } catch (e) {}
      openStripNormal();
      return;
    }
    if (res.action === "visitShelf") { visitShelf(res.index); return; }
    leaderCommand(res.action, res.app ?? "");
  }

  // The strip's measures (shell.qml page): its width, its side margins, and the compose bar's place at the bottom.
  readonly property int margin: 16
  // 22, or above the tab bar where the strip has one (a screen too narrow for the boards beside it).
  property int dock: 22
  readonly property int gap: 8
  // Room around what is drawn for the shadow behind her panel and the shelf, as far as the screen allows; the content
  // sits inside it, so the panel and the compose bar stay where the strip has them.
  readonly property int halo: 28
  readonly property real stripSpan: Math.min(Theme.stripWidth, (win.screen ? win.screen.width : Theme.stripWidth + 32) - 32)
  readonly property real side: Math.max(0, Math.min(halo, ((win.screen ? win.screen.width : stripSpan) - stripSpan) / 2))

  // Rising from below the edge, and sinking back before the window goes; INSTANT skips it, when she trades places
  // with the full strip (shell.qml miniBridge).
  property real rise: 0
  property bool instant: false
  Behavior on rise { enabled: !win.instant; NumberAnimation { duration: 190; easing.type: Easing.OutCubic } }
  visible: shown || rise > 0.001
  onShownChanged: {
    rise = shown ? 1 : 0;
    if (!shown) { normalMode = false; leader = false; helpOpen = false; clearHints(); }
    else if (inputShown) Qt.callLater(() => { if (normalMode) normalCatcher.forceActiveFocus(); else composer.focusInput(); });
  }

  anchors { bottom: true }
  implicitWidth: stripSpan + 2 * side
  implicitHeight: Math.min((win.screen ? win.screen.height : 900) - 40, content.implicitHeight)
  exclusionMode: ExclusionMode.Ignore
  color: "transparent"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.namespace: "june-live"
  WlrLayershell.keyboardFocus: inputShown && !regrab ? WlrKeyboardFocus.Exclusive : WlrKeyboardFocus.None
  // Ask for the keyboard again, as when the full strip, which held it, has just gone: Hyprland does not hand it on to a
  // layer that asked while another held it (Jon, 2026-11-26: the third Tab went nowhere).
  property bool regrab: false
  function refocus() {
    if (!inputShown) return;
    regrab = true;
    Qt.callLater(() => { regrab = false; if (normalMode) normalCatcher.forceActiveFocus(); else composer.focusInput(); });
  }
  // Only what is drawn takes the mouse; the rest lets clicks through to the desktop.
  mask: Region { item: drawn }

  onInputShownChanged: if (inputShown) { normalMode = false; composer.focusInput(); }

  Item {
    id: normalCatcher
    focus: win.normalMode
    Keys.onPressed: event => { if (win.normalMode) win.handleNormalKey(event); }
  }

  HoverHandler { id: hover }

  // The span of what is drawn, for the mask, where the content comes to rest. Outside the content: Quickshell's Region
  // recomputes only when its own item moves, so inside the rising content it kept the place it had below the window.
  Item {
    id: drawn
    x: content.x + win.margin
    y: panel.y
    width: content.width - 2 * win.margin
    height: (win.inputShown ? composer.y + composer.height : panel.y + panel.height) - panel.y
  }

  Item {
    id: content
    x: win.side
    width: parent.width - 2 * win.side
    height: parent.height
    implicitHeight: win.halo + panel.height + (win.inputShown ? win.gap + composer.height : 0) + win.dock
    transform: Translate { y: (1 - win.rise) * (content.implicitHeight + 24) }

    // A soft shadow behind her panel. Not in the mask: clicks pass through it.
    RectangularShadow {
      visible: cell.item !== null
      x: panel.x
      y: panel.y
      width: panel.width
      height: panel.height
      radius: 8
      blur: 20
      spread: 0
      color: Qt.rgba(0, 0, 0, 0.42)
    }

    // Her newest panel, the strip's own; a click opens the full strip around it.
    Item {
      id: panel
      x: win.margin
      width: parent.width - 2 * win.margin
      height: cell.item ? cell.item.height : 0
      anchors.bottom: win.inputShown ? composer.top : parent.bottom
      anchors.bottomMargin: win.inputShown ? win.gap : win.dock
      Loader {
        id: cell
        width: parent.width
        active: win.panelJson !== ""
        sourceComponent: Theme.consoleLook ? consoleCell : comicCell
      }
      Component {
        id: comicCell
        Panel {
          json: win.panelJson
          width: panel.width
          newest: true
          activity: win.activity
          poses: win.poses
          now: win.now
          hourOverride: win.hourOverride
          scenery: win.scenery
          sky: win.sky
          attached: win.attached
        }
      }
      Component {
        id: consoleCell
        ConsolePanel {
          json: win.panelJson
          width: panel.width
          newest: true
          activity: win.activity
        }
      }
      TapHandler { onTapped: win.openStrip() }
    }

      // The strip's compose bar, where the strip has it. Tab toggles Insert ↔ Normal; Esc dismisses mini June.
      Composer {
        id: composer
        visible: win.inputShown
        normalMode: win.normalMode
        x: win.margin
        width: parent.width - 2 * win.margin
        anchors.bottom: parent.bottom
        anchors.bottomMargin: win.dock
        send: win.send
        stop: win.stop
        attachments: win.attachments
        unattach: win.unattach
        paste: win.paste
        pick: win.pick
        tabAction: () => win.enterNormal()
        escAction: () => win.dismissed()
        onEnteredInsert: win.enterInsert()
      }

      KeyOverlay {
        anchors.fill: panel
        leader: win.leader
        helpOpen: win.helpOpen
        hints: win.hints
        hintTyped: win.hintTyped
        surface: "mini"
        column: "chat"
        onCloseHelp: win.helpOpen = false
      }
  }
}
