// Settings page.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORS = ['#ff4d6d', '#ff8a3d', '#ffd23f', '#3ddc97', '#27c3ff', '#7c6cff', '#e15bff', '#ff5fa2'];
  const HOTKEY_GROUPS = [
    ['Playback', [['toggle', 'Play / pause'], ['next', 'Next song'], ['prev', 'Previous song'], ['like', 'Like song']]],
    ['Volume', [['volUp', 'Volume up'], ['volDown', 'Volume down']]],
    ['Windows', [['showFull', 'Show / hide full player'], ['toggleMini', 'Show / hide mini player'], ['miniSearch', 'Search from the mini player']]],
    ['Video', [['toggleVideo', 'Video on / off (data saver)']]],
  ];
  const ALL_HOTKEYS = HOTKEY_GROUPS.flatMap(([, list]) => list);
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
  const ago = (t) => {
    if (!t) return 'never';
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} hr ago` : new Date(t).toLocaleDateString();
  };

  window.renderSettings = function renderSettings(root, s, api, { onSaved, toast }) {
    const save = async (patch) => { const n = await api.setSettings(patch); Object.assign(s, n); onSaved(n); return n; };
    const hk = s.hotkeys || {};
    const status = s.hotkeyStatus || {};
    const mediaTaken = Object.entries(status).filter(([k, v]) => k.startsWith('media:') && v !== 'ok');
    const hkRow = ([k, l]) => `<div class="s-row"><div class="lbl">${l}</div><div class="hk-right">
          ${status[k] === 'taken' ? '<span class="hk-status">Used by another app</span>' : ''}
          <button class="kbd-btn ${hk[k] ? '' : 'empty'}" data-hk="${k}">${esc(pretty(hk[k]))}</button>
          <button class="icon-btn small" data-hk-reset="${k}" title="Reset to ${esc(pretty(s.defaults.hotkeys[k]))}">${window.ICONS.sync}</button></div></div>`;
    root.innerHTML = `<div class="settings-inner">
      <h1>Settings</h1><div class="muted">Changes save instantly.</div>

      <h2>Updates</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Wavelength <span id="st-ver">${esc(s.version || '')}</span></div><div class="desc" id="upd-desc">Checkingâ€¦</div></div>
          <div class="upd-box"><div class="upd-bar" id="upd-bar" hidden><i></i></div><button class="btn small" id="upd-btn">Check now</button></div></div>
        <div class="s-row"><div><div class="lbl">Update automatically</div><div class="desc">Downloads new versions quietly in the background (usually just a few MB). Nothing changes until you restart.</div></div>
          <label class="switch"><input type="checkbox" id="st-auto" ${s.autoUpdate !== false ? 'checked' : ''}><span></span></label></div>
      </div>

      <h2>You</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Display name</div><div class="desc">What friends see in listening rooms.</div></div>
          <input class="input" id="st-name" style="width:220px" maxlength="32" value="${esc(s.name)}"></div>
        <div class="s-row"><div><div class="lbl">Your color</div><div class="desc">Tags the songs you add to a room.</div></div>
          <div class="swatches">${COLORS.map((c) => `<button class="swatch ${c === s.color ? 'on' : ''}" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div></div>
      </div>

      <h2>Playback</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Data saver</div><div class="desc">Shows album art instead of music videos and streams at the lowest video quality, so a song uses a fraction of the data. Click <b>Show video</b> on the player or press ${esc(pretty(hk.toggleVideo))} to switch.</div></div>
          <label class="switch"><input type="checkbox" id="st-saver" ${s.dataSaver ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Block ads</div><div class="desc">Removes YouTube Music's audio/video ads, promo banners and trackers, and auto-answers â€œAre you still listening?â€.</div></div>
          <label class="switch"><input type="checkbox" id="st-adblock" ${s.adblock ? 'checked' : ''}><span></span></label></div>
      </div>

      <h2>Mini player</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Show the mini player</div><div class="desc">Floats above every window. It also pops out whenever you minimize or close the full player.</div></div>
          <div class="seg" id="st-mini">${MINI.map(([v, l]) => `<button data-v="${v}" class="${s.miniMode === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="s-row"><div><div class="lbl">Size</div><div class="desc">Or drag the corner of the mini player. Move it by the handle on top.</div></div>
          <input class="range" type="range" id="st-mini-size" min="380" max="960" step="10" value="${s.miniWidth || 468}"></div>
        <div class="s-row"><div><div class="lbl">Position</div><div class="desc">Put it back at the top center of your main screen.</div></div>
          <button class="btn small" id="st-mini-reset">Reset position</button></div>
      </div>

      <h2>Hotkeys</h2>
      <div class="s-card">
        <div class="s-row"><div class="desc">Hotkeys work everywhere, even when Wavelength is hidden or you're in a game. Click a shortcut and press the new keys. Backspace clears it, Esc cancels.</div>
          <button class="btn small" id="hk-reset-all">Reset all</button></div>
        ${HOTKEY_GROUPS.map(([g, list]) => `<div class="kbd-group">${g}</div>${list.map(hkRow).join('')}`).join('')}
        <div class="kbd-group">Keyboard</div>
        <div class="s-row"><div><div class="lbl">Keyboard media keys</div><div class="desc">Use your keyboard's â¯ â­ â® keys. Restart Wavelength after changing.${mediaTaken.length ? ' <span style="color:var(--warn)">Another app is holding some media keys right now.</span>' : ''}</div></div>
          <label class="switch"><input type="checkbox" id="st-media" ${s.mediaKeys ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Inside Wavelength</div><div class="desc"><kbd>/</kbd> or <kbd>Ctrl</kbd> + <kbd>F</kbd> search Â· <kbd>Esc</kbd> close search or settings Â· right-click a song to add it to Up Next</div></div></div>
      </div>

      <h2>Discord bot</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Discord bot</div><div class="desc" id="dc-status">Off</div></div>
          <label class="switch"><input type="checkbox" id="st-dc-on" ${s.discordEnabled ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Bot token</div><div class="desc">From the Discord Developer Portal â†’ your app â†’ Bot â†’ Reset Token. Stays on this PC only.</div></div>
          <div class="hk-right"><input class="input" id="st-dc-token" type="password" style="width:240px" placeholder="paste token" value="${esc(s.discordToken || '')}" spellcheck="false" autocomplete="off">
          <button class="btn small" id="st-dc-show" type="button">Show</button></div></div>
        <div class="s-row"><div><div class="lbl">Server ID</div><div class="desc">Optional. Commands show up instantly in this server (right-click the server â†’ Copy Server ID, with Developer Mode on).</div></div>
          <input class="input" id="st-dc-guild" style="width:240px" placeholder="all servers" value="${esc(s.discordGuildId || '')}" spellcheck="false"></div>
        <div class="s-row"><div><div class="lbl">Bot volume</div><div class="desc">How loud Wavelength plays in the voice channel for everyone. Your own volume and mute don't change it.</div></div>
          <input class="range" type="range" id="st-dc-vol" min="0" max="150" step="5" value="${s.discordVolume ?? 50}"></div>
        <div class="s-row"><div><div class="lbl">Play on this PC</div><div class="desc">Turn off to play only into Discord while the bot is in a voice channel. Muting or turning Wavelength down never affects what Discord hears.</div></div>
          <label class="switch"><input type="checkbox" id="st-dc-local" ${s.discordPlayLocal !== false ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Add the bot to a server</div><div class="desc">Opens Discord's invite page for your bot.</div></div>
          <button class="btn small" id="st-dc-invite" type="button">Add to server</button></div>
        <div class="s-row"><div class="desc">In a voice channel type <kbd>/join</kbd>. Then <kbd>/play</kbd> adds songs, <kbd>/np</kbd> shows controls, <kbd>/queue</kbd>, <kbd>/skip</kbd>, <kbd>/pause</kbd>, <kbd>/resume</kbd>, <kbd>/volume</kbd>, and <kbd>/room start</kbd> Â· <kbd>/room join</kbd> Â· <kbd>/room info</kbd> for listening rooms. Discord hears whatever Wavelength is playing, including a room you're in.</div></div>
      </div>

      <h2>App</h2>
      <div class="s-card">
        <div class="s-row"><div><div class="lbl">Keep playing when I close the window</div><div class="desc">Wavelength stays in the system tray and the mini player pops out. Quit from the tray icon.</div></div>
          <label class="switch"><input type="checkbox" id="st-tray" ${s.closeToTray ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Start with Windows</div><div class="desc">Opens quietly in the tray when you sign in to your PC.</div></div>
          <label class="switch"><input type="checkbox" id="st-login" ${s.openAtLogin ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Google sign-in compatibility</div><div class="desc">Helps Google's sign-in page accept Wavelength. Leave on unless sign-in misbehaves.</div></div>
          <label class="switch"><input type="checkbox" id="st-compat" ${s.signinCompat ? 'checked' : ''}><span></span></label></div>
        <div class="s-row"><div><div class="lbl">Room connection</div><div class="desc">Automatic tries a direct connection, then switches to an encrypted relay when your networks can't connect directly. "Always relay" works on almost any network.</div></div>
          <div class="seg" id="st-transport">${[['auto', 'Automatic'], ['relay', 'Always relay'], ['direct', 'Direct only']].map(([v, l]) => `<button data-v="${v}" class="${(s.roomTransport || 'auto') === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <div class="s-row"><div><div class="lbl">Room server <span class="muted">(advanced)</span></div><div class="desc">Leave blank to use the free public PeerJS server. Everyone in a room must use the same one.</div></div>
          <input class="input" id="st-peer" style="width:220px" placeholder="default" value="${esc(s.peerServer || '')}" spellcheck="false"></div>
      </div>
      <div class="muted" id="st-about" style="margin-top:22px;font-size:12px"></div>
    </div>`;

    const $ = (q) => root.querySelector(q);
    api.info().then((i) => { $('#st-about').textContent = `Wavelength ${i.version} Â· Electron ${i.electron}${i.fromUpdate ? ' Â· updated in place' : ''}`; });

    // ---------------------------------------------------- updates
    function renderUpdateBox(u) {
      const desc = $('#upd-desc'), btn = $('#upd-btn'), bar = $('#upd-bar');
      if (!desc) return;
      bar.hidden = true;
      btn.disabled = false;
      if (!u) { desc.textContent = 'Updates are unavailable.'; return; }
      if (u.ready) {
        desc.textContent = `Version ${u.ready.version} is downloaded and ready.`;
        btn.textContent = 'Restart to update'; btn.classList.add('primary');
        btn.onclick = () => api.applyUpdate();
        return;
      }
      btn.classList.remove('primary');
      btn.textContent = 'Check now';
      btn.onclick = async () => { btn.disabled = true; desc.textContent = 'Checkingâ€¦'; renderUpdateBox(await api.checkUpdate()); };
      if (u.phase === 'checking') { desc.textContent = 'Checking for updatesâ€¦'; btn.disabled = true; }
      else if (u.phase === 'downloading') {
        desc.textContent = `Downloading ${u.version}${u.kind === 'installer' ? ' (full installer)' : ''}â€¦ ${Math.round((u.pct || 0) * 100)}%`;
        bar.hidden = false; bar.firstChild.style.width = `${Math.round((u.pct || 0) * 100)}%`; btn.disabled = true;
      } else if (u.phase === 'error') desc.textContent = `Couldn't check: ${u.error}. Last checked ${ago(u.lastCheck)}.`;
      else desc.textContent = `You're up to date. Last checked ${ago(u.lastCheck)}.`;
    }
    window.__renderUpdateBox = renderUpdateBox;
    api.updateStatus().then(renderUpdateBox);
    $('#st-auto').addEventListener('change', (e) => save({ autoUpdate: e.target.checked }));

    // ---------------------------------------------------- simple settings
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
    let sizeT = null;
    $('#st-mini-size').addEventListener('input', (e) => { clearTimeout(sizeT); sizeT = setTimeout(() => save({ miniWidth: +e.target.value }), 60); });
    $('#st-mini-reset').onclick = async () => { await save({ miniPos: null }); toast('Mini player moved back to the top.'); };
    const bindSwitch = (id, key, after) => $(id).addEventListener('change', async (e) => { await save({ [key]: e.target.checked }); if (after) after(e.target.checked); });
    bindSwitch('#st-media', 'mediaKeys', () => toast('Restart Wavelength to finish switching media keys.'));
    bindSwitch('#st-adblock', 'adblock', (on) => toast(on ? 'Ad blocker on.' : 'Ad blocker off.'));
    bindSwitch('#st-saver', 'dataSaver', (on) => toast(on ? 'Data saver on: album art instead of video.' : 'Data saver off: videos play normally.'));
    bindSwitch('#st-tray', 'closeToTray');
    bindSwitch('#st-login', 'openAtLogin');
    bindSwitch('#st-compat', 'signinCompat');
    $('#st-peer').addEventListener('change', (e) => save({ peerServer: e.target.value.trim() }));
    // ---------------------------------------------------- discord bot
    function renderDiscord(d) {
      const el = $('#dc-status'); if (!el || !d) return;
      const map = {
        off: 'Off. Turn it on to connect the bot.',
        connecting: 'Connecting to Discordâ€¦',
        online: `Online as ${d.tag || 'the bot'}${d.voice ? ` Â· playing in ðŸ”Š ${d.voice}` : ' Â· type /join in a voice channel'}${d.commands ? ` Â· ${d.commands}` : ''}`,
        error: `Not connected: ${d.error || 'unknown error'}`,
      };
      el.textContent = map[d.state] || '';
      el.style.color = d.state === 'online' ? 'var(--ok)' : d.state === 'error' ? 'var(--err)' : '';
      if (d.warning && d.state === 'online') el.textContent += ` Â· ${d.warning}`;
    }
    window.__renderDiscordBox = renderDiscord;
    api.discordStatus().then(renderDiscord);
    $('#st-dc-on').addEventListener('change', async (e) => { await save({ discordEnabled: e.target.checked }); });
    $('#st-dc-local').addEventListener('change', (e) => save({ discordPlayLocal: e.target.checked }));
    $('#st-dc-token').addEventListener('change', async (e) => { await save({ discordToken: e.target.value.trim() }); toast('Bot token saved.'); });
    $('#st-dc-guild').addEventListener('change', (e) => save({ discordGuildId: e.target.value.trim().replace(/\D/g, '') }));
    $('#st-dc-show').onclick = () => { const i = $('#st-dc-token'); const show = i.type === 'password'; i.type = show ? 'text' : 'password'; $('#st-dc-show').textContent = show ? 'Hide' : 'Show'; };
    let dcVolT = null;
    $('#st-dc-vol').addEventListener('input', (e) => { clearTimeout(dcVolT); dcVolT = setTimeout(() => save({ discordVolume: +e.target.value }), 120); });
    $('#st-dc-invite').onclick = async () => {
      const d = await api.discordStatus();
      if (d.invite) api.openExternal(d.invite); else toast('Paste the bot token first.', { error: true });
    };

    $('#st-transport').addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b) return;
      await save({ roomTransport: b.dataset.v });
      root.querySelectorAll('#st-transport button').forEach((x) => x.classList.toggle('on', x === b));
    });

    // ---------------------------------------------------- hotkey recorder
    const rerender = () => { const top = root.scrollTop; renderSettings(root, s, api, { onSaved, toast }); root.scrollTop = top; };
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
      if (clash) toast(`Moved ${pretty(r.accel)} from â€œ${(ALL_HOTKEYS.find((h) => h[0] === clash[0]) || [, clash[0]])[1]}â€.`);
      if (n.hotkeyStatus[key] === 'taken') toast(`${pretty(r.accel)} is already used by another app. Pick a different combo.`, { error: true });
      rerender();
    }
    root.querySelectorAll('[data-hk]').forEach((btn) => btn.addEventListener('click', () => {
      if (recording) stop(recording.btn, pretty(s.hotkeys[recording.key]));
      recording = { btn, key: btn.dataset.hk };
      btn.classList.add('rec'); btn.classList.remove('empty');
      btn.textContent = 'Press keysâ€¦';
      api.suspendHotkeys(true);
      window.addEventListener('keydown', onKey, true);
    }));
    root.querySelectorAll('[data-hk-reset]').forEach((b) => b.addEventListener('click', async () => {
      const k = b.dataset.hkReset;
      await save({ hotkeys: { [k]: s.defaults.hotkeys[k] } });
      rerender();
    }));
    $('#hk-reset-all').onclick = async () => { await save({ hotkeys: { ...s.defaults.hotkeys } }); toast('All hotkeys are back to their defaults.'); rerender(); };
  };
})();
