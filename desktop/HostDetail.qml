// One host's page in its sheet (board.mjs agentsView hosts), as the phone's HostDetail draws it: whether it answers
// and its load, its harnesses with the quota each would spend, its sessions (each opens where it runs), and the
// clankers that work there.
import QtQuick
import "keys.mjs" as KeyNav

Item {
  id: page
  property var host: null
  property bool keyboardFocused: false
  property int cursorIndex: 0
  signal open(string link)
  signal back()
  // A raw session of HARNESS on this host: the harness as typed, not a clanker.
  signal deploy(string harness)

  readonly property bool ok: host?.ok ?? false
  readonly property var sessions: host?.sessions ?? []
  readonly property var clankers: host?.clankers ?? []
  readonly property var harnesses: host?.harnesses ?? []
  readonly property int itemCount: harnesses.length + sessions.length

  onHostChanged: cursorIndex = 0
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
    if (k === "Escape" || k === "Backspace" || t === "q") { page.back(); return true; }
    if (t === "[" && harnesses.length > 0) { cursorIndex = 0; flick.contentY = 0; return true; }
    if (t === "]" && sessions.length > 0) { cursorIndex = harnesses.length; return true; }
    if (t === "j" || k === "Down") { cursorIndex = KeyNav.stepCursor(itemCount, cursorIndex, 1); return true; }
    if (t === "k" || k === "Up") { cursorIndex = KeyNav.stepCursor(itemCount, cursorIndex, -1); return true; }
    if (t === "n" || t === "N" || k === "PageDown") { cursorIndex = KeyNav.stepCursor(itemCount, cursorIndex, 5); return true; }
    if (t === "p" || t === "P" || k === "PageUp") { cursorIndex = KeyNav.stepCursor(itemCount, cursorIndex, -5); return true; }
    if (t === "Z" || (ev.shift && k === "Z")) {
      const maxY = Math.max(0, flick.contentHeight - flick.height);
      if (itemCount > 0) cursorIndex = cursorIndex >= itemCount - 1 ? 0 : itemCount - 1;
      flick.contentY = flick.contentY >= maxY - 8 ? 0 : maxY;
      return true;
    }
    if (k === "Return" || k === "Enter") {
      if (cursorIndex >= 0 && cursorIndex < harnesses.length) { page.deploy(harnesses[cursorIndex].harness); return true; }
      const si = cursorIndex - harnesses.length;
      if (si >= 0 && si < sessions.length && (sessions[si].link ?? "") !== "") { page.open(sessions[si].link); return true; }
      return true;
    }
    return false;
  }

  Words {
    visible: page.host === null
    width: parent.width
    role: "lettering"
    wrapMode: Text.Wrap
    text: "That host is no longer on the board."
    color: Theme.muted
  }

  Flickable {
    id: flick
    visible: page.host !== null
    anchors.fill: parent
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width - 4
      spacing: 10

      Column {
        width: parent.width
        Words { role: "masthead"; text: page.host?.host ?? ""; color: Theme.pageInk }
        Words {
          role: "meta"
          text: page.ok ? "online · " + (page.host?.working ?? 0) + " working" : "offline"
          color: page.ok ? Theme.muted : Theme.tone("TODO")
        }
        Words { visible: (page.host?.loadText ?? "") !== ""; role: "number"; text: page.host?.loadText ?? ""; color: Theme.pageInk }
        Words {
          visible: (page.host?.error ?? "") !== ""
          width: parent.width
          role: "meta"
          wrapMode: Text.Wrap
          maximumLineCount: 4
          elide: Text.ElideRight
          text: page.host?.error ?? ""
          color: Theme.muted
        }
      }

      SectionRule { visible: page.harnesses.length > 0; text: "HARNESSES · " + page.harnesses.length }
      Pad {
        visible: page.harnesses.length > 0
        Repeater {
          model: page.harnesses
          delegate: Item {
            id: harnessRow
            required property var modelData
            required property int index
            readonly property bool selected: page.keyboardFocused && page.cursorIndex === index
            onSelectedChanged: if (selected) page.ensureVisible(harnessRow)
            width: parent ? parent.width : 0
            height: Math.max(48, harnessText.implicitHeight + 16)
            Rectangle { visible: harnessRow.index > 0; x: 12; width: parent.width - 24; height: 1; color: Theme.rule }
            Rectangle { anchors.fill: parent; anchors.margins: 2; radius: 3; visible: harnessRow.selected; color: Qt.alpha(Theme.accent, 0.14) }
            Rectangle { visible: harnessRow.selected; x: 2; y: 4; width: 3; height: parent.height - 8; radius: 1.5; color: Theme.accent }
            PressTab {
              id: deployTab
              anchors.right: parent.right; anchors.rightMargin: 12; anchors.verticalCenter: parent.verticalCenter
              text: "deploy"; small: true
              onClicked: page.deploy(harnessRow.modelData.harness)
            }
            Clanker { id: harnessArt; x: 12; anchors.verticalCenter: parent.verticalCenter; harness: harnessRow.modelData.clanker; size: 26; claws: false }
            Column {
              id: harnessText
              anchors.left: harnessArt.right; anchors.leftMargin: 10; anchors.right: deployTab.left; anchors.rightMargin: 8
              anchors.verticalCenter: parent.verticalCenter
              spacing: 3
              Words { role: "row"; text: harnessRow.modelData.harness; color: Theme.surfaceInk }
              EnergyGauge { level: harnessRow.modelData.batteryLevel; tone: harnessRow.modelData.batteryTone; gauge: harnessRow.modelData.gauge }
              Words {
                width: parent.width
                role: "meta"
                elide: Text.ElideRight
                text: (harnessRow.modelData.energyText || "unknown") + (harnessRow.modelData.batteryAccount ? " · " + harnessRow.modelData.batteryAccount : "")
                color: Theme.surfaceMuted
              }
            }
          }
        }
      }

      SectionRule { text: "SESSIONS · " + page.sessions.length }
      Words {
        visible: page.sessions.length === 0
        role: "lettering"
        text: page.ok ? "No sessions." : "Out of reach."
        color: Theme.muted
      }
      Pad {
        visible: page.sessions.length > 0
        Repeater {
          model: page.sessions
          delegate: StubRow {
            id: sessionRow
            required property var modelData
            required property int index
            first: index === 0
            selected: page.keyboardFocused && page.cursorIndex === page.harnesses.length + index
            onSelectedChanged: if (selected) page.ensureVisible(sessionRow)
            title: modelData.title; meta: modelData.where + " · " + modelData.status
            harness: modelData.harness; artSize: 26
            opens: (modelData.link ?? "") !== ""
            onClicked: if ((modelData.link ?? "") !== "") page.open(modelData.link)
          }
        }
      }

      SectionRule { text: "CLANKERS · " + page.clankers.length }
      Words {
        width: parent.width
        role: "lettering"
        wrapMode: Text.Wrap
        text: page.clankers.length ? page.clankers.join(", ") : "None work here."
        color: page.clankers.length ? Theme.pageInk : Theme.muted
      }
    }
  }
}
