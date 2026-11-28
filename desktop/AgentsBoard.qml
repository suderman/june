// The agents board as the clankers' room (board.mjs agentsView), drawn as the phone draws it: what needs the user, as
// dockets, most urgent first; then who is working, what is queued (slips on a spike) and under agent review, who is
// idle, and what reported today, each list a pad of docket stubs; or the clankers; or the hosts. Its tabs read hosts,
// clankers, activity, left to right, activity (beside the strip) the default. A docket or row opens where it can: its
// task's page, a clanker's card or a host's page in a sheet risen over the board, an agent's session in Herdr. See
// "Agents and projects" in docs/interfaces.org.
import QtQuick
import "board.mjs" as Board
import "keys.mjs" as KeyNav

Item {
  id: board

  // agentsView's shape; empty until the daemon's board arrives.
  property var view: ({ summary: "", needs: [], working: [], idle: [], queued: [], reviewing: [], recent: [], down: [], hosts: [], roster: [], rosterLeaderboard: [], rosterHasStats: false, rosterHosts: ["kit", "cog"] })
  property bool loaded: false
  property bool idleOpen: false
  property bool queueOpen: false
  // hosts, clankers (cards and editor), or activity (needs, workers, queued, recent).
  property string mode: "activity"
  // The host whose page is open, or "".
  property string hostKey: ""
  // Deploying from a sheet: the host's harness, or the open clanker; DEPLOYASKED once a folder is picked, so the
  // picker closes when the session has started. The session shows in the Herdr app (shell.qml showSession).
  property string deployingHarness: ""
  property bool clankerDeploying: false
  property bool deployAsked: false
  property var deployNotice: ({ text: "", busy: false })
  signal deploy(var request)
  signal visit(string host, string terminal)
  onDeployNoticeChanged: if (deployAsked && !deployNotice.busy && (deployNotice.text ?? "") === "") { deployAsked = false; deployingHarness = ""; clankerDeploying = false; }
  readonly property var activeHost: (view.hosts ?? []).find(h => h.host === shownHost) ?? null
  // The pointer is over the board, so Esc puts its sheet away (shell.qml).
  readonly property bool hovered: hover.hovered
  HoverHandler { id: hover }
  property string rosterSort: "roster"
  property string rosterSlug: ""
  property bool rosterNew: false
  property var rosterNotice: ({ text: "", busy: false, seq: 0, saved: "" })
  signal rosterEdit(var edit)
  onRosterNoticeChanged: {
    if ((rosterNotice.saved ?? "") !== "") {
      rosterSlug = rosterNotice.saved;
      rosterNew = false;
    } else if (rosterNotice.deleted) {
      rosterSlug = "";
      rosterNew = false;
    }
  }
  // What the clanker and host sheets show: the open one, else the last, while the sheet slides away.
  property string shownSlug: ""
  property bool shownNew: false
  property string shownHost: ""
  onRosterSlugChanged: { if (rosterSlug !== "") { shownSlug = rosterSlug; shownNew = false; } else clankerDeploying = false; }
  onRosterNewChanged: if (rosterNew) shownNew = true
  onHostKeyChanged: { if (hostKey !== "") shownHost = hostKey; else deployingHarness = ""; }
  readonly property var activeCard: {
    if (shownNew || shownSlug === "") return null;
    const cards = view.roster ?? [];
    for (let i = 0; i < cards.length; i++) if (cards[i].slug === shownSlug) return cards[i];
    return null;
  }
  // Every task the board names, by key, and how the user signs Dialog, for a task's page; the page open, or "".
  property var tasks: ({})
  property string user: ""
  property string today: ""
  property string detailKey: ""
  // The page the task sheet shows: the open one, else the last, while the sheet slides away.
  property string shownTask: ""
  onDetailKeyChanged: if (detailKey !== "") shownTask = detailKey
  signal open(string link)
  // An edit from a task's page, and what the last one said for the task on show.
  signal edit(string key, var change)
  property var notice: ({ key: "", text: "" })
  // Who a task can be handed to, and where by default (the agents board's dispatch).
  property var dispatch: null
  // The user's edits on their way (shell.qml pendingEdits), shown as made.
  property var pending: ({})
  // A rename moves a task without an ID to a new key; its page follows.
  onNoticeChanged: if ((notice.from ?? "") !== "" && notice.from === detailKey) detailKey = notice.key

  // Wide mode offers a direct Terminal shortcut in the board header; narrow mode puts it in the bottom bar.
  property bool showLaunch: false
  signal launchTerminal()

  // Opening a page counts as seeing a task's review or question, on every device.
  signal seen(string key)

  // Return to the default subsection (activity) and close any open sheet.
  function resetHome() {
    mode = "activity";
    detailKey = "";
    rosterSlug = "";
    rosterNew = false;
    hostKey = "";
  }

  // Whether a sheet is open, so Esc has something to put away.
  readonly property bool sheetOpen: detailKey !== "" || rosterSlug !== "" || rosterNew || hostKey !== ""
  readonly property string activeSheet: detailKey !== "" ? "task" : (rosterSlug !== "" || rosterNew) ? (clankerDeploying ? "deploy" : "roster") : hostKey !== "" ? (deployingHarness !== "" ? "deploy" : "host") : ""
  property bool keyboardFocused: false
  property int cursorIndex: 0
  readonly property var navItems: KeyNav.agentsItems(board.view, board.mode, { queueOpen: board.queueOpen, idleOpen: board.idleOpen, rosterSort: board.rosterSort })
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
    if (!next || next === mode) return;
    dismissSheet();
    mode = next;
    cursorIndex = 0;
    flick.contentY = 0;
  }
  function cycleSection(delta) {
    const sections = ["hosts", "clankers", "activity"];
    const i = sections.indexOf(mode);
    const next = sections[((i >= 0 ? i : 2) + delta + sections.length) % sections.length];
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
    if (it.kind === "host") { board.hostKey = it.host; return; }
    if (it.kind === "clanker") { board.rosterNew = false; board.rosterSlug = it.slug; return; }
    if (it.kind === "toggleQueue") { board.queueOpen = !board.queueOpen; return; }
    if (it.kind === "toggleIdle") { board.idleOpen = !board.idleOpen; return; }
    if (it.kind === "need") { board.show(it.task, ""); return; }
    board.show(it.task, it.link);
  }
  function foldCurrent() {
    const it = currentItem();
    if (it && it.kind === "need" && it.link !== "") { board.open(it.link); return; }
    if (it && (it.kind === "queued" || it.kind === "toggleQueue") && (board.view.queued ?? []).length > 3) { board.queueOpen = !board.queueOpen; return; }
    if ((board.view.idle ?? []).length > 0) board.idleOpen = !board.idleOpen;
  }
  function handleSheetKey(ev) {
    if (detailKey !== "") return detailPage.handleKey(ev);
    if (rosterSlug !== "" || rosterNew) return clankerDeploying ? clankerDeployPicker.handleKey(ev) : rosterPage.handleKey(ev);
    if (hostKey !== "") return deployingHarness !== "" ? hostDeployPicker.handleKey(ev) : hostPage.handleKey(ev);
    return false;
  }
  function handleBoardKey(ev) {
    if (!ev || ev.ctrl || ev.alt || sheetOpen) return false;
    if (mode === "clankers") {
      if (ev.text === "C") { board.rosterSlug = ""; board.rosterNew = true; return true; }
      if (ev.text === "S" && board.view.rosterHasStats === true) {
        board.rosterSort = board.rosterSort === "leaderboard" ? "roster" : "leaderboard";
        cursorIndex = 0;
        return true;
      }
    }
    return false;
  }

  // The showing section again: put its sheet away and go back to its top.
  function resetSection() {
    if (mode === "activity") detailKey = "";
    else if (mode === "clankers") { rosterSlug = ""; rosterNew = false; }
    else hostKey = "";
    flick.contentY = 0;
  }

  // In the narrow layout a tab bar names the board, so it shows no masthead, as on the phone.
  property bool compact: false

  // Put away the open sheet, if there is one; whether there was.
  function dismissSheet() {
    if (detailKey !== "") detailKey = "";
    else if (rosterSlug !== "" || rosterNew) { rosterSlug = ""; rosterNew = false; }
    else if (hostKey !== "") hostKey = "";
    else return false;
    return true;
  }

  // A row with a task opens its page; one without opens where it can.
  function show(task, link) {
    if (task !== "" && Board.findTask(board.tasks, task) !== null) {
      board.detailKey = task;
      if (board.view.needs.some(n => n.task === task && n.kind !== "blocked")) board.seen(task);
    } else if (link !== "") board.open(link);
  }

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
      detail: board.shownTask !== "" ? Board.taskPage(board.tasks, board.shownTask, board.pending, board.user, board.today, Date.now()) : null
      today: board.today
      undo: board.notice.key === board.shownTask || board.notice.key === (detailPage.detail?.key ?? "") ? (board.notice.undo ?? null) : null
      dispatch: board.dispatch
      roster: board.view.roster ?? []
      onBack: board.detailKey = ""
      onOpen: link => board.open(link)
      onCopyText: text => board.copyText(text)
      onRestoreFocus: board.restoreFocus()
      notice: board.notice.key === board.shownTask || board.notice.key === (detailPage.detail?.key ?? "") ? board.notice.text : ""
      onEdit: change => board.edit(detailPage.detail?.key ?? board.shownTask, change)
    }
  }

  Sheet {
    id: clankerSheet
    anchors { left: parent.left; right: parent.right; top: parent.top; bottom: sections.top; bottomMargin: 8 }
    z: 2
    open: board.rosterSlug !== "" || board.rosterNew
    onDismissed: { board.rosterSlug = ""; board.rosterNew = false; }
    RosterDetail {
      id: rosterPage
      anchors.fill: parent
      visible: !board.clankerDeploying
      card: board.activeCard
      creating: board.shownNew
      hosts: board.view.rosterHosts ?? ["kit", "cog"]
      notice: board.rosterNotice
      onBack: { board.rosterSlug = ""; board.rosterNew = false; }
      onSave: edit => board.rosterEdit(edit)
      onRemove: slug => board.rosterEdit({ action: "delete", slug: slug })
      onDeploy: { board.deployAsked = false; board.clankerDeploying = true; }
      onVisit: at => board.visit(at.split("/")[0], at.split("/")[1])
      onRestoreFocus: board.restoreFocus()
    }
    DeployPicker {
      id: clankerDeployPicker
      anchors.fill: parent
      visible: board.clankerDeploying && board.activeCard !== null
      keyboardFocused: board.keyboardFocused && visible
      what: (board.activeCard?.name ?? "") + " on " + (board.activeCard?.host ?? "")
      places: board.view.places ?? []
      notice: board.deployNotice
      onBack: board.clankerDeploying = false
      onPicked: dir => { board.deployAsked = true; board.deploy({ clanker: board.activeCard.slug, dir: dir }); }
      onRestoreFocus: board.restoreFocus()
    }
  }

  Sheet {
    id: hostSheet
    anchors { left: parent.left; right: parent.right; top: parent.top; bottom: sections.top; bottomMargin: 8 }
    z: 2
    open: board.hostKey !== ""
    onDismissed: board.hostKey = ""
    HostDetail {
      id: hostPage
      anchors.fill: parent
      visible: board.deployingHarness === ""
      keyboardFocused: board.keyboardFocused && visible && board.hostKey !== ""
      host: board.activeHost
      onBack: board.hostKey = ""
      onOpen: link => board.open(link)
      onDeploy: harness => { board.deployAsked = false; board.deployingHarness = harness; }
    }
    DeployPicker {
      id: hostDeployPicker
      anchors.fill: parent
      visible: board.deployingHarness !== ""
      keyboardFocused: board.keyboardFocused && visible
      what: board.deployingHarness + " on " + board.shownHost
      places: board.view.places ?? []
      notice: board.deployNotice
      onBack: board.deployingHarness = ""
      onPicked: dir => { board.deployAsked = true; board.deploy({ host: board.shownHost, harness: board.deployingHarness, dir: dir }); }
      onRestoreFocus: board.restoreFocus()
    }
  }

  // The sections, at the bottom as the phone has them in the compose bar's place.
  SectionBar {
    id: sections
    anchors { left: parent.left; right: parent.right; bottom: parent.bottom; rightMargin: 4 }
    sections: [
      { id: "hosts", label: "hosts" },
      { id: "clankers", label: (board.view.roster ?? []).length > 0 ? "clankers " + board.view.roster.length : "clankers" },
      { id: "activity", label: "activity", badge: board.view.needs.length },
    ]
    current: board.mode
    // Another section puts away the open sheet, which belongs to the one left.
    onPicked: id => { if (id === board.mode) board.resetSection(); else { board.dismissSheet(); board.mode = id; } }
  }

  Flickable {
    id: flick
    visible: !(taskSheet.covers || clankerSheet.covers || hostSheet.covers)
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
        Words { id: mastheadText; role: "masthead"; text: (Theme.consoleLook ? "$ " : "") + "agents"; color: Theme.pageInk }
        Words {
          id: summary
          anchors.top: mastheadText.bottom
          width: parent.width - (termLaunch.visible ? termLaunch.width + 8 : 0)
          role: "meta"
          elide: Text.ElideRight
          text: board.loaded ? board.view.summary : "asking hc…"
          color: Theme.muted
        }
        Item {
          id: termLaunch
          visible: board.showLaunch
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.topMargin: 2
          width: 30; height: 30
          Rectangle { anchors.fill: parent; radius: 7; color: Theme.pageInk; opacity: termHover.containsMouse ? 0.1 : 0 }
          TabIcon { anchors.centerIn: parent; width: 20; height: 20; kind: "terminal"; on: false; ink: termHover.containsMouse ? Theme.pageInk : Theme.muted; paper: Theme.paper }
          MouseArea { id: termHover; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: board.launchTerminal() }
        }
      }

      // ---- HOSTS: where work goes, from the agents board ----
      Column {
        visible: board.mode === "hosts"
        width: parent.width
        spacing: 10
        SectionRule { text: "HOSTS · " + (board.view.hosts ?? []).length }
        Words {
          visible: board.loaded && (board.view.hosts ?? []).length === 0
          width: parent.width
          role: "lettering"
          text: "No hosts reported yet."
          color: Theme.muted
        }
        Pad {
          visible: (board.view.hosts ?? []).length > 0
          Repeater {
            model: board.view.hosts ?? []
            delegate: StubRow {
              id: hostRow
              required property var modelData
              required property int index
              first: index === 0
              selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "host:" + modelData.host
              onSelectedChanged: if (selected) board.ensureVisible(hostRow)
              title: modelData.host; meta: modelData.meta
              stamp: modelData.ok ? "" : "OFFLINE"
              onClicked: board.hostKey = modelData.host
            }
          }
        }
      }

      // ---- CLANKERS: clankers/<slug>/CARD.org ----
      Column {
        visible: board.mode === "clankers"
        width: parent.width
        spacing: 10
        SectionRule {
          text: (board.rosterSort === "leaderboard" ? "HISTORY · " : "CLANKERS · ") + (board.view.roster ?? []).length
          PressTab { text: "+ create"; small: true; onClicked: { board.rosterSlug = ""; board.rosterNew = true; } }
        }
        // The order, under the rule so the column's narrow header keeps its title.
        Item {
          visible: board.view.rosterHasStats === true
          width: parent.width
          height: sortLink.height
          PressTab {
            id: sortLink
            anchors.right: parent.right
            text: board.rosterSort === "leaderboard" ? "by name" : "by history"
            kind: "quiet"; small: true
            onClicked: board.rosterSort = board.rosterSort === "leaderboard" ? "roster" : "leaderboard"
          }
        }
        Words {
          visible: board.loaded && (board.view.roster ?? []).length === 0
          width: parent.width
          wrapMode: Text.Wrap
          role: "lettering"
          text: "No clankers yet."
          color: Theme.muted
        }
        Repeater {
          model: board.mode === "clankers" ? (board.rosterSort === "leaderboard" ? (board.view.rosterLeaderboard ?? []) : (board.view.roster ?? [])) : []
          delegate: EnlistCard {
            id: enlistRow
            required property var modelData
            entry: modelData
            selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "clanker:" + modelData.slug
            onSelectedChanged: if (selected) board.ensureVisible(enlistRow)
            width: column.width
            onClicked: { board.rosterNew = false; board.rosterSlug = modelData.slug; }
          }
        }
      }

      // ---- ACTIVITY ----
      Column {
        visible: board.mode === "activity"
        width: parent.width
        spacing: 10

        SectionRule { text: "NEEDS YOU · " + board.view.needs.length; alert: true; visible: board.view.needs.length > 0 }
        Repeater {
          model: board.view.needs
          delegate: NeedDocket {
            id: needCard
            required property var modelData
            required property int index
            need: modelData
            selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "need:" + index
            onSelectedChanged: if (selected) board.ensureVisible(needCard)
            width: column.width
          }
        }
        Words {
          visible: board.loaded && board.view.needs.length === 0
          width: parent.width
          topPadding: 4
          role: "lettering"
          text: "Nothing needs you."
          color: Theme.muted
        }

        SectionRule { text: "WORKING · " + board.view.working.length; visible: board.view.working.length > 0 }
        Pad {
          visible: board.view.working.length > 0
          Repeater {
            model: board.view.working
            delegate: StubRow {
              id: workRow
              required property var modelData
              required property int index
              first: index === 0
              selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "work:" + index
              onSelectedChanged: if (selected) board.ensureVisible(workRow)
              title: modelData.title; meta: modelData.where; harness: modelData.harness; artSize: 30
              opens: (modelData.link ?? "") !== "" || (modelData.task ?? "") !== ""
              onClicked: board.show(modelData.task ?? "", modelData.link ?? "")
            }
          }
        }

        SectionRule { text: "QUEUED · " + board.view.queued.length; visible: board.view.queued.length > 0 }
        // Slips on a spike: the queue's next few on top, the rest stacked under them.
        Item {
          visible: board.view.queued.length > 0
          width: parent.width
          height: queuePad.height + (spike.visible ? 6 : 0)
          Item {
            id: spike
            visible: !board.queueOpen && board.view.queued.length > 3 && !Theme.consoleLook
            Inked { x: 6; y: 6; width: queuePad.width; height: queuePad.height; lift: 0; lineWidth: 1.5 }
            Inked { x: 3; y: 3; width: queuePad.width; height: queuePad.height; lift: 0; lineWidth: 1.5 }
          }
          Pad {
            id: queuePad
            width: parent.width - (spike.visible ? 6 : 0)
            Repeater {
              model: board.queueOpen ? board.view.queued : board.view.queued.slice(0, 3)
              delegate: StubRow {
                id: qRow
                required property var modelData
                required property int index
                first: index === 0
                selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "q:" + index
                onSelectedChanged: if (selected) board.ensureVisible(qRow)
                title: modelData.title; meta: modelData.who
                lead: board.whenLead(modelData.when); leadWidth: 66
                onClicked: board.show(modelData.task, modelData.link ?? "")
              }
            }
          }
        }
        Item {
          id: queueToggleRow
          visible: board.view.queued.length > 3
          readonly property bool selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "toggle:queue"
          onSelectedChanged: if (selected) board.ensureVisible(queueToggleRow)
          width: parent.width
          height: moreQueued.height
          Rectangle {
            visible: queueToggleRow.selected
            anchors.fill: moreQueued; anchors.margins: -3; radius: 5
            color: Qt.alpha(Theme.accent, 0.16); border.color: Theme.accent; border.width: 1
          }
          PressTab {
            id: moreQueued
            anchors.right: parent.right
            text: board.queueOpen ? "fewer" : "all " + board.view.queued.length + " ›"
            kind: "quiet"; small: true
            onClicked: board.queueOpen = !board.queueOpen
          }
        }

        SectionRule { text: "IN AGENT REVIEW · " + board.view.reviewing.length; visible: board.view.reviewing.length > 0 }
        Pad {
          visible: board.view.reviewing.length > 0
          Repeater {
            model: board.view.reviewing
            delegate: StubRow {
              id: revRow
              required property var modelData
              required property int index
              first: index === 0
              selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "rev:" + index
              onSelectedChanged: if (selected) board.ensureVisible(revRow)
              title: modelData.title; meta: modelData.who; stamp: "EVAL"
              onClicked: board.show(modelData.task, modelData.link ?? "")
            }
          }
        }

        SectionRule {
          id: idleRule
          visible: board.view.idle.length > 0
          selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "toggle:idle"
          onSelectedChanged: if (selected) board.ensureVisible(idleRule)
          text: "IDLE · " + board.view.idle.length + (board.idleOpen ? "  ▾" : "")
          clickable: true
          onClicked: board.idleOpen = !board.idleOpen
        }
        Pad {
          visible: board.idleOpen && board.view.idle.length > 0
          Repeater {
            model: board.idleOpen ? board.view.idle : []
            delegate: StubRow {
              id: idleRow
              required property var modelData
              required property int index
              first: index === 0
              selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "idle:" + index
              onSelectedChanged: if (selected) board.ensureVisible(idleRow)
              title: modelData.title; meta: modelData.where + " · " + modelData.status; harness: modelData.harness; artSize: 24
              opens: (modelData.link ?? "") !== "" || (modelData.task ?? "") !== ""
              onClicked: board.show(modelData.task ?? "", modelData.link ?? "")
            }
          }
        }

        SectionRule { text: "REPORTED TODAY · " + board.view.recent.length; visible: board.view.recent.length > 0 }
        Pad {
          visible: board.view.recent.length > 0
          Repeater {
            model: board.view.recent.slice(0, 6)
            delegate: StubRow {
              id: recRow
              required property var modelData
              required property int index
              first: index === 0
              selected: board.keyboardFocused && !board.sheetOpen && board.activeItemKey === "rec:" + index
              onSelectedChanged: if (selected) board.ensureVisible(recRow)
              title: modelData.title; stamp: modelData.state; quote: modelData.line
              meta: modelData.when ? modelData.when + " ago" : ""
              onClicked: board.show(modelData.task, modelData.link ?? "")
            }
          }
        }

        Words {
          visible: board.view.down.length > 0
          width: parent.width
          wrapMode: Text.Wrap
          role: "meta"
          text: "Out of reach: " + board.view.down.join(", ")
          color: Theme.muted
        }
      }
    }
  }

  // A start ("tomorrow 04:30", "Thu 18:00", "now") as a day over a time, for a stub's left column.
  function whenLead(at) {
    const m = /^(.*)\s(\d{1,2}:\d{2})$/.exec(String(at ?? ""));
    if (!m) return String(at ?? "").indexOf("waits") === 0 ? "waits" : String(at ?? "");
    return m[1] + "\n" + m[2];
  }

  // A docket for what needs the user: its kind on the band, the clanker and title, its last word, and where it opens.
  component NeedDocket: Item {
    id: card
    property var need
    property bool selected: false
    readonly property bool urgent: need.level === 1
    height: inner.implicitHeight
    Inked { anchors.fill: parent; edge: card.selected ? Theme.accent : card.urgent ? Theme.tone("TODO") : card.need.kind === "asks" ? Theme.accent : Theme.edge; lift: 3; lineWidth: card.selected || card.urgent ? 2.5 : 2 }
    Rectangle { anchors.fill: parent; anchors.margins: 2; radius: 4; visible: card.selected || hover.containsMouse; color: card.selected ? Qt.alpha(Theme.accent, 0.1) : Qt.alpha(Theme.surfaceInk, 0.04) }
    // The docket opens the task's page; its button opens Herdr or Emacs straight away.
    MouseArea { id: hover; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: board.show(card.need.task ?? "", "") }
    Column {
      id: inner
      width: parent.width
      spacing: 6
      bottomPadding: 8
      Band { label: card.need.label; Words { role: "number"; text: card.need.where; color: Theme.surfaceMuted; rightPadding: 4 } }
      Row {
        x: 10
        width: parent.width - 20
        spacing: 9
        Clanker {
          size: 34
          harness: card.need.harness
          mark: card.need.kind === "blocked" ? "!" : card.need.kind === "asks" ? "?" : ""
          markColor: card.need.kind === "blocked" ? Theme.tone("TODO") : Theme.accent
        }
        Words { width: parent.width - 43; anchors.verticalCenter: parent.verticalCenter; role: "row"; wrapMode: Text.Wrap; text: card.need.title }
      }
      Words {
        visible: card.need.line !== ""
        x: 10
        width: parent.width - 20
        role: "lettering"
        wrapMode: Text.Wrap
        maximumLineCount: 4
        elide: Text.ElideRight
        text: "“" + card.need.line + "”"
        color: Qt.alpha(Theme.surfaceInk, 0.9)
      }
      Item {
        visible: (card.need.link ?? "") !== ""
        x: 10
        width: parent.width - 20
        height: action.height
        PressTab { id: action; anchors.right: parent.right; text: card.need.action; kind: card.urgent ? "primary" : "secondary"; small: true; onClicked: board.open(card.need.link) }
      }
    }
  }
}
