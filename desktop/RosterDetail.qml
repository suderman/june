// One clanker's page (clankers/<slug>/CARD.org via the daemon's `roster` op), as the phone's Squad.kt draws it: the
// full clanker card (portrait, name, host, harness, model, quota, directives, history); or the card filled in to
// create a new clanker or edit this one, where destroying asks once more before it archives the clanker's folder.
import QtQuick
import "board.mjs" as Board

Item {
  id: page

  // Shaped card from board.mjs rosterView, or null when creating a new clanker.
  property var card: null
  property bool creating: false
  property var hosts: ["kit", "cog"]
  property var notice: ({ text: "", busy: false, seq: 0, saved: "" })
  signal back()
  // Deploy this clanker somewhere, or visit it at work (AT is HOST/TERMINAL).
  signal deploy()
  signal visit(string at)
  signal save(var edit)
  signal remove(string slug)

  property bool editing: creating
  property bool confirmingDelete: false

  // Form fields, loaded when entering edit mode or creating.
  property string fName: ""
  property string fHost: ""
  property string fHarness: "claude"
  property string fModel: ""
  property string fEffort: ""
  property string fInstructions: ""

  function loadForm(c) {
    confirmingDelete = false;
    fName = c?.name ?? "";
    fHost = c?.host ?? (hosts.length > 0 ? hosts[0] : "kit");
    fHarness = c?.harness && Board.ROSTER_HARNESSES.includes(c.harness) ? c.harness : "claude";
    fModel = c?.model ?? "";
    fEffort = c ? (c.effort ?? "") : "high";
    fInstructions = c?.instructions ?? "";
    name.text = fName; host.text = fHost; modelField.text = fModel; orders.text = fInstructions;
  }

  onCreatingChanged: {
    editing = creating;
    if (creating) loadForm(null);
  }
  onCardChanged: {
    confirmingDelete = false;
    if (!creating) editing = false;
  }
  onNoticeChanged: {
    if ((notice.saved ?? "") !== "" && !creating) {
      confirmingDelete = false;
      editing = false;
    }
  }
  readonly property string stampTone: card?.stamp === "WORKING" ? Theme.tone("PROG") : card?.stamp === "INVALID" ? Theme.tone("TODO") : Theme.muted

  Flickable {
    anchors.fill: parent
    contentHeight: col.implicitHeight + 20
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: col
      width: parent.width - 6
      spacing: 10

      // Back to the card while editing it, and edit; the sheet it sits in closes the page.
      Item {
        visible: (page.editing && !page.creating) || (!page.editing && page.card !== null)
        width: parent.width
        height: backLink.height
        PressTab {
          id: backLink
          visible: page.editing && !page.creating
          text: (Theme.consoleLook ? "< " : "‹  ") + "card"
          kind: "quiet"; small: true
          onClicked: {
            if (page.editing && !page.creating) { page.editing = false; page.confirmingDelete = false; }
            else page.back();
          }
        }
        // A clanker at work is visited, in its terminal; an idle one is deployed somewhere first.
        PressTab {
          visible: !page.editing && page.card !== null
          anchors.right: editLink.left; anchors.rightMargin: 8
          readonly property string at: page.card?.terminal ?? ""
          text: at.indexOf("/") > 0 ? "visit" : "deploy"
          small: true
          enabled: at.indexOf("/") > 0 || (page.card?.problems ?? []).length === 0
          onClicked: at.indexOf("/") > 0 ? page.visit(at) : page.deploy()
        }
        PressTab {
          id: editLink
          visible: !page.editing && page.card !== null
          anchors.right: parent.right
          text: "edit card"; small: true
          onClicked: { page.loadForm(page.card); page.editing = true; }
        }
      }

      Words {
        visible: !page.editing && page.card === null
        width: parent.width
        role: "lettering"
        wrapMode: Text.Wrap
        text: "That clanker is gone."
        color: Theme.muted
      }

      // ---- The clanker card ----
      Column {
        visible: !page.editing && page.card !== null
        width: parent.width
        spacing: 10

        Item {
          width: parent.width
          height: cardColumn.implicitHeight
          Inked { anchors.fill: parent; lift: 4 }
          Column {
            id: cardColumn
            width: parent.width
            Band { label: "Clanker card"; number: page.card?.serviceNo ?? "" }
            Column {
              x: 10
              width: parent.width - 20
              topPadding: 10; bottomPadding: 10
              spacing: 6
              Portrait {
                visible: !Theme.consoleLook
                width: parent.width; height: 130
                harness: page.card?.clanker ?? "other"
                stamp: page.card?.stamp ?? ""
                art: 88
              }
              Words { visible: Theme.consoleLook; role: "number"; text: "(o)  " + ((page.card?.stamp ?? "") !== "" ? page.card.stamp.toLowerCase() : "idle"); color: Theme.muted }
              Words { width: parent.width; role: "masthead"; elide: Text.ElideRight; text: page.card?.name ?? "" }
              Words {
                width: parent.width
                role: "meta"
                elide: Text.ElideRight
                textFormat: Text.StyledText
                text: "<b><font color='" + (Theme.consoleLook ? Theme.surfaceInk : Theme.harnessTone(page.card?.clanker ?? "other")) + "'>" + ((page.card?.harness ?? "") !== "" ? page.card.harness : "no class").toUpperCase() + "</font></b>"
                  + ((page.card?.loadout ?? "") !== "" ? "  ·  " + page.card.loadout : "")
                color: Theme.surfaceMuted
              }
            }
            Rectangle { width: parent.width; height: 1; color: Theme.rule }
            FieldRow {
              label: "Host"
              Column {
                width: parent.width
                Words { width: parent.width; role: "value"; text: (page.card?.unit ?? "") !== "" ? page.card.unit : "none"; color: (page.card?.unit ?? "") !== "" ? Theme.surfaceInk : Theme.surfaceMuted }
                // Its host's load, as the hosts tab shows it.
                Words { visible: (page.card?.hostLoad ?? "") !== ""; width: parent.width; role: "meta"; text: page.card?.hostLoad ?? ""; color: Theme.surfaceMuted }
              }
            }
            FieldRow { label: "Harness"; Words { width: parent.width; role: "value"; text: (page.card?.harness ?? "") !== "" ? page.card.harness : "none" } }
            FieldRow { label: "Model"; Words { width: parent.width; role: "value"; wrapMode: Text.Wrap; text: ((page.card?.model ?? "") !== "" ? page.card.model : "harness default") + " · " + ((page.card?.effort ?? "") !== "" ? page.card.effort : "default effort") } }
            FieldRow {
              label: "Quota"
              last: (page.card?.terminal ?? "") === ""
              Column {
                width: parent.width
                spacing: 4
                EnergyGauge { level: page.card?.batteryLevel ?? -1; tone: page.card?.batteryTone ?? "unknown"; gauge: page.card?.gauge ?? ""; cell: 6 }
                Words {
                  width: parent.width
                  role: "value"
                  wrapMode: Text.Wrap
                  text: ((page.card?.energyText ?? "") !== "" ? page.card.energyText : "unknown") + ((page.card?.batteryAccount ?? "") !== "" ? " · " + page.card.batteryAccount : "")
                  color: (page.card?.batteryLevel ?? -1) >= 0 ? Theme.surfaceInk : Theme.surfaceMuted
                }
                Words { visible: (page.card?.energyDetail ?? "") !== ""; width: parent.width; role: "meta"; wrapMode: Text.Wrap; text: page.card?.energyDetail ?? ""; color: Theme.surfaceMuted }
              }
            }
            FieldRow { visible: (page.card?.terminal ?? "") !== ""; label: "Terminal"; last: true; Words { width: parent.width; role: "number"; text: page.card?.terminal ?? "" } }
            Words {
              visible: (page.card?.problems ?? []).length > 0
              x: 10; width: parent.width - 20
              topPadding: 4; bottomPadding: 10
              role: "meta"
              font.weight: Font.Bold
              wrapMode: Text.Wrap
              text: (page.card?.problems ?? []).join("; ")
              color: Theme.tone("TODO")
            }
          }
        }

        SectionRule { text: "DIRECTIVES" }
        Item {
          width: parent.width
          height: ordersText.implicitHeight + 18
          Inked { anchors.fill: parent; lift: 2 }
          Words {
            id: ordersText
            x: 10; y: 9
            width: parent.width - 20
            role: (page.card?.instructions ?? "").length > 280 ? "body" : "lettering"
            wrapMode: Text.Wrap
            text: (page.card?.instructions ?? "") !== "" ? page.card.instructions : "No directives."
            color: (page.card?.instructions ?? "") !== "" ? Theme.surfaceInk : Theme.surfaceMuted
          }
        }

        SectionRule { visible: (page.card?.runs ?? 0) > 0; text: "HISTORY" }
        Item {
          visible: (page.card?.runs ?? 0) > 0
          width: parent.width
          height: record.implicitHeight + 10
          Inked { anchors.fill: parent; lift: 2 }
          Column {
            id: record
            x: 10; y: 5
            width: parent.width - 20
            spacing: 2
            Words {
              width: parent.width
              topPadding: 4; bottomPadding: 4
              role: "meta"
              font.weight: Font.Bold
              wrapMode: Text.Wrap
              text: (page.card?.statsLine ?? "") + ((page.card?.handoffs ?? 0) > 0 ? " · " + page.card.handoffs + " handed off" : "") + ((page.card?.parked ?? 0) > 0 ? " · " + page.card.parked + " parked" : "")
            }
            Repeater {
              model: page.card?.recentRuns ?? []
              delegate: Item {
                required property var modelData
                width: record.width
                height: 28
                readonly property color tone: modelData.outcome === "done" ? Theme.tone("DONE") : modelData.outcome === "eval" ? Theme.tone("EVAL")
                  : modelData.outcome === "handoff" || modelData.outcome === "parked" ? Theme.tone("TODO") : modelData.outcome === "running" ? Theme.tone("PROG") : Theme.surfaceMuted
                Stamp { id: outcome; width: 66; anchors.verticalCenter: parent.verticalCenter; text: modelData.outcome !== "" ? modelData.outcome : "run"; tone: parent.tone; tilt: 0 }
                Words { anchors.left: outcome.right; anchors.leftMargin: 8; anchors.right: duration.left; anchors.rightMargin: 6; anchors.verticalCenter: parent.verticalCenter; role: "meta"; elide: Text.ElideRight; text: modelData.taskTitle }
                Words { id: duration; anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; role: "number"; text: modelData.duration; color: Theme.surfaceMuted }
              }
            }
          }
        }
      }

      // ---- The clanker card, new or to edit ----
      Column {
        visible: page.editing
        width: parent.width
        spacing: 10

        Item {
          width: parent.width
          height: form.implicitHeight
          Inked { anchors.fill: parent; lift: 4 }
          Column {
            id: form
            width: parent.width
            Band { label: page.creating ? "Clanker card · new" : "Clanker card · edit"; number: page.creating ? "" : (page.card?.serviceNo ?? "") }
            Item {
              width: parent.width
              height: Math.max(formPortrait.height, name.implicitHeight) + 20
              Portrait { id: formPortrait; visible: !Theme.consoleLook; x: 10; y: 10; width: 48; height: 48; harness: Board.harnessOf(page.fHarness); art: 36 }
              RuledField {
                id: name
                x: Theme.consoleLook ? 10 : formPortrait.x + formPortrait.width + 10
                y: 10
                width: parent.width - x - 10
                label: "Name"; placeholder: "e.g. pax"
                onEdited: text => page.fName = text
              }
            }
            FieldRow {
              label: "Host"
              Flow {
                width: parent.width
                spacing: 5
                Repeater {
                  model: page.hosts
                  delegate: Stamp { required property string modelData; text: modelData; tone: Theme.edge; on: page.fHost === modelData; clickable: true; tilt: 0; onClicked: { page.fHost = modelData; host.text = modelData; } }
                }
              }
            }
            Item {
              visible: !page.hosts.includes(page.fHost)
              width: parent.width
              height: host.implicitHeight + 6
              RuledField { id: host; x: 10; width: parent.width - 20; label: "Other unit"; placeholder: "host name"; mono: true; onEdited: text => page.fHost = text }
            }
            FieldRow {
              label: "Harness"
              Flow {
                width: parent.width
                spacing: 5
                Repeater {
                  model: Board.ROSTER_HARNESSES
                  delegate: Stamp { required property string modelData; text: modelData; tone: Theme.harnessTone(modelData); on: page.fHarness === modelData; clickable: true; tilt: 0; onClicked: page.fHarness = modelData }
                }
              }
            }
            Item {
              width: parent.width
              height: modelField.implicitHeight + 10
              RuledField { id: modelField; x: 10; y: 4; width: parent.width - 20; label: "Model"; placeholder: "harness default"; mono: true; onEdited: text => page.fModel = text }
            }
            FieldRow {
              label: "Effort"
              Flow {
                width: parent.width
                spacing: 5
                Repeater {
                  model: Board.ROSTER_EFFORTS
                  delegate: Stamp { required property string modelData; text: modelData === "" ? "default" : modelData; tone: Theme.edge; on: page.fEffort === modelData; clickable: true; tilt: 0; onClicked: page.fEffort = modelData }
                }
              }
            }
            Item { width: parent.width; height: 8 }
          }
        }

        SectionRule { text: "DIRECTIVES" }
        MemoField { id: orders; placeholder: "Role, skills, voice…"; lines: 4; onTextChanged: if (text !== page.fInstructions) page.fInstructions = text }

        Words {
          visible: page.notice.busy || (page.notice.text ?? "") !== ""
          width: parent.width
          wrapMode: Text.Wrap
          role: "meta"
          font.weight: Font.Bold
          text: page.notice.busy ? "saving…" : (page.notice.text ?? "")
          color: page.notice.busy || page.notice.text === "saved" ? Theme.muted : Theme.accent
        }

        Flow {
          width: parent.width
          spacing: 8
          PressTab {
            text: page.creating ? "Create" : "Save card"
            kind: "primary"
            enabled: !page.notice.busy
            onClicked: {
              const payload = { action: "save", name: page.fName, host: page.fHost, harness: page.fHarness, model: page.fModel, effort: page.fEffort, instructions: page.fInstructions };
              if (!page.creating && page.card) payload.original = page.card.slug;
              page.save(payload);
            }
          }
          PressTab { visible: !page.creating && page.card !== null && !page.confirmingDelete; text: "Destroy"; kind: "danger"; enabled: !page.notice.busy; onClicked: page.confirmingDelete = true }
          PressTab { visible: page.confirmingDelete && page.card !== null; text: "Confirm destroy"; kind: "danger"; enabled: !page.notice.busy; onClicked: page.remove(page.card.slug) }
          PressTab { visible: page.confirmingDelete; text: "Keep"; kind: "quiet"; onClicked: page.confirmingDelete = false }
        }
      }
    }
  }
}
