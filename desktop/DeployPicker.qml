// Where to deploy WHAT ("pi on cog", "cid on cog"), as the phone's DeployPicker asks it: home, for throwaways and
// chat; a folder where sessions work now or a checkout (board.mjs agentsView places); or one typed in. A pick starts
// it; NOTICE says it is starting, or why it could not.
import QtQuick
import "keys.mjs" as KeyNav

Item {
  id: picker
  property string what: ""
  property var places: []
  property bool keyboardFocused: false
  property int cursorIndex: 0
  // { text, busy } from shell.qml's deployNotice.
  property var notice: ({ text: "", busy: false })
  signal picked(string dir)
  signal back()
  signal restoreFocus()

  readonly property int itemCount: 1 + (places ? places.length : 0) + 1
  onVisibleChanged: if (visible) cursorIndex = 0
  function pick(dir) { if (!picker.notice.busy && dir.trim() !== "") picker.picked(dir.trim()); }
  function ensureVisible(item) {
    if (!item) return;
    const top = item.mapToItem(column, 0, 0).y;
    const bottom = top + item.height;
    const maxY = Math.max(0, flick.contentHeight - flick.height);
    if (top < flick.contentY + 20) flick.contentY = Math.max(0, top - 20);
    else if (bottom > flick.contentY + flick.height - 20) flick.contentY = Math.min(maxY, bottom - flick.height + 20);
  }
  function handleKey(ev) {
    if (!ev || ev.ctrl || ev.alt) return false;
    const k = ev.key || "";
    const t = ev.text || "";
    if (k === "Tab" || k === "Space" || t === " " || t === "?") return false;
    if (k === "Escape" || t === "q") { picker.back(); return true; }
    if (t === "j" || k === "Down") { cursorIndex = KeyNav.stepCursor(itemCount, cursorIndex, 1); return true; }
    if (t === "k" || k === "Up") { cursorIndex = KeyNav.stepCursor(itemCount, cursorIndex, -1); return true; }
    if (t === "n" || t === "N" || k === "PageDown") { cursorIndex = KeyNav.stepCursor(itemCount, cursorIndex, 5); return true; }
    if (t === "p" || t === "P" || k === "PageUp") { cursorIndex = KeyNav.stepCursor(itemCount, cursorIndex, -5); return true; }
    if (t === "Z" || (ev.shift && k === "Z")) { cursorIndex = cursorIndex >= itemCount - 1 ? 0 : itemCount - 1; return true; }
    if (k === "Return" || k === "Enter") {
      if (cursorIndex === 0) picker.pick("~");
      else if (cursorIndex <= (places ? places.length : 0)) picker.pick(places[cursorIndex - 1]);
      else typed.focusField();
      return true;
    }
    return false;
  }

  Flickable {
    id: flick
    anchors.fill: parent
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width - 4
      spacing: 10

      PressTab { text: (Theme.consoleLook ? "< " : "‹  ") + "back"; kind: "quiet"; small: true; onClicked: picker.back() }
      Column {
        width: parent.width
        Words { width: parent.width; role: "title"; wrapMode: Text.Wrap; text: "deploy " + picker.what; color: Theme.pageInk }
        Words { visible: picker.notice.busy; role: "meta"; text: "starting…"; color: Theme.muted }
        Words { visible: !picker.notice.busy && (picker.notice.text ?? "") !== ""; width: parent.width; role: "meta"; wrapMode: Text.Wrap; text: picker.notice.text ?? ""; color: Theme.accent }
      }
      SectionRule { text: "WHERE" }
      Pad {
        StubRow {
          id: homeRow
          first: true
          selected: picker.keyboardFocused && picker.cursorIndex === 0
          onSelectedChanged: if (selected) picker.ensureVisible(homeRow)
          title: "home"; meta: "~ · for throwaways and chat"; onClicked: picker.pick("~")
        }
        Repeater {
          model: picker.places
          delegate: StubRow {
            id: placeRow
            required property var modelData
            required property int index
            selected: picker.keyboardFocused && picker.cursorIndex === index + 1
            onSelectedChanged: if (selected) picker.ensureVisible(placeRow)
            title: String(modelData).split("/").pop()
            meta: modelData
            onClicked: picker.pick(modelData)
          }
        }
      }
      Item {
        id: customBox
        readonly property bool selected: picker.keyboardFocused && picker.cursorIndex === (picker.places ? picker.places.length : 0) + 1
        onSelectedChanged: if (selected) picker.ensureVisible(customBox)
        width: parent.width
        height: typed.implicitHeight + 16
        Inked { anchors.fill: parent; lift: 2; edge: customBox.selected ? Theme.accent : Theme.edge; lineWidth: customBox.selected ? 2.5 : 2 }
        RuledField {
          id: typed
          x: 10; y: 6
          width: parent.width - go.width - 30
          label: "Another folder"; placeholder: "~/src/…"; mono: true
          onAccepted: { picker.pick(typed.text); picker.restoreFocus(); }
          onEscaped: picker.restoreFocus()
        }
        PressTab {
          id: go
          anchors.right: parent.right; anchors.rightMargin: 10; anchors.verticalCenter: parent.verticalCenter
          text: "go"; small: true
          enabled: typed.text.trim() !== "" && !picker.notice.busy
          onClicked: picker.pick(typed.text)
        }
      }
    }
  }
}
