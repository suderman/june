// The strip's masthead: June's name, the connection or what she is doing, and a "meanwhile" card while briefs run.
import QtQuick
import QtQuick.Controls
import "strip.mjs" as Strip

Row {
  id: masthead

  property bool linked: false
  property int refusals: 0
  property string host: ""
  property int background: 0
  // What she is doing in plain words, and the tasks she follows for a click (strip.mjs status).
  property string status: ""
  property var detail: []
  property bool detailOpen: false
  // A click on a task that needs the user dismisses it until its signal changes (strip.mjs status).
  signal dismissed(string key)
  // Do not disturb: she stays down until summoned.
  property bool quiet: false
  // The shell, for browsing June's history from the date (Browse.qml); null leaves the date out.
  property var browser: null
  // The day picker is the strip's: off while a narrow window shows a board instead.
  property bool showDays: true
  function openBrowse() { if (day.visible) calendar.open(); }
  function stepDay(delta) {
    if (!day.visible || day.b === null) return;
    if (delta < 0 && day.before !== "") day.b.openDay(day.before);
    else if (delta > 0 && day.after !== "") day.b.openDay(day.after);
  }
  readonly property bool browseOpen: calendar.opened

  // The boards' masthead role for her name, as "agents" and "projects" have it, and their summary's size for the rest.
  height: Theme.type.masthead.line
  spacing: 12
  // The follow list hangs below over the strip.
  z: 5
  Words { text: "june"; role: "masthead"; color: Theme.pageInk; anchors.verticalCenter: parent.verticalCenter }
  // The day on show: today, live, or a past day, fixed. ‹ and › step between days with conversation, and a click on the
  // date opens the calendar and search.
  Row {
    id: day
    visible: masthead.browser !== null && masthead.showDays && masthead.linked
    anchors.verticalCenter: parent.verticalCenter
    spacing: 8
    readonly property var b: masthead.browser
    readonly property string current: b === null ? "" : b.past ? b.past.date : b.today
    readonly property string before: b === null || current === "" ? "" : (Strip.stepDay(b.days, current, -1, b.today) ?? "")
    readonly property string after: b === null || b.past === null ? "" : (Strip.stepDay(b.days, current, 1, b.today) ?? b.today)
    Text {
      objectName: "earlierDay"
      visible: day.before !== ""
      text: "‹"
      font.pixelSize: 20; color: Theme.pageInk
      anchors.verticalCenter: parent.verticalCenter
      MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: day.b.openDay(day.before) }
    }
    Text {
      id: date
      objectName: "date"
      text: (day.b !== null && day.b.past ? Strip.dayLabel(day.current, day.b.today) : "today") + " ▾"
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: Theme.type.meta.size
      color: day.b !== null && day.b.past ? Theme.accent : Theme.muted
      anchors.verticalCenter: parent.verticalCenter
      MouseArea { anchors.fill: parent; anchors.margins: -4; cursorShape: Qt.PointingHandCursor; onClicked: calendar.opened ? calendar.close() : calendar.open() }
      Browse { id: calendar; objectName: "browse"; browser: masthead.browser ?? ({}); y: date.height + 8 }
    }
    Text {
      objectName: "laterDay"
      visible: day.after !== ""
      text: "›"
      font.pixelSize: 20; color: Theme.pageInk
      anchors.verticalCenter: parent.verticalCenter
      MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: day.b.openDay(day.after) }
    }
    Text {
      objectName: "backToToday"
      visible: day.b !== null && day.b.past !== null
      text: "back to today"
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: Theme.type.meta.size; color: Theme.muted
      anchors.verticalCenter: parent.verticalCenter
      MouseArea { anchors.fill: parent; anchors.margins: -4; cursorShape: Qt.PointingHandCursor; onClicked: day.b.backToToday() }
    }
  }
  Text {
    id: said
    anchors.verticalCenter: parent.verticalCenter
    width: Math.min(implicitWidth, Math.max(0, masthead.width - x - (meanwhileBox.visible ? meanwhileBox.width + masthead.spacing : 0)))
    elide: Text.ElideRight
    text: (!masthead.linked ? (masthead.refusals >= 2 ? "pairing needed: check this device's token" : "reconnecting to " + masthead.host + "…") : masthead.status) + (masthead.quiet ? " · do not disturb" : "") + (masthead.linked && masthead.detail.length > 0 ? (masthead.detailOpen ? "  ▴" : "  ▾") : "")
    font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: Theme.type.meta.size
    color: masthead.linked && !masthead.detail.some(f => f.needsYou) ? Theme.muted : Theme.accent
    MouseArea {
      anchors.fill: parent
      enabled: masthead.detail.length > 0
      cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
      onClicked: masthead.detailOpen = !masthead.detailOpen
    }
    // What she follows: each task and where it stands, a click on the line away.
    Popup {
      visible: masthead.detailOpen && masthead.linked && masthead.detail.length > 0
      y: said.height + 8
      width: Math.max(260, follows.implicitWidth + 24)
      height: follows.implicitHeight + 16
      horizontalPadding: 12
      verticalPadding: 8
      onClosed: masthead.detailOpen = false
      background: Rectangle {
        radius: 6
        color: Theme.cardFill
        border.color: Theme.cardLine
        border.width: 1.5
      }
      contentItem: Column {
        id: follows
        spacing: 4
        Repeater {
          model: masthead.detail
          delegate: Text {
            required property var modelData
            text: modelData.title + "  ·  " + modelData.state + (modelData.needsYou ? "   dismiss" : "")
            font.family: Theme.caption; font.pixelSize: Theme.type.meta.size; font.weight: modelData.needsYou ? Font.Bold : Font.Normal
            color: modelData.needsYou ? Theme.cardFail : Theme.cardInk
            MouseArea {
              anchors.fill: parent
              enabled: parent.modelData.needsYou
              cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
              onClicked: masthead.dismissed(parent.modelData.key)
            }
          }
        }
      }
    }
  }
  // Background briefs: a small inked "meanwhile" card, the comic's cutaway to work going on elsewhere.
  Rectangle {
    id: meanwhileBox
    visible: masthead.linked && masthead.background > 0
    anchors.verticalCenter: parent.verticalCenter
    width: meanwhile.implicitWidth + 20
    height: 26
    radius: 6
    color: Theme.cardFill
    border.color: Theme.cardLine
    border.width: 1.5
    Text {
      id: meanwhile
      anchors.centerIn: parent
      text: "meanwhile, on " + masthead.host + " · " + (masthead.background === 1 ? "1 brief" : masthead.background + " briefs")
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: Theme.type.meta.size
      color: Theme.cardBusy
    }
  }
}
