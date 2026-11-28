// A date and time picker for a task's page (board.mjs monthDays, quickDays): quick days, a month to pick a day in,
// and a time by preset or in quarter hours, or none. It answers with "YYYY-MM-DD" or "YYYY-MM-DD HH:MM", which
// org-edit reads, or with clear or cancel.
import QtQuick
import "board.mjs" as Board
import "keys.mjs" as KeyNav

Rectangle {
  id: picker

  property string title: ""
  property string today: ""
  // Where it starts: { date, time } as board.mjs pickerStart gives it.
  property var start: ({ date: "", time: "" })
  property bool canClear: false
  property string setLabel: "Set"
  signal picked(string when)
  signal cleared()
  signal cancelled()

  property string date: start.date !== "" ? start.date : today
  property string time: start.time
  property int year: Number(date.slice(0, 4))
  property int month: Number(date.slice(5, 7))
  readonly property var shown: Board.monthDays(year, month, today)
  readonly property var presets: ["09:00", "12:00", "13:00", "17:00"]

  function setDate(iso) {
    if (!iso) return;
    date = iso;
    year = Number(iso.slice(0, 4));
    month = Number(iso.slice(5, 7));
  }
  function step(minutes) {
    const t = time === "" ? 9 * 60 : Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const n = Math.min(23 * 60 + 45, Math.max(0, Math.round((t + minutes) / 15) * 15));
    time = String(Math.floor(n / 60)).padStart(2, "0") + ":" + String(n % 60).padStart(2, "0");
  }
  function moveMonth(by) {
    const m = month - 1 + by;
    year = year + Math.floor(m / 12);
    month = ((m % 12) + 12) % 12 + 1;
  }
  function handleKey(ev) {
    if (!ev || ev.ctrl || ev.alt) return false;
    const k = ev.key || "";
    const t = ev.text || "";
    if (k === "Escape" || k === "Backspace" || t === "q") { cancelled(); return true; }
    if (k === "Return" || k === "Enter") { picked(time === "" ? date : date + " " + time); return true; }
    if (t === "h" || k === "Left") { setDate(KeyNav.stepIsoDate(date, -1)); return true; }
    if (t === "l" || k === "Right") { setDate(KeyNav.stepIsoDate(date, 1)); return true; }
    if (t === "j" || k === "Down") { setDate(KeyNav.stepIsoDate(date, 7)); return true; }
    if (t === "k" || k === "Up") { setDate(KeyNav.stepIsoDate(date, -7)); return true; }
    if (t === "[" || t === "p" || k === "PageUp") { moveMonth(-1); return true; }
    if (t === "]" || t === "n" || k === "PageDown") { moveMonth(1); return true; }
    if (t === "t") { setDate(today); return true; }
    if (t === "m") { setDate(KeyNav.stepIsoDate(today, 1)); return true; }
    if (t === "-") { step(-15); return true; }
    if (t === "+" || t === "=") { step(15); return true; }
    if (t === "0") { time = ""; return true; }
    if (t === "x" && canClear) { cleared(); return true; }
    return false;
  }

  width: parent ? parent.width : 260
  height: body.implicitHeight + 20
  radius: 12
  color: Theme.balloon
  border.color: Theme.pageInk
  border.width: 2

  Column {
    id: body
    x: 10; y: 10
    width: parent.width - 20
    spacing: 8

    Text {
      visible: picker.title !== ""
      width: parent.width
      wrapMode: Text.Wrap
      text: picker.title
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12
      color: Theme.pageInk
    }
    Flow {
      width: parent.width
      spacing: 6
      Repeater {
        model: Board.quickDays(picker.today)
        delegate: Pill {
          required property var modelData
          text: modelData.label
          on: picker.date === modelData.date
          onClicked: { picker.date = modelData.date; picker.year = Number(modelData.date.slice(0, 4)); picker.month = Number(modelData.date.slice(5, 7)); }
        }
      }
    }

    // The month: ‹ Nov 2026 ›, then its weeks from Sunday.
    Item {
      width: parent.width
      height: 24
      Text { anchors.left: parent.left; anchors.verticalCenter: parent.verticalCenter; text: "‹"; font.pixelSize: 18; font.weight: Font.Bold; color: Theme.pageInk
        MouseArea { anchors.fill: parent; anchors.margins: -8; cursorShape: Qt.PointingHandCursor; onClicked: picker.moveMonth(-1) } }
      Text { anchors.centerIn: parent; text: picker.shown.title; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: Theme.pageInk }
      Text { anchors.right: parent.right; anchors.verticalCenter: parent.verticalCenter; text: "›"; font.pixelSize: 18; font.weight: Font.Bold; color: Theme.pageInk
        MouseArea { anchors.fill: parent; anchors.margins: -8; cursorShape: Qt.PointingHandCursor; onClicked: picker.moveMonth(1) } }
    }
    Row {
      Repeater {
        model: ["S", "M", "T", "W", "T", "F", "S"]
        delegate: Text {
          required property string modelData
          width: body.width / 7
          horizontalAlignment: Text.AlignHCenter
          text: modelData
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 11
          color: Theme.muted
        }
      }
    }
    Column {
      Repeater {
        model: picker.shown.weeks
        delegate: Row {
          required property var modelData
          Repeater {
            model: modelData
            delegate: Item {
              id: cell
              required property var modelData
              readonly property bool chosen: modelData.date === picker.date
              width: body.width / 7
              height: 30
              Rectangle {
                anchors.centerIn: parent
                width: 28; height: 28; radius: 14
                color: cell.chosen ? Theme.pageInk : "transparent"
                border.color: Theme.pageInk
                border.width: cell.modelData.today && !cell.chosen ? 1.5 : 0
              }
              Text {
                anchors.centerIn: parent
                text: cell.modelData.day
                font.family: Theme.caption; font.pixelSize: 12; font.weight: cell.chosen ? Font.Bold : Font.Normal
                color: cell.chosen ? Theme.paper : Theme.pageInk
                opacity: !cell.modelData.inMonth ? 0.3 : cell.modelData.past ? 0.45 : 1
              }
              MouseArea {
                anchors.fill: parent
                cursorShape: Qt.PointingHandCursor
                onClicked: { picker.date = cell.modelData.date; if (!cell.modelData.inMonth) { picker.year = Number(picker.date.slice(0, 4)); picker.month = Number(picker.date.slice(5, 7)); } }
              }
            }
          }
        }
      }
    }

    // The time: a preset, a quarter hour either way, or none.
    Flow {
      width: parent.width
      spacing: 6
      Pill { text: "no time"; on: picker.time === ""; onClicked: picker.time = "" }
      Repeater {
        model: picker.presets
        delegate: Pill { required property string modelData; text: modelData; on: picker.time === modelData; onClicked: picker.time = modelData }
      }
    }
    Row {
      spacing: 6
      Pill { text: "−15"; onClicked: picker.step(-15) }
      Text {
        width: 64; height: 28
        horizontalAlignment: Text.AlignHCenter; verticalAlignment: Text.AlignVCenter
        text: picker.time === "" ? "all day" : picker.time
        font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 14
        color: Theme.pageInk
      }
      Pill { text: "+15"; onClicked: picker.step(15) }
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: Board.dayWord(picker.date, picker.today) + (picker.time !== "" ? " " + picker.time : "") + (picker.date < picker.today ? ", already past" : "")
      font.family: Theme.caption; font.pixelSize: 12
      color: picker.date < picker.today ? Theme.accent : Theme.muted
    }
    Flow {
      width: parent.width
      spacing: 6
      Pill { text: picker.setLabel; on: true; onClicked: picker.picked(picker.time === "" ? picker.date : picker.date + " " + picker.time) }
      Pill { visible: picker.canClear; text: "Clear"; onClicked: picker.cleared() }
      Pill { text: "Cancel"; onClicked: picker.cancelled() }
    }
    Text {
      width: parent.width
      wrapMode: Text.Wrap
      text: "h/l day · j/k wk · [/] mo · t/m today/tmrw · -/+ time · RET set"
      font.family: "monospace"; font.pixelSize: 10
      color: Theme.muted
    }
  }

  component Pill: Rectangle {
    id: pill
    property string text: ""
    property bool on: false
    signal clicked()
    width: pillLabel.implicitWidth + 18
    height: 28
    radius: 14
    color: on ? Theme.pageInk : "transparent"
    border.color: Theme.pageInk
    border.width: 2
    Text { id: pillLabel; anchors.centerIn: parent; text: pill.text; font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 12; color: pill.on ? Theme.paper : Theme.pageInk }
    MouseArea { anchors.fill: parent; cursorShape: Qt.PointingHandCursor; onClicked: pill.clicked() }
  }
}
