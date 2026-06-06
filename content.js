(function () {
  'use strict';

  var PLUGIN_PREFIX = '[AudioEffectPlugin]';
  var DEFAULT_API_BASE = 'http://127.0.0.1:6521';

  var AUDIO_EFFECTS = [
    { value: 'none', label: '原声', icon: 'fa-music' },
    { value: 'piano', label: '钢琴', icon: 'fa-music' },
    { value: 'subwoofer', label: '乐器', icon: 'fa-drum' },
    { value: 'ancient', label: '尤克里里', icon: 'fa-guitar' },
    { value: 'surnay', label: '唢呐', icon: 'fa-bullhorn' },
    { value: 'dj', label: 'DJ', icon: 'fa-compact-disc' },
    { value: 'accompaniment', label: '伴奏', icon: 'fa-music' },
  ];

  var VALID_EFFECTS = AUDIO_EFFECTS.map(function (e) { return e.value; }).concat(['climax']);

  var currentEffect = 'none';
  var panelVisible = false;
  var isProcessing = false;
  var _panelToggleTimer = null;
  var autoSkipEnabled = false;
  var climaxModeEnabled = false;
  var switchVersion = 0;
  var lastAppliedSongHash = null;
  var _autoSkipCount = 0;
  var MAX_AUTO_SKIP = 5;
  var _isRestoring = false;

  function log() { var args = Array.prototype.slice.call(arguments); console.log.apply(console, [PLUGIN_PREFIX].concat(args)); }
  function warn() { var args = Array.prototype.slice.call(arguments); console.warn.apply(console, [PLUGIN_PREFIX].concat(args)); }
  function error() { var args = Array.prototype.slice.call(arguments); console.error.apply(console, [PLUGIN_PREFIX].concat(args)); }

  function getApiBaseUrl() {
    try {
      var settingsRaw = localStorage.getItem('settings');
      if (settingsRaw) {
        var settings = JSON.parse(settingsRaw);
        var custom = (settings.apiBaseUrl || '').toString().trim().replace(/\/+$/, '');
        if (custom) {
          if (/^https?:\/\//.test(custom)) return custom;
          warn('自定义API地址格式无效:', custom);
        }
      }
    } catch (e) { warn('读取API地址失败:', e.message); }
    return DEFAULT_API_BASE;
  }

  function getAuthHeaders() {
    try {
      var moeData = JSON.parse(localStorage.getItem('MoeData') || '{}');
      var user = moeData.UserInfo || {};
      var device = moeData.Device || {};
      var parts = [];
      if (user.token) parts.push('token=' + user.token);
      if (user.userid) parts.push('userid=' + user.userid);
      if (device.dfid) parts.push('dfid=' + device.dfid);
      if (user.t1) parts.push('t1=' + user.t1);
      if (device.mid) parts.push('KUGOU_API_MID=' + device.mid);
      if (device.guid) parts.push('KUGOU_API_GUID=' + device.guid);
      if (device.serverDev) parts.push('KUGOU_API_DEV=' + device.serverDev);
      if (device.mac) parts.push('KUGOU_API_MAC=' + device.mac);
      return parts.length > 0 ? { Authorization: parts.join(';') } : {};
    } catch (e) { warn('获取认证头失败:', e.message); return {}; }
  }

  async function apiRequest(method, path, params) {
    if (!params) params = {};
    var baseUrl = getApiBaseUrl();
    var url = new URL(path, baseUrl);
    var headers = Object.assign({ 'Content-Type': 'application/json' }, getAuthHeaders());
    var opts = { method: method, headers: headers, credentials: 'include' };
    if (method === 'POST') {
      // POST 请求参数放在 body 中，不重复添加到 URL
      opts.body = JSON.stringify(params);
    } else {
      // GET 请求参数放在 URL query string 中
      var keys = Object.keys(params);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var v = params[k];
        if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
      }
    }
    log('API', method, '请求:', url.toString());
    var response = await fetch(url.toString(), opts);
    if (!response.ok) throw new Error('HTTP ' + response.status + ' ' + response.statusText);
    return response.json();
  }

  function resolveUrlFromResponse(payload) {
    if (!payload) return null;
    if (typeof payload === 'string') {
      var trimmed = payload.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (Array.isArray(payload)) {
      for (var i = 0; i < payload.length; i++) {
        if (typeof payload[i] === 'string' && payload[i].trim()) return payload[i].trim();
        if (typeof payload[i] === 'object' && payload[i]) {
          var urlFromObj = resolveUrlFromResponse(payload[i]);
          if (urlFromObj) return urlFromObj;
        }
      }
      return null;
    }
    if (typeof payload === 'object') {
      var urlField = payload.url !== undefined ? payload.url
        : payload.play_url !== undefined ? payload.play_url
        : payload.playUrl !== undefined ? payload.playUrl
        : undefined;
      if (urlField !== undefined) {
        var resolved = resolveUrlFromResponse(urlField);
        if (resolved) return resolved;
      }
      if ('data' in payload) {
        var dataResolved = resolveUrlFromResponse(payload.data);
        if (dataResolved) return dataResolved;
      }
      if ('info' in payload) {
        var infoResolved = resolveUrlFromResponse(payload.info);
        if (infoResolved) return infoResolved;
      }
    }
    return null;
  }

  function extractVariants(privilegeData) {
    var variants = [];
    if (!privilegeData || typeof privilegeData !== 'object') return variants;
    var source = privilegeData.data !== undefined ? privilegeData.data : privilegeData;
    var list = Array.isArray(source) ? source : [];
    for (var i = 0; i < list.length; i++) {
      var item = list[i];
      if (!item || typeof item !== 'object') continue;
      if (item.hash && item.quality) {
        variants.push({ hash: item.hash, quality: item.quality, level: item.level });
      }
      var goods = item.relate_goods || item.relateGoods || [];
      if (!Array.isArray(goods)) continue;
      for (var j = 0; j < goods.length; j++) {
        var g = goods[j];
        if (g && g.hash && g.quality) {
          variants.push({ hash: g.hash, quality: g.quality, level: g.level });
        }
      }
    }
    return variants;
  }

  function extractMultiTrackHash(privilegeData) {
    try {
      var source = privilegeData && privilegeData.data !== undefined ? privilegeData.data : privilegeData;
      if (Array.isArray(source) && source.length > 0) {
        var item = source[0];
        var tp = item && (item.trans_param || item.transParam);
        if (tp && tp.hash_multitrack) return tp.hash_multitrack;
      }
      if (privilegeData && privilegeData.trans_param && privilegeData.trans_param.hash_multitrack) {
        return privilegeData.trans_param.hash_multitrack;
      }
    } catch (e) { warn('提取multitrack失败:', e.message); }
    return null;
  }

  function isMkvUrl(url) {
    if (!url) return false;
    return url.toLowerCase().indexOf('.mkv') !== -1;
  }

  function getCurrentSong() {
    try {
      var currentSong = localStorage.getItem('current_song');
      if (currentSong) {
        var song = JSON.parse(currentSong);
        if (song && (song.hash || song.playHash)) return song;
      }
      var musicQueue = localStorage.getItem('MusicQueue');
      if (musicQueue) {
        var data = JSON.parse(musicQueue);
        if (data && data.queue && data.queue.length > 0) return data.queue[0];
      }
    } catch (e) { warn('获取当前歌曲失败:', e.message); }
    return null;
  }

  function getAudioState() {
    return new Promise(function (resolve) {
      var handler = function (e) {
        document.removeEventListener('moe-effect-state-response', handler);
        resolve(e.detail);
      };
      document.addEventListener('moe-effect-state-response', handler);
      document.dispatchEvent(new CustomEvent('moe-effect-get-state'));
      setTimeout(function () {
        document.removeEventListener('moe-effect-state-response', handler);
        resolve(null);
      }, 3000);
    });
  }

  function handleUnsupported(hint) {
    if (autoSkipEnabled) {
      // 自动切歌时保持静音，避免播放无音效歌曲的原声
      _autoSkipCount++;
      if (_autoSkipCount >= MAX_AUTO_SKIP) {
        _autoSkipCount = 0;
        setHint('连续' + MAX_AUTO_SKIP + '首无音效，已暂停播放');
        log('自动切歌已达上限，暂停播放');
        // 达到上限时取消静音，让用户手动操作
        document.dispatchEvent(new CustomEvent('moe-effect-unmute'));
        var audio = document.querySelector('audio');
        if (audio && !audio.paused) audio.pause();
        return;
      }
      setHint(hint + '，自动跳歌 (' + _autoSkipCount + '/' + MAX_AUTO_SKIP + ')...');
      setTimeout(function () { skipToNextSong(); }, 1000);
    } else {
      // 非自动切歌时取消静音，让用户听到原声
      document.dispatchEvent(new CustomEvent('moe-effect-unmute'));
      setHint(hint);
    }
  }

  function injectPageScript() {
    if (document.getElementById('aep-inject-script')) return;
    var script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.id = 'aep-inject-script';
    script.onload = function () { script.remove(); };
    (document.head || document.documentElement).appendChild(script);
    log('注入脚本已加载');
  }

  function injectEffectButton() {
    var extraControls = document.querySelector('.extra-controls');
    if (!extraControls || document.getElementById('aep-btn')) return;

    var btn = document.createElement('button');
    btn.id = 'aep-btn';
    btn.className = 'extra-btn aep-btn';
    btn.title = '音效';
    btn.innerHTML = '<i class="fas fa-sliders-h"></i>';
    btn.addEventListener('click', function (e) { e.stopPropagation(); togglePanel(); });

    var speedBtn = extraControls.querySelector('.playback-speed');
    if (speedBtn && speedBtn.nextSibling) {
      extraControls.insertBefore(btn, speedBtn.nextSibling);
    } else {
      extraControls.appendChild(btn);
    }
    log('音效按钮已注入');
  }

  function togglePanel() {
    if (_panelToggleTimer) return;
    _panelToggleTimer = setTimeout(function () { _panelToggleTimer = null; }, 300);
    var panel = document.getElementById('aep-panel');
    if (panel) { panel.remove(); panelVisible = false; return; }
    panelVisible = true;
    createPanel();
  }

  function createPanel() {
    var panel = document.createElement('div');
    panel.id = 'aep-panel';
    panel.className = 'aep-panel';
    panel.innerHTML = '\
      <div class="aep-panel-header">\
        <span class="aep-panel-title">音效切换</span>\
        <button class="aep-close-btn" id="aep-close">&times;</button>\
      </div>\
      <div class="aep-panel-body">\
        <div class="aep-effect-grid">\
          ' + AUDIO_EFFECTS.map(function (e) {
            return '<button class="aep-effect-item ' + (e.value === currentEffect ? 'active' : '') + '"\
                    data-effect="' + e.value + '" title="' + e.label + '">\
              <i class="fas ' + e.icon + '"></i>\
              <span>' + e.label + '</span>\
            </button>';
          }).join('') + '\
        </div>\
        <div class="aep-toggles-section">\
          <div class="aep-toggle-row">\
            <div class="aep-toggle-info">\
              <span class="aep-toggle-label">高潮模式</span>\
              <span class="aep-toggle-desc">自动播放歌曲高潮片段</span>\
            </div>\
            <label class="aep-capsule-switch">\
              <input type="checkbox" id="aep-climax-mode" ' + (climaxModeEnabled ? 'checked' : '') + ' />\
              <span class="aep-capsule-slider"></span>\
            </label>\
          </div>\
          <div class="aep-toggle-row">\
            <div class="aep-toggle-info">\
              <span class="aep-toggle-label">无音效时自动切歌</span>\
              <span class="aep-toggle-desc">当前歌曲不支持时自动跳过</span>\
            </div>\
            <label class="aep-capsule-switch">\
              <input type="checkbox" id="aep-auto-skip" ' + (autoSkipEnabled ? 'checked' : '') + ' />\
              <span class="aep-capsule-slider"></span>\
            </label>\
          </div>\
        </div>\
        <div class="aep-effect-hint" id="aep-hint"></div>\
      </div>';

    var btn = document.getElementById('aep-btn');
    if (btn) {
      var rect = btn.getBoundingClientRect();
      panel.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
      panel.style.right = (window.innerWidth - rect.right) + 'px';
    }
    document.body.appendChild(panel);
    bindPanelEvents(panel);
  }

  function bindPanelEvents(panel) {
    panel.querySelector('#aep-close').addEventListener('click', function () { panel.remove(); panelVisible = false; });
    panel.querySelectorAll('.aep-effect-item').forEach(function (btn) {
      btn.addEventListener('click', function () { switchEffect(btn.dataset.effect); });
    });
    panel.querySelector('#aep-climax-mode').addEventListener('change', function (e) {
      climaxModeEnabled = e.target.checked;
      saveClimaxMode();
      log('高潮模式开关:', climaxModeEnabled ? '开启' : '关闭');
      if (climaxModeEnabled) {
        switchEffect('climax', true);
      } else if (currentEffect === 'climax') {
        switchEffect('none');
      }
    });
    panel.querySelector('#aep-auto-skip').addEventListener('change', function (e) {
      autoSkipEnabled = e.target.checked;
      saveAutoSkip();
      log('自动跳歌开关:', autoSkipEnabled ? '开启' : '关闭');
    });
    setTimeout(function () {
      document.addEventListener('click', function closePanel(e) {
        if (!panel.contains(e.target) && e.target.id !== 'aep-btn') {
          panel.remove(); panelVisible = false;
          document.removeEventListener('click', closePanel);
        }
      });
    }, 100);
  }

  function updateEffectUI(effect) {
    document.querySelectorAll('.aep-effect-item').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.effect === effect);
    });
    var mainBtn = document.getElementById('aep-btn');
    if (mainBtn) mainBtn.classList.toggle('aep-btn-active', effect !== 'none');
    // 高潮模式开关与 currentEffect 同步
    var climaxSwitch = document.getElementById('aep-climax-mode');
    if (climaxSwitch) climaxSwitch.checked = (effect === 'climax' || climaxModeEnabled);
  }

  var _hintTimer = null;
  function setHint(text) {
    var hint = document.getElementById('aep-hint');
    if (hint) {
      if (_hintTimer) clearTimeout(_hintTimer);
      hint.textContent = text;
      if (text) _hintTimer = setTimeout(function () { if (hint) hint.textContent = ''; _hintTimer = null; }, 5000);
    }
  }

  async function tryGetPlayableUrl(hash, quality, extraParams) {
    var params = { hash: hash };
    if (quality) params.quality = quality;
    if (extraParams && extraParams.ppage_id) params.ppage_id = extraParams.ppage_id;
    log('[旧API] /song/url, hash:', hash.substring(0, 8), 'quality:', quality || '(无)');
    try {
      var data = await apiRequest('GET', '/song/url', params);
      log('[旧API] 响应:', JSON.stringify(data).substring(0, 200));
      var url = resolveUrlFromResponse(data);
      if (url) {
        var isBackup = data.is_hash_backup === 1;
        log('[旧API] URL:', url.substring(0, 80), isMkvUrl(url) ? '[MKV]' : '[可播放]', isBackup ? '[回退原曲]' : '');
        return { url: url, isMkv: isMkvUrl(url), status: data.status, isHashBackup: isBackup };
      }
      return { url: null, isMkv: false, status: data.status, error: data.error };
    } catch (e) {
      warn('[旧API] 请求失败:', e.message);
      return { url: null, isMkv: false, error: e.message };
    }
  }

  async function tryGetUrlNewApi(hash, desiredQuality) {
    var params = { hash: hash, album_audio_id: 0 };
    log('[新API] POST /song/url/new, hash:', hash.substring(0, 8), '目标quality:', desiredQuality || '(全部)');
    try {
      var data = await apiRequest('POST', '/song/url/new', params);
      log('[新API] 响应:', JSON.stringify(data).substring(0, 300));
      return parseNewApiResponse(data, desiredQuality);
    } catch (e) {
      warn('[新API] 请求失败:', e.message);
      return { url: null, isMkv: false, error: e.message };
    }
  }

  function parseNewApiResponse(data, desiredQuality) {
    if (!data) return { url: null, isMkv: false };

    var urlList = null;

    if (data.data && data.data.url) {
      if (Array.isArray(data.data.url)) {
        urlList = data.data.url;
      } else if (typeof data.data.url === 'string' && data.data.url.trim()) {
        var directUrl = data.data.url.trim();
        return { url: directUrl, isMkv: isMkvUrl(directUrl), status: data.status };
      }
    } else if (Array.isArray(data.data)) {
      urlList = data.data;
    }

    if (urlList && desiredQuality) {
      for (var i = 0; i < urlList.length; i++) {
        var item = urlList[i];
        if (item && typeof item === 'object') {
          var itemQuality = item.quality || item.type || '';
          if (itemQuality === desiredQuality) {
            var itemUrl = item.url || item.play_url || item.playUrl || '';
            if (typeof itemUrl === 'string' && itemUrl.trim()) {
              return { url: itemUrl.trim(), isMkv: isMkvUrl(itemUrl), status: data.status };
            }
          }
        }
      }
    }

    if (urlList && !desiredQuality) {
      var url = resolveUrlFromResponse(data);
      if (url) return { url: url, isMkv: isMkvUrl(url), status: data.status };
    }

    return { url: null, isMkv: false, status: data.status, error: data.error || '未找到可用URL' };
  }

  async function fetchClimaxInfo(hash) {
    log('[高潮] 获取高潮信息, hash:', hash.substring(0, 8));
    try {
      var data = await apiRequest('GET', '/song/climax', { hash: hash });
      log('[高潮] 响应:', JSON.stringify(data).substring(0, 300));
      return parseClimaxResponse(data, hash);
    } catch (e) {
      warn('[高潮] 请求失败:', e.message);
      return null;
    }
  }

  function parseClimaxResponse(data, hash) {
    if (!data) return null;

    var climaxData = null;
    if (data.data) {
      if (Array.isArray(data.data)) {
        for (var i = 0; i < data.data.length; i++) {
          if (data.data[i].hash === hash || !data.data[i].hash) { climaxData = data.data[i]; break; }
        }
        if (!climaxData && data.data.length > 0) climaxData = data.data[0];
      } else if (typeof data.data === 'object') {
        climaxData = data.data;
      }
    } else if (typeof data === 'object' && !Array.isArray(data)) {
      climaxData = data;
    }

    if (!climaxData || typeof climaxData !== 'object') return null;

    var startFields = ['climax_start_ms', 'climax_start', 'start_time', 'start'];
    var endFields = ['climax_end_ms', 'climax_end', 'end_time', 'end'];
    var startTime = extractTimeField(climaxData, startFields);
    var endTime = extractTimeField(climaxData, endFields);

    if (endTime > 0 && endTime <= startTime) endTime = 0;
    return startTime > 0 ? { startTime: startTime, endTime: endTime } : null;
  }

  function extractTimeField(data, fields) {
    for (var i = 0; i < fields.length; i++) {
      if (data[fields[i]] != null) {
        var val = Number(data[fields[i]]);
        if (isNaN(val) || val <= 0) continue;
        // 字段名含 _ms 后缀，明确为毫秒
        if (fields[i].indexOf('_ms') !== -1) return val / 1000;
        // 无 _ms 后缀时，用数值判断：> 1000 秒（约16分钟）几乎不可能是秒数，视为毫秒
        if (val > 1000) return val / 1000;
        return val;
      }
    }
    return 0;
  }

  async function checkKtvAvailable(songHash) {
    log('[KTV预检] 检查歌曲是否支持伴奏, hash:', songHash.substring(0, 8));
    try {
      var privilegeData = await apiRequest('GET', '/privilege/lite', { hash: songHash });
      var variants = extractVariants(privilegeData);
      var multiTrackHash = extractMultiTrackHash(privilegeData);

      var hasAccompVariant = false;
      for (var i = 0; i < variants.length; i++) {
        var q = variants[i].quality;
        if (q === 'multitrack' || q === 'acappella' || q === 'accompaniment') {
          hasAccompVariant = true;
          break;
        }
      }

      log('[KTV预检] multitrack:', multiTrackHash ? '有' : '无',
        'acappella变体:', hasAccompVariant ? '有' : '无',
        '总变体数:', variants.length);

      return { available: hasAccompVariant || !!multiTrackHash, variants: variants, multiTrackHash: multiTrackHash };
    } catch (e) {
      warn('[KTV预检] 检查失败:', e.message);
      setHint('网络异常，正在尝试获取伴奏...');
      return { available: true, variants: [], multiTrackHash: null };
    }
  }

  function skipToNextSong() {
    var selectors = [
      '.next-btn', '.btn-next', '.player-next', '.control-next',
      'button[title*="下一"]', 'button[title*="Next"]',
      '.fa-step-forward', '.fa-forward-step',
      '[class*="next"]', '[class*="Next"]'
    ];
    for (var i = 0; i < selectors.length; i++) {
      var btn = document.querySelector(selectors[i]);
      if (btn) { log('找到下一曲按钮:', selectors[i]); btn.click(); return true; }
    }
    var allBtns = document.querySelectorAll('button, [role="button"], .control-btn');
    for (var j = 0; j < allBtns.length; j++) {
      var b = allBtns[j];
      var icon = b.querySelector('i.fa-step-forward, i.fa-forward-step, svg[data-icon="forward-step"]');
      if (icon) { log('通过图标找到下一曲按钮'); b.click(); return true; }
    }
    warn('未找到下一曲按钮');
    return false;
  }

  async function switchEffect(effect, forceApply) {
    if (isProcessing && !forceApply) return;
    if (!forceApply) _autoSkipCount = 0;
    if (!forceApply && effect === currentEffect) effect = 'none';

    // 切换到非高潮音效时，自动关闭高潮模式开关
    if (effect !== 'climax' && climaxModeEnabled) {
      climaxModeEnabled = false;
      saveClimaxMode();
      var climaxSwitch = document.getElementById('aep-climax-mode');
      if (climaxSwitch) climaxSwitch.checked = false;
    }

    currentEffect = effect;
    updateEffectUI(effect);
    document.dispatchEvent(new CustomEvent('moe-effect-set', { detail: { effect: effect } }));

    if (effect === 'none') { setHint(''); lastAppliedSongHash = null; return; }

    setHint(effect === 'accompaniment' ? '正在提取伴奏...' : effect === 'climax' ? '正在获取高潮信息...' : '正在切换音效...');
    isProcessing = true;
    var myVersion = ++switchVersion;

    try {
      var song = getCurrentSong();
      if (!song || (!song.hash && !song.playHash)) {
        setHint('无法获取当前歌曲信息');
        document.dispatchEvent(new CustomEvent('moe-effect-unmute'));
        return;
      }
      var songHash = song.hash || song.playHash;
      log('切换音效:', effect, '歌曲hash:', songHash);
      var audioState = await getAudioState();
      var currentTime = audioState ? audioState.audioCurrentTime : 0;
      // fallback: 从 DOM 直接获取 audio.currentTime
      if (!audioState || currentTime === 0) {
        var domAudio = document.querySelector('audio');
        if (domAudio && domAudio.currentTime > 0) currentTime = domAudio.currentTime;
      }

      if (effect === 'climax') {
        await switchClimax(songHash, currentTime, myVersion);
      } else if (effect === 'accompaniment') {
        await switchAccompaniment(song, songHash, currentTime, myVersion);
      } else {
        await switchMagicEffect(song, songHash, effect, currentTime, myVersion);
      }
    } catch (err) {
      error('切换音效异常:', err);
      setHint('切换失败: ' + err.message);
      document.dispatchEvent(new CustomEvent('moe-effect-unmute'));
    } finally {
      isProcessing = false;
      // 处理期间歌曲可能已切换，检查是否需要重新应用音效（最多重试1次，防止无限递归）
      if (currentEffect !== 'none' && !forceApply) {
        var song = getCurrentSong();
        var newHash = song ? (song.hash || song.playHash) : null;
        if (newHash && newHash !== lastAppliedSongHash) {
          log('处理期间歌曲已切换，重新应用音效:', currentEffect);
          switchEffect(currentEffect, true);
        }
      }
    }
  }

  async function switchClimax(songHash, currentTime, myVersion) {
    var info = await fetchClimaxInfo(songHash);
    if (myVersion !== switchVersion) return;

    if (info && info.startTime > 0) {
      lastAppliedSongHash = songHash;
      document.dispatchEvent(new CustomEvent('moe-effect-seek-climax', {
        detail: { startTime: info.startTime, endTime: info.endTime }
      }));
      var dur = info.endTime > 0 ? Math.round(info.endTime - info.startTime) : '?';
      setHint('播放高潮片段 (' + Math.floor(info.startTime) + 's-' + (info.endTime > 0 ? Math.floor(info.endTime) + 's' : '末尾') + ')');
    } else {
      handleUnsupported('该歌曲无高潮信息');
    }
  }

  async function switchAccompaniment(song, songHash, currentTime, myVersion) {
    var ktvCheck = await checkKtvAvailable(songHash);
    if (myVersion !== switchVersion) return;
    if (!ktvCheck.available) { handleUnsupported('该歌曲不支持伴奏'); return; }

    var bestUrl = null;
    var bestIsMkv = false;

    log('[伴奏] 策略1: 旧API + acappella quality');
    var accompHashes = [songHash];
    if (song.playHash && song.playHash !== songHash) accompHashes.push(song.playHash);

    for (var vi = 0; vi < accompHashes.length; vi++) {
      var vResult = await tryGetPlayableUrl(accompHashes[vi], 'acappella', { ppage_id: '356753938' });
      if (myVersion !== switchVersion) return;
      if (vResult.url) {
        bestUrl = vResult.url;
        bestIsMkv = vResult.isMkv;
        log('[伴奏] 策略1成功:', bestUrl.substring(0, 80), bestIsMkv ? '[MKV多音轨]' : '[直接URL]');
        break;
      }
    }

    if (!bestUrl && ktvCheck.multiTrackHash) {
      log('[伴奏] 策略2: 旧API + hash_multitrack');
      var mtResult = await tryGetPlayableUrl(ktvCheck.multiTrackHash, null, { ppage_id: '356753938' });
      if (myVersion !== switchVersion) return;
      if (mtResult.url && mtResult.isMkv) {
        bestUrl = mtResult.url;
        bestIsMkv = true;
        log('[伴奏] 策略2成功:', bestUrl.substring(0, 80), '[MKV]');
      }
    }

    if (!bestUrl) {
      log('[伴奏] 策略3: 新API + multitrack');
      var newResult = await tryGetUrlNewApi(songHash, 'multitrack');
      if (myVersion !== switchVersion) return;
      if (newResult.url && newResult.isMkv) {
        bestUrl = newResult.url;
        bestIsMkv = true;
        log('[伴奏] 策略3成功:', bestUrl.substring(0, 80), '[MKV]');
      }
    }

    if (bestUrl) {
      lastAppliedSongHash = songHash;
      document.dispatchEvent(new CustomEvent('moe-effect-switch-instant', {
        detail: { url: bestUrl, currentTime: currentTime, targetTrack: 'accompaniment' }
      }));
      setHint(bestIsMkv ? '伴奏加载中...' : '伴奏切换成功');
    } else {
      handleUnsupported('该歌曲不支持伴奏');
    }
  }

  async function switchMagicEffect(song, songHash, effect, currentTime, myVersion) {
    var privilegeData = await apiRequest('GET', '/privilege/lite', { hash: songHash });
    if (myVersion !== switchVersion) return;
    log('[魔法音效] privilege 响应:', JSON.stringify(privilegeData).substring(0, 200));

    var variants = extractVariants(privilegeData);
    log('[魔法音效] 提取到变体数量:', variants.length,
      'qualities:', variants.map(function (v) { return v.quality + ':' + v.hash.substring(0, 8); }).join(', '));

    var matchedVariant = null;
    for (var mvi = 0; mvi < variants.length; mvi++) {
      if (variants[mvi].quality === effect && variants[mvi].hash) { matchedVariant = variants[mvi]; break; }
    }
    log('[魔法音效] 匹配的音效变体:', matchedVariant ? matchedVariant.quality + ':' + matchedVariant.hash : '无');

    var effectHashes = [];
    if (matchedVariant && matchedVariant.hash) effectHashes.push(matchedVariant.hash);
    if (songHash && effectHashes.indexOf(songHash) === -1) effectHashes.push(songHash);
    if (song.playHash && song.playHash !== songHash && effectHashes.indexOf(song.playHash) === -1) {
      effectHashes.push(song.playHash);
    }
    log('[魔法音效] 候选hash列表:', effectHashes.map(function (h) { return h.substring(0, 8); }).join(', '));

    var lastError = '';
    var allBackup = true;
    for (var hi = 0; hi < effectHashes.length; hi++) {
      var result = await tryGetPlayableUrl(effectHashes[hi], effect, { ppage_id: '356753938' });
      if (result.url && !result.isHashBackup) {
        log('获取到音效URL:', result.url.substring(0, 80));
        if (myVersion !== switchVersion) return;
        lastAppliedSongHash = songHash;
        document.dispatchEvent(new CustomEvent('moe-effect-switch-instant', {
          detail: { url: result.url, currentTime: currentTime }
        }));
        setHint('音效切换成功');
        return;
      }
      if (result.url && result.isHashBackup) {
        log('[魔法音效] API回退返回原曲，跳过此候选hash');
      }
      if (!result.url) {
        if (result.status && result.status !== 1) {
          lastError = 'API返回 status=' + result.status;
          if (result.error) lastError += ', error=' + result.error;
        } else if (result.error) {
          lastError = result.error;
        }
      }
      if (!result.isHashBackup) allBackup = false;
    }

    if (allBackup) {
      handleUnsupported('该歌曲不支持此音效');
    } else if (lastError) {
      handleUnsupported('获取音效失败');
    } else {
      handleUnsupported('该歌曲不支持此音效');
    }
  }

  function loadAutoSkip() {
    try { var saved = localStorage.getItem('audio_effect_plugin_autoskip'); if (saved) autoSkipEnabled = JSON.parse(saved); } catch (e) {}
  }
  function saveAutoSkip() {
    try { localStorage.setItem('audio_effect_plugin_autoskip', JSON.stringify(autoSkipEnabled)); } catch (e) {}
  }
  function loadClimaxMode() {
    try { var saved = localStorage.getItem('audio_effect_plugin_climax'); if (saved) climaxModeEnabled = JSON.parse(saved); } catch (e) {}
  }
  function saveClimaxMode() {
    try { localStorage.setItem('audio_effect_plugin_climax', JSON.stringify(climaxModeEnabled)); } catch (e) {}
  }
  function loadCurrentEffect() {
    try {
      var saved = localStorage.getItem('audio_effect_plugin_state');
      if (saved) {
        var p = JSON.parse(saved);
        if (p.currentEffect) {
          if (VALID_EFFECTS.indexOf(p.currentEffect) === -1) {
            log('已保存的音效已失效:', p.currentEffect, '重置为原声');
            currentEffect = 'none';
          } else {
            currentEffect = p.currentEffect;
          }
        }
      }
    } catch (e) {}
  }

  var _songChangeDebounce = null;

  function onSongChanged() {
    if (currentEffect === 'none') return;
    if (_isRestoring) { log('恢复期间跳过 onSongChanged'); return; }
    // 防抖：清除旧的定时器，避免多次 src 变化导致并发 switchEffect
    if (_songChangeDebounce) clearTimeout(_songChangeDebounce);
    _songChangeDebounce = setTimeout(function () {
      _songChangeDebounce = null;
      if (currentEffect === 'none' || isProcessing || _isRestoring) return;
      // 高潮模式：只在真正切歌时（hash变化）重新应用，避免 seek 触发循环
      if (currentEffect === 'climax') {
        var song = getCurrentSong();
        var newHash = song ? (song.hash || song.playHash) : null;
        if (newHash && newHash === lastAppliedSongHash) {
          log('高潮模式：同一首歌，跳过重新应用');
          return;
        }
      }
      log('歌曲切换检测: 重新应用音效:', currentEffect);
      switchEffect(currentEffect, true);
    }, 1500);
  }

  function onClimaxEnded() {
    log('高潮片段结束，准备切歌');
    setHint('高潮结束，切换下一首...');
     // 保存当前歌曲hash用于切歌后的比较，再重置 lastAppliedSongHash
    var currentHash = lastAppliedSongHash;
    lastAppliedSongHash = null;
    // 延迟切歌，避免与主应用的自动切歌冲突
    setTimeout(function () {
      // 检查歌曲是否已经切换（主应用可能已自动切歌）
      var song = getCurrentSong();
      var newHash = song ? (song.hash || song.playHash) : null;
      if (newHash && newHash !== currentHash) {
        log('主应用已自动切歌，无需重复切歌');
        return;
      }
      if (!skipToNextSong()) {
        // 切歌失败，延迟重试一次
        log('切歌失败，1秒后重试');
        setTimeout(function () {
          var song2 = getCurrentSong();
          var hash2 = song2 ? (song2.hash || song2.playHash) : null;
          if (hash2 && hash2 !== currentHash) return;
          skipToNextSong();
        }, 1000);
      }
    }, 800);
  }

  function onEffectFailed(e) {
    var reason = e.detail ? e.detail.reason : 'unknown';
    warn('音效加载失败:', reason);
    // 音效加载失败时取消静音，避免主 audio 被预静音但无音效播放
    document.dispatchEvent(new CustomEvent('moe-effect-unmute'));
    if (reason === 'effect_load_error' || reason === 'effect_load_timeout') {
      setHint('音效加载失败，请稍后重试');
    } else if (reason === 'mkv_play_error') {
      setHint('伴奏加载失败，该歌曲可能不支持');
    } else if (reason === 'unexpected_mkv') {
      setHint('收到意外的MKV格式');
    }
  }

  function onFetchAudio(e) {
    if (!e.detail || !e.detail.url) return;
    var url = e.detail.url;
    var requestId = e.detail.requestId;
    log('音频代理请求:', url.substring(0, 80), 'requestId:', requestId);
    chrome.runtime.sendMessage({ type: 'fetch-audio', url: url }, function (response) {
      if (chrome.runtime.lastError) {
        warn('音频代理失败:', chrome.runtime.lastError.message);
        document.dispatchEvent(new CustomEvent('moe-effect-audio-data', {
          detail: { requestId: requestId, error: chrome.runtime.lastError.message }
        }));
        return;
      }
      if (!response || response.error) {
        warn('音频代理返回错误:', response ? response.error : '无响应');
        document.dispatchEvent(new CustomEvent('moe-effect-audio-data', {
          detail: { requestId: requestId, error: response ? response.error : '无响应' }
        }));
        return;
      }
      log('音频代理成功, 数据大小:', response.data ? response.data.length : 0, '字符');
      document.dispatchEvent(new CustomEvent('moe-effect-audio-data', {
        detail: { requestId: requestId, data: response.data }
      }));
    });
  }

  function onRestoreEffect(e) {
    var effect = e.detail ? e.detail.effect : 'none';
    if (!effect || effect === 'none') return;
    log('页面刷新后恢复音效:', effect);
    _isRestoring = true;
    currentEffect = effect;
    updateEffectUI(effect);
    switchEffect(effect, true).then(function () {
      // 恢复完成后延迟重置标志，确保 onSongChanged 不会干扰
      setTimeout(function () { _isRestoring = false; }, 3000);
    }).catch(function () {
      _isRestoring = false;
    });
  }

  // 注意：不再通过 player_volume 同步静音状态
  // 之前设置 player_volume=0 会导致 MoeKoeMusic 将 audio.volume 设为 0，
  // volumechange 回调同步到音效 audio 后所有声音消失

  function init() {
    loadCurrentEffect();
    loadAutoSkip();
    loadClimaxMode();
    injectPageScript();
    setTimeout(function () { injectEffectButton(); }, 1000);
    var observerTimer = null;
    var observer = new MutationObserver(function () {
      if (observerTimer) clearTimeout(observerTimer);
      observerTimer = setTimeout(function () {
        if (!document.getElementById('aep-btn')) injectEffectButton();
      }, 500);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('moe-effect-song-changed', onSongChanged);
    document.addEventListener('moe-effect-climax-ended', onClimaxEnded);
    document.addEventListener('moe-effect-failed', onEffectFailed);
    document.addEventListener('moe-effect-fetch-audio', onFetchAudio);
    document.addEventListener('moe-effect-restore', onRestoreEffect);
    log('Content script 已初始化, API地址:', getApiBaseUrl(), '当前音效:', currentEffect, '自动跳歌:', autoSkipEnabled);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
