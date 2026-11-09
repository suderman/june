// A private proof of panels through the checkout's actual Panel.qml, at several widths and lengths. proof-panels.py
// copies this in as shell.qml beside proof-data.mjs.
import QtQuick
import QtQuick.Window
import Quickshell
import "compose.mjs" as Compose
import "scenery.mjs" as Scene
import "proof-data.mjs" as Data

ShellRoot {
  id: root
  readonly property var poses: Compose.readPoses(Data.manifest, Data.artUrl)
  readonly property var scenery: Scene.mergeScenery([Scene.readScenery(Data.manifest, Data.artUrl), Scene.readScenery(Data.baseManifest, Data.baseUrl)])
  readonly property string words: "checking the dependency tool and anything else that was waiting on the same activation. i'll report what actually works, not just whether the switch succeeded."
  function panelData(scene, width) {
    const elements = [];
    for (let b = 0; b < scene.beats; b++) elements.push({ kind: "june", text: root.words + (b % 2 ? " the next thing is the same check on cog." : ""), streaming: false });
    return { id: "proof-" + scene.pose + "-" + scene.side + "-" + scene.beats, side: scene.side, pose: root.poses.find(p => p.id === scene.pose), elements: elements };
  }
  Window {
    id: proof
    visible: true
    width: Data.windowWidth
    height: Data.windowHeight
    Rectangle { anchors.fill: parent; color: "#1b1a1f" }
    Column {
      id: rows
      x: 16; y: 16; spacing: 16
      Repeater {
        model: Data.scenes
        Row {
          id: row
          required property var modelData
          spacing: 16
          Repeater {
            model: Data.widths
            Panel {
              required property int modelData
              width: modelData
              height: implicitHeight
              json: JSON.stringify(root.panelData(row.modelData, modelData))
              poses: root.poses
              scenery: root.scenery
              hourOverride: 12
              newest: false
            }
          }
        }
      }
    }
    Timer {
      interval: 5000; running: true; repeat: false
      onTriggered: {
        for (let i = 0; i < rows.children.length; i++) {
          const row = rows.children[i];
          for (let j = 0; j < (row.children ? row.children.length : 0); j++) {
            const panel = row.children[j];
            if (!panel.layout) continue;
            const l = panel.layout, p = panel.pose;
            console.log("PROOF " + JSON.stringify({ pose: p ? p.id : null, side: panel.p.side, width: l.width, height: l.height, framing: l.framing, illustration: l.illustration, inset: l.clip.inset, desk: l.desk !== null, mirror: l.mirror, ready: panel.presented, art: l.art, clip: l.clip, face: l.face, figure: p ? p.figure : null }));
          }
        }
        proof.contentItem.grabToImage(result => { console.log("SAVED " + result.saveToFile(Data.outputPath)); Qt.exit(0); });
      }
    }
  }
}
