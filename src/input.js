export class InputManager {
  constructor() {
    this.keys = { w: false, a: false, s: false, d: false };
    this.joystick = { x: 0, y: 0 };
    this.actionPressed = false;
    this.deadzone = 0.12;
    this.joystickRadius = 50;

    this.onPause = null;   // Escape
    this.onMuteToggle = null; // M
    this.onChatFocus = null; // Enter
    this.onPowerup1 = null; // 1
    this.onPowerup2 = null; // 2
    this.onPowerup3 = null; // 3

    this.initKeyboard();
    this.initJoystick();
    this.initActionButtons();
  }

  initKeyboard() {
    const keyMap = {
      w: 'w', arrowup: 'w',
      a: 'a', arrowleft: 'a',
      s: 's', arrowdown: 's',
      d: 'd', arrowright: 'd',
    };

    window.addEventListener('keydown', (e) => {
      // Don't hijack input while the user is typing in chat/settings fields
      if (document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
        if (e.code === 'Escape') document.activeElement.blur();
        return;
      }
      const k = keyMap[e.key.toLowerCase()];
      if (k) { this.keys[k] = true; e.preventDefault(); }
      if (e.code === 'Space') { this.actionPressed = true; e.preventDefault(); }
      if (e.code === 'Escape' && this.onPause) this.onPause();
      if ((e.key === 'm' || e.key === 'M') && this.onMuteToggle) this.onMuteToggle();
      if (e.key === 'Enter' && this.onChatFocus) this.onChatFocus();
      if (e.key === '1' && this.onPowerup1) this.onPowerup1();
      if (e.key === '2' && this.onPowerup2) this.onPowerup2();
      if (e.key === '3' && this.onPowerup3) this.onPowerup3();
    });

    window.addEventListener('keyup', (e) => {
      const k = keyMap[e.key.toLowerCase()];
      if (k) this.keys[k] = false;
      if (e.code === 'Space') this.actionPressed = false;
    });

    // Prevent a stuck-key bug when the tab loses focus mid-press
    window.addEventListener('blur', () => {
      this.keys.w = this.keys.a = this.keys.s = this.keys.d = false;
      this.actionPressed = false;
      this.joystick.x = 0; this.joystick.y = 0;
    });
  }

  initJoystick() {
    const zone = document.getElementById('joystick-zone');
    if (!zone) return;

    let isDragging = false;
    let originX = 0;
    let originY = 0;
    let activePointerId = null;

    const base = document.createElement('div');
    base.className = 'joystick-base';
    base.style.display = 'none';
    zone.appendChild(base);

    const stick = document.createElement('div');
    stick.className = 'joystick-stick';
    stick.style.display = 'none';
    zone.appendChild(stick);

    const place = (x, y) => {
      base.style.left = `${x}px`; base.style.top = `${y}px`;
      stick.style.left = `${x}px`; stick.style.top = `${y}px`;
    };

    zone.addEventListener('pointerdown', (e) => {
      if (isDragging) return; // ignore multi-touch on the same zone
      isDragging = true;
      activePointerId = e.pointerId;
      originX = e.clientX;
      originY = e.clientY;
      place(originX, originY);
      base.style.display = 'block';
      stick.style.display = 'block';
      zone.setPointerCapture(e.pointerId);
    });

    zone.addEventListener('pointermove', (e) => {
      if (!isDragging || e.pointerId !== activePointerId) return;

      const dx = e.clientX - originX;
      const dy = e.clientY - originY;
      const distance = Math.min(this.joystickRadius, Math.sqrt(dx * dx + dy * dy));
      const angle = Math.atan2(dy, dx);

      const stickX = originX + Math.cos(angle) * distance;
      const stickY = originY + Math.sin(angle) * distance;
      stick.style.left = `${stickX}px`;
      stick.style.top = `${stickY}px`;

      let nx = (stickX - originX) / this.joystickRadius;
      let ny = (stickY - originY) / this.joystickRadius;
      const mag = Math.sqrt(nx * nx + ny * ny);
      if (mag < this.deadzone) { nx = 0; ny = 0; }
      this.joystick.x = nx;
      this.joystick.y = ny;
    });

    const release = (e) => {
      if (!isDragging || (e && e.pointerId !== activePointerId)) return;
      isDragging = false;
      activePointerId = null;
      base.style.display = 'none';
      stick.style.display = 'none';
      this.joystick.x = 0;
      this.joystick.y = 0;
      try { zone.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    };

    zone.addEventListener('pointerup', release);
    zone.addEventListener('pointercancel', release);
    zone.addEventListener('lostpointercapture', release);
  }

  initActionButtons() {
    const btnAction = document.getElementById('btn-action');
    if (!btnAction) return;
    const press = () => {
      this.actionPressed = true;
      if (navigator.vibrate) navigator.vibrate(15);
    };
    const release = () => { this.actionPressed = false; };
    btnAction.addEventListener('pointerdown', press);
    btnAction.addEventListener('pointerup', release);
    btnAction.addEventListener('pointercancel', release);
    btnAction.addEventListener('pointerleave', release);
  }

  getMovement() {
    let x = this.joystick.x;
    let y = this.joystick.y;

    if (this.keys.w) y -= 1;
    if (this.keys.s) y += 1;
    if (this.keys.a) x -= 1;
    if (this.keys.d) x += 1;

    const len = Math.sqrt(x * x + y * y);
    if (len > 1) { x /= len; y /= len; }

    return { x, y };
  }

  isActionPressed() {
    return this.actionPressed;
  }
}