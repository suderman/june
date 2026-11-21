// One task's page in a board column (board.mjs taskDetail), as the Dialog artboard in the mockup draws it: its state
// and facts, title, the buttons that open it in Emacs and its session in Herdr, its last report, and its Dialog as a
// conversation by who wrote each entry. See "Agents and projects" in docs/interfaces.org.
import QtQuick

Item {
  id: page

  property var detail: null
  property string backLabel: "back"
  signal back()
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
    }
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
