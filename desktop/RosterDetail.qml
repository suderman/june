// One roster agent's card and editor (ROSTER.org via daemon `roster` op): shows host, harness, model, effort,
// battery, status and instructions when opened, and edits, adds or removes cards in place.
import QtQuick
import QtQuick.Controls
import "board.mjs" as Board

Item {
  id: page

  // Shaped card from board.mjs rosterView, or null when creating a new agent.
  property var card: null
  property bool creating: false
  property var hosts: ["kit", "cog"]
  property var notice: ({ text: "", busy: false, seq: 0, saved: "" })
  signal back()
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
  property string fAvatar: ""
  property string fInstructions: ""

  function loadForm(c) {
    confirmingDelete = false;
    if (c) {
      fName = c.name ?? "";
      fHost = c.host ?? (hosts.length > 0 ? hosts[0] : "kit");
      fHarness = c.harness && Board.ROSTER_HARNESSES.includes(c.harness) ? c.harness : "claude";
      fModel = c.model ?? "";
      fEffort = c.effort ?? "";
      fAvatar = c.avatar ?? "";
      fInstructions = c.instructions ?? "";
    } else {
      fName = "";
      fHost = hosts.length > 0 ? hosts[0] : "kit";
      fHarness = "claude";
      fModel = "";
      fEffort = "high";
      fAvatar = "";
      fInstructions = "";
    }
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

  readonly property var colours: Board.HARNESS[Board.harnessOf(editing ? fHarness : (card?.harness ?? ""))] ?? Board.HARNESS.other

  Flickable {
    anchors.fill: parent
    contentHeight: col.implicitHeight + 20
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: col
      width: parent.width
      spacing: 10

      // Top bar: back/cancel and edit toggle.
      Item {
        width: parent.width
        height: 28
        Text {
          anchors.left: parent.left
          anchors.verticalCenter: parent.verticalCenter
          text: page.editing && !page.creating ? "‹ card" : "‹ roster"
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13
          color: Theme.pageInk
          MouseArea {
            anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor
            onClicked: {
              if (page.editing && !page.creating) { page.editing = false; page.confirmingDelete = false; }
              else page.back();
            }
          }
        }
        Choice {
          visible: !page.editing && page.card !== null
          anchors.right: parent.right
          anchors.verticalCenter: parent.verticalCenter
          text: "edit"
          onClicked: { page.loadForm(page.card); page.editing = true; }
        }
      }

      // ---- VIEW MODE: Pokemon-style Clanker Card ----
      Column {
        visible: !page.editing && page.card !== null
        width: parent.width
        spacing: 10

        Rectangle {
          width: parent.width
          height: viewCardInner.implicitHeight + 26
          radius: 14
          color: Theme.balloon
          border.color: Theme.ink
          border.width: 2.5
          clip: true

          // Harness-coloured header stripe.
          Rectangle { width: parent.width; height: 8; color: page.colours.band }

          Column {
            id: viewCardInner
            x: 12; y: 16
            width: parent.width - 24
            spacing: 10

            Row {
              width: parent.width
              spacing: 10
              Clanker { size: 52; harness: page.card?.clanker ?? "other" }
              Column {
                width: parent.width - 62
                anchors.verticalCenter: parent.verticalCenter
                spacing: 4
                Text {
                  width: parent.width
                  elide: Text.ElideRight
                  text: page.card?.name ?? ""
                  font.family: Theme.display; font.pixelSize: 20
                  color: Theme.ink
                }
                Row {
                  spacing: 6
                  Rectangle {
                    height: 20
                    width: stText.implicitWidth + 12
                    radius: 10
                    color: page.card?.busy ? "#d7e4f2" : page.card?.status === "idle" ? "#dfead6" : "#ffd6cf"
                    border.color: page.card?.busy ? "#1c3a66" : page.card?.status === "idle" ? "#2f5a22" : "#8a1f12"
                    border.width: 1.5
                    Text {
                      id: stText
                      anchors.centerIn: parent
                      text: page.card?.statusLabel ?? ""
                      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 10
                      color: page.card?.busy ? "#1c3a66" : page.card?.status === "idle" ? "#2f5a22" : "#8a1f12"
                    }
                  }
                  Text {
                    visible: (page.card?.terminal ?? "") !== ""
                    anchors.verticalCenter: parent.verticalCenter
                    text: page.card?.terminal ?? ""
                    font.family: Theme.caption; font.pixelSize: 11
                    color: "#6d6a73"
                  }
                }
              }
            }

            // Battery gauge row.
            Row {
              visible: (page.card?.batteryText ?? "") !== ""
              width: parent.width
              spacing: 8
              BatteryBar {
                anchors.verticalCenter: parent.verticalCenter
                level: page.card?.batteryLevel ?? -1
                tone: page.card?.batteryTone ?? "unknown"
              }
              Text {
                width: parent.width - 42
                anchors.verticalCenter: parent.verticalCenter
                elide: Text.ElideRight
                text: (page.card?.batteryText ?? "") + ((page.card?.batteryAccount ?? "") !== "" ? " · " + page.card.batteryAccount : "")
                font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
                color: Theme.ink
              }
            }

            Rectangle { width: parent.width; height: 1.5; color: Theme.ink; opacity: 0.15 }

            // Core specs: host, harness, model, effort.
            Grid {
              width: parent.width
              columns: 2
              columnSpacing: 10
              rowSpacing: 6
              SpecCell { width: (parent.width - 10) / 2; label: "HOST"; value: page.card?.host || "—" }
              SpecCell { width: (parent.width - 10) / 2; label: "HARNESS"; value: page.card?.harness || "—" }
              SpecCell { width: (parent.width - 10) / 2; label: "MODEL"; value: page.card?.model || "default" }
              SpecCell { width: (parent.width - 10) / 2; label: "EFFORT"; value: page.card?.effort || "default" }
            }

            SpecCell {
              visible: (page.card?.avatar ?? "") !== ""
              width: parent.width
              label: "AVATAR"
              value: page.card?.avatar ?? ""
            }

            Text {
              visible: (page.card?.problems ?? []).length > 0
              width: parent.width
              wrapMode: Text.Wrap
              text: (page.card?.problems ?? []).join("; ")
              font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
              color: Theme.accent
            }
          }
        }

        Text {
          text: "INSTRUCTIONS"
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 11; font.letterSpacing: 1
          color: Theme.muted
        }
        Rectangle {
          width: parent.width
          height: instrView.implicitHeight + 16
          radius: 12
          color: Theme.balloon
          border.color: Theme.ink
          border.width: 2
          Text {
            id: instrView
            x: 10; y: 8
            width: parent.width - 20
            wrapMode: Text.Wrap
            text: (page.card?.instructions ?? "") !== "" ? page.card.instructions : "No extra instructions."
            font.family: Theme.lettering; font.pixelSize: 13
            color: (page.card?.instructions ?? "") !== "" ? Theme.ink : Theme.muted
          }
        }

        Text {
          visible: (page.card?.runs ?? 0) > 0
          text: "HISTORY"
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 11; font.letterSpacing: 1
          color: Theme.muted
        }
        Rectangle {
          visible: (page.card?.runs ?? 0) > 0
          width: parent.width
          height: histCol.implicitHeight + 16
          radius: 12
          color: Theme.balloon
          border.color: Theme.ink
          border.width: 2
          Column {
            id: histCol
            x: 10; y: 8
            width: parent.width - 20
            spacing: 6
            Text {
              width: parent.width
              wrapMode: Text.Wrap
              text: (page.card?.statsLine ?? "")
                + ((page.card?.handoffs ?? 0) > 0 ? " · " + page.card.handoffs + " handoff" : "")
                + ((page.card?.parked ?? 0) > 0 ? " · " + page.card.parked + " parked" : "")
              font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
              color: Theme.ink
            }
            Repeater {
              model: page.card?.recentRuns ?? []
              delegate: Row {
                required property var modelData
                width: histCol.width
                spacing: 6
                Text {
                  width: 48
                  text: modelData.outcome.toUpperCase()
                  font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 10
                  color: modelData.outcome === "done" || modelData.outcome === "eval" ? "#2f5a22" : modelData.outcome === "handoff" || modelData.outcome === "parked" ? "#8a1f12" : "#6d6a73"
                }
                Text {
                  width: parent.width - 96
                  elide: Text.ElideRight
                  text: modelData.taskTitle
                  font.family: Theme.caption; font.pixelSize: 12
                  color: Theme.ink
                }
                Text {
                  width: 36
                  horizontalAlignment: Text.AlignRight
                  text: modelData.duration
                  font.family: Theme.caption; font.pixelSize: 11
                  color: "#6d6a73"
                }
              }
            }
          }
        }
      }

      // ---- EDIT / CREATE MODE ----
      Column {
        visible: page.editing
        width: parent.width
        spacing: 9

        // Live card preview header.
        Row {
          width: parent.width
          spacing: 10
          Clanker { size: 40; harness: Board.harnessOf(page.fHarness) }
          Column {
            width: parent.width - 50
            anchors.verticalCenter: parent.verticalCenter
            spacing: 1
            Text {
              width: parent.width; elide: Text.ElideRight
              text: page.fName.trim() !== "" ? page.fName.trim() : (page.creating ? "New agent" : (page.card?.name ?? ""))
              font.family: Theme.display; font.pixelSize: 18
              color: Theme.pageInk
            }
            Text {
              width: parent.width; elide: Text.ElideRight
              text: [page.fHost.trim(), page.fHarness, page.fModel.trim(), page.fEffort].filter(s => s !== "").join(" · ")
              font.family: Theme.caption; font.pixelSize: 11
              color: Theme.muted
            }
          }
        }

        FieldLabel { text: "NAME" }
        StyledInput {
          width: parent.width
          text: page.fName
          placeholderText: "e.g. Bolt"
          onTextEdited: page.fName = text
        }

        FieldLabel { text: "HOST" }
        Flow {
          width: parent.width
          spacing: 6
          Repeater {
            model: page.hosts
            delegate: Choice {
              required property string modelData
              text: modelData
              on: page.fHost === modelData
              onClicked: page.fHost = modelData
            }
          }
        }
        StyledInput {
          width: parent.width
          text: page.fHost
          placeholderText: "host name (kit, cog, …)"
          onTextEdited: page.fHost = text
        }

        FieldLabel { text: "HARNESS" }
        Flow {
          width: parent.width
          spacing: 6
          Repeater {
            model: Board.ROSTER_HARNESSES
            delegate: Choice {
              required property string modelData
              text: modelData
              on: page.fHarness === modelData
              onClicked: page.fHarness = modelData
            }
          }
        }

        FieldLabel { text: "MODEL" }
        StyledInput {
          width: parent.width
          text: page.fModel
          placeholderText: "harness default"
          onTextEdited: page.fModel = text
        }

        FieldLabel { text: "EFFORT" }
        Flow {
          width: parent.width
          spacing: 6
          Repeater {
            model: Board.ROSTER_EFFORTS
            delegate: Choice {
              required property string modelData
              text: modelData === "" ? "default" : modelData
              on: page.fEffort === modelData
              onClicked: page.fEffort = modelData
            }
          }
        }

        FieldLabel { text: "AVATAR" }
        StyledInput {
          width: parent.width
          text: page.fAvatar
          placeholderText: "optional path beside ROSTER.org"
          onTextEdited: page.fAvatar = text
        }

        FieldLabel { text: "INSTRUCTIONS" }
        Rectangle {
          width: parent.width
          height: Math.max(96, instrEdit.implicitHeight + 16)
          radius: 10
          color: Theme.balloon
          border.color: Theme.pageInk
          border.width: 1.5
          TextArea {
            id: instrEdit
            anchors.fill: parent
            anchors.margins: 4
            wrapMode: TextEdit.Wrap
            text: page.fInstructions
            placeholderText: "Role, skills, voice…"
            font.family: Theme.lettering; font.pixelSize: 13
            color: Theme.ink
            background: null
            onTextChanged: if (text !== page.fInstructions) page.fInstructions = text
          }
        }

        Text {
          visible: page.notice.busy || (page.notice.text ?? "") !== ""
          width: parent.width
          wrapMode: Text.Wrap
          text: page.notice.busy ? "saving…" : (page.notice.text ?? "")
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
          color: page.notice.busy || page.notice.text === "saved" ? Theme.muted : Theme.accent
        }

        Row {
          spacing: 8
          Choice {
            text: page.creating ? "Add agent" : "Save"
            on: true
            enabled: !page.notice.busy
            onClicked: {
              const payload = {
                action: "save",
                name: page.fName,
                host: page.fHost,
                harness: page.fHarness,
                model: page.fModel,
                effort: page.fEffort,
                avatar: page.fAvatar,
                instructions: page.fInstructions,
              };
              if (!page.creating && page.card) payload.original = page.card.slug;
              page.save(payload);
            }
          }
          Choice {
            visible: !page.creating && page.card !== null && !page.confirmingDelete
            text: "Remove"
            danger: true
            enabled: !page.notice.busy
            onClicked: page.confirmingDelete = true
          }
          Choice {
            visible: page.confirmingDelete && page.card !== null
            text: "Confirm remove"
            danger: true
            on: true
            enabled: !page.notice.busy
            onClicked: page.remove(page.card.slug)
          }
          Choice {
            visible: page.confirmingDelete
            text: "Keep"
            onClicked: page.confirmingDelete = false
          }
        }
      }
    }
  }

  component FieldLabel: Text {
    topPadding: 2
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 11; font.letterSpacing: 1
    color: Theme.muted
  }

  component SpecCell: Column {
    property string label: ""
    property string value: ""
    spacing: 1
    Text { text: label; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 10; font.letterSpacing: 0.8; color: "#6d6a73" }
    Text { width: parent.width; elide: Text.ElideRight; text: value; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: Theme.ink }
  }

  component StyledInput: TextField {
    height: 30
    font.family: Theme.caption; font.pixelSize: 12
    color: Theme.ink
    background: Rectangle { radius: 8; color: Theme.balloon; border.color: Theme.pageInk; border.width: 1.5 }
  }

  component Choice: Rectangle {
    id: ch
    property string text: ""
    property bool on: false
    property bool danger: false
    signal clicked()
    width: chLabel.implicitWidth + 20
    height: 28
    radius: 14
    readonly property color edge: danger ? "#b3311f" : Theme.pageInk
    color: on ? edge : "transparent"
    border.color: edge
    border.width: 2
    opacity: enabled ? 1 : 0.5
    Text { id: chLabel; anchors.centerIn: parent; text: ch.text; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: ch.on ? Theme.paper : ch.edge }
    MouseArea { anchors.fill: parent; enabled: ch.enabled; cursorShape: Qt.PointingHandCursor; onClicked: ch.clicked() }
  }

  // Drawn battery icon filled to `level` (0..100, or -1 for unknown).
  component BatteryBar: Item {
    id: bat
    property int level: -1
    property string tone: "unknown"
    width: 34; height: 15
    readonly property color fill: tone === "high" ? "#2f8a4e" : tone === "mid" ? "#c88a12" : tone === "low" ? "#b3311f" : "#8b8892"
    Rectangle {
      x: 0; y: 0; width: 30; height: 15; radius: 4
      color: "transparent"
      border.color: Theme.ink; border.width: 2
      Rectangle {
        visible: bat.level >= 0
        x: 3; y: 3
        width: Math.max(bat.level > 0 ? 3 : 0, Math.round((parent.width - 6) * bat.level / 100))
        height: parent.height - 6
        radius: 1.5
        color: bat.fill
      }
    }
    Rectangle { x: 31; y: 4; width: 3; height: 7; radius: 1.5; color: Theme.ink }
  }
}
