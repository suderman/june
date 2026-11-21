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
  signal open(string link)

  readonly property var drillRows: mode === "state" ? Board.stateRows(agenda, drill) : []
  readonly property int openCount: view.counts.reduce((n, c) => n + c.n, 0)

  Flickable {
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
          anchors.bottom: parent.bottom
          anchors.bottomMargin: 8
          text: board.loaded ? board.openCount + " open in " + board.view.projects.length + " projects" : ""
          font.family: Theme.caption; font.pixelSize: 13
          color: Theme.muted
        }
        Row {
          anchors.right: parent.right
          anchors.bottom: parent.bottom
          anchors.bottomMargin: 26
          spacing: 0
          Segment { text: "agenda"; on: board.mode !== "projects"; onClicked: { board.mode = "agenda"; board.drill = ""; } }
          Segment { text: "projects"; on: board.mode === "projects"; onClicked: board.mode = "projects" }
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 2.5; color: Theme.pageInk }
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
      SectionTitle { text: "BY STATE"; visible: board.mode === "agenda" && board.view.counts.length > 0 }
      Flow {
        visible: board.mode === "agenda"
        width: parent.width
        spacing: 6
        Repeater {
          model: board.view.counts
          delegate: StateChip {
            required property var modelData
            orgState: modelData.state; count: modelData.n; big: true
            onClicked: { board.drill = modelData.state; board.mode = "state"; }
          }
        }
      }

      // One state's tasks.
      Text {
        visible: board.mode === "state"
        text: "‹ agenda"
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
        color: Theme.pageInk
        MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: { board.mode = "agenda"; board.drill = ""; } }
      }
      SectionTitle { visible: board.mode === "state"; text: board.drill + " · " + board.drillRows.length }
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
      width: 40
      text: r.entry.day ? r.entry.day : (r.entry.time ?? "")
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
      color: Theme.muted
      y: 2
    }
    StateChip { id: badge; anchors.left: when.right; orgState: r.entry.state; y: 1 }
    Column {
      id: rowLines
      anchors.left: badge.right
      anchors.leftMargin: 8
      anchors.right: parent.right
      spacing: 1
      Text { width: parent.width; wrapMode: Text.Wrap; text: (r.entry.day && r.entry.time ? r.entry.time + "  " : "") + r.entry.title; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: Theme.pageInk }
      Text { visible: r.entry.meta !== ""; width: parent.width; elide: Text.ElideRight; text: r.entry.meta; font.family: Theme.caption; font.pixelSize: 12; color: r.entry.overdue ? Theme.accent : Theme.muted }
    }
    MouseArea { anchors.fill: parent; enabled: (r.entry.link ?? "") !== ""; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: board.open(r.entry.link) }
  }
}
