// Momentum scrolling for the strip: a wheel notch glides and slows instead of jumping a step, and a touchpad scroll
// follows the fingers and coasts on when they lift. QML feeds it wheel events and frame ticks; it returns how far to
// move. Plain JavaScript as QML's engine knows it, tested in test/overlay.test.mjs. Distances add to Flickable's contentY:
// negative moves up, toward the earlier panels, as a wheel turned away from the user does.

// A notch of a mouse wheel is 120 units of angle; each unit adds this much speed, in px/s.
const WHEEL_GAIN = 10;
// How fast a glide or a coast slows: speed falls by e^(−rate·t), so a notch travels gain·120/rate px.
const WHEEL_FRICTION = 7;
const TOUCH_FRICTION = 4;
// A touchpad gesture has ended when no event has come for this long, and the coast begins.
const TOUCH_IDLE_MS = 45;
// Below this speed, px/s, the motion stops.
const REST = 12;
const MAX_SPEED = 9000;
const clampSpeed = (v) => Math.max(-MAX_SPEED, Math.min(MAX_SPEED, v));

export const rest = () => ({ v: 0, touch: false, lastAt: 0, coasting: false });

/**
 * One wheel event. `angleY` is the wheel's angle delta (120 a notch, positive away from the user), `pixelY` a touchpad's
 * pixel delta, 0 if none; `now` is in ms. Returns the new state and a distance to move now (a touchpad's own motion).
 */
export function wheel(state, { angleY = 0, pixelY = 0, now }) {
	if (pixelY !== 0) {
		const dt = Math.max(8, Math.min(100, now - (state.touch ? state.lastAt : now - 16)));
		const speed = (-pixelY / dt) * 1000;
		// Smooth the fingers' speed over the last few events, so a jittery last event does not decide the coast.
		const v = state.touch && !state.coasting ? state.v * 0.6 + speed * 0.4 : speed;
		return { state: { v: clampSpeed(v), touch: true, lastAt: now, coasting: false }, dy: -pixelY };
	}
	// A mouse wheel: no motion now, speed added for the glide; a notch the other way reverses it at once.
	const add = -angleY * WHEEL_GAIN;
	const v = Math.sign(add) !== Math.sign(state.v) && state.v !== 0 ? add : state.v + add;
	return { state: { v: clampSpeed(v), touch: false, lastAt: now, coasting: false }, dy: 0 };
}

/**
 * One frame, `dt` seconds after the last, at `now` ms. Returns the new state, the distance to move, and whether the
 * motion is over. A touchpad gesture moves nothing here until its fingers lift; then it coasts.
 */
export function step(state, dt, now) {
	if (state.touch && !state.coasting) {
		if (now - state.lastAt < TOUCH_IDLE_MS) return { state, dy: 0, done: false };
		state = { v: state.v, touch: true, lastAt: state.lastAt, coasting: true };
	}
	const friction = state.touch ? TOUCH_FRICTION : WHEEL_FRICTION;
	const decay = Math.exp(-friction * dt);
	// Exact distance under exponential decay over the frame, so the glide is the same at any frame rate.
	const dy = (state.v * (1 - decay)) / friction;
	const v = state.v * decay;
	if (Math.abs(v) < REST) return { state: rest(), dy, done: true };
	return { state: { v, touch: state.touch, lastAt: state.lastAt, coasting: state.coasting }, dy, done: false };
}

/** Stop dead, as at the end of the content. */
export const halt = () => rest();

// A page keeps this share of the view, so a few lines carry over as context.
export const PAGE = 0.85;

/**
 * Where a page turn lands: `direction` 1 for the next page (down, toward newer panels), −1 for the previous (up),
 * from `y` in a view `height` tall, kept within `top` and `bottom` (Flickable's contentY range).
 */
export function pageTarget(y, height, top, bottom, direction) {
	return Math.max(top, Math.min(bottom, y + direction * height * PAGE));
}

