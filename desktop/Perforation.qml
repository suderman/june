// A ticket's tear line across a docket: a dashed rule with a punched notch at each edge, as wide as its parent so the
// notches bite the panel's edge. The console draws a plain dashed rule.
import QtQuick

Item {
  id: perf
  property real notch: 6
  width: parent ? parent.width : 0
  height: notch * 2
  Canvas {
    id: canvas
    x: -perf.notch
    width: perf.width + 2 * perf.notch
    height: perf.height
    onPaint: {
      const ctx = getContext("2d");
      ctx.reset();
      const y = height / 2, r = perf.notch;
      const from = Theme.consoleLook ? r : 2 * r + 4, to = width - from;
      ctx.strokeStyle = Theme.edge;
      ctx.globalAlpha = Theme.consoleLook ? 1 : Theme.neon ? 0.7 : 0.55;
      ctx.lineWidth = 1.5;
      for (let x = from; x < to; x += 9) { ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(Math.min(x + 5, to), y); ctx.stroke(); }
      if (Theme.consoleLook) return;
      ctx.globalAlpha = 1;
      ctx.lineWidth = Theme.neon ? 1.4 : 2;
      for (const x of [r, width - r]) {
        ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fillStyle = Theme.paper; ctx.fill(); ctx.stroke();
      }
    }
    onWidthChanged: requestPaint()
    Connections { target: Theme; function onConsoleLookChanged() { canvas.requestPaint(); } function onDarkChanged() { canvas.requestPaint(); } }
  }
}
