// One task's page in a board column (board.mjs taskDetail), as the Dialog artboard in the mockup draws it: its state
// and facts, title, the buttons that open it in Emacs and its session in Herdr, its last report, and its Dialog as a
// conversation by who wrote each entry. See "Agents and projects" in docs/interfaces.org.
import QtQuick
import QtQuick.Controls
import "board.mjs" as Board

Item {
  id: page

  property var detail: null
  property string backLabel: "back"
  // What the last edit said: "saved", or why org-edit refused; with undo, the edit that puts it back.
  property string notice: ""
  property var undo: null
  property string today: ""
  signal back()
  signal open(string link)
  // The user's edit (board-edit.ts TaskEdit): a state, an assignment, a reply, a date.
  signal edit(var change)
  // Who a task can be handed to, and where by default: { hosts, host, agents }.
  property var dispatch: null

  readonly property string orgState: detail?.state ?? ""
  // A file another program rebuilds (org.protected): only TODO or DONE, which the mirror may sync back.
  readonly property bool locked: detail?.protected ?? false
  readonly property bool editable: orgState !== "" && !locked
  readonly property bool assignable: !locked && ["TODO", "EVAL", "HOLD"].includes(orgState)
  // An edit on its way: the page shows it as made and takes no other until it lands or fails.
  readonly property bool busy: detail?.busy ?? false
  // A handoff waiting for the user to confirm it: { agent, host, when }, or null; when "" starts as the page says.
  property var handoff: null
  // Which date is being picked: schedule, deadline, handoff, or "".
  property string picking: ""
  onDetailChanged: {
    if (detail === null || !assignable) handoff = null;
    if (detail === null) picking = "";
  }
  function send(change) {
    if (page.busy) return;
    page.picking = "";
    page.edit(change);
  }

  // The page's task left the boards: archived, or no longer in an agenda file.
  Column {
    visible: page.detail === null
    width: parent.width
    spacing: 10
    Text {
      text: "‹ " + page.backLabel
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
      color: Theme.pageInk
      MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: page.back() }
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "That task is no longer on the boards."
      font.family: Theme.lettering; font.pixelSize: 13
      color: Theme.muted
    }
  }

  Flickable {
    anchors.fill: parent
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width
      spacing: 10
      visible: page.detail !== null

      Text {
        text: "‹ " + page.backLabel
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
        color: Theme.pageInk
        MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: page.back() }
      }
      Row {
        spacing: 8
        StateChip { orgState: page.detail?.state ?? ""; big: true; visible: (page.detail?.state ?? "") !== "" }
        Text {
          anchors.verticalCenter: parent.verticalCenter
          text: page.detail?.asked ? "asks you" : ""
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
          color: Theme.accent
        }
      }
      Text {
        width: parent.width
        wrapMode: Text.Wrap
        text: page.detail?.title ?? ""
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 17
        color: Theme.pageInk
      }
      Text {
        width: parent.width
        wrapMode: Text.Wrap
        visible: text !== ""
        text: [page.detail?.project ?? "", page.detail?.path ?? "", page.detail?.facts ?? ""].filter(s => s !== "").join(" · ")
        font.family: Theme.caption; font.pixelSize: 12
        color: Theme.muted
      }
      Flow {
        width: parent.width
        spacing: 6
        Action { text: "Emacs"; link: page.detail?.emacs ?? "" }
        Action { text: "Herdr"; link: page.detail?.herdr ?? "" }
      }
      Rectangle {
        visible: (page.detail?.headline ?? "") !== ""
        width: parent.width
        height: headline.implicitHeight + 14
        radius: 12
        color: Theme.balloon
        border.color: Theme.ink
        border.width: 2
        Text {
          id: headline
          x: 10; y: 7
          width: parent.width - 20
          wrapMode: Text.Wrap
          text: page.detail?.headline ?? ""
          font.family: Theme.lettering; font.pixelSize: 13
          color: Theme.ink
        }
      }

      // The edits June's own task tools make, here the user's: state, a clanker, a date.
      Text {
        visible: page.orgState !== ""
        topPadding: 4
        text: "STATE"
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; font.letterSpacing: 1
        color: Theme.muted
      }
      Flow {
        visible: page.orgState !== ""
        width: parent.width
        spacing: 6
        Repeater {
          model: page.locked ? ["TODO", "DONE"] : ["TODO", "PROG", "EVAL", "HOLD", "DONE"]
          delegate: Choice {
            required property string modelData
            text: modelData
            on: page.orgState === modelData
            onClicked: if (page.orgState !== modelData) page.send({ action: "state", state: modelData })
          }
        }
      }
      Text {
        visible: page.locked
        width: parent.width
        wrapMode: Text.Wrap
        text: (page.detail?.file ?? "") + " is rebuilt by another program, so only TODO and DONE are set here; DONE may sync back."
        font.family: Theme.caption; font.pixelSize: 12
        color: Theme.muted
      }
      Flow {
        visible: page.assignable && page.handoff === null
        width: parent.width
        spacing: 6
        Text { text: "hand to"; height: 28; verticalAlignment: Text.AlignVCenter; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: Theme.muted }
        Repeater {
          model: page.dispatch?.agents ?? ["pi", "claude"]
          delegate: Choice {
            required property string modelData
            text: modelData
            onClicked: page.handoff = { agent: modelData, host: (page.detail?.host ?? "") !== "" ? page.detail.host : (page.dispatch?.host ?? ""), when: "" }
          }
        }
      }
      // Nothing is queued until the user confirms who, where and when.
      Rectangle {
        visible: page.handoff !== null
        width: parent.width
        height: handoffColumn.implicitHeight + 20
        radius: 12
        color: Theme.balloon
        border.color: Theme.pageInk
        border.width: 2
        Column {
          id: handoffColumn
          x: 10; y: 10
          width: parent.width - 20
          spacing: 8
          Text {
            width: parent.width
            wrapMode: Text.Wrap
            text: "Hand to " + (page.handoff?.agent ?? "") + ", starting " + ((page.handoff?.when ?? "") !== ""
              ? Board.dayWord(page.handoff.when.slice(0, 10), page.today) + page.handoff.when.slice(10)
              : page.detail?.starts === "now" ? "now" : "at its schedule, " + (page.detail?.starts ?? "")) + "."
            font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
            color: Theme.pageInk
          }
          Flow {
            visible: (page.dispatch?.hosts ?? []).length > 1
            width: parent.width
            spacing: 6
            Text { text: "on"; height: 28; verticalAlignment: Text.AlignVCenter; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: Theme.muted }
            Repeater {
              model: page.dispatch?.hosts ?? []
              delegate: Choice {
                required property string modelData
                text: modelData
                on: (page.handoff?.host ?? "") === modelData
                onClicked: page.handoff = { agent: page.handoff.agent, host: modelData, when: page.handoff.when }
              }
            }
          }
          Choice {
            visible: page.picking !== "handoff"
            text: (page.handoff?.when ?? "") !== "" ? "change the start" : "start later…"
            onClicked: page.picking = "handoff"
          }
          WhenPicker {
            visible: page.picking === "handoff"
            width: parent.width
            title: "Start at"
            today: page.today
            start: page.detail?.scheduled ?? ({ date: page.today, time: "" })
            setLabel: "Use this start"
            onPicked: when => { page.handoff = { agent: page.handoff.agent, host: page.handoff.host, when: when }; page.picking = ""; }
            onCancelled: page.picking = ""
          }
          Row {
            spacing: 6
            Choice {
              text: (page.handoff?.when ?? "") === "" && page.detail?.starts === "now" ? "Hand off now" : "Hand off"
              on: true
              onClicked: {
                const change = { action: "assign", agent: page.handoff.agent };
                if ((page.handoff.host ?? "") !== "") change.host = page.handoff.host;
                if ((page.handoff.when ?? "") !== "") change.when = page.handoff.when;
                page.handoff = null;
                page.send(change);
              }
            }
            Choice { text: "Cancel"; onClicked: { page.handoff = null; page.picking = ""; } }
          }
        }
      }
      // SCHEDULED and DEADLINE, each picked on a calendar; a queued task's start moves through reschedule-task.
      Flow {
        visible: page.editable && page.picking !== "schedule" && page.picking !== "deadline" && page.handoff === null
        width: parent.width
        spacing: 6
        Choice { text: page.detail?.hasScheduled ? "scheduled " + page.detail.scheduledLabel : "schedule…"; onClicked: page.picking = "schedule" }
        Choice { text: page.detail?.hasDeadline ? "due " + page.detail.deadlineLabel : "deadline…"; onClicked: page.picking = "deadline" }
      }
      WhenPicker {
        visible: page.picking === "schedule" || page.picking === "deadline"
        width: parent.width
        title: page.picking === "schedule" ? (page.detail?.repeats ? "Scheduled, keeping its repeat" : "Scheduled") : "Deadline"
        today: page.today
        start: page.picking === "deadline" ? (page.detail?.deadline ?? ({ date: page.today, time: "" })) : (page.detail?.scheduled ?? ({ date: page.today, time: "" }))
        canClear: page.picking === "schedule" ? (page.detail?.hasScheduled ?? false) : (page.detail?.hasDeadline ?? false)
        onPicked: when => page.send({ action: page.picking, when: when })
        onCleared: page.send({ action: page.picking, when: "none" })
        onCancelled: page.picking = ""
      }
      // A new title, as June's org_update_task makes it: refused if the task changed since the board read it.
      Row {
        visible: !page.locked && ["", "TODO", "EVAL", "HOLD"].includes(page.orgState)
        width: parent.width
        spacing: 6
        TextField {
          id: rename
          width: parent.width - 6 - renameButton.width
          height: 28
          placeholderText: "new title"
          onAccepted: renameButton.clicked()
          font.family: Theme.caption; font.pixelSize: 12
          color: Theme.ink
          background: Rectangle { radius: 8; color: Theme.balloon; border.color: Theme.pageInk; border.width: 1.5 }
        }
        Choice { id: renameButton; text: "rename"; onClicked: if (rename.text.trim() !== "" && !page.busy) { page.send({ action: "title", title: rename.text.trim() }); rename.text = ""; } }
      }
      Row {
        visible: page.busy || page.notice !== ""
        width: parent.width
        spacing: 10
        Text {
          width: parent.width - (undoLink.visible ? undoLink.width + 10 : 0)
          wrapMode: Text.Wrap
          text: page.busy ? "saving…" : page.notice
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
          color: page.busy || page.notice === "saved" ? Theme.muted : Theme.accent
        }
        Text {
          id: undoLink
          visible: !page.busy && page.undo !== null
          text: "undo"
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; font.underline: true
          color: Theme.pageInk
          MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: page.send(page.undo) }
        }
      }

      Text {
        topPadding: 6
        text: "DIALOG"
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; font.letterSpacing: 1
        color: Theme.muted
      }
      Text {
        visible: (page.detail?.dialog ?? []).length === 0
        text: "No Dialog yet."
        font.family: Theme.lettering; font.pixelSize: 13
        color: Theme.muted
      }
      Repeater {
        model: page.detail?.dialog ?? []
        delegate: Entry { required property var modelData; entry: modelData; width: column.width }
      }

      // A reply in the user's name; with resume, the task goes back to its clanker with it.
      TextArea {
        id: reply
        visible: page.editable
        width: parent.width
        height: Math.max(64, implicitHeight)
        wrapMode: TextEdit.Wrap
        placeholderText: "Reply in Dialog (Ctrl+Enter sends)"
        Keys.onPressed: event => {
          if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && (event.modifiers & Qt.ControlModifier)) {
            replyButton.clicked();
            event.accepted = true;
          }
        }
        font.family: Theme.caption; font.pixelSize: 13
        color: Theme.ink
        background: Rectangle { radius: 12; color: Theme.balloon; border.color: Theme.pageInk; border.width: 2 }
      }
      Row {
        visible: page.editable
        spacing: 6
        Choice { id: replyButton; text: "Reply"; onClicked: if (reply.text.trim() !== "" && !page.busy) { page.send({ action: "reply", text: reply.text }); reply.text = ""; } }
        Choice {
          visible: page.assignable
          text: "Reply and resume"
          on: true
          onClicked: if (reply.text.trim() !== "" && !page.busy) { page.send({ action: "reply", text: reply.text, resume: true }); reply.text = ""; }
        }
      }
    }
  }

  // A choice in the page's buttons: filled when it is the current one.
  component Choice: Rectangle {
    id: choice
    property string text: ""
    property bool on: false
    signal clicked()
    width: choiceLabel.implicitWidth + 20
    height: 28
    radius: 14
    color: on ? Theme.pageInk : "transparent"
    border.color: Theme.pageInk
    border.width: 2
    opacity: page.busy ? 0.45 : 1
    Behavior on opacity { NumberAnimation { duration: 120 } }
    Text { id: choiceLabel; anchors.centerIn: parent; text: choice.text; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: choice.on ? Theme.paper : Theme.pageInk }
    MouseArea { anchors.fill: parent; enabled: !page.busy; cursorShape: page.busy ? Qt.BusyCursor : Qt.PointingHandCursor; onClicked: choice.clicked() }
  }

  component Action: Rectangle {
    id: action
    property string text: ""
    property string link: ""
    visible: link !== ""
    width: label.implicitWidth + 24
    height: 30
    radius: 15
    color: "transparent"
    border.color: Theme.pageInk
    border.width: 2
    Text { id: label; anchors.centerIn: parent; text: action.text; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: Theme.pageInk }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: page.open(action.link) }
  }

  // A Dialog entry: the user's as a blue note on the right, an agent's beside its clanker, June's in her balloon,
  // the dispatcher's as a narration caption.
  component Entry: Item {
    id: e
    property var entry
    readonly property bool mine: entry.kind === "user"
    readonly property bool narration: entry.kind === "dispatcher"
    // The widest a balloon gets: the user's leave room on the left, an agent's make room for its clanker.
    readonly property real cap: mine ? width * 0.86 : narration ? width : width - (avatar.visible ? 38 : 0)
    height: box.height + 2
    Clanker {
      id: avatar
      visible: e.entry.kind === "agent"
      size: 30
      claws: false
      harness: page.detail?.harness ?? "other"
      anchors.bottom: box.bottom
    }
    Rectangle {
      id: box
      x: e.mine ? e.width - width : e.narration ? 0 : (avatar.visible ? 38 : 0)
      width: e.narration ? e.width : Math.min(e.cap, Math.max(who.implicitWidth, words.implicitWidth) + 22)
      height: who.implicitHeight + words.implicitHeight + 16
      radius: e.narration ? 2 : 14
      color: e.mine ? Theme.noteFill : e.narration ? Theme.captionFill : Theme.balloon
      border.color: e.mine ? Theme.noteLine : Theme.ink
      border.width: 2
      Text {
        id: who
        x: 11; y: 6
        text: e.entry.who.toLowerCase() + (e.entry.at !== "" ? " · " + e.entry.at : "")
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 11
        color: e.mine ? Theme.noteInk : Theme.muted
      }
      Text {
        id: words
        x: 11
        anchors.top: who.bottom
        anchors.topMargin: 2
        width: Math.min(implicitWidth, e.cap - 22)
        wrapMode: Text.Wrap
        text: e.entry.text
        font.family: e.mine || e.narration ? Theme.caption : Theme.lettering
        font.pixelSize: 13
        color: e.mine ? Theme.noteInk : Theme.ink
      }
    }
  }
}
