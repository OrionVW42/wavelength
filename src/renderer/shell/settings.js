// Settings page.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORS = ['#ff4d6d', '#ff8a3d', '#ffd23f', '#3ddc97', '#27c3ff', '#7c6cff', '#e15bff', '#ff5fa2'];
  const HOTKEYS = [
    ['toggle', 'Play / pause'],
    ['next', 'Next song'],
    ['prev', 'Previous song'],
    ['volUp', 'Volume up'],
    ['volDown', 'Volume down'],
    ['like', 'Like song'],
    ['showFull', 'Show / hide full player'],
    ['toggleMini', 'Show / hide mini player'],
  ];
  const MINI = [['playing', 'While playing'], ['background', 'When window is hidden'], ['always', 'Always'], ['never', 'Never']];

  // KeyboardEvent -> Electron accelerator
  function accelFrom(e) {
    const mods = [];
    if (e.ctrlKey) mods.push('Ctrl');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    const c = e.code;
    let key = null;
    if (/^Key[A-Z]$/.test(c)) key = c.slice(3);
    else if (/^Digit\d$/.test(c)) key = c.slice(5);
    else if (/^F\d{1,2}$/.test(c)) key = c;
    else if (/^Numpad\d$/.test(c)) key = 'num' + c.slice(6);
    else {
      key = ({
        Space: 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
        Enter: 'Enter', Tab: 'Tab', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
        Insert: 'Insert', Delete: 'Delete', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
        BracketRight: ']', Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
        NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
        NumpadDecimal: 'numdec', MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack',
        MediaTrackPrevious: 'MediaPreviousTrack', Pause: 'Pause', ScrollLock: 'Scrolllock',
      })[c] || null;
    }
    if (!key) return null;
    const bare = /^F\d/.test(key) || /^Media/.test(key) || key === 'Pause' || key === 'Scrolllock';
    if (!mods.length && !bare) return { error: 'Add Ctrl, Alt or Shift so it doesn\'t fire while you type.' };
    if (mods.length === 1 && mods[0] === 'Shift' && !bare) return { error: 'Shift alone isn\'t enough. Add Ctrl or Alt.' };
    return { accel: [...mods, key].join('+') };
  }
  const pretty = (a) => (a ? a.replace(/\+/g, ' + ').replace('Super', 'Win') : 'Not set');

  window.renderSettings = function renderSettings(root, s, api, { onSaved, toast }) {
    const save = async (patch) => { const n = await api.setSettings(patch); Object.assign(s, n); onSaved(n); return n; };
    const hk = s.hotkeys || {};
    const status = s.hotkeyStatus || {};
    const mediaTaken = Object.entries(status).filter(([k, v]) => k.startsWith('media:') && v !== 'ok');
    root.innerHTML = `<div class="settings-inner">
      <h1>Settings</h1><div class="muted">Changes save instantly.</div>

      <h2>You</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Display name</div><div class="desc">What friends see in listening rooms.</div></div>
          <input class="input" id="st-name" style="width:220px" maxlength="32" value="${esc(s.name)}"></div>
        <div class="s-row"><div><div class="lbl">Your color</div><div class="desc">Tags the songs you add to a room.</div></div>
          <div class="swatches">${COLORS.map((c) => `<button class="swatch ${c === s.color ? 'on' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div></div>
      </div>

      <h2>Mini player</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Show the mini player</div><div class="desc">Floats above every window at the top of your screen. Drag it anywhere.</div></div>
          <div class="seg" id="st-mini">${MINI.map(([v, l]) => `<button data-v="${v}" class="${s.miniMode === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="s-row"><div><div class="lbl">Position</div><div class="desc">Put it back at the top center of your main screen.</div></div>
          <button class="btn small" id="st-mini-reset">Reset position</button></div>
      </div>

      <h2>Hotkeys</h2>
      <div class="s-card">
        ${HOTKEYS.map(([k, l]) => `<div class="s-row"><div class="lbl">${l}</div><div class="hk-right">
          ${status[k] === 'taken' ? '<span class="hk-status">Used by another app</span>' : ''}
          <button class="kbd-btn ${hk[k] ? '' : 'empty'}" data-hk="${k}">${esc(pretty(hk[k]))}</button>
          <button class="icon-btn small" data-hk-reset="${k}" title="Reset to default">${window.ICONS.sync}</button></div></div>`).join('')}
        <div class="s-row"><div><div class="lbl">Keyboard media keys</div><div class="desc">Use your keyboard's play/pause, next and previous keys. Restart Wavelength after changing.${mediaTaken.length ? ' <span style="color:var(--warn)">Another app is holding some media keys right now.</span>' : ''}</div></div>
          <label class="switch"><input type="checkbox" id="st-media" ${s.mediaKeys ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div class="desc">Click a shortcut, then press the new keys. Backspace clears it, Esc cancels. Hotkeys work everywhere, even in games and full-screen apps.</div></div>
      </div>

      <h2>Playback</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Block ads</div><div class="desc">Removes YouTube Music's audio/video ads, promo banners and trackers, and auto-answers “Are you still listening?”.</div></div>
          <label class="switch"><input type="checkbox" id="st-adblock" ${s.adblock ? 'checked' : ''}><span></span></label></div>
      </div>

      <h2>App</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Keep playing when I close the window</div><div class="desc">Wavelength stays in the system tray. Quit from the tray icon.</div></div>
          <label class="switch"><input type="checkbox" id="st-tray" ${s.closeToTray ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Start with Windows</div><div class="desc">Opens quietly in the tray when you sign in to your PC.</div></div>
          <label class="switch"><input type="checkbox" id="st-login" ${s.openAtLogin ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Google sign-in compatibility</div><div class="desc">Helps Google's sign-in page accept Wavelength. Leave on unless sign-in misbehaves.</div></div>
          <label class="switch"><input type="checkbox" id="st-compat" ${s.signinCompat ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Room server <span class="muted">(advanced)</span></div><div class="desc">Leave blank to use the free public PeerJS server. Everyone in a room must use the same one.</div></div>
          <input class="input" id="st-peer" style="width:220px" placeholder="default" value="${esc(s.peerServer || '')}" spellcheck="false"></div>
      </div>
      <div class="muted" id="st-ver" style="margin-top:22px;font-size:12px"></div>
    </div>`;

    const $ = (q) => root.querySelector(q);
    api.info().then((i) => { $('#st-ver').textContent = `Wavelength ${i.version} · Electron ${i.electron}`; });

    $('#st-name').addEventListener('change', (e) => { const v = e.target.value.trim().slice(0, 32); if (v) save({ name: v }); });
    root.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', async () => {
      await save({ color: b.dataset.c });
      root.querySelectorAll('.swatch').forEach((x) => x.classList.toggle('on', x === b));
    }));
    $('#st-mini').addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      await save({ miniMode: b.dataset.v });
      root.querySelectorAll('#st-mini button').forEach((x) => x.classList.toggle('on', x === b));
    });
    $('#st-mini-reset').onclick = async () => { await save({ miniPos: null }); toast('Mini player moved back to the top.'); };
    const bindSwitch = (id, key, after) => $(id).addEventListener('change', async (e) => { await save({ [key]: e.target.checked }); if (after) after(e.target.checked); });
    bindSwitch('#st-media', 'mediaKeys', () => toast('Restart Wavelength to finish switching media keys.'));
    bindSwitch('#st-adblock', 'adblock', (on) => toast(on ? 'Ad blocker on.' : 'Ad blocker off.'));
    bindSwitch('#st-tray', 'closeToTray');
    bindSwitch('#st-login', 'openAtLogin');
    bindSwitch('#st-compat', 'signinCompat');
    $('#st-peer').addEventListener('change', (e) => save({ peerServer: e.target.value.trim() }));

    // Hotkey recorder
    let recording = null;
    const stop = (btn, label) => {
      recording = null;
      btn.classList.remove('rec');
      btn.textContent = label;
      btn.classList.toggle('empty', label === 'Not set');
      api.suspendHotkeys(false);
      window.removeEventListener('keydown', onKey, true);
    };
    async function onKey(e) {
      if (!recording) return;
      e.preventDefault(); e.stopPropagation();
      const { btn, key } = recording;
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;
      if (e.key === 'Escape') { stop(btn, pretty(s.hotkeys[key])); return; }
      if (e.key === 'Backspace') { await save({ hotkeys: { [key]: '' } }); stop(btn, 'Not set'); return; }
      const r = accelFrom(e);
      if (!r) return;
      if (r.error) { toast(r.error, { error: true }); return; }
      const clash = Object.entries(s.hotkeys).find(([k, v]) => k !== key && v && v.toLowerCase() === r.accel.toLowerCase());
      const patch = { [key]: r.accel };
      if (clash) patch[clash[0]] = '';
      const n = await save({ hotkeys: patch });
      stop(btn, pretty(r.accel));
      if (clash) toast(`Moved ${pretty(r.accel)} from “${HOTKEYS.find((h) => h[0] === clash[0])[1]}”.`);
      if (n.hotkeyStatus[key] === 'taken') toast(`${pretty(r.accel)} is already used by another app. Pick a different combo.`, { error: true });
      renderSettings(root, s, api, { onSaved, toast });
    }
    root.querySelectorAll('[data-hk]').forEach((btn) => btn.addEventListener('click', () => {
      if (recording) stop(recording.btn, pretty(s.hotkeys[recording.key]));
      recording = { btn, key: btn.dataset.hk };
      btn.classList.add('rec'); btn.classList.remove('empty');
      btn.textContent = 'Press keys…';
      api.suspendHotkeys(true);
      window.addEventListener('keydown', onKey, true);
    }));
    root.querySelectorAll('[data-hk-reset]').forEach((b) => b.addEventListener('click', async () => {
      const k = b.dataset.hkReset;
      await save({ hotkeys: { [k]: s.defaults.hotkeys[k] } });
      renderSettings(root, s, api, { onSaved, toast });
    }));
  };
})();
