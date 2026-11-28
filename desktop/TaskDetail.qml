// One task's page in a board column (board.mjs taskDetail) as a work-order docket, as the phone's Docket.kt draws it:
// the slip with its project, number, title and state stamp, and below its tear who has it and when; then what the
// task asks and its Dialog, each entry folded to a few lines; the reply on a memo pad; and last the slip's fields to
// change. See "Restyle the phone boards as task dockets" in the June project notes for why the question comes first.
import QtQuick
import "board.mjs" as Board
import "keys.mjs" as KeyNav

Item {
  id: page

  property var detail: null
  property string backLabel: "back"
  property bool keyboardFocused: false
  // What the last edit said: "saved", or why org-edit refused; with undo, the edit that puts it back.
  property string notice: ""
  property var undo: null
  property string today: ""
  signal back()
  signal open(string link)
  // The user's edit (board-edit.ts TaskEdit): a state, an assignment, a reply, a date, a title.
  signal edit(var change)
  signal copyText(string text)
  signal restoreFocus()
  // Who a task can be handed to, and where by default: { hosts, host, agents }.
  property var dispatch: null
  // The roster's cards (board.mjs rosterView), so a task can be handed to a clanker on its own host.
  property var roster: []

  readonly property string orgState: detail?.state ?? ""
  // A file another program rebuilds (org.protected): only TODO or DONE, which the mirror may sync back.
  readonly property bool locked: detail?.protected ?? false
  readonly property bool editable: orgState !== "" && !locked
  readonly property bool assignable: !locked && (detail?.next ?? []).includes("AUTO")
  // A queued task can be renamed too: the daemon renames it under the dispatcher's lock.
  readonly property bool renamable: !locked && ["", "TODO", "EVAL", "HOLD", "AUTO"].includes(orgState)
  // An edit on its way: the page shows it as made; taps meanwhile queue behind it (shell.qml editTask).
  readonly property bool busy: detail?.busy ?? false
  readonly property string agent: detail?.agent ?? ""
  readonly property string host: detail?.host ?? ""
  // The clankers a task can go to: valid cards on a host the dispatcher launches on.
  readonly property var clankers: (roster ?? []).filter(c => (c.problems ?? []).length === 0 && (c.host ?? "") !== ""
    && ((dispatch?.hosts ?? []).length === 0 || dispatch.hosts.includes(c.host)))
  readonly property string agentName: clankers.find(c => c.slug === agent)?.name ?? agent
  // A handoff waiting for the user to confirm it: { agent, name, host, when, fixed }, or null; when "" starts as the
  // page says. A clanker's host is its own (fixed); a bare harness needs one picked.
  property var handoff: null
  // Which date is being picked: schedule, deadline, handoff, or "".
  property string picking: ""
  property bool renaming: false
  property bool statePick: false
  property bool assignPick: false
  property int assignIndex: 0
  // Item-by-item keyboard cursor inside the docket (title, Dialog entries, reply, Change rows & pills).
  property string lastDetailKey: ""
  property int cursorIndex: 0
  property int stateCursor: 0
  property int handCursor: 0
  property var openEntries: ({})
  property var entryTabCycle: null
  readonly property var stateOptions: KeyNav.taskStateOptions(page.detail, page.locked, page.assignable, page.agent !== "" && page.host !== "")
  readonly property var moveToStates: {
    const out = (page.detail?.next ?? []).filter(s => page.locked || s !== "AUTO").map(s => ({ state: s, isRequeue: false }));
    if (page.assignable && page.agent !== "" && page.host !== "") out.push({ state: "AUTO", isRequeue: true });
    return out;
  }
  readonly property var assignCandidates: {
    const out = [];
    for (let i = 0; i < clankers.length; i++) {
      const c = clankers[i];
      out.push({ agent: c.slug, name: c.name, host: c.host, fixed: true });
    }
    const bare = dispatch?.agents ?? ["pi", "claude"];
    for (let i = 0; i < bare.length; i++) {
      const a = bare[i];
      out.push({ agent: a, name: a, host: page.host !== "" ? page.host : (dispatch?.host ?? ""), fixed: false });
    }
    return out;
  }
  // The dialog entry the page leads with when the task asks: the agent's latest.
  readonly property var asked: (detail?.dialog ?? []).find(e => (detail?.ask ?? "") !== "" && e.key === detail.ask) ?? null
  readonly property var earlier: (detail?.dialog ?? []).filter(e => e !== asked)
  readonly property var navItems: detail === null ? [] : KeyNav.taskDetailItems({
    renamable: page.renamable,
    hasAsked: page.asked !== null,
    askedKey: page.asked?.key ?? "asked",
    earlierCount: page.earlier.length,
    earlierKeys: page.earlier.map((e, i) => e?.key || ("entry:" + i)),
    editable: page.editable,
    stateCount: page.orgState !== "" ? page.moveToStates.length : 0,
    assignable: page.orgState !== "" && page.assignable && page.handoff === null,
    assignCount: page.assignCandidates.length,
  })
  readonly property string activeItemKey: navItems.length > 0 ? navItems[Math.max(0, Math.min(navItems.length - 1, cursorIndex))].key : ""
  function currentItem() {
    if (navItems.length === 0) return null;
    return navItems[Math.max(0, Math.min(navItems.length - 1, cursorIndex))];
  }
  function entryOpen(entryKey, isLead) {
    if (openEntries[entryKey] !== undefined) return Boolean(openEntries[entryKey]);
    return Boolean(isLead);
  }
  function toggleSingleEntry(entryKey, isLead) {
    entryTabCycle = null;
    const next = Object.assign({}, openEntries);
    next[entryKey] = !entryOpen(entryKey, isLead);
    openEntries = next;
  }
  function allEntryIds() {
    const out = [];
    if (asked !== null) out.push({ id: asked.key || "asked", lead: true });
    for (let i = 0; i < earlier.length; i++) out.push({ id: earlier[i]?.key || ("entry:" + i), lead: false });
    return out;
  }
  function cycleDialogEntries(globalOnly) {
    const list = allEntryIds();
    if (list.length === 0) return;
    const ids = list.map(x => x.id);
    const leadSet = {};
    for (let i = 0; i < list.length; i++) if (list[i].lead) leadSet[list[i].id] = true;
    const it = currentItem();
    const target = (it && (it.kind === "asked" || it.kind === "entry")) ? it.entryKey : ids[0];
    const r = KeyNav.cycleSections(ids, openEntries, id => Boolean(leadSet[id]), target, entryTabCycle, Boolean(globalOnly));
    openEntries = r.openMap;
    entryTabCycle = r.nextCycle;
  }
  function ensureVisible(item) {
    if (!item || !column) return;
    const top = item.mapToItem(column, 0, 0).y;
    const bottom = top + item.height;
    const maxY = Math.max(0, flick.contentHeight - flick.height);
    if (top < flick.contentY + 24) flick.contentY = Math.max(0, top - 24);
    else if (bottom > flick.contentY + flick.height - 24) flick.contentY = Math.min(maxY, bottom - flick.height + 24);
  }
  onCursorIndexChanged: entryTabCycle = null
  onDetailChanged: {
    if (detail === null || !assignable) { handoff = null; assignPick = false; }
    if (detail === null) { picking = ""; renaming = false; statePick = false; lastDetailKey = ""; cursorIndex = 0; stateCursor = 0; handCursor = 0; openEntries = ({}); entryTabCycle = null; return; }
    const k = detail.key ?? "";
    if (k !== lastDetailKey) {
      lastDetailKey = k;
      cursorIndex = 0;
      stateCursor = 0;
      handCursor = 0;
      openEntries = ({});
      entryTabCycle = null;
      flick.contentY = 0;
    }
  }
  function send(change) {
    page.picking = "";
    page.statePick = false;
    page.assignPick = false;
    page.edit(change);
  }
  function scrollBy(dy) {
    const maxY = Math.max(0, flick.contentHeight - flick.height);
    flick.contentY = Math.max(0, Math.min(maxY, flick.contentY + dy));
  }
  function scrollToBottom() {
    flick.contentY = Math.max(0, flick.contentHeight - flick.height);
  }
  function confirmHandoff() {
    if (page.handoff === null) return;
    const c = { action: "assign", agent: page.handoff.agent };
    if ((page.handoff.host ?? "") !== "") c.host = page.handoff.host;
    if ((page.handoff.when ?? "") !== "") c.when = page.handoff.when;
    page.handoff = null;
    page.send(c);
  }
  function activateCurrent() {
    const it = currentItem();
    if (!it) return;
    if (it.kind === "title" && page.renamable && page.detail) {
      page.renaming = true; rename.text = page.detail.title; flick.contentY = 0; rename.focusField(); return;
    }
    if (it.kind === "asked") { toggleSingleEntry(it.entryKey, true); return; }
    if (it.kind === "entry") { toggleSingleEntry(it.entryKey, false); return; }
    if (it.kind === "reply" && page.editable) { ensureVisible(reply); reply.focusField(); return; }
    if (it.kind === "moveTo" && page.moveToStates.length > 0) {
      const m = page.moveToStates[Math.max(0, Math.min(page.moveToStates.length - 1, page.stateCursor))];
      page.send(m.isRequeue ? { action: "assign", agent: page.agent, host: page.host } : { action: "state", state: m.state });
      return;
    }
    if (it.kind === "handTo" && page.assignCandidates.length > 0) {
      const pick = page.assignCandidates[Math.max(0, Math.min(page.assignCandidates.length - 1, page.handCursor))];
      page.handoff = { agent: pick.agent, name: pick.name, host: pick.host, when: "", fixed: pick.fixed };
      scrollToBottom();
      return;
    }
    if (it.kind === "schedule" && page.editable) { page.handoff = null; page.picking = "schedule"; scrollToBottom(); return; }
    if (it.kind === "deadline" && page.editable) { page.handoff = null; page.picking = "deadline"; scrollToBottom(); return; }
  }
  function handleKey(ev) {
    if (!ev || ev.ctrl || ev.alt) return false;
    const k = ev.key || "";
    const t = ev.text || "";
    if (k === "Space" || t === " " || t === "?") return false;
    if (page.picking === "handoff") return handoffPicker.handleKey(ev);
    if (page.picking === "schedule" || page.picking === "deadline") return datePicker.handleKey(ev);
    if (page.statePick) {
      if (k === "Escape" || k === "Backspace" || t === "q") { page.statePick = false; return true; }
      for (let i = 0; i < page.stateOptions.length; i++) {
        const opt = page.stateOptions[i];
        if (opt.key === t) {
          page.statePick = false;
          page.send(opt.isRequeue ? { action: "assign", agent: page.agent, host: page.host } : { action: "state", state: opt.state });
          return true;
        }
      }
      page.statePick = false;
      return true;
    }
    if (page.assignPick) {
      const list = page.assignCandidates;
      if (k === "Escape" || k === "Backspace" || t === "q") { page.assignPick = false; return true; }
      if (t >= "1" && t <= "9") {
        const idx = Number(t) - 1;
        if (idx >= 0 && idx < list.length) {
          const pick = list[idx];
          page.handoff = { agent: pick.agent, name: pick.name, host: pick.host, when: "", fixed: pick.fixed };
          page.assignPick = false;
          scrollToBottom();
        }
        return true;
      }
      if (t === "j" || k === "Down") { page.assignIndex = KeyNav.stepCursor(list.length, page.assignIndex, 1); return true; }
      if (t === "k" || k === "Up") { page.assignIndex = KeyNav.stepCursor(list.length, page.assignIndex, -1); return true; }
      if (k === "Return" || k === "Enter") {
        if (page.assignIndex >= 0 && page.assignIndex < list.length) {
          const pick = list[page.assignIndex];
          page.handoff = { agent: pick.agent, name: pick.name, host: pick.host, when: "", fixed: pick.fixed };
          page.assignPick = false;
          scrollToBottom();
        }
        return true;
      }
      return true;
    }
    if (page.handoff !== null) {
      if (k === "Escape" || k === "Backspace" || t === "q") { page.handoff = null; return true; }
      if (k === "Return" || k === "Enter") { confirmHandoff(); return true; }
      if (t === "w") { page.picking = "handoff"; scrollToBottom(); return true; }
      if ((t === "h" || t === "l" || k === "Left" || k === "Right") && !page.handoff.fixed) {
        const hosts = page.dispatch?.hosts ?? [];
        if (hosts.length > 1) {
          const i = hosts.indexOf(page.handoff.host);
          const d = (t === "h" || k === "Left") ? -1 : 1;
          const nextHost = hosts[((i >= 0 ? i : 0) + d + hosts.length) % hosts.length];
          page.handoff = Object.assign({}, page.handoff, { host: nextHost });
        }
        return true;
      }
      return true;
    }
    if (k === "Escape" || k === "Backspace" || t === "q") {
      if (page.renaming) { page.renaming = false; return true; }
      page.back();
      return true;
    }
    const cur = currentItem();
    if ((t === "h" || t === "l" || k === "Left" || k === "Right") && cur) {
      const d = (t === "h" || k === "Left") ? -1 : 1;
      if (cur.kind === "moveTo" && page.moveToStates.length > 0) {
        page.stateCursor = KeyNav.stepCursor(page.moveToStates.length, page.stateCursor, d);
        return true;
      }
      if (cur.kind === "handTo" && page.assignCandidates.length > 0) {
        page.handCursor = KeyNav.stepCursor(page.assignCandidates.length, page.handCursor, d);
        return true;
      }
    }
    if (t === "[") {
      if (navItems.length > 0) cursorIndex = KeyNav.stepGroup(navItems, cursorIndex, -1);
      else scrollBy(-160);
      return true;
    }
    if (t === "]") {
      if (navItems.length > 0) cursorIndex = KeyNav.stepGroup(navItems, cursorIndex, 1);
      else scrollBy(160);
      return true;
    }
    if (t === "j" || k === "Down") {
      if (navItems.length > 0) cursorIndex = KeyNav.stepCursor(navItems.length, cursorIndex, 1);
      else scrollBy(96);
      return true;
    }
    if (t === "k" || k === "Up") {
      if (navItems.length > 0) cursorIndex = KeyNav.stepCursor(navItems.length, cursorIndex, -1);
      else scrollBy(-96);
      return true;
    }
    if (t === "n" || t === "N" || k === "PageDown") { scrollBy(Math.max(160, flick.height * 0.75)); return true; }
    if (t === "p" || t === "P" || k === "PageUp") { scrollBy(-Math.max(160, flick.height * 0.75)); return true; }
    if (t === "Z" || (ev.shift && k === "Z")) {
      const maxY = Math.max(0, flick.contentHeight - flick.height);
      const atEnd = (navItems.length > 0 && cursorIndex >= navItems.length - 1) || flick.contentY >= maxY - 8;
      if (navItems.length > 0) cursorIndex = atEnd ? 0 : navItems.length - 1;
      flick.contentY = atEnd ? 0 : maxY;
      return true;
    }
    if (k === "Return" || k === "Enter") { activateCurrent(); return true; }
    if (k === "Tab") { cycleDialogEntries(Boolean(ev.shift)); return true; }
    if (t === "o") {
      if (cur && cur.kind === "asked") toggleSingleEntry(cur.entryKey, true);
      else if (cur && cur.kind === "entry") toggleSingleEntry(cur.entryKey, false);
      else cycleDialogEntries(true);
      return true;
    }
    if (t === "s" && page.stateOptions.length > 0) { page.statePick = true; return true; }
    if (t === "r" && page.editable) { ensureVisible(reply); reply.focusField(); return true; }
    if (t === "w" && page.editable) { page.handoff = null; page.picking = "schedule"; scrollToBottom(); return true; }
    if (t === "W" && page.editable) { page.handoff = null; page.picking = "deadline"; scrollToBottom(); return true; }
    if (t === "A" && page.assignable && page.assignCandidates.length > 0) { page.picking = ""; page.assignPick = true; page.assignIndex = 0; return true; }
    if (t === "R" && page.renamable && page.detail) { page.renaming = true; rename.text = page.detail.title; flick.contentY = 0; rename.focusField(); return true; }
    if (t === "e" && (page.detail?.emacs ?? "") !== "" && page.detail.emacs !== "null") { page.open(page.detail.emacs); return true; }
    if (t === "t" && (page.detail?.herdr ?? "") !== "" && page.detail.herdr !== "null") { page.open(page.detail.herdr); return true; }
    if (t === "u" && !page.busy && page.undo !== null) { page.send(page.undo); return true; }
    if (t === "c" && page.detail) {
      let out = "";
      if (cur && cur.kind === "asked" && page.asked) out = page.asked.text ?? "";
      else if (cur && cur.kind === "entry" && page.earlier[cur.index]) out = page.earlier[cur.index].text ?? "";
      else {
        const parts = [page.detail.title ?? ""];
        if ((page.detail.headline ?? "") !== "") parts.push(page.detail.headline);
        else if (page.asked && (page.asked.text ?? "") !== "") parts.push(page.asked.text);
        out = parts.filter(Boolean).join("\n\n");
      }
      if (out !== "") page.copyText(out);
      return true;
    }
    return false;
  }

  // The page's task left the boards: archived, or no longer in an agenda file.
  Column {
    visible: page.detail === null
    width: parent.width
    spacing: 10
    BackLink {}
    Words { width: parent.width; wrapMode: Text.Wrap; role: "lettering"; text: "That task is no longer on the boards."; color: Theme.muted }
  }

  Flickable {
    id: flick
    anchors.fill: parent
    anchors.bottomMargin: keyPromptBar.visible ? keyPromptBar.height + 6 : 0
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width - 4
      spacing: 10
      visible: page.detail !== null

      BackLink {}

      // The slip: band, title and stamp, then its stub of who and when below the tear.
      Item {
        width: parent.width
        height: slip.implicitHeight
        Inked { anchors.fill: parent; lift: 3 }
        Column {
          id: slip
          width: parent.width
          Band {
            label: (page.detail?.project ?? "") !== "" ? page.detail.project : "Task"
            number: page.detail?.docket ?? ""
            BandLink { kind: "editor"; name: "emacs"; link: page.detail?.emacs ?? "" }
            BandLink { kind: "terminal"; name: "herdr"; link: page.detail?.herdr ?? "" }
          }
          Item {
            width: parent.width
            height: Math.max(heading.implicitHeight, stateStamp.height) + 18
            Column {
              id: heading
              x: 12; y: 10
              width: parent.width - 24 - (stateStamp.visible ? stateStamp.width + 8 : 0)
              spacing: 3
              Words { visible: (page.detail?.path ?? "") !== ""; width: parent.width; role: "meta"; elide: Text.ElideRight; text: page.detail?.path ?? ""; color: Theme.surfaceMuted }
              Words {
                id: titleText
                readonly property bool selected: page.keyboardFocused && page.activeItemKey === "title"
                onSelectedChanged: if (selected) page.ensureVisible(titleText)
                width: parent.width
                role: "title"
                wrapMode: Text.Wrap
                text: (page.detail?.title ?? "") + (page.renamable && !page.renaming ? "  ✎" : "")
                color: selected ? Theme.accent : Theme.surfaceInk
                font.underline: page.renamable && (titleHover.containsMouse || selected)
                MouseArea {
                  id: titleHover
                  anchors.fill: parent
                  enabled: page.renamable
                  hoverEnabled: true
                  cursorShape: Qt.PointingHandCursor
                  onClicked: { page.renaming = !page.renaming; if (page.renaming) { rename.text = page.detail.title; rename.focusField(); } }
                }
              }
            }
            Stamp {
              id: stateStamp
              visible: page.orgState !== ""
              anchors.right: parent.right; anchors.rightMargin: 10
              y: 10
              text: page.orgState
              tone: Theme.tone(page.orgState)
              big: true
              tilt: -2.5
            }
          }
          Column {
            visible: page.renaming
            x: 12
            width: parent.width - 24
            spacing: 6
            RuledField {
              id: rename
              label: "New title"
              onAccepted: renameButton.clicked()
              onEscaped: { page.renaming = false; page.restoreFocus(); }
            }
            Row {
              spacing: 8
              PressTab {
                id: renameButton
                text: "Rename"; kind: "primary"; small: true
                onClicked: {
                  const title = rename.text.trim();
                  if (title !== "" && title !== page.detail.title) page.send({ action: "title", title: title });
                  page.renaming = false;
                  page.restoreFocus();
                }
              }
              PressTab { text: "Cancel"; kind: "quiet"; small: true; onClicked: { page.renaming = false; page.restoreFocus(); } }
            }
          }
          Words {
            visible: (page.detail?.headline ?? "") !== ""
            x: 12
            width: parent.width - 24
            topPadding: 2
            role: "lettering"
            wrapMode: Text.Wrap
            text: "“" + (page.detail?.headline ?? "") + "”"
            color: Qt.alpha(Theme.surfaceInk, 0.85)
          }
          Item { width: 1; height: 4 }
          Perforation {}
          Row {
            x: 12
            width: parent.width - 24
            spacing: 8
            bottomPadding: 10
            Repeater {
              model: [
                ["Assigned", page.agent === "" ? "—" : page.host !== "" ? page.agentName + " · " + page.host : page.agentName],
                ["Scheduled", (page.detail?.scheduledLabel ?? "") !== "" ? page.detail.scheduledLabel : "—"],
                ["Due", (page.detail?.deadlineLabel ?? "") !== "" ? page.detail.deadlineLabel : "—"],
              ]
              delegate: Column {
                required property var modelData
                width: (column.width - 24 - 16) / 3
                Words { role: "label"; text: Theme.consoleLook ? modelData[0].toLowerCase() : modelData[0].toUpperCase(); color: Theme.surfaceMuted }
                Words { width: parent.width; role: "meta"; font.weight: Font.Bold; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; text: modelData[1] }
              }
            }
          }
        }
      }
      // What else holds the task, as the facts line has it, less what the stub shows.
      Words {
        readonly property var extra: (page.detail?.facts ?? "").split(" · ").filter(f => f.indexOf("waits on") === 0 || f.endsWith("review"))
        visible: extra.length > 0
        width: parent.width
        role: "meta"
        wrapMode: Text.Wrap
        text: extra.join(" · ")
        color: Theme.muted
      }
      Item {
        visible: page.busy || page.notice !== ""
        width: parent.width
        height: Math.max(noticeText.implicitHeight, undoLink.height)
        Words {
          id: noticeText
          width: parent.width - (undoLink.visible ? undoLink.width + 10 : 0)
          anchors.verticalCenter: parent.verticalCenter
          role: "meta"
          font.weight: Font.Bold
          wrapMode: Text.Wrap
          text: page.busy ? "saving…" : page.notice
          color: page.busy || page.notice === "saved" ? Theme.muted : Theme.accent
        }
        PressTab {
          id: undoLink
          visible: !page.busy && page.undo !== null
          anchors.right: parent.right
          text: "undo"; kind: "quiet"; small: true
          onClicked: page.send(page.undo)
        }
      }

      // The question first, when the task asks the user; then the rest of the Dialog, oldest first.
      SectionRule { id: asksRule; visible: page.asked !== null; text: "ASKS YOU"; alert: true }
      Entry {
        id: askedEntry
        visible: page.asked !== null
        entry: page.asked
        entryKey: page.asked?.key ?? "asked"
        width: column.width
        lead: true
        selected: page.keyboardFocused && page.activeItemKey === "asked"
        onSelectedChanged: if (selected) page.ensureVisible(askedEntry)
      }
      SectionRule { id: dialogRule; text: page.asked !== null ? "EARLIER IN DIALOG · " + page.earlier.length : "DIALOG" }
      Words { visible: (page.detail?.dialog ?? []).length === 0; role: "lettering"; text: "No Dialog yet."; color: Theme.muted }
      Repeater {
        model: page.earlier
        delegate: Entry {
          id: dialogEntry
          required property var modelData
          required property int index
          entry: modelData
          entryKey: modelData?.key || ("entry:" + index)
          width: column.width
          selected: page.keyboardFocused && page.activeItemKey === "entry:" + index
          onSelectedChanged: if (selected) page.ensureVisible(dialogEntry)
        }
      }

      // A reply in the user's name; with resume, the task goes back to its clanker with it.
      MemoField {
        id: reply
        visible: page.editable
        selected: page.keyboardFocused && page.activeItemKey === "reply"
        onSelectedChanged: if (selected) page.ensureVisible(reply)
        placeholder: (page.asked !== null ? "Answer in Dialog" : "Reply in Dialog") + " (Ctrl+Enter sends)"
        onSubmitted: { (page.assignable ? resumeButton : replyButton).clicked(); page.restoreFocus(); }
        onEscaped: page.restoreFocus()
      }
      Row {
        visible: page.editable
        spacing: 8
        PressTab {
          id: resumeButton
          visible: page.assignable
          text: "Reply and resume"; kind: "primary"
          onClicked: if (reply.text.trim() !== "") { page.send({ action: "reply", text: reply.text, resume: true }); reply.text = ""; }
        }
        PressTab {
          id: replyButton
          text: "Reply"; kind: page.assignable ? "secondary" : "primary"
          onClicked: if (reply.text.trim() !== "") { page.send({ action: "reply", text: reply.text }); reply.text = ""; }
        }
      }

      // The slip's fields, to change: where its state can go, who to hand it to, and its dates.
      SectionRule { id: changeRule; visible: page.orgState !== ""; text: "CHANGE" }
      Item {
        visible: page.orgState !== ""
        width: parent.width
        height: change.implicitHeight
        Inked { anchors.fill: parent; lift: 2 }
        Column {
          id: change
          width: parent.width
          // Back to AUTO is a handoff to the clanker it already names, keeping its schedule.
          readonly property var requeue: page.agent !== "" && page.host !== "" ? { action: "assign", agent: page.agent, host: page.host } : null
          FieldRow {
            id: moveRow
            label: "Move to"
            last: !page.editable && !page.assignable
            selected: page.keyboardFocused && page.activeItemKey === "moveTo"
            onSelectedChanged: if (selected) page.ensureVisible(moveRow)
            Flow {
              width: parent.width
              spacing: 5
              Repeater {
                model: page.moveToStates
                delegate: Stamp {
                  required property var modelData
                  required property int index
                  text: modelData.state
                  tone: Theme.tone(modelData.state)
                  on: moveRow.selected && page.stateCursor === index
                  clickable: true
                  tilt: 0
                  onClicked: page.send(modelData.isRequeue ? { action: "assign", agent: page.agent, host: page.host } : { action: "state", state: modelData.state })
                }
              }
            }
          }
          Words {
            visible: page.locked
            x: 10; width: parent.width - 20
            topPadding: 6; bottomPadding: 8
            role: "meta"
            wrapMode: Text.Wrap
            text: (page.detail?.file ?? "") + " is rebuilt by another program, so only TODO and DONE are set here; DONE may sync back."
            color: Theme.surfaceMuted
          }
          // The roster's clankers first, each on its own host; then a bare harness, which needs one.
          FieldRow {
            id: handRow
            visible: page.assignable && page.handoff === null
            label: "Hand to"
            selected: page.keyboardFocused && page.activeItemKey === "handTo"
            onSelectedChanged: if (selected) page.ensureVisible(handRow)
            Flow {
              width: parent.width
              spacing: 5
              Repeater {
                model: page.clankers
                delegate: Stamp {
                  required property var modelData
                  required property int index
                  text: modelData.name
                  tone: Theme.harnessTone(modelData.clanker ?? Board.harnessOf(modelData.harness))
                  on: handRow.selected && page.handCursor === index
                  clickable: true; tilt: 0
                  onClicked: page.handoff = { agent: modelData.slug, name: modelData.name, host: modelData.host, when: "", fixed: true }
                }
              }
              Repeater {
                model: page.dispatch?.agents ?? ["pi", "claude"]
                delegate: Stamp {
                  required property string modelData
                  required property int index
                  text: modelData
                  tone: Theme.harnessTone(Board.harnessOf(modelData))
                  on: handRow.selected && page.handCursor === (page.clankers.length + index)
                  clickable: true; tilt: 0
                  onClicked: page.handoff = { agent: modelData, name: modelData, host: page.host !== "" ? page.host : (page.dispatch?.host ?? ""), when: "", fixed: false }
                }
              }
            }
          }
          // Nothing is queued until the user confirms who, where and when.
          Column {
            visible: page.handoff !== null
            x: 10
            width: parent.width - 20
            spacing: 8
            topPadding: 10; bottomPadding: 10
            Words {
              width: parent.width
              role: "row"
              wrapMode: Text.Wrap
              text: "Hand to " + (page.handoff?.name ?? "") + (page.handoff?.fixed ? " on " + page.handoff.host : "") + ", starting " + ((page.handoff?.when ?? "") !== ""
                ? Board.dayWord(page.handoff.when.slice(0, 10), page.today) + page.handoff.when.slice(10)
                : page.detail?.starts === "now" ? "now" : "at its schedule, " + (page.detail?.starts ?? "")) + "."
            }
            Flow {
              visible: !(page.handoff?.fixed ?? false) && (page.dispatch?.hosts ?? []).length > 1
              width: parent.width
              spacing: 5
              Words { height: 26; verticalAlignment: Text.AlignVCenter; role: "label"; text: "ON"; color: Theme.surfaceMuted }
              Repeater {
                model: page.dispatch?.hosts ?? []
                delegate: Stamp {
                  required property string modelData
                  text: modelData; tone: Theme.edge; on: (page.handoff?.host ?? "") === modelData; clickable: true; tilt: 0
                  onClicked: page.handoff = Object.assign({}, page.handoff, { host: modelData })
                }
              }
            }
            WhenPicker {
              id: handoffPicker
              visible: page.picking === "handoff"
              width: parent.width
              title: "Start at"
              today: page.today
              start: page.detail?.scheduled ?? ({ date: page.today, time: "" })
              setLabel: "Use this start"
              onPicked: when => { page.handoff = Object.assign({}, page.handoff, { when: when }); page.picking = ""; }
              onCancelled: page.picking = ""
            }
            Flow {
              width: parent.width
              spacing: 8
              PressTab {
                text: (page.handoff?.when ?? "") === "" && page.detail?.starts === "now" ? "Hand off now" : "Hand off"
                kind: "primary"
                onClicked: page.confirmHandoff()
              }
              PressTab { visible: page.picking !== "handoff"; text: (page.handoff?.when ?? "") !== "" ? "Change start" : "Start later…"; onClicked: page.picking = "handoff" }
              PressTab { text: "Cancel"; kind: "quiet"; onClicked: { page.handoff = null; page.picking = ""; } }
            }
          }
          // SCHEDULED and DEADLINE, each picked on a calendar; a queued task's start moves through reschedule-task.
          FieldRow {
            id: schedRow
            visible: page.editable && page.handoff === null
            label: "Scheduled"
            clickable: true
            selected: page.keyboardFocused && page.activeItemKey === "schedule"
            onSelectedChanged: if (selected) page.ensureVisible(schedRow)
            onClicked: page.picking = page.picking === "schedule" ? "" : "schedule"
            Words { width: parent.width; role: "value"; elide: Text.ElideRight; text: page.detail?.hasScheduled ? page.detail.scheduledLabel : "not scheduled"; color: page.detail?.hasScheduled ? Theme.surfaceInk : Theme.surfaceMuted }
          }
          FieldRow {
            id: dueRow
            visible: page.editable && page.handoff === null
            label: "Due"
            clickable: true
            selected: page.keyboardFocused && page.activeItemKey === "deadline"
            onSelectedChanged: if (selected) page.ensureVisible(dueRow)
            last: page.picking !== "schedule" && page.picking !== "deadline"
            onClicked: page.picking = page.picking === "deadline" ? "" : "deadline"
            Words { width: parent.width; role: "value"; elide: Text.ElideRight; text: page.detail?.hasDeadline ? page.detail.deadlineLabel : "no deadline"; color: page.detail?.hasDeadline ? Theme.surfaceInk : Theme.surfaceMuted }
          }
          WhenPicker {
            id: datePicker
            visible: page.picking === "schedule" || page.picking === "deadline"
            x: 10
            width: parent.width - 20
            title: page.picking === "schedule" ? (page.detail?.repeats ? "Scheduled, keeping its repeat" : "Scheduled") : "Deadline"
            today: page.today
            start: page.picking === "deadline" ? (page.detail?.deadline ?? ({ date: page.today, time: "" })) : (page.detail?.scheduled ?? ({ date: page.today, time: "" }))
            canClear: page.picking === "schedule" ? (page.detail?.hasScheduled ?? false) : (page.detail?.hasDeadline ?? false)
            onPicked: when => page.send({ action: page.picking, when: when })
            onCleared: page.send({ action: page.picking, when: "none" })
            onCancelled: page.picking = ""
          }
        }
      }
    }
  }

  // Compact single-key sub-prompt bar for `s` state quick-pick, `A` assign picker, and handoff confirmation.
  Rectangle {
    id: keyPromptBar
    visible: page.statePick || page.assignPick || (page.handoff !== null && page.picking === "")
    anchors { left: parent.left; right: parent.right; bottom: parent.bottom; rightMargin: 4 }
    height: promptFlow.implicitHeight + 14
    radius: 6
    color: Theme.cardFill
    border.color: Theme.accent
    border.width: 1.5
    Flow {
      id: promptFlow
      anchors { left: parent.left; right: parent.right; verticalCenter: parent.verticalCenter; margins: 8 }
      spacing: 8
      Text {
        visible: page.statePick
        text: "STATE:"
        font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 11
        color: Theme.accent
      }
      Repeater {
        model: page.statePick ? page.stateOptions : []
        delegate: Text {
          required property var modelData
          text: "[" + modelData.key + "] " + modelData.state
          font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 11
          color: Theme.cardInk
        }
      }
      Text {
        visible: page.assignPick
        text: "HAND TO:"
        font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 11
        color: Theme.accent
      }
      Repeater {
        model: page.assignPick ? page.assignCandidates : []
        delegate: Text {
          required property var modelData
          required property int index
          text: (index < 9 ? "[" + (index + 1) + "] " : "") + modelData.name
          font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 11
          color: index === page.assignIndex ? Theme.accent : Theme.cardInk
        }
      }
      Text {
        visible: !page.statePick && !page.assignPick && page.handoff !== null
        text: "[RET] hand off · " + (!(page.handoff?.fixed ?? true) ? "[h/l] host · " : "") + "[w] start time · [Esc] cancel"
        font.family: "monospace"; font.weight: Font.Bold; font.pixelSize: 11
        color: Theme.cardInk
      }
    }
  }
  // The back link at the top of the page.
  // None in a sheet (backLabel ""), which closes the page itself.
  component BackLink: PressTab {
    visible: page.backLabel !== ""
    text: (Theme.consoleLook ? "< " : "‹  ") + page.backLabel
    kind: "quiet"
    small: true
    onClicked: page.back()
  }

  // A link on the docket's band, Emacs or Herdr, drawn as the tab bar draws them; the console names it.
  component BandLink: Item {
    id: bandLink
    property string kind: "editor"
    property string name: ""
    property string link: ""
    visible: link !== "" && link !== "null"
    width: Theme.consoleLook ? label.implicitWidth + 6 : 26
    height: 26
    Rectangle { anchors.fill: parent; radius: 5; visible: linkHover.containsMouse; color: Qt.alpha(Theme.surfaceInk, 0.1) }
    TabIcon { visible: !Theme.consoleLook; anchors.centerIn: parent; width: 18; height: 18; kind: bandLink.kind; ink: Theme.surfaceInk; paper: Theme.surface }
    Words { id: label; visible: Theme.consoleLook; anchors.centerIn: parent; role: "number"; text: "[" + bandLink.name + "]" }
    MouseArea { id: linkHover; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: page.open(bandLink.link) }
  }

  // A Dialog entry: the user's as a blue note on the right, an agent's as a note clipped beside its clanker (LEAD, the
  // question the page leads with, edged in the accent), June's as a printed balloon, the dispatcher's as a caption.
  // Long entries are set in the reading face. Each folds to its first four lines; a click opens it (the lead starts open).
  component Entry: Item {
    id: e
    property var entry: ({ kind: "", who: "", at: "", text: "", blocks: [] })
    property string entryKey: ""
    property bool lead: false
    property bool selected: false
    readonly property bool open: page.entryOpen(entryKey !== "" ? entryKey : (entry?.key ?? ""), lead)
    function toggle() { page.toggleSingleEntry(entryKey !== "" ? entryKey : (entry?.key ?? ""), lead); }
    readonly property string kind: entry?.kind ?? ""
    readonly property bool mine: kind === "user"
    readonly property bool narration: kind === "dispatcher"
    readonly property bool agentNote: kind === "agent" && !Theme.consoleLook
    readonly property bool long: (entry?.text ?? "").length > 280
    readonly property string role: long || mine ? "body" : "lettering"
    // Whether the folded text ran past its lines, so there is more to open.
    readonly property bool more: foldedProbe.truncated
    readonly property color noteInk: mine && !Theme.neon && !Theme.consoleLook ? Theme.noteInk : Theme.surfaceInk
    readonly property real cap: mine ? width * 0.86 : narration ? width : width - (agentNote ? 36 : 0)
    height: narration ? captionCol.implicitHeight : box.height + (agentNote ? 6 : 0) + 2

    readonly property string captionText: (Theme.consoleLook ? "# " : (e.open ? "▾ " : "▸ ")) + (e.entry?.who ?? "").toLowerCase() + ((e.entry?.at ?? "") !== "" ? " · " + e.entry.at : "") + " — " + (e.open ? (e.entry?.text ?? "") : (e.entry?.text ?? "").replace(/\n+/g, " "))
    Words { id: captionProbe; visible: false; width: e.width; role: "meta"; wrapMode: Text.Wrap; maximumLineCount: 3; text: (Theme.consoleLook ? "# " : "▸ ") + (e.entry?.who ?? "").toLowerCase() + ((e.entry?.at ?? "") !== "" ? " · " + e.entry.at : "") + " — " + (e.entry?.text ?? "").replace(/\n+/g, " ") }
    Column {
      id: captionCol
      visible: e.narration
      width: e.width
      spacing: 2
      Words {
        id: caption
        width: parent.width
        role: "meta"
        wrapMode: Text.Wrap
        maximumLineCount: e.open ? 2147483647 : 3
        elide: e.open ? Text.ElideNone : Text.ElideRight
        text: e.captionText
        color: Theme.muted
      }
      Words {
        visible: captionProbe.truncated
        anchors.right: parent.right
        role: "label"
        text: e.open ? (Theme.consoleLook ? "[less]" : "less ▴") : (Theme.consoleLook ? "[more]" : "more ▾")
        color: Theme.muted
      }
    }
    Rectangle {
      visible: e.narration && e.selected
      anchors.fill: captionCol
      anchors.margins: -3
      radius: 4
      color: Qt.alpha(Theme.accent, 0.14)
      border.color: Theme.accent
      border.width: 1
    }
    MouseArea {
      visible: e.narration && (captionProbe.truncated || e.open)
      anchors.fill: captionCol
      cursorShape: Qt.PointingHandCursor
      onClicked: e.toggle()
    }
    Clanker {
      visible: e.agentNote
      size: 28
      claws: false
      harness: page.detail?.harness ?? "other"
      anchors.bottom: box.bottom
    }
    Item {
      id: box
      visible: !e.narration
      x: e.mine ? e.width - width : e.agentNote ? 36 : 0
      y: e.agentNote ? 6 : 0
      width: Math.min(e.cap, Math.max(who.implicitWidth, folded.implicitWidth, 60) + 24)
      height: inner.implicitHeight + 18
      Inked {
        anchors.fill: parent
        radius: e.kind === "june" ? 14 : 4
        edge: e.selected || e.lead ? Theme.accent : e.mine ? (Theme.neon ? Theme.consoleUser : Theme.consoleLook ? Theme.edge : Theme.noteLine) : Theme.edge
        fill: e.mine && !Theme.neon && !Theme.consoleLook ? Theme.noteFill : Theme.surface
        lift: e.selected || e.lead ? 3 : 2
        lineWidth: e.selected || e.lead ? 2.5 : 2
      }
      Rectangle {
        visible: e.selected
        anchors.fill: parent; anchors.margins: 2
        radius: e.kind === "june" ? 12 : 3
        color: Qt.alpha(Theme.accent, 0.08)
      }
      Column {
        id: inner
        x: 12; y: 9
        width: box.width - 24
        spacing: 2
        Words { id: who; role: "label"; font.letterSpacing: Theme.type.number.spacing; text: (e.entry?.who ?? "").toLowerCase() + ((e.entry?.at ?? "") !== "" ? " · " + e.entry.at : "") + (Theme.consoleLook ? ":" : ""); color: e.mine && !Theme.neon && !Theme.consoleLook ? Theme.noteInk : Theme.surfaceMuted }
        // Folded: one run of text, its points marked inline.
        Words {
          id: folded
          visible: !e.open
          width: Math.min(implicitWidth, e.cap - 24)
          role: e.role
          wrapMode: Text.Wrap
          maximumLineCount: 4
          elide: Text.ElideRight
          text: (e.entry?.blocks ?? []).length > 0 ? e.entry.blocks.map(b => b.kind === "item" ? b.mark + " " + b.text : b.text).join("  ") : (e.entry?.text ?? "")
          color: e.noteInk
        }
        // The same text, always measured folded, so "more" and "less" show only where there is more.
        Words { id: foldedProbe; visible: false; width: e.cap - 24; role: e.role; wrapMode: Text.Wrap; maximumLineCount: 4; text: folded.text }
        Repeater {
          model: e.open ? ((e.entry?.blocks ?? []).length > 0 ? e.entry.blocks : [{ kind: "para", mark: "", text: e.entry?.text ?? "" }]) : []
          delegate: Item {
            required property var modelData
            width: inner.width
            height: words.implicitHeight + 3
            Words { visible: modelData.kind === "item"; role: e.role; font.weight: Font.Bold; text: modelData.mark; color: e.noteInk }
            Words { id: words; x: modelData.kind === "item" ? 20 : 0; width: parent.width - x; role: e.role; wrapMode: Text.Wrap; text: modelData.text; color: e.noteInk }
          }
        }
        Words {
          visible: e.more
          anchors.right: parent.right
          role: "label"
          text: e.open ? (Theme.consoleLook ? "[less]" : "less ▴") : (Theme.consoleLook ? "[more]" : "more ▾")
          color: e.lead ? Theme.accent : Theme.surfaceMuted
        }
      }
      MouseArea {
        anchors.fill: parent
        enabled: e.more
        cursorShape: Qt.PointingHandCursor
        onClicked: e.toggle()
      }
      // A paper clip over an agent's note.
      Canvas {
        visible: e.agentNote
        anchors.right: parent.right; anchors.rightMargin: 20
        y: -8
        width: 11; height: 26
        onPaint: {
          const ctx = getContext("2d");
          ctx.reset();
          ctx.strokeStyle = Theme.neon ? Theme.surfaceMuted : "#8b8892";
          ctx.lineWidth = 1.6;
          const rr = (x, y, w, h) => { const r = w / 2; ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.stroke(); };
          rr(1, 1, width - 2, height - 2);
          rr(3.5, 6, width - 7, height - 11);
        }
      }
    }
  }
}
