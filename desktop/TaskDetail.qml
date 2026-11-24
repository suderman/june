// One task's page in a board column (board.mjs taskDetail) as a work-order docket, as the phone's Docket.kt draws it:
// the slip with its project, number, title and state stamp, and below its tear who has it and when; then what the
// task asks and its Dialog, each entry folded to a few lines; the reply on a memo pad; and last the slip's fields to
// change. See "Restyle the phone boards as task dockets" in the June project notes for why the question comes first.
import QtQuick
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
  // The user's edit (board-edit.ts TaskEdit): a state, an assignment, a reply, a date, a title.
  signal edit(var change)
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
  onDetailChanged: {
    if (detail === null || !assignable) handoff = null;
    if (detail === null) { picking = ""; renaming = false; }
  }
  function send(change) {
    page.picking = "";
    page.edit(change);
  }
  // The dialog entry the page leads with when the task asks: the agent's latest.
  readonly property var asked: (detail?.dialog ?? []).find(e => (detail?.ask ?? "") !== "" && e.key === detail.ask) ?? null
  readonly property var earlier: (detail?.dialog ?? []).filter(e => e !== asked)

  // The page's task left the boards: archived, or no longer in an agenda file.
  Column {
    visible: page.detail === null
    width: parent.width
    spacing: 10
    BackLink {}
    Words { width: parent.width; wrapMode: Text.Wrap; role: "lettering"; text: "That task is no longer on the boards."; color: Theme.muted }
  }

  Flickable {
    anchors.fill: parent
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
                width: parent.width
                role: "title"
                wrapMode: Text.Wrap
                text: (page.detail?.title ?? "") + (page.renamable && !page.renaming ? "  ✎" : "")
                font.underline: page.renamable && titleHover.containsMouse
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
                }
              }
              PressTab { text: "Cancel"; kind: "quiet"; small: true; onClicked: page.renaming = false }
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
      SectionRule { visible: page.asked !== null; text: "ASKS YOU"; alert: true }
      Entry { visible: page.asked !== null; entry: page.asked; width: column.width; lead: true }
      SectionRule { text: page.asked !== null ? "EARLIER IN DIALOG · " + page.earlier.length : "DIALOG" }
      Words { visible: (page.detail?.dialog ?? []).length === 0; role: "lettering"; text: "No Dialog yet."; color: Theme.muted }
      Repeater {
        model: page.earlier
        delegate: Entry { required property var modelData; entry: modelData; width: column.width }
      }

      // A reply in the user's name; with resume, the task goes back to its clanker with it.
      MemoField {
        id: reply
        visible: page.editable
        placeholder: (page.asked !== null ? "Answer in Dialog" : "Reply in Dialog") + " (Ctrl+Enter sends)"
        onSubmitted: (page.assignable ? resumeButton : replyButton).clicked()
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
      SectionRule { visible: page.orgState !== ""; text: "CHANGE" }
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
            label: "Move to"
            last: !page.editable && !page.assignable
            Flow {
              width: parent.width
              spacing: 5
              Repeater {
                model: (page.detail?.next ?? []).filter(s => page.locked || s !== "AUTO")
                delegate: Stamp {
                  required property string modelData
                  text: modelData; tone: Theme.tone(modelData); on: false; clickable: true; tilt: 0
                  onClicked: page.send({ action: "state", state: modelData })
                }
              }
              Stamp {
                visible: page.assignable && change.requeue !== null
                text: "AUTO"; tone: Theme.tone("AUTO"); on: false; clickable: true; tilt: 0
                onClicked: page.send(change.requeue)
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
            visible: page.assignable && page.handoff === null
            label: "Hand to"
            Flow {
              width: parent.width
              spacing: 5
              Repeater {
                model: page.clankers
                delegate: Stamp {
                  required property var modelData
                  text: modelData.name; tone: Theme.harnessTone(modelData.clanker ?? Board.harnessOf(modelData.harness)); on: false; clickable: true; tilt: 0
                  onClicked: page.handoff = { agent: modelData.slug, name: modelData.name, host: modelData.host, when: "", fixed: true }
                }
              }
              Repeater {
                model: page.dispatch?.agents ?? ["pi", "claude"]
                delegate: Stamp {
                  required property string modelData
                  text: modelData; tone: Theme.harnessTone(Board.harnessOf(modelData)); on: false; clickable: true; tilt: 0
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
                onClicked: {
                  const c = { action: "assign", agent: page.handoff.agent };
                  if ((page.handoff.host ?? "") !== "") c.host = page.handoff.host;
                  if ((page.handoff.when ?? "") !== "") c.when = page.handoff.when;
                  page.handoff = null;
                  page.send(c);
                }
              }
              PressTab { visible: page.picking !== "handoff"; text: (page.handoff?.when ?? "") !== "" ? "Change start" : "Start later…"; onClicked: page.picking = "handoff" }
              PressTab { text: "Cancel"; kind: "quiet"; onClicked: { page.handoff = null; page.picking = ""; } }
            }
          }
          // SCHEDULED and DEADLINE, each picked on a calendar; a queued task's start moves through reschedule-task.
          FieldRow {
            visible: page.editable && page.handoff === null
            label: "Scheduled"
            clickable: true
            onClicked: page.picking = page.picking === "schedule" ? "" : "schedule"
            Words { width: parent.width; role: "value"; elide: Text.ElideRight; text: page.detail?.hasScheduled ? page.detail.scheduledLabel : "not scheduled"; color: page.detail?.hasScheduled ? Theme.surfaceInk : Theme.surfaceMuted }
          }
          FieldRow {
            visible: page.editable && page.handoff === null
            label: "Due"
            clickable: true
            last: page.picking !== "schedule" && page.picking !== "deadline"
            onClicked: page.picking = page.picking === "deadline" ? "" : "deadline"
            Words { width: parent.width; role: "value"; elide: Text.ElideRight; text: page.detail?.hasDeadline ? page.detail.deadlineLabel : "no deadline"; color: page.detail?.hasDeadline ? Theme.surfaceInk : Theme.surfaceMuted }
          }
          WhenPicker {
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

  // The back link at the top of the page.
  component BackLink: PressTab {
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
    property bool lead: false
    property bool open: lead
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
    height: narration ? caption.implicitHeight : box.height + (agentNote ? 6 : 0) + 2

    Words {
      id: caption
      visible: e.narration
      width: e.width
      role: "meta"
      wrapMode: Text.Wrap
      text: (Theme.consoleLook ? "# " : "▸ ") + (e.entry?.who ?? "").toLowerCase() + ((e.entry?.at ?? "") !== "" ? " · " + e.entry.at : "") + " — " + (e.entry?.text ?? "")
      color: Theme.muted
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
        edge: e.lead ? Theme.accent : e.mine ? (Theme.neon ? Theme.consoleUser : Theme.consoleLook ? Theme.edge : Theme.noteLine) : Theme.edge
        fill: e.mine && !Theme.neon && !Theme.consoleLook ? Theme.noteFill : Theme.surface
        lift: e.lead ? 3 : 2
        lineWidth: e.lead ? 2.5 : 2
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
        onClicked: e.open = !e.open
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
