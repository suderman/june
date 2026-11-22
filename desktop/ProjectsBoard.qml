// The projects board (board.mjs agendaView): Org's agenda, overdue, today and the rest of the week, then the counts
// by state, each opening the tasks in that state; or the projects with open work. Every row opens its task in Emacs.
// See "Agents and projects" in docs/interfaces.org.
import QtQuick
import "board.mjs" as Board

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

  // Wide mode offers a direct Editor shortcut in the board header; narrow mode puts it in the bottom bar.
  property bool showLaunch: false
  signal launchEditor()

  readonly property var drillRows: mode === "state" ? Board.stateRows(agenda, drill, pending, user) : []
  readonly property int openCount: view.counts.reduce((n, c) => n + c.n, 0)

  TaskDetail {
    anchors.fill: parent
    visible: board.detailKey !== ""
    backLabel: board.mode === "state" ? (Board.LISTS.find(l => l[0] === board.drill)?.[1] ?? board.drill).toLowerCase() : board.mode
    id: detailPage
    detail: board.detailKey !== "" ? Board.taskPage(board.agenda?.tasks, board.detailKey, board.pending, board.user, board.agenda?.today ?? "", Date.now()) : null
    today: board.agenda?.today ?? ""
    undo: board.notice.key === board.detailKey || board.notice.key === (detailPage.detail?.key ?? "") ? (board.notice.undo ?? null) : null
    dispatch: board.dispatch
    onBack: board.detailKey = ""
    onOpen: link => board.open(link)
    notice: board.notice.key === board.detailKey || board.notice.key === (detailPage.detail?.key ?? "") ? board.notice.text : ""
    onEdit: change => board.edit(detailPage.detail?.key ?? board.detailKey, change)
  }

  Flickable {
    visible: board.detailKey === ""
    anchors.fill: parent
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width
      spacing: 9

      Item {
        width: parent.width
        height: 52
        Text {
          anchors.left: parent.left
          anchors.bottom: parent.bottom
          anchors.bottomMargin: 26
          text: "projects"
          font.family: Theme.display; font.pixelSize: 22
          color: Theme.pageInk
        }
        Text {
          anchors.left: parent.left
          anchors.right: editorLaunch.visible ? editorLaunch.left : parent.right
          anchors.rightMargin: editorLaunch.visible ? 8 : 0
          anchors.bottom: parent.bottom
          anchors.bottomMargin: 8
          elide: Text.ElideRight
          text: board.loaded ? board.openCount + " open in " + board.view.projects.length + " projects" : ""
          font.family: Theme.caption; font.pixelSize: 13
          color: Theme.muted
        }
        Item {
          id: editorLaunch
          visible: board.showLaunch
          anchors.right: parent.right
          anchors.top: parent.top
          anchors.topMargin: 2
          width: 30; height: 30
          Rectangle {
            anchors.fill: parent; radius: 7; color: Theme.pageInk
            opacity: editorHover.containsMouse ? 0.1 : 0
          }
          TabIcon {
            anchors.centerIn: parent; width: 20; height: 20
            kind: "editor"; on: false
            ink: editorHover.containsMouse ? Theme.pageInk : Theme.muted
            paper: Theme.paper
          }
          MouseArea {
            id: editorHover
            anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor
            onClicked: board.launchEditor()
          }
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 2.5; color: Theme.pageInk }
      }
      // What's dated, every open task by state, or the projects.
      Row {
        spacing: 6
        Segment { text: "agenda"; on: board.mode === "agenda"; onClicked: { board.mode = "agenda"; board.drill = ""; } }
        Segment { text: "tasks"; on: board.mode === "tasks" || board.mode === "state"; onClicked: { board.mode = "tasks"; board.drill = ""; } }
        Segment { text: "projects"; on: board.mode === "projects"; onClicked: board.mode = "projects" }
      }

      Text {
        visible: !board.loaded
        text: "asking Emacs…"
        font.family: Theme.caption; font.pixelSize: 13
        color: Theme.muted
      }

      // The agenda: its sections, then the counts by state.
      Repeater {
        model: board.mode === "agenda" ? board.view.sections : []
        delegate: Column {
          required property var modelData
          width: column.width
          spacing: 7
          SectionTitle { text: modelData.title; alert: modelData.alert }
          Repeater {
            model: modelData.rows
            delegate: AgendaRow { required property var modelData; width: column.width; entry: modelData }
          }
          Text {
            visible: modelData.rows.length === 0
            text: "Nothing on the agenda."
            font.family: Theme.lettering; font.pixelSize: 13
            color: Theme.muted
          }
        }
      }
      // Every open task by state, dated or not: a few rows each, the rest a tap away.
      Repeater {
        model: board.mode === "tasks" ? (board.view.lists ?? []) : []
        delegate: Column {
          id: list
          required property var modelData
          width: column.width
          spacing: 7
          Item {
            width: parent.width
            height: listTitle.implicitHeight
            SectionTitle { id: listTitle; text: list.modelData.title + " · " + list.modelData.n }
            MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { board.drill = list.modelData.state; board.mode = "state"; } }
          }
          Repeater {
            model: list.modelData.rows
            delegate: AgendaRow { required property var modelData; width: column.width; entry: modelData }
          }
          Text {
            visible: list.modelData.more > 0
            text: "all " + list.modelData.n + " ›"
            font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
            color: Theme.pageInk
            MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: { board.drill = list.modelData.state; board.mode = "state"; } }
          }
        }
      }
      Text {
        visible: board.mode === "tasks" && (board.view.queued ?? 0) > 0
        width: parent.width
        wrapMode: Text.Wrap
        text: board.view.queued + " queued for agents, on the agents board"
        font.family: Theme.caption; font.pixelSize: 12
        color: Theme.muted
      }

      // One state's tasks.
      Text {
        visible: board.mode === "state"
        text: "‹ tasks"
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
        color: Theme.pageInk
        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { board.mode = "tasks"; board.drill = ""; } }
      }
      SectionTitle {
        visible: board.mode === "state"
        text: (Board.LISTS.find(l => l[0] === board.drill)?.[1] ?? board.drill) + " · " + board.drillRows.length
      }
      Repeater {
        model: board.drillRows
        delegate: AgendaRow { required property var modelData; width: column.width; entry: modelData }
      }

      // The projects with open work.
      Repeater {
        model: board.mode === "projects" ? board.view.projects : []
        delegate: Item {
          id: project
          required property var modelData
          width: column.width
          height: projectLines.implicitHeight + 6
          Column {
            id: projectLines
            width: parent.width
            spacing: 4
            Text { width: parent.width; wrapMode: Text.Wrap; text: project.modelData.title; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 14; color: Theme.pageInk }
            Flow {
              width: parent.width
              spacing: 4
              Repeater { model: project.modelData.counts; delegate: StateChip { required property var modelData; orgState: modelData.state; count: modelData.n } }
            }
          }
          MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: board.open(project.modelData.link) }
        }
      }

      Text {
        visible: board.loaded
        width: parent.width
        wrapMode: Text.Wrap
        topPadding: 6
        text: "From Emacs on " + board.host + (board.generatedAt > 0 ? ", " + Qt.formatTime(new Date(board.generatedAt), "hh:mm") : "") + " · a row opens Emacs"
        font.family: Theme.caption; font.pixelSize: 11
        color: Theme.muted
      }
    }
  }

  component SectionTitle: Text {
    property bool alert: false
    width: parent ? parent.width : 0
    topPadding: 4
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; font.letterSpacing: 1
    color: alert ? Theme.accent : Theme.pageInk
  }

  // A segment of the agenda/projects switch, filled when chosen.
  component Segment: Rectangle {
    id: seg
    property string text: ""
    property bool on: false
    signal clicked()
    width: segLabel.implicitWidth + 22
    height: 24
    radius: 12
    color: on ? Theme.pageInk : "transparent"
    border.color: Theme.pageInk
    border.width: 2
    Text { id: segLabel; anchors.centerIn: parent; text: seg.text; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: seg.on ? Theme.paper : Theme.pageInk }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: seg.clicked() }
  }

  // An agenda line: its day or time, state, title and what it is; a click opens it in Emacs.
  component AgendaRow: Item {
    id: r
    property var entry
    height: Math.max(rowLines.implicitHeight, 20)
    Text {
      id: when
      // A list row has no day or time column, nor a chip: its list names the state.
      width: r.entry.plain ? 0 : 40
      text: r.entry.day ? r.entry.day : (r.entry.time ?? "")
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
      color: Theme.muted
      y: 2
    }
    StateChip { id: badge; anchors.left: when.right; orgState: r.entry.plain ? "" : r.entry.state; width: r.entry.plain ? 0 : implicitWidth; y: 1 }
    Column {
      id: rowLines
      anchors.left: badge.right
      anchors.leftMargin: r.entry.plain ? 0 : 8
      anchors.right: parent.right
      spacing: 1
      Text { width: parent.width; wrapMode: Text.Wrap; text: (r.entry.day && r.entry.time ? r.entry.time + "  " : "") + r.entry.title; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: Theme.pageInk }
      Text { visible: r.entry.meta !== ""; width: parent.width; elide: Text.ElideRight; text: r.entry.meta; font.family: Theme.caption; font.pixelSize: 12; color: r.entry.overdue ? Theme.accent : Theme.muted }
    }
    MouseArea {
      anchors.fill: parent
      enabled: (r.entry.task ?? "") !== "" || (r.entry.link ?? "") !== ""
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      // A task opens its page, where Emacs is a button away.
      onClicked: (r.entry.task ?? "") !== "" && Board.findTask(board.agenda?.tasks, r.entry.task) !== null ? board.detailKey = r.entry.task : board.open(r.entry.link)
    }
  }
}
