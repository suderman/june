// June's bridge to libghostty-vt (Ghostty's terminal emulation library, MIT): one emulator per terminal on show. Kotlin
// feeds it the bytes herdr-core sends, reads back a compact snapshot of the viewport to draw, and asks it to encode keys
// for the program's current keyboard modes (kitty or legacy). The snapshot layout follows T3 Code's Android terminal
// (apps/mobile/modules/t3-terminal, MIT, Copyright (c) 2026 T3 Tools Inc.), rewritten for libghostty-vt 1.0's API.
#include <jni.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <vector>

#include <ghostty/vt.h>

namespace {

constexpr uint32_t kMagic = 0x4A54524D;  // "MRTJ" little endian.
constexpr uint16_t kVersion = 1;

enum CellFlag : uint16_t {
  kBold = 1 << 0,
  kItalic = 1 << 1,
  kFaint = 1 << 2,
  kInverse = 1 << 3,
  kInvisible = 1 << 4,
  kStrikethrough = 1 << 5,
  kUnderline = 1 << 7,
  kSelected = 1 << 8,
};

struct Session {
  GhosttyTerminal terminal = nullptr;
  GhosttyRenderState render = nullptr;
  GhosttyRenderStateRowIterator rows = nullptr;
  GhosttyRenderStateRowCells cells = nullptr;
  GhosttyKeyEncoder encoder = nullptr;
  GhosttyKeyEvent key = nullptr;
  GhosttyMouseEncoder mouse = nullptr;
  GhosttyMouseEvent wheel = nullptr;
  uint32_t cell_w = 1, cell_h = 1;
  std::vector<uint8_t> replies;
  std::mutex mutex;
};

Session* From(jlong handle) { return reinterpret_cast<Session*>(static_cast<intptr_t>(handle)); }

jbyteArray Bytes(JNIEnv* env, const uint8_t* data, size_t len) {
  jbyteArray out = env->NewByteArray(static_cast<jsize>(len));
  if (out != nullptr && len > 0) env->SetByteArrayRegion(out, 0, static_cast<jsize>(len), reinterpret_cast<const jbyte*>(data));
  return out;
}

jbyteArray Drain(JNIEnv* env, Session* s) {
  jbyteArray out = Bytes(env, s->replies.data(), s->replies.size());
  s->replies.clear();
  return out;
}

void OnWrite(GhosttyTerminal, void* userdata, const uint8_t* data, size_t len) {
  auto* s = static_cast<Session*>(userdata);
  if (s != nullptr && data != nullptr) s->replies.insert(s->replies.end(), data, data + len);
}

GhosttyColorRgb Rgb(jint argb) {
  auto v = static_cast<uint32_t>(argb);
  return {static_cast<uint8_t>(v >> 16), static_cast<uint8_t>(v >> 8), static_cast<uint8_t>(v)};
}

uint32_t Argb(GhosttyColorRgb c) { return 0xFF000000U | (uint32_t(c.r) << 16) | (uint32_t(c.g) << 8) | c.b; }

GhosttyColorRgb Blend(GhosttyColorRgb a, GhosttyColorRgb b, uint8_t w) {
  auto mix = [w](uint8_t x, uint8_t y) { return static_cast<uint8_t>((x * w + y * (255 - w)) / 255); };
  return {mix(a.r, b.r), mix(a.g, b.g), mix(a.b, b.b)};
}

void Utf8(std::vector<uint8_t>* out, uint32_t cp) {
  if (cp <= 0x7F) {
    out->push_back(static_cast<uint8_t>(cp));
  } else if (cp <= 0x7FF) {
    out->push_back(static_cast<uint8_t>(0xC0 | (cp >> 6)));
    out->push_back(static_cast<uint8_t>(0x80 | (cp & 0x3F)));
  } else if (cp <= 0xFFFF) {
    out->push_back(static_cast<uint8_t>(0xE0 | (cp >> 12)));
    out->push_back(static_cast<uint8_t>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<uint8_t>(0x80 | (cp & 0x3F)));
  } else if (cp <= 0x10FFFF) {
    out->push_back(static_cast<uint8_t>(0xF0 | (cp >> 18)));
    out->push_back(static_cast<uint8_t>(0x80 | ((cp >> 12) & 0x3F)));
    out->push_back(static_cast<uint8_t>(0x80 | ((cp >> 6) & 0x3F)));
    out->push_back(static_cast<uint8_t>(0x80 | (cp & 0x3F)));
  }
}

struct Writer {
  std::vector<uint8_t> b;
  void U8(uint8_t v) { b.push_back(v); }
  void U16(uint16_t v) { U8(uint8_t(v)); U8(uint8_t(v >> 8)); }
  void U32(uint32_t v) { U16(uint16_t(v)); U16(uint16_t(v >> 16)); }
};

void Free(Session* s) {
  if (s == nullptr) return;
  ghostty_mouse_event_free(s->wheel);
  ghostty_mouse_encoder_free(s->mouse);
  ghostty_key_event_free(s->key);
  ghostty_key_encoder_free(s->encoder);
  ghostty_render_state_row_cells_free(s->cells);
  ghostty_render_state_row_iterator_free(s->rows);
  ghostty_render_state_free(s->render);
  ghostty_terminal_free(s->terminal);
  delete s;
}

}  // namespace

extern "C" JNIEXPORT jlong JNICALL Java_net_suderman_june_TerminalBridge_nativeCreate(
    JNIEnv* env, jclass, jint cols, jint rows, jint cell_w, jint cell_h, jint fg, jint bg, jint cursor, jintArray palette) {
  auto* s = new Session();
  if (ghostty_terminal_new(nullptr, &s->terminal, uint16_t(std::clamp(cols, 1, 1000)), uint16_t(std::clamp(rows, 1, 1000))) != GHOSTTY_SUCCESS ||
      ghostty_render_state_new(nullptr, &s->render) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_iterator_new(nullptr, &s->rows) != GHOSTTY_SUCCESS ||
      ghostty_render_state_row_cells_new(nullptr, &s->cells) != GHOSTTY_SUCCESS ||
      ghostty_key_encoder_new(nullptr, &s->encoder) != GHOSTTY_SUCCESS ||
      ghostty_key_event_new(nullptr, &s->key) != GHOSTTY_SUCCESS ||
      ghostty_mouse_encoder_new(nullptr, &s->mouse) != GHOSTTY_SUCCESS ||
      ghostty_mouse_event_new(nullptr, &s->wheel) != GHOSTTY_SUCCESS) {
    Free(s);
    return 0;
  }
  ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_USERDATA, s);
  ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_WRITE_PTY, reinterpret_cast<const void*>(OnWrite));
  size_t lines = 10000;
  ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_LINES, &lines);
  GhosttyColorRgb f = Rgb(fg), b = Rgb(bg), c = Rgb(cursor);
  ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_COLOR_FOREGROUND, &f);
  ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_COLOR_BACKGROUND, &b);
  ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_COLOR_CURSOR, &c);
  // The first colours of the 256 from PALETTE (the desktop terminal's 16), the rest Ghostty's defaults.
  GhosttyColorRgb colors[256];
  if (palette != nullptr && ghostty_terminal_get(s->terminal, GHOSTTY_TERMINAL_DATA_COLOR_PALETTE_DEFAULT, colors) == GHOSTTY_SUCCESS) {
    jsize n = std::min<jsize>(env->GetArrayLength(palette), 256);
    std::vector<jint> given(static_cast<size_t>(n));
    env->GetIntArrayRegion(palette, 0, n, given.data());
    for (jsize i = 0; i < n; i++) colors[i] = Rgb(given[static_cast<size_t>(i)]);
    ghostty_terminal_set(s->terminal, GHOSTTY_TERMINAL_OPT_COLOR_PALETTE, colors);
  }
  s->cell_w = uint32_t(std::max(cell_w, 1));
  s->cell_h = uint32_t(std::max(cell_h, 1));
  ghostty_terminal_resize(s->terminal, uint16_t(std::clamp(cols, 1, 1000)), uint16_t(std::clamp(rows, 1, 1000)), s->cell_w, s->cell_h);
  return static_cast<jlong>(reinterpret_cast<intptr_t>(s));
}

extern "C" JNIEXPORT void JNICALL Java_net_suderman_june_TerminalBridge_nativeDestroy(JNIEnv*, jclass, jlong h) { Free(From(h)); }

// Feed program output; returns the emulator's own replies to send back (as AUTOMATIC_INPUT).
extern "C" JNIEXPORT jbyteArray JNICALL Java_net_suderman_june_TerminalBridge_nativeFeed(JNIEnv* env, jclass, jlong h, jbyteArray data, jint len) {
  auto* s = From(h);
  if (s == nullptr || data == nullptr) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(s->mutex);
  std::vector<uint8_t> bytes(static_cast<size_t>(len));
  env->GetByteArrayRegion(data, 0, len, reinterpret_cast<jbyte*>(bytes.data()));
  ghostty_terminal_vt_write(s->terminal, bytes.data(), bytes.size());
  return Drain(env, s);
}

extern "C" JNIEXPORT void JNICALL Java_net_suderman_june_TerminalBridge_nativeResize(JNIEnv*, jclass, jlong h, jint cols, jint rows, jint cell_w, jint cell_h) {
  auto* s = From(h);
  if (s == nullptr) return;
  std::lock_guard<std::mutex> lock(s->mutex);
  s->cell_w = uint32_t(std::max(cell_w, 1));
  s->cell_h = uint32_t(std::max(cell_h, 1));
  ghostty_terminal_resize(s->terminal, uint16_t(std::clamp(cols, 1, 1000)), uint16_t(std::clamp(rows, 1, 1000)), uint32_t(std::max(cell_w, 1)), uint32_t(std::max(cell_h, 1)));
}

extern "C" JNIEXPORT void JNICALL Java_net_suderman_june_TerminalBridge_nativeScroll(JNIEnv*, jclass, jlong h, jint delta) {
  auto* s = From(h);
  if (s == nullptr) return;
  std::lock_guard<std::mutex> lock(s->mutex);
  GhosttyTerminalScrollViewport sv{};
  if (delta == 0) {
    sv.tag = GHOSTTY_TERMINAL_SCROLL_VIEWPORT_BOTTOM;
  } else {
    sv.tag = GHOSTTY_TERMINAL_SCROLL_VIEWPORT_DELTA;
    sv.value.delta = delta;
  }
  ghostty_terminal_scroll_viewport(s->terminal, sv);
}

// A drag of ROWS rows at cell (COL, ROW), negative toward older lines, as a terminal's scroll wheel: wheel events when
// the program asked for the mouse, arrow keys in the alternate screen (which has no history), else the local history.
// Returns the bytes to send the program, empty when the history moved here.
extern "C" JNIEXPORT jbyteArray JNICALL Java_net_suderman_june_TerminalBridge_nativeWheel(JNIEnv* env, jclass, jlong h, jint rows, jint col, jint row) {
  auto* s = From(h);
  if (s == nullptr || rows == 0) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(s->mutex);
  std::vector<uint8_t> out;
  uint8_t buf[64];
  size_t written = 0;
  const int count = std::min(std::abs(rows), 50);
  bool tracking = false;
  ghostty_terminal_get(s->terminal, GHOSTTY_TERMINAL_DATA_MOUSE_TRACKING, &tracking);
  if (tracking) {
    uint16_t cols = 0, height = 0;
    ghostty_terminal_get(s->terminal, GHOSTTY_TERMINAL_DATA_COLS, &cols);
    ghostty_terminal_get(s->terminal, GHOSTTY_TERMINAL_DATA_ROWS, &height);
    ghostty_mouse_encoder_set_from_terminal(s->mouse, s->terminal);
    GhosttyMouseEncoderSize size = GHOSTTY_INIT_SIZED(GhosttyMouseEncoderSize);
    size.screen_width = uint32_t(cols) * s->cell_w;
    size.screen_height = uint32_t(height) * s->cell_h;
    size.cell_width = s->cell_w;
    size.cell_height = s->cell_h;
    ghostty_mouse_encoder_set(s->mouse, GHOSTTY_MOUSE_ENCODER_OPT_SIZE, &size);
    ghostty_mouse_event_set_action(s->wheel, GHOSTTY_MOUSE_ACTION_PRESS);
    ghostty_mouse_event_set_button(s->wheel, rows < 0 ? GHOSTTY_MOUSE_BUTTON_FOUR : GHOSTTY_MOUSE_BUTTON_FIVE);
    ghostty_mouse_event_set_mods(s->wheel, 0);
    ghostty_mouse_event_set_position(s->wheel, GhosttyMousePosition{float(col) * s->cell_w + 1.0f, float(row) * s->cell_h + 1.0f});
    for (int i = 0; i < count; i++)
      if (ghostty_mouse_encoder_encode(s->mouse, s->wheel, buf, sizeof(buf), &written) == GHOSTTY_SUCCESS) out.insert(out.end(), buf, buf + written);
    return Bytes(env, out.data(), out.size());
  }
  GhosttyTerminalScreen screen = GHOSTTY_TERMINAL_SCREEN_PRIMARY;
  ghostty_terminal_get(s->terminal, GHOSTTY_TERMINAL_DATA_ACTIVE_SCREEN, &screen);
  if (screen == GHOSTTY_TERMINAL_SCREEN_ALTERNATE) {
    ghostty_key_encoder_set_from_terminal(s->encoder, s->terminal);
    ghostty_key_event_set_action(s->key, GHOSTTY_KEY_ACTION_PRESS);
    ghostty_key_event_set_key(s->key, rows < 0 ? GHOSTTY_KEY_ARROW_UP : GHOSTTY_KEY_ARROW_DOWN);
    ghostty_key_event_set_mods(s->key, 0);
    ghostty_key_event_set_utf8(s->key, GhosttyString{reinterpret_cast<const uint8_t*>(""), 0});
    ghostty_key_event_set_unshifted_codepoint(s->key, 0);
    for (int i = 0; i < count; i++)
      if (ghostty_key_encoder_encode(s->encoder, s->key, buf, sizeof(buf), &written) == GHOSTTY_SUCCESS) out.insert(out.end(), buf, buf + written);
    return Bytes(env, out.data(), out.size());
  }
  GhosttyTerminalScrollViewport sv{};
  sv.tag = GHOSTTY_TERMINAL_SCROLL_VIEWPORT_DELTA;
  sv.value.delta = rows;
  ghostty_terminal_scroll_viewport(s->terminal, sv);
  return env->NewByteArray(0);
}

// The screen and its history as plain text, soft-wrapped lines joined, for copying.
extern "C" JNIEXPORT jbyteArray JNICALL Java_net_suderman_june_TerminalBridge_nativeText(JNIEnv* env, jclass, jlong h) {
  auto* s = From(h);
  if (s == nullptr) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(s->mutex);
  GhosttyFormatter f = nullptr;
  if (ghostty_formatter_terminal_new(nullptr, &f, s->terminal) != GHOSTTY_SUCCESS) return env->NewByteArray(0);
  bool yes = true;
  ghostty_formatter_set(f, GHOSTTY_FORMATTER_OPT_UNWRAP, &yes);
  ghostty_formatter_set(f, GHOSTTY_FORMATTER_OPT_TRIM, &yes);
  uint8_t* buf = nullptr;
  size_t len = 0;
  jbyteArray out = env->NewByteArray(0);
  if (ghostty_formatter_format_alloc(f, nullptr, &buf, &len) == GHOSTTY_SUCCESS && buf != nullptr) {
    out = Bytes(env, buf, len);
    ghostty_free(nullptr, buf, len);
  }
  ghostty_formatter_free(f);
  return out;
}

// TEXT pasted: control bytes made safe, and bracketed when the program asked for bracketed paste.
extern "C" JNIEXPORT jbyteArray JNICALL Java_net_suderman_june_TerminalBridge_nativePaste(JNIEnv* env, jclass, jlong h, jbyteArray text) {
  auto* s = From(h);
  if (s == nullptr || text == nullptr) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(s->mutex);
  jsize n = env->GetArrayLength(text);
  std::vector<char> data(static_cast<size_t>(n));
  env->GetByteArrayRegion(text, 0, n, reinterpret_cast<jbyte*>(data.data()));
  GhosttyTerminalModeConfig mode{GHOSTTY_MODE_BRACKETED_PASTE, false};
  ghostty_terminal_get(s->terminal, GHOSTTY_TERMINAL_DATA_MODE, &mode);
  size_t needed = 0;
  ghostty_paste_encode(data.data(), data.size(), mode.value, nullptr, 0, &needed);
  std::vector<uint8_t> out(needed);
  size_t written = 0;
  if (ghostty_paste_encode(data.data(), data.size(), mode.value, out.data(), out.size(), &written) != GHOSTTY_SUCCESS) return env->NewByteArray(0);
  return Bytes(env, out.data(), written);
}

// A key for the program's current modes: KEY is a GhosttyKey, MODS GhosttyMods, TEXT what it types (may be empty).
extern "C" JNIEXPORT jbyteArray JNICALL Java_net_suderman_june_TerminalBridge_nativeKey(
    JNIEnv* env, jclass, jlong h, jint key, jint mods, jstring text, jint unshifted) {
  auto* s = From(h);
  if (s == nullptr) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(s->mutex);
  const char* utf = text != nullptr ? env->GetStringUTFChars(text, nullptr) : nullptr;
  ghostty_key_encoder_set_from_terminal(s->encoder, s->terminal);
  ghostty_key_event_set_action(s->key, GHOSTTY_KEY_ACTION_PRESS);
  ghostty_key_event_set_key(s->key, static_cast<GhosttyKey>(key));
  ghostty_key_event_set_mods(s->key, static_cast<GhosttyMods>(mods));
  ghostty_key_event_set_consumed_mods(s->key, 0);
  ghostty_key_event_set_utf8(s->key, GhosttyString{reinterpret_cast<const uint8_t*>(utf != nullptr ? utf : ""), utf != nullptr ? strlen(utf) : 0});
  ghostty_key_event_set_unshifted_codepoint(s->key, static_cast<uint32_t>(unshifted));
  uint8_t buf[128];
  size_t written = 0;
  GhosttyResult r = ghostty_key_encoder_encode(s->encoder, s->key, buf, sizeof(buf), &written);
  // The event keeps a pointer to the text: clear it before the string goes.
  ghostty_key_event_set_utf8(s->key, GhosttyString{reinterpret_cast<const uint8_t*>(""), 0});
  if (utf != nullptr) env->ReleaseStringUTFChars(text, utf);
  return r == GHOSTTY_SUCCESS ? Bytes(env, buf, written) : env->NewByteArray(0);
}

// The viewport: header, then per cell fg u32, bg u32, flags u16, text length u16, UTF-8 text.
extern "C" JNIEXPORT jbyteArray JNICALL Java_net_suderman_june_TerminalBridge_nativeSnapshot(JNIEnv* env, jclass, jlong h) {
  auto* s = From(h);
  if (s == nullptr) return env->NewByteArray(0);
  std::lock_guard<std::mutex> lock(s->mutex);
  if (ghostty_render_state_update(s->render, s->terminal) != GHOSTTY_SUCCESS) return env->NewByteArray(0);
  uint16_t cols = 0, rows = 0;
  ghostty_render_state_get(s->render, GHOSTTY_RENDER_STATE_DATA_COLS, &cols);
  ghostty_render_state_get(s->render, GHOSTTY_RENDER_STATE_DATA_ROWS, &rows);
  GhosttyRenderStateCursor cursor = GHOSTTY_INIT_SIZED(GhosttyRenderStateCursor);
  ghostty_render_state_get(s->render, GHOSTTY_RENDER_STATE_DATA_CURSOR, &cursor);
  GhosttyRenderStateColors colors = GHOSTTY_INIT_SIZED(GhosttyRenderStateColors);
  ghostty_render_state_get(s->render, GHOSTTY_RENDER_STATE_DATA_COLORS, &colors);
  Writer w;
  w.b.reserve(32 + size_t(cols) * rows * 13);
  w.U32(kMagic);
  w.U16(kVersion);
  w.U16(cols);
  w.U16(rows);
  bool shown = cursor.visible && cursor.viewport_has_value;
  w.U16(shown ? cursor.viewport_x : 0xFFFF);
  w.U16(shown ? cursor.viewport_y : 0xFFFF);
  w.U8(shown ? 1 : 0);
  w.U8(static_cast<uint8_t>(cursor.visual_style));
  w.U8(cursor.blinking ? 1 : 0);
  w.U8(0);
  w.U32(Argb(colors.foreground));
  w.U32(Argb(colors.background));
  w.U32(Argb(colors.cursor_has_value ? colors.cursor : colors.foreground));
  ghostty_render_state_get(s->render, GHOSTTY_RENDER_STATE_DATA_ROW_ITERATOR, &s->rows);
  uint32_t cps[32];
  std::vector<uint8_t> text;
  uint16_t y = 0;
  while (y < rows && ghostty_render_state_row_iterator_next(s->rows)) {
    ghostty_render_state_row_get(s->rows, GHOSTTY_RENDER_STATE_ROW_DATA_CELLS, &s->cells);
    uint16_t x = 0;
    while (x < cols && ghostty_render_state_row_cells_next(s->cells)) {
      GhosttyStyle style{};
      ghostty_render_state_row_cells_get(s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_STYLE, &style);
      bool selected = false;
      ghostty_render_state_row_cells_get(s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_SELECTED, &selected);
      GhosttyColorRgb fg = colors.foreground, bg = colors.background;
      if (ghostty_render_state_row_cells_get(s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_FG_COLOR, &fg) != GHOSTTY_SUCCESS) fg = colors.foreground;
      if (ghostty_render_state_row_cells_get(s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_BG_COLOR, &bg) != GHOSTTY_SUCCESS) bg = colors.background;
      uint16_t flags = 0;
      if (style.flags & GHOSTTY_STYLE_FLAG_BOLD) flags |= kBold;
      if (style.flags & GHOSTTY_STYLE_FLAG_ITALIC) flags |= kItalic;
      if (style.flags & GHOSTTY_STYLE_FLAG_FAINT) flags |= kFaint;
      if (style.flags & GHOSTTY_STYLE_FLAG_INVISIBLE) flags |= kInvisible;
      if (style.flags & GHOSTTY_STYLE_FLAG_STRIKETHROUGH) flags |= kStrikethrough;
      if (GHOSTTY_STYLE_UNDERLINE(style) != 0) flags |= kUnderline;
      if (selected) flags |= kSelected;
      if (style.flags & GHOSTTY_STYLE_FLAG_INVERSE) {
        std::swap(fg, bg);
        flags |= kInverse;
      }
      if (style.flags & GHOSTTY_STYLE_FLAG_FAINT) fg = Blend(fg, bg, 155);
      text.clear();
      uint32_t n = 0;
      ghostty_render_state_row_cells_get(s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_LEN, &n);
      if (n > 0) {
        GhosttyCodepointBuffer buf{cps, 32, 0};
        if (ghostty_render_state_row_cells_get(s->cells, GHOSTTY_RENDER_STATE_ROW_CELLS_DATA_GRAPHEMES_BUF, &buf) == GHOSTTY_SUCCESS)
          for (size_t i = 0; i < std::min<size_t>(buf.len, 32); i++) Utf8(&text, cps[i]);
      }
      w.U32(Argb(fg));
      w.U32(Argb(bg));
      w.U16(flags);
      w.U16(static_cast<uint16_t>(text.size()));
      w.b.insert(w.b.end(), text.begin(), text.end());
      ++x;
    }
    for (; x < cols; ++x) {
      w.U32(Argb(colors.foreground));
      w.U32(Argb(colors.background));
      w.U16(0);
      w.U16(0);
    }
    ++y;
  }
  for (; y < rows; ++y)
    for (uint16_t x = 0; x < cols; ++x) {
      w.U32(Argb(colors.foreground));
      w.U32(Argb(colors.background));
      w.U16(0);
      w.U16(0);
    }
  return Bytes(env, w.b.data(), w.b.size());
}
