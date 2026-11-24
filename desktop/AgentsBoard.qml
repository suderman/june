// The agents board as the clankers' room (board.mjs agentsView): what needs the user, as cards, most urgent first;
// then who is working, what is queued and under agent review, who is idle, and what reported today. A card or row
// opens where it can: an agent's session in Herdr, a task in Emacs. See "Agents and projects" in docs/interfaces.org.
import QtQuick
import "board.mjs" as Board

Item {
  id: board

  // agentsView's shape; empty until the daemon's board arrives.
  property var view: ({ summary: "", needs: [], working: [], idle: [], queued: [], reviewing: [], recent: [], down: [], roster: [], rosterLeaderboard: [], rosterHasStats: false, rosterHosts: ["kit", "cog"] })
  property bool loaded: false
  property bool idleOpen: false
  // activity (needs, workers, queued, recent) or roster (clanker cards and editor).
  property string mode: "activity"
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
  readonly property var activeCard: {
    if (rosterSlug === "") return null;
    const cards = view.roster ?? [];
    for (let i = 0; i < cards.length; i++) if (cards[i].slug === rosterSlug) return cards[i];
    return null;
  }
  // Every task the board names, by key, and how the user signs Dialog, for a task's page; the page open, or "".
  property var tasks: ({})
  property string user: ""
  property string today: ""
  property string detailKey: ""
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

  // A row with a task opens its page; one without opens where it can.
  function show(task, link) {
    if (task !== "" && Board.findTask(board.tasks, task) !== null) {
      board.detailKey = task;
      if (board.view.needs.some(n => n.task === task && n.kind !== "blocked")) board.seen(task);
    } else if (link !== "") board.open(link);
  }

  TaskDetail {
    anchors.fill: parent
    visible: board.detailKey !== ""
    backLabel: "agents"
    id: detailPage
    detail: board.detailKey !== "" ? Board.taskPage(board.tasks, board.detailKey, board.pending, board.user, board.today, Date.now()) : null
    today: board.today
    undo: board.notice.key === board.detailKey || board.notice.key === (detailPage.detail?.key ?? "") ? (board.notice.undo ?? null) : null
    dispatch: board.dispatch
    onBack: board.detailKey = ""
    onOpen: link => board.open(link)
    notice: board.notice.key === board.detailKey || board.notice.key === (detailPage.detail?.key ?? "") ? board.notice.text : ""
    onEdit: change => board.edit(detailPage.detail?.key ?? board.detailKey, change)
  }

  RosterDetail {
    anchors.fill: parent
    visible: board.detailKey === "" && (board.rosterSlug !== "" || board.rosterNew)
    card: board.activeCard
    creating: board.rosterNew
    hosts: board.view.rosterHosts ?? ["kit", "cog"]
    notice: board.rosterNotice
    onBack: { board.rosterSlug = ""; board.rosterNew = false; }
    onSave: edit => board.rosterEdit(edit)
    onRemove: slug => board.rosterEdit({ action: "delete", slug: slug })
  }

  Flickable {
    visible: board.detailKey === "" && board.rosterSlug === "" && !board.rosterNew
    anchors.fill: parent
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width
      spacing: 10

      Item {
        width: parent.width
        height: 52
        Text {
          id: heading
          anchors.left: parent.left
          anchors.bottom: parent.bottom
          anchors.bottomMargin: 26
          text: "agents"
          font.family: Theme.display; font.pixelSize: 22
          color: Theme.pageInk
        }
        Text {
          anchors.left: parent.left
          anchors.right: termLaunch.visible ? termLaunch.left : parent.right
          anchors.rightMargin: termLaunch.visible ? 8 : 0
          anchors.bottom: parent.bottom
          anchors.bottomMargin: 8
          elide: Text.ElideRight
          text: board.loaded ? board.view.summary : "asking hc…"
          font.family: Theme.caption; font.pixelSize: 13
          color: Theme.muted
        }
        Item {
          id: termLaunch
          visible: board.showLaunch
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.topMargin: 2
          width: 30; height: 30
          Rectangle {
            anchors.fill: parent; radius: 7; color: Theme.pageInk
            opacity: termHover.containsMouse ? 0.1 : 0
          }
          TabIcon {
            anchors.centerIn: parent; width: 20; height: 20
            kind: "terminal"; on: false
            ink: termHover.containsMouse ? Theme.pageInk : Theme.muted
            paper: Theme.paper
          }
          MouseArea {
            id: termHover
            anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
            onClicked: board.launchTerminal()
          }
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 2.5; color: Theme.pageInk }
      }

      // Live room activity, or the roster of named clanker cards.
      Row {
        spacing: 6
        Segment { text: "activity"; on: board.mode === "activity"; onClicked: board.mode = "activity" }
        Segment {
          text: (board.view.roster ?? []).length > 0 ? "roster · " + board.view.roster.length : "roster"
          on: board.mode === "roster"
          onClicked: board.mode = "roster"
        }
      }

      // ---- ROSTER PAGE ----
      Column {
        visible: board.mode === "roster"
        width: parent.width
        spacing: 9

        Item {
          width: parent.width
          height: 26
          SectionTitle {
            anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter
            text: (board.rosterSort === "leaderboard" ? "LEADERBOARD · " : "CLANKERS · ") + (board.view.roster ?? []).length
          }
          Row {
            anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter
            spacing: 5
            Segment {
              visible: board.view.rosterHasStats === true
              text: "ranked"
              on: board.rosterSort === "leaderboard"
              onClicked: board.rosterSort = board.rosterSort === "leaderboard" ? "roster" : "leaderboard"
            }
            Segment {
              text: "+ new"
              on: false
              onClicked: { board.rosterSlug = ""; board.rosterNew = true; }
            }
          }
        }
        Text {
          visible: board.loaded && (board.view.roster ?? []).length === 0
          width: parent.width
          wrapMode: Text.Wrap
          text: "No agents in ROSTER.org yet."
          font.family: Theme.lettering; font.pixelSize: 13
          color: Theme.muted
        }
        Repeater {
          model: board.mode === "roster" ? (board.rosterSort === "leaderboard" ? (board.view.rosterLeaderboard ?? []) : (board.view.roster ?? [])) : []
          delegate: RosterCard { required property var modelData; entry: modelData; width: column.width }
        }
      }

      // ---- ACTIVITY PAGE ----
      Column {
        visible: board.mode === "activity"
        width: parent.width
        spacing: 10

      SectionTitle { text: "NEEDS YOU · " + board.view.needs.length; alert: true; visible: board.view.needs.length > 0 }
      Repeater {
        model: board.view.needs
        delegate: NeedCard { required property var modelData; need: modelData; width: column.width }
      }
      Text {
        visible: board.loaded && board.view.needs.length === 0
        width: parent.width
        text: "Nothing needs you."
        font.family: Theme.lettering; font.pixelSize: 14
        color: Theme.muted
      }

      SectionTitle { text: "WORKING · " + board.view.working.length; visible: board.view.working.length > 0 }
      Repeater {
        model: board.view.working
        delegate: WorkerRow { required property var modelData; worker: modelData; width: column.width }
      }

      SectionTitle { text: "QUEUED · " + board.view.queued.length; visible: board.view.queued.length > 0 }
      Repeater {
        model: board.view.queued
        delegate: TaskRow { required property var modelData; width: column.width; chip: "AUTO"; title: modelData.title; meta: modelData.who + " · " + modelData.when; link: modelData.link ?? ""; task: modelData.task }
      }

      SectionTitle { text: "IN AGENT REVIEW · " + board.view.reviewing.length; visible: board.view.reviewing.length > 0 }
      Repeater {
        model: board.view.reviewing
        delegate: TaskRow { required property var modelData; width: column.width; chip: "EVAL"; title: modelData.title; meta: modelData.who; link: modelData.link ?? ""; task: modelData.task }
      }

      SectionTitle {
        text: "IDLE · " + board.view.idle.length + (board.idleOpen ? "  ▾" : "  ▸")
        visible: board.view.idle.length > 0
        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: board.idleOpen = !board.idleOpen }
      }
      Repeater {
        model: board.idleOpen ? board.view.idle : []
        delegate: WorkerRow { required property var modelData; worker: modelData; width: column.width; small: true }
      }

      SectionTitle { text: "REPORTED TODAY · " + board.view.recent.length; visible: board.view.recent.length > 0 }
      Repeater {
        model: board.view.recent.slice(0, 6)
        delegate: TaskRow {
          required property var modelData
          width: column.width
          chip: modelData.state
          title: modelData.title
          quote: modelData.line
          meta: modelData.when ? modelData.when + " ago" : ""
          link: modelData.link ?? ""
          task: modelData.task
        }
      }

      Text {
        visible: board.view.down.length > 0
        width: parent.width
        wrapMode: Text.Wrap
        text: "Out of reach: " + board.view.down.join(", ")
        font.family: Theme.caption; font.pixelSize: 12
        color: Theme.muted
      }
      }
    }
  }

  component Segment: Rectangle {
    id: seg
    property string text: ""
    property bool on: false
    signal clicked()
    width: segLabel.implicitWidth + 20
    height: 24
    radius: 12
    color: on ? Theme.pageInk : "transparent"
    border.color: Theme.pageInk
    border.width: 2
    Text { id: segLabel; anchors.centerIn: parent; text: seg.text; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: seg.on ? Theme.paper : Theme.pageInk }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: seg.clicked() }
  }

  // One roster agent as a Pokemon-style clanker card: harness band, clanker, status, spec and battery gauge.
  component RosterCard: Rectangle {
    id: rc
    property var entry
    readonly property var colours: Board.HARNESS[entry.clanker] ?? Board.HARNESS.other
    readonly property color batFill: entry.batteryTone === "high" ? "#2f8a4e" : entry.batteryTone === "mid" ? "#c88a12" : entry.batteryTone === "low" ? "#b3311f" : "#8b8892"
    height: rcInner.implicitHeight + 22
    radius: 14
    color: Theme.balloon
    border.color: Theme.ink
    border.width: 2
    clip: true
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { board.rosterNew = false; board.rosterSlug = rc.entry.slug; } }

    Rectangle { width: parent.width; height: 5; color: rc.colours.band }

    Column {
      id: rcInner
      x: 10; y: 12
      width: parent.width - 20
      spacing: 6
      Row {
        width: parent.width
        spacing: 9
        Clanker { size: 38; harness: rc.entry.clanker; claws: rc.entry.available || rc.entry.busy }
        Column {
          width: parent.width - 47
          anchors.verticalCenter: parent.verticalCenter
          spacing: 2
          Row {
            width: parent.width
            spacing: 6
            Text {
              width: Math.min(implicitWidth, parent.width - badge.width - 6)
              elide: Text.ElideRight
              text: rc.entry.name
              font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 15
              color: Theme.ink
            }
            Rectangle {
              id: badge
              anchors.verticalCenter: parent.verticalCenter
              height: 17
              width: badgeLabel.implicitWidth + 10
              radius: 8.5
              color: rc.entry.busy ? "#d7e4f2" : rc.entry.status === "idle" ? "#dfead6" : "#ffd6cf"
              border.color: rc.entry.busy ? "#1c3a66" : rc.entry.status === "idle" ? "#2f5a22" : "#8a1f12"
              border.width: 1.5
              Text {
                id: badgeLabel
                anchors.centerIn: parent
                text: rc.entry.statusLabel
                font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 9
                color: rc.entry.busy ? "#1c3a66" : rc.entry.status === "idle" ? "#2f5a22" : "#8a1f12"
              }
            }
          }
          Text {
            width: parent.width
            elide: Text.ElideRight
            text: rc.entry.specLine
            font.family: Theme.caption; font.pixelSize: 11
            color: "#6d6a73"
          }
        }
      }
      // Battery gauge row (or active terminal when busy).
      Row {
        visible: rc.entry.batteryText !== "" || rc.entry.terminal !== ""
        width: parent.width
        spacing: 7
        Item {
          visible: rc.entry.batteryLevel >= 0
          anchors.verticalCenter: parent.verticalCenter
          width: 28; height: 13
          Rectangle {
            x: 0; y: 0; width: 25; height: 13; radius: 3.5
            color: "transparent"; border.color: Theme.ink; border.width: 1.8
            Rectangle {
              x: 2.5; y: 2.5
              width: Math.max(rc.entry.batteryLevel > 0 ? 2.5 : 0, Math.round((parent.width - 5) * rc.entry.batteryLevel / 100))
              height: parent.height - 5; radius: 1; color: rc.batFill
            }
          }
          Rectangle { x: 26; y: 3.5; width: 2; height: 6; radius: 1; color: Theme.ink }
        }
        Text {
          width: parent.width - (rc.entry.batteryLevel >= 0 ? 35 : 0)
          anchors.verticalCenter: parent.verticalCenter
          elide: Text.ElideRight
          text: rc.entry.terminal !== "" ? rc.entry.terminal : rc.entry.batteryText
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 11
          color: rc.entry.batteryLevel >= 0 ? Theme.ink : "#6d6a73"
        }
      }
      Text {
        visible: (rc.entry.statsLine ?? "") !== ""
        width: parent.width
        elide: Text.ElideRight
        text: rc.entry.statsLine ?? ""
        font.family: Theme.caption; font.pixelSize: 11
        color: "#6d6a73"
      }
    }
  }

  component SectionTitle: Text {
    property bool alert: false
    width: parent ? parent.width : 0
    topPadding: 4
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; font.letterSpacing: 1
    color: alert ? Theme.accent : Theme.muted
  }

  // One thing that needs the user: its clanker and mark, what kind of need, the task, its words, and where it opens.
  component NeedCard: Rectangle {
    id: card
    property var need
    readonly property bool urgent: need.level === 1
    height: inner.implicitHeight + 20
    radius: 14
    // The card opens the task's page; its button opens Herdr or Emacs straight away.
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: board.show(card.need.task ?? "", "") }
    color: urgent ? "#fff0ec" : Theme.balloon
    border.color: urgent ? "#b3311f" : Theme.ink
    border.width: urgent ? 3 : 2

    Column {
      id: inner
      x: 10; y: 10
      width: parent.width - 20
      spacing: 8
      Row {
        width: parent.width
        spacing: 10
        Clanker {
          size: 42
          harness: card.need.harness
          mark: card.need.kind === "blocked" ? "!" : card.need.kind === "asks" ? "?" : "new"
          markColor: card.need.kind === "blocked" ? "#b3311f" : card.need.kind === "asks" ? "#1b1a1f" : "#3d3466"
        }
        Column {
          width: parent.width - 52
          spacing: 2
          Text { text: card.need.label; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 11; font.letterSpacing: 0.5; color: card.urgent ? "#b3311f" : card.need.kind === "review" ? "#3d3466" : Theme.ink }
          Text { width: parent.width; wrapMode: Text.Wrap; text: card.need.title; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 14; color: Theme.ink }
          Text { width: parent.width; elide: Text.ElideRight; text: card.need.where; font.family: Theme.caption; font.pixelSize: 12; color: "#6d6a73" }
        }
      }
      Rectangle {
        visible: card.need.line !== ""
        width: parent.width
        height: quoteText.implicitHeight + 14
        radius: 12
        color: "#fffcf5"
        border.color: Theme.ink
        border.width: 2
        Text {
          id: quoteText
          x: 10; y: 7
          width: parent.width - 20
          wrapMode: Text.Wrap
          maximumLineCount: 4
          elide: Text.ElideRight
          text: card.need.line
          font.family: Theme.lettering; font.pixelSize: 13
          color: Theme.ink
        }
      }
      Rectangle {
        visible: (card.need.link ?? "") !== ""
        anchors.right: parent.right
        width: action.implicitWidth + 28
        height: 30
        radius: 15
        color: Theme.ink
        Text { id: action; anchors.centerIn: parent; text: card.need.action; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: "#f6f1e7" }
        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: board.open(card.need.link) }
      }
    }
  }

  // A worker in a line: its clanker, what it works on, and where; a click opens its session when it has one.
  component WorkerRow: Item {
    id: w
    property var worker
    property bool small: false
    height: Math.max(small ? 28 : 36, texts.implicitHeight)
    opacity: (worker.link ?? "") !== "" || !small ? 1 : 0.75
    Clanker { id: icon; size: w.small ? 26 : 34; claws: !w.small; harness: w.worker.harness }
    Column {
      id: texts
      anchors.left: icon.right
      anchors.leftMargin: 10
      anchors.right: parent.right
      anchors.verticalCenter: icon.verticalCenter
      Text { width: parent.width; wrapMode: Text.Wrap; maximumLineCount: 2; elide: Text.ElideRight; text: w.worker.title; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: w.small ? 12 : 13; color: Theme.pageInk }
      Text { width: parent.width; elide: Text.ElideRight; text: w.worker.where + (w.small ? " · " + w.worker.status : ""); font.family: Theme.caption; font.pixelSize: 12; color: Theme.muted }
    }
    MouseArea { anchors.fill: parent; enabled: (w.worker.link ?? "") !== "" || (w.worker.task ?? "") !== ""; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: board.show(w.worker.task ?? "", w.worker.link ?? "") }
  }

  // A task in a line: its state, title, a quoted report, and what it is waiting on; a click opens it in Emacs.
  component TaskRow: Item {
    id: t
    property string chip: ""
    property string title: ""
    property string quote: ""
    property string meta: ""
    property string link: ""
    property string task: ""
    height: lines.implicitHeight
    StateChip { id: badge; orgState: t.chip; y: 1 }
    Column {
      id: lines
      anchors.left: badge.right
      anchors.leftMargin: 8
      anchors.right: parent.right
      spacing: 1
      Text { width: parent.width; wrapMode: Text.Wrap; text: t.title; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: Theme.pageInk }
      Text { visible: t.quote !== ""; width: parent.width; wrapMode: Text.Wrap; maximumLineCount: 3; elide: Text.ElideRight; text: "“" + t.quote + "”"; font.family: Theme.lettering; font.pixelSize: 12; color: Theme.muted }
      Text { visible: t.meta !== ""; width: parent.width; elide: Text.ElideRight; text: t.meta; font.family: Theme.caption; font.pixelSize: 12; color: Theme.muted }
    }
    MouseArea { anchors.fill: parent; enabled: t.link !== "" || t.task !== ""; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: board.show(t.task, t.link) }
  }
}
