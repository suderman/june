// The agents board as the clankers' room (board.mjs agentsView): what needs the user, as cards, most urgent first;
// then who is working, what is queued and under agent review, who is idle, and what reported today. A card or row
// opens where it can: an agent's session in Herdr, a task in Emacs. See "Agents and projects" in docs/interfaces.org.
import QtQuick

Item {
  id: board

  // agentsView's shape; empty until the daemon's board arrives.
  property var view: ({ summary: "", needs: [], working: [], idle: [], queued: [], reviewing: [], recent: [], down: [] })
  property bool loaded: false
  property bool idleOpen: false
  signal open(string link)

  Flickable {
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
          anchors.bottom: parent.bottom
          anchors.bottomMargin: 8
          text: board.loaded ? board.view.summary : "asking hc…"
          font.family: Theme.caption; font.pixelSize: 13
          color: Theme.muted
        }
        Rectangle { anchors.bottom: parent.bottom; width: parent.width; height: 2.5; color: Theme.pageInk }
      }

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
        delegate: TaskRow { required property var modelData; width: column.width; chip: "AUTO"; title: modelData.title; meta: modelData.who + " · " + modelData.when; link: modelData.link ?? "" }
      }

      SectionTitle { text: "IN AGENT REVIEW · " + board.view.reviewing.length; visible: board.view.reviewing.length > 0 }
      Repeater {
        model: board.view.reviewing
        delegate: TaskRow { required property var modelData; width: column.width; chip: "EVAL"; title: modelData.title; meta: modelData.who; link: modelData.link ?? "" }
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
    MouseArea { anchors.fill: parent; enabled: (w.worker.link ?? "") !== ""; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: board.open(w.worker.link) }
  }

  // A task in a line: its state, title, a quoted report, and what it is waiting on; a click opens it in Emacs.
  component TaskRow: Item {
    id: t
    property string chip: ""
    property string title: ""
    property string quote: ""
    property string meta: ""
    property string link: ""
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
    MouseArea { anchors.fill: parent; enabled: t.link !== ""; cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor; onClicked: board.open(t.link) }
  }
}
