// June's history from the masthead's date: a month calendar with the days that have conversation marked, and a search
// across everything the user and June said, its results updating while the user types. Choosing a day or a hit opens it
// in the strip through the shell (`browser`): openDay(date), openMoment(id), search(words), with its days, today, hits
// and more. See "Browse June's history by day" in docs/interfaces.org.
import QtQuick
import QtQuick.Controls
import "strip.mjs" as Strip

Popup {
  id: browse

  required property var browser
  // The month on show, from the day the strip shows when the popup opens.
  property int year: new Date().getFullYear()
  property int month: new Date().getMonth()
  readonly property var counts: {
    const out = {};
    for (const d of browser.days ?? []) out[d.date] = d.count;
    return out;
  }
  readonly property bool searching: field.text.trim() !== ""

  width: 340
  padding: 12
  focus: true
  closePolicy: Popup.CloseOnEscape | Popup.CloseOnPressOutside
  background: Rectangle { radius: 6; color: Theme.cardFill; border.color: Theme.cardLine; border.width: 1.5 }

  onAboutToShow: {
    const shown = browser.past ? browser.past.date : browser.today;
    const at = /^(\d{4})-(\d{2})/.exec(shown ?? "");
    const now = new Date();
    year = at ? Number(at[1]) : now.getFullYear();
    month = at ? Number(at[2]) - 1 : now.getMonth();
    field.text = "";
    browser.search("");
    browser.listDays();
    field.forceActiveFocus();
  }

  function step(by) {
    const next = new Date(year, month + by, 1);
    year = next.getFullYear();
    month = next.getMonth();
  }
  function chooseDay(date) { close(); browser.openDay(date); }
  function chooseHit(id) { close(); browser.openMoment(id); }

  // Search as the user types, a moment after the last key, so each word does not send a request of its own.
  Timer { id: settle; interval: 250; onTriggered: browse.browser.search(field.text) }

  contentItem: Column {
    spacing: 10

    TextField {
      id: field
      objectName: "search"
      width: parent.width
      placeholderText: "search what you and June said"
      font.family: Theme.caption; font.pixelSize: 13
      color: Theme.cardInk
      placeholderTextColor: Theme.cardLine
      background: Rectangle { radius: 4; color: "transparent"; border.color: Theme.cardLine; border.width: 1 }
      onTextEdited: settle.restart()
      Keys.onReturnPressed: if (browse.browser.hits.length > 0) browse.chooseHit(browse.browser.hits[0].id)
    }

    // The calendar, while nothing is typed.
    Column {
      visible: !browse.searching
      width: parent.width
      spacing: 6
      Item {
        width: parent.width
        height: 22
        Text {
          objectName: "earlierMonth"
          anchors.left: parent.left
          text: "‹"; font.pixelSize: 18; color: Theme.cardInk
          MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: browse.step(-1) }
        }
        Text {
          objectName: "monthName"
          anchors.centerIn: parent
          text: grid.title
          font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 13; color: Theme.cardInk
        }
        Text {
          objectName: "laterMonth"
          anchors.right: parent.right
          text: "›"; font.pixelSize: 18; color: Theme.cardInk
          MouseArea { anchors.fill: parent; anchors.margins: -6; cursorShape: Qt.PointingHandCursor; onClicked: browse.step(1) }
        }
      }
      DayOfWeekRow {
        width: parent.width
        locale: grid.locale
        delegate: Text {
          required property string shortName
          text: shortName
          horizontalAlignment: Text.AlignHCenter
          font.family: Theme.caption; font.pixelSize: 11; color: Theme.cardLine
        }
      }
      MonthGrid {
        id: grid
        objectName: "calendar"
        width: parent.width
        // Six weeks of cells; the grid divides its height among them.
        height: 6 * 30
        year: browse.year
        month: browse.month
        locale: Qt.locale("en_CA")
        delegate: Rectangle {
          id: cell
          required property var model
          readonly property string key: Strip.dateKey(model.date)
          readonly property bool said: browse.counts[key] !== undefined || key === browse.browser.today
          readonly property bool current: key === (browse.browser.past ? browse.browser.past.date : browse.browser.today)
          objectName: "day-" + key
          radius: 4
          color: current ? Theme.cardLine : "transparent"
          opacity: model.month === grid.month ? 1 : 0.35
          Text {
            anchors.centerIn: parent
            text: cell.model.day
            font.family: Theme.caption; font.pixelSize: 13
            font.weight: cell.said ? Font.Bold : Font.Normal
            color: cell.said ? Theme.cardInk : Theme.cardLine
          }
          // A dot under a day with conversation.
          Rectangle {
            visible: browse.counts[cell.key] !== undefined
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.bottom: parent.bottom
            anchors.bottomMargin: 2
            width: 4; height: 4; radius: 2
            color: Theme.cardBusy
          }
          MouseArea {
            anchors.fill: parent
            enabled: cell.said
            cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
            onClicked: browse.chooseDay(cell.key)
          }
        }
      }
    }

    // What the search found, newest first; a click opens that moment.
    ListView {
      id: results
      objectName: "results"
      visible: browse.searching
      width: parent.width
      height: Math.min(contentHeight, 320)
      clip: true
      spacing: 6
      model: browse.browser.hits ?? []
      delegate: Item {
        id: hit
        required property var modelData
        required property int index
        objectName: "hit-" + index
        width: results.width
        height: lines.implicitHeight
        Column {
          id: lines
          width: parent.width
          Text {
            width: parent.width
            text: Strip.dayLabel(hit.modelData.date, browse.browser.today) + " · " + new Date(hit.modelData.at).toLocaleTimeString(Qt.locale("en_CA"), "HH:mm") + " · " + (hit.modelData.kind === "user" ? "you" : "June")
            font.family: Theme.caption; font.pixelSize: 11; color: Theme.cardBusy
          }
          Text {
            width: parent.width
            text: hit.modelData.text
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
            font.family: Theme.caption; font.pixelSize: 12; color: Theme.cardInk
          }
        }
        MouseArea {
          anchors.fill: parent
          cursorShape: Qt.PointingHandCursor
          onClicked: browse.chooseHit(hit.modelData.id)
        }
      }
      footer: Text {
        width: results.width
        topPadding: 6
        text: browse.browser.hits.length === 0 ? (browse.browser.searchDone ? "nothing found" : "searching…") : browse.browser.hitsMore ? "older hits left out; add words to narrow it" : ""
        font.family: Theme.caption; font.pixelSize: 11; color: Theme.cardLine
      }
    }
  }
}
