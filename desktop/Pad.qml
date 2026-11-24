// A list on ruled paper: one inked pad holding its rows (StubRow), each ruled off from the one before.
import QtQuick

Item {
  id: pad
  default property alias rows: list.data
  width: parent ? parent.width : 0
  implicitHeight: list.implicitHeight
  Inked { anchors.fill: parent; lift: 2; lineWidth: 1.75 }
  Column { id: list; width: pad.width }
}
