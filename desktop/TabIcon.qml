// One of June's five Muse-style navigation icons drawn on a 24-unit grid, matching the phone's Boards.kt tabIcon:
// terminal (command prompt), agents (robot head), chat (speech bubble), projects (checkbox), editor (pen on paper).
import QtQuick

Canvas {
  id: icon

  property string kind: "chat"
  property bool on: false
  property color ink: Theme.muted
  property color paper: Theme.paper

  implicitWidth: 24
  implicitHeight: 24
  width: 24
  height: 24

  onKindChanged: requestPaint()
  onOnChanged: requestPaint()
  onInkChanged: requestPaint()
  onPaperChanged: requestPaint()
  onWidthChanged: requestPaint()
  onHeightChanged: requestPaint()

  onPaint: {
    const ctx = getContext("2d");
    ctx.reset();
    const s = Math.min(width, height) / 24;
    ctx.scale(s, s);
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    const roundBox = (l, t, r, b, rad, fill) => {
      ctx.beginPath();
      ctx.moveTo(l + rad, t);
      ctx.lineTo(r - rad, t);
      ctx.arcTo(r, t, r, t + rad, rad);
      ctx.lineTo(r, b - rad);
      ctx.arcTo(r, b, r - rad, b, rad);
      ctx.lineTo(l + rad, b);
      ctx.arcTo(l, b, l, b - rad, rad);
      ctx.lineTo(l, t + rad);
      ctx.arcTo(l, t, l + rad, t, rad);
      ctx.closePath();
      if (fill) { ctx.fillStyle = icon.ink; ctx.fill(); }
      else { ctx.strokeStyle = icon.ink; ctx.stroke(); }
    };

    const poly = (col, pts) => {
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.strokeStyle = col;
      ctx.stroke();
    };

    const dot = (col, cx, cy, r) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.fill();
    };

    if (icon.kind === "terminal") {
      roundBox(2.5, 4.5, 21.5, 19.5, 2.5, false);
      poly(icon.ink, [6.5, 9, 9.5, 12, 6.5, 15]);
      poly(icon.ink, [11.5, 15, 16.5, 15]);
    } else if (icon.kind === "agents") {
      poly(icon.ink, [12, 6, 12, 4]);
      dot(icon.ink, 12, 2.9, 1.3);
      poly(icon.ink, [2.4, 10.5, 2.4, 14.5]);
      poly(icon.ink, [21.6, 10.5, 21.6, 14.5]);
      roundBox(4.5, 6, 19.5, 19.5, 3.5, icon.on);
      const face = icon.on ? icon.paper : icon.ink;
      dot(face, 9, 11.6, 1.5);
      dot(face, 15, 11.6, 1.5);
      poly(face, [9.5, 15.6, 14.5, 15.6]);
    } else if (icon.kind === "chat") {
      const a0 = Math.atan2(4.21 / 7, -7.19 / 9);
      const a1 = Math.atan2(6.76 / 7, -2.33 / 9) + Math.PI * 2;
      ctx.beginPath();
      for (let i = 0; i <= 40; i++) {
        const a = a0 + (a1 - a0) * (i / 40);
        const x = 12 + 9 * Math.cos(a), y = 10.5 + 7 * Math.sin(a);
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.lineTo(4, 20.5);
      ctx.closePath();
      if (icon.on) { ctx.fillStyle = icon.ink; ctx.fill(); }
      else { ctx.strokeStyle = icon.ink; ctx.stroke(); }
    } else if (icon.kind === "projects") {
      roundBox(4, 4, 20, 20, 4, icon.on);
      poly(icon.on ? icon.paper : icon.ink, [8, 12.3, 10.9, 15.2, 16.2, 9.2]);
    } else if (icon.kind === "editor") {
      roundBox(3.5, 4.5, 19, 20, 3.5, false);
      poly(icon.ink, [6.8, 8.8, 11.2, 8.8]);
      poly(icon.ink, [6.8, 12.4, 9.5, 12.4]);
      poly(icon.ink, [6.8, 16, 15.7, 16]);
      const pen = () => {
        ctx.beginPath();
        ctx.moveTo(19.14, 4.04);
        ctx.lineTo(21.26, 6.16);
        ctx.lineTo(15.46, 11.96);
        ctx.lineTo(12.3, 13);
        ctx.lineTo(13.34, 9.84);
        ctx.closePath();
      };
      pen();
      ctx.fillStyle = icon.paper;
      ctx.fill();
      ctx.strokeStyle = icon.paper;
      ctx.lineWidth = 3.6;
      ctx.stroke();
      ctx.lineWidth = 1.8;
      pen();
      ctx.strokeStyle = icon.ink;
      ctx.stroke();
      poly(icon.ink, [17.94, 5.24, 20.06, 7.36]);
    }
  }
}
