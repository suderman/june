// Where to deploy WHAT ("pi on cog", "cid on cog"), as the phone's DeployPicker asks it: home, for throwaways and
// chat; a folder where sessions work now or a checkout (board.mjs agentsView places); or one typed in. A pick starts
// it; NOTICE says it is starting, or why it could not.
import QtQuick

Item {
  id: picker
  property string what: ""
  property var places: []
  // { text, busy } from shell.qml's deployNotice.
  property var notice: ({ text: "", busy: false })
  signal picked(string dir)
  signal back()

  function pick(dir) { if (!picker.notice.busy && dir.trim() !== "") picker.picked(dir.trim()); }

  Flickable {
    anchors.fill: parent
    contentHeight: column.implicitHeight + 16
    clip: true
    boundsBehavior: Flickable.StopAtBounds

    Column {
      id: column
      width: parent.width - 4
      spacing: 10

      PressTab { text: (Theme.consoleLook ? "< " : "‹  ") + "back"; kind: "quiet"; small: true; onClicked: picker.back() }
      Column {
        width: parent.width
        Words { width: parent.width; role: "title"; wrapMode: Text.Wrap; text: "deploy " + picker.what; color: Theme.pageInk }
        Words { visible: picker.notice.busy; role: "meta"; text: "starting…"; color: Theme.muted }
        Words { visible: !picker.notice.busy && (picker.notice.text ?? "") !== ""; width: parent.width; role: "meta"; wrapMode: Text.Wrap; text: picker.notice.text ?? ""; color: Theme.accent }
      }
      SectionRule { text: "WHERE" }
      Pad {
        StubRow { first: true; title: "home"; meta: "~ · for throwaways and chat"; onClicked: picker.pick("~") }
        Repeater {
          model: picker.places
          delegate: StubRow {
            required property var modelData
            title: String(modelData).split("/").pop()
            meta: modelData
            onClicked: picker.pick(modelData)
          }
        }
      }
      Item {
        width: parent.width
        height: typed.implicitHeight + 16
        Inked { anchors.fill: parent; lift: 2 }
        RuledField {
          id: typed
          x: 10; y: 6
          width: parent.width - go.width - 30
          label: "Another folder"; placeholder: "~/src/…"; mono: true
        }
        PressTab {
          id: go
          anchors.right: parent.right; anchors.rightMargin: 10; anchors.verticalCenter: parent.verticalCenter
          text: "go"; small: true
          enabled: typed.text.trim() !== "" && !picker.notice.busy
          onClicked: picker.pick(typed.text)
        }
      }
    }
  }
}
