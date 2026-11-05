import QtQuick
import QtQuick.Window
import Quickshell
import "compose.mjs" as Compose
import "scenery.mjs" as Scene
import "proof-data.mjs" as Data

ShellRoot {
  id: root
  readonly property var poses: Compose.readPoses(Data.manifest, Data.stageUrl)
  readonly property var selected: poses.find(p => p.id === Data.poseName)
  readonly property var scenery: Scene.mergeScenery([Scene.readScenery(Data.baseManifest, Data.baseUrl)])

  function panelData(id, framing) {
    return { id: id, side: "left", pose: selected, framing: framing,
      elements: [{ kind: "june", text: "I'm here. What are we working on?", streaming: false }] };
  }

  Window {
    id: proof
    visible: true
    width: 1244
    height: Math.max(desktop.height, phone.height) + 90
    title: "June isolated art proof"
    Rectangle { anchors.fill: parent; color: "#f6f1e7" }
    Text {
      x: 20; y: 12
      text: Data.poseName + ", actual Panel.qml and shared compositor, noon lighting"
      color: "#1b1a1f"
      font.pixelSize: 16
    }
    Row {
      x: 20; y: 46
      spacing: 24
      Column {
        id: desktop
        width: 820
        spacing: 8
        Text { text: "Desktop width, waist framing"; font.pixelSize: 14; color: "#1b1a1f" }
        Panel {
          id: desktopPanel
          width: 820
          height: implicitHeight
          json: JSON.stringify(root.panelData("art-proof-desktop", "waist"))
          poses: root.poses
          scenery: root.scenery
          hourOverride: 12
          newest: false
        }
      }
      Column {
        id: phone
        width: 360
        spacing: 8
        Text { text: "360 px layout, not an Android device test"; font.pixelSize: 14; color: "#1b1a1f" }
        Panel {
          id: phonePanel
          width: 360
          height: implicitHeight
          json: JSON.stringify(root.panelData("art-proof-narrow", undefined))
          poses: root.poses
          scenery: root.scenery
          hourOverride: 12
          newest: false
        }
      }
    }
    Timer {
      interval: 2000
      running: true
      repeat: false
      onTriggered: {
        const info = { desktopReady: desktopPanel.presented, narrowReady: phonePanel.presented,
          desktop: desktopPanel.layout, narrow: phonePanel.layout, poseUrl: root.selected.url };
        console.log("JUNE_PROOF " + JSON.stringify(info));
        if (!info.desktopReady || !info.narrowReady) { Qt.exit(2); return; }
        proof.contentItem.grabToImage(function(result) {
          const ok = result.saveToFile(Data.outputPath);
          console.log("JUNE_PROOF_SAVED " + ok);
          Qt.exit(ok ? 0 : 3);
        });
      }
    }
  }
}
