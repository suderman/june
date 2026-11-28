// The projects board (board.mjs agendaView), drawn as the phone draws it: Org's agenda (overdue, today, then a section
// a day) as pads of docket stubs; every open task by state; one state's tasks; or the projects with open work, by
// project. A row opens its task's page, a project its file in Emacs. See "Agents and projects" in docs/interfaces.org.
import QtQuick
import "board.mjs" as Board
import "keys.mjs" as KeyNav

Item {
  id: board

  // agendaView's shape, and the agenda itself for drilling into a state; empty until the daemon's board arrives.
  property var view: ({ sections: [], counts: [], projects: [], today: "" })
  property var agenda: null
  property bool loaded: false
  property string host: ""
  property real generatedAt: 0
  // agenda, projects, or a state's tasks.
  property string mode: "agenda"
  property string drill: ""
  property string user: ""
  property string detailKey: ""
  // The page the task sheet shows: the open one, else the last, while the sheet slides away.
  property string shownTask: ""
  onDetailKeyChanged: if (detailKey !== "") shownTask = detailKey
  signal open(string link)
  // An edit from a task's page, and what the last one said for the task on show.
  signal edit(string key, var change)
  property var notice: ({ key: "", text: "" })
  // Who a task can be handed to, and where by default (the agents board's dispatch), and the roster's clankers.
  property var dispatch: null
  property var roster: []
  // The user's edits on their way (shell.qml pendingEdits), shown as made.
  property var pending: ({})
  // A rename moves a task without an ID to a new key; its page follows.
  onNoticeChanged: if ((notice.from ?? "") !== "" && notice.from === detailKey) detailKey = notice.key

  // Wide mode offers a direct Editor shortcut in the board header; narrow mode puts it in the bottom bar.
  property bool showLaunch: false
  signal launchEditor()

  // The pointer is over the board, so Esc puts its sheet away (shell.qml).
  readonly property bool hovered: hover.hovered
  HoverHandler { id: hover }

  // Whether a sheet is open, so Esc has something to put away.
  readonly property bool sheetOpen: detailKey !== ""
  readonly property string activeSheet: detailKey !== "" ? "task" : ""
  property bool keyboardFocused: false
  property int cursorIndex: 0
  readonly property var navItems: KeyNav.projectsItems(board.view, board.mode, board.drillRows)
  readonly property string activeItemKey: navItems.length > 0 ? navItems[Math.max(0, Math.min(navItems.length - 1, cursorIndex))].key : ""
  signal copyText(string text)
  signal restoreFocus()

  onModeChanged: cursorIndex = 0
  function ensureVisible(item) {
    if (!item || !column) return;
    const top = item.mapToItem(column, 0, 0).y;
    const bottom = top + item.height;
    const maxY = Math.max(0, flick.contentHeight - flick.height);
    if (top < flick.contentY + 24) flick.contentY = Math.max(0, top - 24);
    else if (bottom > flick.contentY + flick.height - 24) flick.contentY = Math.min(maxY, bottom - flick.height + 24);
  }
  function setSection(next) {
    if (!next || (next === mode && drill === "")) return;
    detailKey = "";
    drill = "";
    mode = next;
    cursorIndex = 0;
    flick.contentY = 0;
  }
  function cycleSection(delta) {
    const sections = ["agenda", "tasks", "projects"];
    const cur = mode === "state" ? "tasks" : mode;
    const i = sections.indexOf(cur);
    const next = sections[((i >= 0 ? i : 0) + delta + sections.length) % sections.length];
    setSection(next);
  }
  function scrollBy(dy) {
    const maxY = Math.max(0, flick.contentHeight - flick.height);
    flick.contentY = Math.max(0, Math.min(maxY, flick.contentY + dy));
  }
  function scrollStep(delta) { scrollBy(delta * 96); }
  function scrollPage(delta) { scrollBy(delta * Math.max(160, flick.height * 0.8)); }
  function stepRow(delta) {
    if (navItems.length === 0) { scrollStep(delta); return; }
    cursorIndex = KeyNav.stepCursor(navItems.length, cursorIndex, delta);
  }
  function stepSection(delta) {
    if (navItems.length === 0) { scrollPage(delta); return; }
    cursorIndex = KeyNav.stepGroup(navItems, cursorIndex, delta);
  }
  function pageRows(delta) {
    if (navItems.length === 0) { scrollPage(delta); return; }
    cursorIndex = KeyNav.stepCursor(navItems.length, cursorIndex, delta * 6);
  }
  function toggleBottomTop() {
    const maxY = Math.max(0, flick.contentHeight - flick.height);
    if (navItems.length > 0) {
      const atEnd = cursorIndex >= navItems.length - 1 || flick.contentY >= maxY - 8;
      cursorIndex = atEnd ? 0 : navItems.length - 1;
      flick.contentY = atEnd ? 0 : maxY;
    } else {
      flick.contentY = flick.contentY >= maxY - 8 ? 0 : maxY;
    }
  }
  function currentItem() {
    if (navItems.length === 0) return null;
    return navItems[Math.max(0, Math.min(navItems.length - 1, cursorIndex))];
  }
  function activateCurrent() {
    const it = currentItem();
    if (!it) return;
    if (it.kind === "stateHeader") { board.drill = it.state; board.mode = "state"; return; }
    if (it.kind === "project") { if (it.link !== "") board.open(it.link); return; }
    if (it.entry) board.show(it.entry);
  }
  function foldCurrent() {
    if (board.mode === "state") {
      board.mode = "tasks";
      board.drill = "";
      cursorIndex = 0;
      return;
    }
    const it = currentItem();
    if (board.mode === "tasks" && it && (it.state ?? "") !== "") {
      board.drill = it.state;
      board.mode = "state";
      cursorIndex = 0;
    }
  }
  function handleSheetKey(ev) {
    if (detailKey !== "") return detailPage.handleKey(ev);
    return false;
  }

  // Put away the open task page, if there is one; whether there was.
  function dismissSheet() {
    if (detailKey === "") return false;
    detailKey = "";
    return true;
  }

  // Return to the default subsection (agenda) and close any open detail or state drill-down.
  function resetHome() {
    mode = "agenda";
    drill = "";
    detailKey = "";
  }

  readonly property var drillRows: mode === "state" ? Board.stateRows(agenda, drill, pending, user) : []
  readonly property int openCount: view.counts.reduce((n, c) => n + c.n, 0)

  Sheet {
    id: taskSheet
    anchors { left: parent.left; right: parent.right; top: parent.top; bottom: sections.top; bottomMargin: 8 }
    z: 2
    open: board.detailKey !== ""
    onDismissed: board.detailKey = ""
    TaskDetail {
      anchors.fill: parent
      backLabel: ""
      id: detailPage
      detail: board.shownTask !== "" ? Board.taskPage(board.agenda?.tasks, board.shownTask, board.pending, board.user, board.agenda?.today ?? "", Date.now()) : null
      today: board.agenda?.today ?? ""
      undo: board.notice.key === board.shownTask || board.notice.key === (detailPage.detail?.key ?? "") ? (board.notice.undo ?? null) : null
      dispatch: board.dispatch
      roster: board.roster
      onBack: board.detailKey = ""
      onOpen: link => board.open(link)
      onCopyText: text => board.copyText(text)
      onRestoreFocus: board.restoreFocus()
      notice: board.notice.key === board.shownTask || board.notice.key === (detailPage.detail?.key ?? "") ? board.notice.text : ""
      onEdit: change => board.edit(detailPage.detail?.key ?? board.shownTask, change)
    }
  }

  // A row with a task opens its page; one without opens where it can.
  function show(entry) {
    if ((entry.task ?? "") !== "" && Board.findTask(board.agenda?.tasks, entry.task) !== null) board.detailKey = entry.task;
    else if ((entry.link ?? "") !== "") board.open(entry.link);
  }

  // The sections, at the bottom as the phone has them in the compose bar's place.
  SectionBar {
    id: sections
    anchors { left: parent.left; right: parent.right; bottom: parent.bottom; rightMargin: 4 }
    sections: [{ id: "agenda", label: "agenda" }, { id: "tasks", label: "tasks" }, { id: "projects", label: "by project" }]
    current: board.mode === "state" ? "tasks" : board.mode
    // Another section puts away the open task page, which belongs to the one left.
    onPicked: id => { if (id === (board.mode === "state" ? "tasks" : board.mode)) board.resetSection(); else { board.detailKey = ""; board.mode = id; board.drill = ""; } }
  }

  // The showing section again: put its sheet and drill-down away and go back to its top.
  function resetSection() {
    detailKey = "";
    if (mode === "state") { mode = "tasks"; drill = ""; }
    flick.contentY = 0;
  }

  // In the narrow layout a tab bar names the board, so it shows no masthead, as on the phone.
  property bool compact: false

  Flickable {
    id: flick
    visible: !taskSheet.covers
    anchors { left: parent.left; right: parent.right; top: parent.top; bottom: sections.top; bottomMargin: 8 }
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width - 4
      spacing: 10

      // The masthead: the board's name and its summary; the sections are in the bar below.
      Item {
        visible: !board.compact
        width: parent.width
        height: mastheadText.implicitHeight + summary.implicitHeight + 2
        Words { id: mastheadText; role: "masthead"; text: (Theme.consoleLook ? "$ " : "") + "projects"; color: Theme.pageInk }
        Words {
          id: summary
          anchors.top: mastheadText.bottom
          width: parent.width - (editorLaunch.visible ? editorLaunch.width + 8 : 0)
          role: "meta"
          elide: Text.ElideRight
          text: board.loaded ? board.openCount + " open in " + board.view.projects.length + " projects" : "asking Emacs…"
          color: Theme.muted
        }
        Item {
          id: editorLaunch
          visible: board.showLaunch
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.topMargin: 2
          width: 30; height: 30
          Rectangle { anchors.fill: parent; radius: 7; color: Theme.pageInk; opacity: editorHover.containsMouse ? 0.1 : 0 }
          TabIcon { anchors.centerIn: parent; width: 20; height: 20; kind: "editor"; on: false; ink: editorHover.containsMouse ? Theme.pageInk : Theme.muted; paper: Theme.paper }
          MouseArea { id: editorHover; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: board.launchEditor() }
        }
      }

      // The agenda: overdue, today, then a section a day.
      Repeater {
        model: board.mode === "agenda" ? board.view.sections : []
        delegate: Column {
          id: section
          required property var modelData
          required property int index
          readonly property int sectionIndex: index
          width: column.width
          spacing: 8
          SectionRule { text: section.modelData.title; alert: section.modelData.alert }
          Words { visible: section.modelData.rows.length === 0; role: "lettering"; text: "Nothing on the agenda."; color: Theme.muted }
          Pad {
            visible: section.modelData.rows.length > 0
            Repeater {
              model: section.modelData.rows
              delegate: StubRow {
                id: agRow
                required property var modelData
                required property int index
                first: index === 0
                selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "ag:" + section.sectionIndex + ":" + index
                onSelectedChanged: if (selected) board.ensureVisible(agRow)
                title: modelData.title; meta: modelData.meta; stamp: modelData.state ?? ""
                lead: modelData.allDay ? "all day" : (modelData.time ?? ""); leadWidth: 54
                overdue: modelData.overdue ?? false
                opens: (modelData.task ?? "") !== "" || (modelData.link ?? "") !== ""
                onClicked: board.show(modelData)
              }
            }
          }
        }
      }

      // Every open task by state, dated or not: a few rows each, the rest a click away.
      Repeater {
        model: board.mode === "tasks" ? (board.view.lists ?? []) : []
        delegate: Column {
          id: list
          required property var modelData
          width: column.width
          spacing: 6
          SectionRule {
            id: stateRule
            text: list.modelData.title + " · " + list.modelData.n
            clickable: true
            selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "sh:" + list.modelData.state
            onSelectedChanged: if (selected) board.ensureVisible(stateRule)
            onClicked: { board.drill = list.modelData.state; board.mode = "state"; }
          }
          Pad {
            Repeater {
              model: list.modelData.rows
              delegate: StubRow {
                id: tkRow
                required property var modelData
                required property int index
                first: index === 0
                selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "tk:" + list.modelData.state + ":" + index
                onSelectedChanged: if (selected) board.ensureVisible(tkRow)
                title: modelData.title; meta: modelData.meta; overdue: modelData.overdue ?? false
                onClicked: board.show(modelData)
              }
            }
          }
          Item {
            visible: list.modelData.more > 0
            width: parent.width
            height: allRows.height
            PressTab { id: allRows; anchors.right: parent.right; text: "all " + list.modelData.n + " ›"; kind: "quiet"; small: true; onClicked: { board.drill = list.modelData.state; board.mode = "state"; } }
          }
        }
      }
      Words {
        visible: board.mode === "tasks" && (board.view.queued ?? 0) > 0
        width: parent.width
        wrapMode: Text.Wrap
        role: "meta"
        text: board.view.queued + " queued for agents, on the agents board"
        color: Theme.muted
      }

      // One state's tasks.
      PressTab { visible: board.mode === "state"; text: (Theme.consoleLook ? "< " : "‹  ") + "tasks"; kind: "quiet"; small: true; onClicked: { board.mode = "tasks"; board.drill = ""; } }
      SectionRule { visible: board.mode === "state"; text: (Board.LISTS.find(l => l[0] === board.drill)?.[1] ?? board.drill) + " · " + board.drillRows.length }
      Pad {
        visible: board.mode === "state" && board.drillRows.length > 0
        Repeater {
          model: board.drillRows
          delegate: StubRow {
            id: drRow
            required property var modelData
            required property int index
            first: index === 0
            selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "dr:" + index
            onSelectedChanged: if (selected) board.ensureVisible(drRow)
            title: modelData.title; meta: modelData.meta; overdue: modelData.overdue ?? false
            onClicked: board.show(modelData)
          }
        }
      }

      // Each project a binder divider: its title, where it lives when two share a name, its counts as stamps; it
      // opens in Emacs (↗), where the project file is.
      Pad {
        visible: board.mode === "projects"
        Repeater {
          model: board.mode === "projects" ? board.view.projects : []
          delegate: Item {
            id: project
            required property var modelData
            required property int index
            readonly property bool selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "pr:" + index
            onSelectedChanged: if (selected) board.ensureVisible(project)
            width: parent ? parent.width : 0
            height: projectLines.implicitHeight + 16
            Rectangle { visible: project.index > 0; x: 10; width: parent.width - 20; height: 1; color: Theme.rule }
            Rectangle {
              anchors.fill: parent; anchors.margins: 2; radius: 3
              visible: project.selected || projectHover.containsMouse
              color: project.selected ? Qt.alpha(Theme.accent, 0.14) : Qt.alpha(Theme.surfaceInk, 0.05)
            }
            Rectangle { visible: project.selected; x: 2; y: 4; width: 3; height: parent.height - 8; radius: 1.5; color: Theme.accent }
            Column {
              id: projectLines
              x: 10; y: 8
              width: parent.width - 20
              spacing: 4
              Item {
                width: parent.width
                height: projectTitle.implicitHeight
                Words { id: projectTitle; width: parent.width - 18; role: "row"; wrapMode: Text.Wrap; text: project.modelData.title }
                Words { anchors.right: parent.right; role: "row"; text: "↗"; color: Theme.surfaceMuted }
              }
              Words { visible: (project.modelData.where ?? "") !== ""; width: parent.width; role: "number"; elide: Text.ElideMiddle; text: project.modelData.where ?? ""; color: Theme.surfaceMuted }
              Flow {
                width: parent.width
                spacing: 6
                Repeater { model: project.modelData.counts; delegate: Stamp { required property var modelData; text: modelData.state + " " + modelData.n; tone: Theme.tone(modelData.state); tilt: 0 } }
              }
            }
            MouseArea { id: projectHover; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: board.open(project.modelData.link) }
          }
        }
      }

      Words {
        visible: board.loaded
        width: parent.width
        wrapMode: Text.Wrap
        topPadding: 6
        role: "meta"
        text: "From Emacs on " + board.host + (board.generatedAt > 0 ? ", " + Qt.formatTime(new Date(board.generatedAt), "hh:mm") : "")
        color: Theme.muted
      }
    }
  }
}
