// A manga screentone: fine halftone dots in TINT at DENSITY (keep it low behind text), ink on paper, the accent or a
// meaning colour in neon, nothing in the console. Clipped to the panel by its parent.
import QtQuick

Canvas {
  id: tone
  property color tint: Theme.neon ? Theme.accent : Theme.edge
  property real density: 0.16
  property real pitch: 3.5
  visible: !Theme.consoleLook
  onPaint: {
    const ctx = getContext("2d");
    ctx.reset();
    ctx.fillStyle = tone.tint;
    ctx.globalAlpha = tone.density;
    const p = tone.pitch, r = p * 0.3;
    for (let row = 0, y = p / 2; y < height; row++, y += p)
      for (let x = (row % 2) * p + p / 2; x < width; x += 2 * p) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
      }
  }
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()
  onTintChanged: requestPaint()
  onDensityChanged: requestPaint()
}
