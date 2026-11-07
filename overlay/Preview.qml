// A picture or file the user's message brought, shown over the strip rather than in another app, on a dark ground with
// its name, "open in browser" to hand it to the desktop's app, and a close. A picture is fitted to the window; a PDF
// shows a page at a time as the daemon renders them (‹ ›, or the window's arrow keys); a text file shows its words; any
// other file only its name. Esc (the window's shortcut), the close, or a click on the ground closes it. See "Previewing
// what a message brought" in docs/interfaces.org.
import QtQuick

Item {
  id: preview
  // { kind: "picture" | "pdf" | "text" | "file" (Strip.previewKind), url, name }, or null when closed.
  property var what: null
  readonly property bool open: what !== null
  readonly property string kind: open ? (what.kind ?? "picture") : ""
  // A PDF's pages: how many (-1 while asking), and the one shown, from 1.
  property int pages: -1
  property int page: 1
  readonly property bool paging: kind === "pdf" && pages > 1
  // A text file's words, or "" while loading; `failed` when it could not be read.
  property string words: ""
  property bool failed: false
  // Asks the window to open the url with the desktop's app.
  signal external(string url)
  visible: open
  z: 100

  readonly property int maxChars: 200000

  function show(item) {
    what = item; pages = -1; page = 1; words = ""; failed = false;
    if (kind === "pdf") ask(item.url + "/pages", text => { pages = Number(JSON.parse(text).pages) || 0; }, () => { pages = 0; });
    else if (kind === "text") ask(item.url, text => { words = text.length > maxChars ? text.slice(0, maxChars) + "\n…" : text; }, () => { failed = true; });
  }
  function close() { what = null; }
  function next() { if (paging && page < pages) page++; }
  function previous() { if (paging && page > 1) page--; }

  // GET `url`, then `done(text)`, or `fail()`; a reply for a preview since closed or replaced is dropped.
  function ask(url, done, fail) {
    const shown = what;
    const request = new XMLHttpRequest();
    request.onreadystatechange = () => {
      if (request.readyState !== XMLHttpRequest.DONE || what !== shown) return;
      if (request.status === 200) done(request.responseText); else fail();
    };
    request.open("GET", url);
    request.send();
  }

  Rectangle { anchors.fill: parent; color: "#000000"; opacity: 0.86 }
  // A click on the ground closes it; one on what is shown or the buttons does not.
  MouseArea { objectName: "ground"; anchors.fill: parent; onClicked: preview.close() }

  // The area what is shown fills, between the buttons and the name.
  Item {
    id: stage
    anchors.fill: parent
    anchors.topMargin: 64; anchors.bottomMargin: 56; anchors.leftMargin: 24; anchors.rightMargin: 24

    Image {
      id: picture
      objectName: "picture"
      anchors.fill: parent
      visible: preview.kind === "picture" || preview.kind === "pdf"
      fillMode: Image.PreserveAspectFit
      asynchronous: true
      source: preview.kind === "picture" ? preview.what.url : preview.kind === "pdf" && preview.pages > 0 ? preview.what.url + "/page/" + preview.page : ""
      sourceSize.width: 2400
      sourceSize.height: 2400
      Item {
        anchors.centerIn: parent
        width: picture.paintedWidth; height: picture.paintedHeight
        MouseArea { anchors.fill: parent }
        // A page of a document sits on white, as paper, for a PDF without a background of its own.
        Rectangle { anchors.fill: parent; z: -1; color: "#ffffff"; visible: preview.kind === "pdf" }
      }
    }

    Rectangle {
      objectName: "words"
      anchors.centerIn: parent
      width: Math.min(parent.width, 820); height: parent.height
      visible: preview.kind === "text" && preview.words !== ""
      color: "#fbf8f1"; radius: 6
      MouseArea { anchors.fill: parent }
      Flickable {
        anchors.fill: parent; anchors.margins: 18
        clip: true
        contentWidth: width; contentHeight: text.height
        boundsBehavior: Flickable.StopAtBounds
        TextEdit {
          id: text
          objectName: "text"
          width: parent.width
          readOnly: true; selectByMouse: true
          wrapMode: TextEdit.Wrap
          textFormat: TextEdit.PlainText
          text: preview.words
          font.family: "monospace"; font.pixelSize: 14; color: Theme.ink
          selectionColor: Theme.highlight
        }
      }
    }

    // Any other file: its page, folded at the corner, and that there is nothing to show of it here.
    Column {
      anchors.centerIn: parent
      visible: preview.kind === "file"
      spacing: 14
      Rectangle {
        anchors.horizontalCenter: parent.horizontalCenter
        width: 84; height: 108; color: "#fbf8f1"; border.color: "#ffffff"; border.width: 2; radius: 4
        MouseArea { anchors.fill: parent }
      }
      Text {
        anchors.horizontalCenter: parent.horizontalCenter
        text: "No preview for this kind of file."
        font.family: Theme.caption; font.pixelSize: 16; color: "#ffffff"
      }
    }
  }

  Text {
    objectName: "status"
    anchors.centerIn: parent
    readonly property bool loading: (preview.kind === "picture" || (preview.kind === "pdf" && preview.pages > 0)) ? picture.status !== Image.Ready && picture.status !== Image.Error
      : preview.kind === "pdf" ? preview.pages < 0 : preview.kind === "text" && preview.words === "" && !preview.failed
    readonly property bool broken: (preview.kind === "picture" || (preview.kind === "pdf" && preview.pages > 0)) ? picture.status === Image.Error
      : preview.kind === "pdf" ? preview.pages === 0 : preview.kind === "text" && preview.failed
    visible: loading || broken
    text: loading ? "loading…" : preview.kind === "pdf" && preview.pages === 0 ? "Its pages could not be read here. Open it in the browser instead."
      : "It could not be loaded. June's inbox may have dropped it."
    font.family: Theme.caption; font.pixelSize: 16; color: "#ffffff"
  }

  Text {
    anchors.bottom: parent.bottom; anchors.bottomMargin: 18; anchors.horizontalCenter: parent.horizontalCenter
    width: Math.min(implicitWidth, parent.width - 48)
    elide: Text.ElideMiddle
    text: preview.open ? (preview.what.name ?? "") + (preview.kind === "pdf" && preview.pages > 0 ? "  ·  page " + preview.page + " of " + preview.pages : "") : ""
    font.family: Theme.caption; font.pixelSize: 15; color: "#ffffff"
  }

  Row {
    anchors.top: parent.top; anchors.topMargin: 16; anchors.right: parent.right; anchors.rightMargin: 16
    spacing: 10
    Button { objectName: "previous"; label: "‹"; visible: preview.paging; dim: preview.page <= 1; onClicked: preview.previous() }
    Button { objectName: "next"; label: "›"; visible: preview.paging; dim: preview.page >= preview.pages; onClicked: preview.next() }
    Button { objectName: "external"; label: "open in browser"; onClicked: preview.external(preview.what.url) }
    Button { objectName: "close"; label: "✕"; onClicked: preview.close() }
  }

  component Button: Rectangle {
    id: button
    property string label: ""
    property bool dim: false
    signal clicked()
    width: text.implicitWidth + 28
    height: 34
    radius: 17
    color: "#ffffff"
    opacity: dim ? 0.4 : area.containsMouse ? 1 : 0.88
    Text {
      id: text
      anchors.centerIn: parent
      text: button.label
      font.family: Theme.caption; font.weight: Font.Bold; font.pixelSize: 14; color: Theme.ink
    }
    MouseArea { id: area; anchors.fill: parent; hoverEnabled: true; cursorShape: Qt.PointingHandCursor; onClicked: button.clicked() }
  }
}
