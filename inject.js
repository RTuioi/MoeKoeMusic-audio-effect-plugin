(function () {
  'use strict';

  var P = '[AudioEffectPlugin]';
  var VALID_EFFECTS = ['none', 'piano', 'subwoofer', 'ancient', 'surnay', 'dj', 'climax', 'accompaniment'];
  var state = {
    currentEffect: 'none',
    audio: null,
  };

  var pendingSwitch = null;
  var mkvVideoEl = null;
  var _songChangeTimer = null;
  var _pendingSwitchTimer = null;
  var climaxInfo = null;
  var _climaxMonitorFn = null;
  var _unmuteSafetyTimer = null;
  var _isEffectActive = false;
  var _accompSyncFns = [];
  var _effectAudio = null;
  var _effectSyncFns = [];
  var _muteGuardTimer = null;

  function startMuteGuard(audio) {
    stopMuteGuard();
    if (!audio) return;
    _muteGuardTimer = setInterval(function () {
      if (_isEffectActive && audio && !audio.muted) {
        audio.muted = true;
      }
    }, 200);
  }

  function stopMuteGuard() {
    if (_muteGuardTimer) { clearInterval(_muteGuardTimer); _muteGuardTimer = null; }
  }

  function loadState() {
    try {
      var saved = localStorage.getItem('audio_effect_plugin_state');
      if (saved) {
        var p = JSON.parse(saved);
        var effect = p.currentEffect || 'none';
        state.currentEffect = VALID_EFFECTS.indexOf(effect) !== -1 ? effect : 'none';
      }
    } catch (e) {}
  }

  function saveState() {
    try {
      localStorage.setItem('audio_effect_plugin_state', JSON.stringify({ currentEffect: state.currentEffect }));
    } catch (e) {}
  }

  loadState();
  // 初始加载时不设置 _isEffectActive = true
  // 等恢复流程通过 moe-effect-set 事件明确设置，避免刷新后在音效加载前静音主 audio

  function onAudioCaptured(audio) {
    var isNew = state.audio !== audio;
    state.audio = audio;
    console.log(P, 'Audio 元素已捕获', isNew ? '(新元素)' : '(同一元素)');
    if (pendingSwitch && isNew) {
      if (_pendingSwitchTimer) clearTimeout(_pendingSwitchTimer);
      _pendingSwitchTimer = setTimeout(function () {
        if (pendingSwitch) {
          console.log(P, '延迟执行待处理的音效切换');
          var ps = pendingSwitch;
          pendingSwitch = null;
          _pendingSwitchTimer = null;
          executeSwitch(ps.url, ps.currentTime, ps.targetTrack);
        }
      }, 800);
    }
  }

  function findAudioInShadowDOM(root) {
    try {
      var allElements = root.querySelectorAll('*');
      for (var i = 0; i < allElements.length; i++) {
        var el = allElements[i];
        if (el.shadowRoot) {
          var audio = el.shadowRoot.querySelector('audio');
          if (audio) return audio;
          var deeper = findAudioInShadowDOM(el.shadowRoot);
          if (deeper) return deeper;
        }
      }
    } catch (e) {}
    return null;
  }

  var origSrcDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
  Object.defineProperty(HTMLAudioElement.prototype, 'src', {
    get: function () {
      return origSrcDescriptor.get.call(this);
    },
    set: function (val) {
      if (this._aepEffect) return origSrcDescriptor.set.call(this, val);
      var isNewElement = state.audio !== this;
      if (isNewElement) onAudioCaptured(this);
      if (state.audio === this) {
        if (_isEffectActive && state.currentEffect !== 'none') {
          this.muted = true;
          cleanupEffectAudio(false);
          cleanupMkvVideo();
          startMuteGuard(this);
          console.log(P, '歌曲切换且音效活跃，已预静音并销毁旧音效');
          scheduleUnmuteSafety(this, 6000);
        }
        // 高潮模式下切歌：临时静音主 audio，等跳转到高潮位置后再取消
        if (state.currentEffect === 'climax') {
          this.muted = true;
          stopClimaxMonitor();
          climaxInfo = null;
          // 安全超时：如果 seekToClimax 失败，自动取消静音
          scheduleUnmuteSafety(this, 8000);
          console.log(P, '高潮模式下歌曲切换，临时静音，等待跳转高潮');
        }
        if (_songChangeTimer) clearTimeout(_songChangeTimer);
        _songChangeTimer = setTimeout(function () {
          console.log(P, '检测到歌曲切换');
          document.dispatchEvent(new CustomEvent('moe-effect-song-changed'));
        }, 300);
      }
      return origSrcDescriptor.set.call(this, val);
    },
    configurable: true,
    enumerable: true,
  });

  var origPlay = HTMLAudioElement.prototype.play;
  HTMLAudioElement.prototype.play = function () {
    if (!this._aepEffect && state.audio !== this) onAudioCaptured(this);
    return origPlay.call(this);
  };

  function getMainAudio() {
    if (state.audio) {
      try {
        if (state.audio.paused !== undefined) return state.audio;
      } catch (e) {}
      state.audio = null;
    }
    var domAudio = document.querySelector('audio');
    if (domAudio) { onAudioCaptured(domAudio); return domAudio; }
    var shadowAudio = findAudioInShadowDOM(document);
    if (shadowAudio) { onAudioCaptured(shadowAudio); return shadowAudio; }
    var allAudios = document.querySelectorAll('audio');
    if (allAudios.length > 0) { onAudioCaptured(allAudios[allAudios.length - 1]); return allAudios[allAudios.length - 1]; }
    return null;
  }

  function isMkvUrl(url) {
    if (!url) return false;
    return url.toLowerCase().indexOf('.mkv') !== -1;
  }

  function scheduleUnmuteSafety(audio, delay) {
    cancelUnmuteSafety();
    _unmuteSafetyTimer = setTimeout(function () {
      stopMuteGuard();
      if (audio && audio.muted) { audio.muted = false; console.log(P, '安全超时：自动取消静音'); }
      _unmuteSafetyTimer = null;
    }, delay || 6000);
  }

  function cancelUnmuteSafety() {
    if (_unmuteSafetyTimer) { clearTimeout(_unmuteSafetyTimer); _unmuteSafetyTimer = null; }
  }

  function removeSyncFns(fns, audio) {
    if (!fns || fns.length === 0) return;
    if (audio) { for (var i = 0; i < fns.length; i++) audio.removeEventListener(fns[i].ev, fns[i].fn); }
    fns.length = 0;
  }

  function destroyMediaElement(el) {
    if (!el) return;
    try { el.pause(); } catch (e) {}
    try { el.removeAttribute('src'); } catch (e) {}
    try { el.load(); } catch (e) {}
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  function bindSyncEvents(target, mainAudio, fns) {
    fns.push(
      { ev: 'play', fn: function () { if (target.paused) target.play().catch(function () {}); } },
      { ev: 'pause', fn: function () { if (!target.paused) target.pause(); } },
      { ev: 'seeked', fn: function () {
        target.currentTime = mainAudio.currentTime;
        // 主 audio 播放中但音效暂停时（如单曲循环 loop=true），自动播放音效
        if (!mainAudio.paused && target.paused) target.play().catch(function () {});
      } },
      { ev: 'volumechange', fn: function () {
        target.volume = mainAudio.volume;
        if (_isEffectActive && !mainAudio.muted) {
          mainAudio.muted = true;
        }
      } }
    );
    for (var i = 0; i < fns.length; i++) mainAudio.addEventListener(fns[i].ev, fns[i].fn);
  }

  function cleanupEffectAudio(unmuteMain) {
    removeSyncFns(_effectSyncFns, state.audio);
    destroyMediaElement(_effectAudio);
    _effectAudio = null;
    stopMuteGuard();
    if (unmuteMain) {
      var audio = getMainAudio();
      if (audio && audio.muted) { audio.muted = false; console.log(P, 'cleanupEffectAudio: 取消主audio静音'); }
    }
  }

  function cleanupMkvVideo() {
    removeSyncFns(_accompSyncFns, state.audio);
    destroyMediaElement(mkvVideoEl);
    mkvVideoEl = null;
    stopMuteGuard();
    // 仅在无音效时取消静音，音效间切换时保持静音等待新音效接管
    var audio = getMainAudio();
    if (audio && audio.muted && state.currentEffect === 'none') {
      audio.muted = false;
      console.log(P, 'cleanupMkvVideo: 取消主audio静音');
    }
  }

  function cleanupAllEffects() {
    cleanupEffectAudio(true);
    cleanupMkvVideo();
    stopClimaxMonitor();
    stopMuteGuard();
    climaxInfo = null;
    cancelUnmuteSafety();
    var audio = getMainAudio();
    if (audio && audio.muted) { audio.muted = false; console.log(P, 'cleanupAllEffects: 取消主audio静音'); }
  }

  function selectAudioTrack(media, targetTrack) {
    if (!media.audioTracks || media.audioTracks.length === 0) return false;
    console.log(P, 'audioTracks 数量:', media.audioTracks.length);
    var accompTrackIndex = -1;
    for (var j = 0; j < media.audioTracks.length; j++) {
      var t = media.audioTracks[j];
      var label = (t.label || '').toLowerCase();
      var lang = (t.language || '').toLowerCase();
      var isAccomp = label.indexOf('accompaniment') !== -1 || label.indexOf('伴奏') !== -1 || label.indexOf('instrumental') !== -1 || lang.indexOf('accompaniment') !== -1;
      if (targetTrack === 'accompaniment' && isAccomp) { accompTrackIndex = j; break; }
    }
    if (accompTrackIndex >= 0) {
      // 显式禁用其他音轨，启用伴奏音轨
      for (var k = 0; k < media.audioTracks.length; k++) {
        media.audioTracks[k].enabled = (k === accompTrackIndex);
      }
      return true;
    }
    // 未找到伴奏音轨，默认使用第一个音轨
    if (media.audioTracks.length >= 1) {
      for (var m = 0; m < media.audioTracks.length; m++) media.audioTracks[m].enabled = (m === 0);
      return true;
    }
    return false;
  }

  function playAccompaniment(mkvUrl, currentTime, mainAudio) {
    cleanupMkvVideo();
    console.log(P, '伴奏模式: 使用 video 元素直接播放 MKV (默认音轨=伴奏)');

    var video = document.createElement('video');
    video.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    video.volume = mainAudio ? mainAudio.volume : 1;
    document.body.appendChild(video);
    mkvVideoEl = video;

    function onMeta() {
      video.removeEventListener('loadedmetadata', onMeta);
      console.log(P, '伴奏 MKV loadedmetadata');
      selectAudioTrack(video, 'accompaniment');
      if (mainAudio) {
        mainAudio.muted = true;
        bindSyncEvents(video, mainAudio, _accompSyncFns);
        startMuteGuard(mainAudio);
      }
      if (currentTime > 0) video.currentTime = currentTime;
      video.play().catch(function (e) { console.warn(P, 'video.play() 失败:', e.message); });
      cancelUnmuteSafety();
      console.log(P, '伴奏 MKV 开始播放');
    }

    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('error', function () {
      video.removeEventListener('loadedmetadata', onMeta);
      console.error(P, '伴奏 MKV 播放失败');
      cleanupMkvVideo();
      if (mainAudio) mainAudio.muted = false;
      document.dispatchEvent(new CustomEvent('moe-effect-failed', { detail: { reason: 'mkv_play_error' } }));
    });

    video.src = mkvUrl;

    if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
      onMeta();
    }
  }

  function playEffectAudio(effectUrl, currentTime, mainAudio) {
    cleanupEffectAudio(false);
    console.log(P, '音效模式: 使用隐藏audio元素播放 (不修改主audio.src)');

    var audio = document.createElement('audio');
    audio._aepEffect = true;
    audio.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    audio.volume = mainAudio ? mainAudio.volume : 1;
    document.body.appendChild(audio);
    _effectAudio = audio;

    var timeoutId = setTimeout(function () {
      console.warn(P, '音效音频加载超时');
      cleanupEffectAudio(true);
      document.dispatchEvent(new CustomEvent('moe-effect-failed', { detail: { reason: 'effect_load_timeout' } }));
    }, 10000);

    var _readyFired = false;
    function onReady() {
      if (_readyFired) return;
      _readyFired = true;
      audio.removeEventListener('canplay', onReady);
      audio.removeEventListener('loadeddata', onReady);
      clearTimeout(timeoutId);
      console.log(P, '音效音频就绪');
      if (mainAudio) {
        mainAudio.muted = true;
        bindSyncEvents(audio, mainAudio, _effectSyncFns);
        startMuteGuard(mainAudio);
      }
      if (currentTime > 0) audio.currentTime = currentTime;
      audio.play().catch(function (e) { console.warn(P, '音效播放失败:', e.message); });
      cancelUnmuteSafety();
      console.log(P, '音效开始播放');
    }

    audio.addEventListener('canplay', onReady);
    audio.addEventListener('loadeddata', onReady);
    audio.addEventListener('error', function () {
      audio.removeEventListener('canplay', onReady);
      audio.removeEventListener('loadeddata', onReady);
      clearTimeout(timeoutId);
      console.error(P, '音效音频加载失败');
      cleanupEffectAudio(true);
      document.dispatchEvent(new CustomEvent('moe-effect-failed', { detail: { reason: 'effect_load_error' } }));
    });

    audio.src = effectUrl;

    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      onReady();
    }
  }

  function executeSwitch(url, currentTime, targetTrack) {
    var audio = getMainAudio();
    if (!audio) {
      pendingSwitch = { url: url, currentTime: currentTime, targetTrack: targetTrack };
      console.warn(P, 'Audio 未就绪，切换已挂起');
      return;
    }
    pendingSwitch = null;
    if (_pendingSwitchTimer) { clearTimeout(_pendingSwitchTimer); _pendingSwitchTimer = null; }

    var isMkv = isMkvUrl(url);

    if (isMkv && state.currentEffect === 'accompaniment') {
      console.log(P, '伴奏 MKV 模式');
      playAccompaniment(url, currentTime, audio);
      return;
    }

    if (isMkv) {
      console.warn(P, '收到MKV URL但当前不是伴奏模式, 忽略MKV');
      document.dispatchEvent(new CustomEvent('moe-effect-failed', { detail: { reason: 'unexpected_mkv' } }));
      return;
    }

    console.log(P, '普通音效模式, URL:', url.substring(0, 80));
    playEffectAudio(url, currentTime, audio);
  }

  var _climaxEndedFn = null;

  function startClimaxMonitor(startTime, endTime) {
    stopClimaxMonitor();
    var audio = getMainAudio();
    if (!audio) return;
    if (endTime <= 0) { endTime = startTime + 30; console.log(P, 'endTime未提供，使用默认值: startTime+30=' + endTime + 's'); }
    climaxInfo = { startTime: startTime, endTime: endTime, lastTime: audio.currentTime };
    _climaxMonitorFn = function () {
      if (!climaxInfo) return;
      var ct = audio.currentTime;
      // 如果跳跃幅度超过2秒，视为用户手动 seek，不触发切歌
      var isSeek = Math.abs(ct - climaxInfo.lastTime) > 2;
      climaxInfo.lastTime = ct;
      if (ct >= climaxInfo.endTime && !isSeek) {
        console.log(P, '高潮片段结束 (currentTime=' + ct + ' >= endTime=' + climaxInfo.endTime + ')，通知切歌');
        stopClimaxMonitor();
        document.dispatchEvent(new CustomEvent('moe-effect-climax-ended'));
      }
    };
    audio.addEventListener('timeupdate', _climaxMonitorFn);
    // 监听歌曲自然结束事件，确保即使未达 endTime 也能自动切歌
    _climaxEndedFn = function () {
      console.log(P, '歌曲自然结束，触发高潮切歌');
      stopClimaxMonitor();
      document.dispatchEvent(new CustomEvent('moe-effect-climax-ended'));
    };
    audio.addEventListener('ended', _climaxEndedFn);
    console.log(P, '高潮监控已启动, startTime:', startTime, 'endTime:', endTime);
  }

  function stopClimaxMonitor() {
    if (_climaxMonitorFn) {
      var audio = getMainAudio();
      if (audio) audio.removeEventListener('timeupdate', _climaxMonitorFn);
      _climaxMonitorFn = null;
    }
    if (_climaxEndedFn) {
      var audio2 = getMainAudio();
      if (audio2) audio2.removeEventListener('ended', _climaxEndedFn);
      _climaxEndedFn = null;
    }
  }

  function seekToClimax(startTime, endTime) {
    var audio = getMainAudio();
    if (!audio) { console.warn(P, '高潮跳转失败: Audio 未就绪'); return; }

    var _seekReadyFired = false;
    function doSeek() {
      if (_seekReadyFired) return;
      _seekReadyFired = true;
      if (startTime > 0 && startTime < audio.duration) {
        audio.currentTime = startTime;
        audio.muted = false;
        if (audio.paused) audio.play().catch(function () {});
        startClimaxMonitor(startTime, endTime);
        console.log(P, '已跳转至高潮位置:', startTime + 's, 结束位置:', endTime + 's');
      } else {
        console.warn(P, '高潮时间无效:', startTime, '音频时长:', audio.duration);
        audio.muted = false;
      }
    }

    if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) {
      doSeek();
    } else {
      var onReady = function () {
        audio.removeEventListener('loadedmetadata', onReady);
        audio.removeEventListener('canplay', onReady);
        doSeek();
      };
      audio.addEventListener('loadedmetadata', onReady);
      audio.addEventListener('canplay', onReady);
      setTimeout(function () {
        audio.removeEventListener('loadedmetadata', onReady);
        audio.removeEventListener('canplay', onReady);
        if (audio.readyState >= HTMLMediaElement.HAVE_METADATA) doSeek();
        else { console.warn(P, '高潮跳转超时'); audio.muted = false; }
      }, 5000);
    }
  }

  document.addEventListener('moe-effect-set', function (e) {
    var newEffect = e.detail.effect;
    var oldEffect = state.currentEffect;
    state.currentEffect = newEffect;
    // 高潮模式直接使用主 audio 播放，不需要静音；其他音效使用独立 audio/video，需要静音主 audio
    _isEffectActive = (newEffect !== 'none' && newEffect !== 'climax');
    saveState();
    console.log(P, '音效状态已更新:', oldEffect, '->', newEffect, '_isEffectActive:', _isEffectActive);

    if (newEffect === 'none') {
      cleanupAllEffects();
    } else if (newEffect === 'climax') {
      // 高潮模式：清理其他音效资源，停止 muteGuard
      // 临时静音主 audio，等 seekToClimax 跳转到高潮位置后再取消
      cleanupEffectAudio(false);
      cleanupMkvVideo();
      stopMuteGuard();
      cancelUnmuteSafety();
      var mainAudio = getMainAudio();
      if (mainAudio) {
        mainAudio.muted = true;
        scheduleUnmuteSafety(mainAudio, 8000);
      }
      console.log(P, '高潮模式: 已清理旧音效，临时静音等待跳转');
    } else {
      // 其他音效：清理旧资源，静音主 audio 等待新音效接管
      cleanupEffectAudio(false);
      cleanupMkvVideo();
      cancelUnmuteSafety();
      var mainAudio = getMainAudio();
      if (mainAudio) {
        mainAudio.muted = true;
        startMuteGuard(mainAudio);
      }
    }

    if (newEffect !== 'climax') { stopClimaxMonitor(); climaxInfo = null; }
  });

  document.addEventListener('moe-effect-switch-instant', function (e) {
    console.log(P, '收到切换指令, URL:', (e.detail.url || '').substring(0, 80), '时间:', e.detail.currentTime, '目标音轨:', e.detail.targetTrack || '(无)');
    executeSwitch(e.detail.url, e.detail.currentTime || 0, e.detail.targetTrack);
  });

  document.addEventListener('moe-effect-seek-climax', function (e) {
    console.log(P, '收到高潮跳转指令, startTime:', e.detail.startTime, 'endTime:', e.detail.endTime);
    seekToClimax(e.detail.startTime, e.detail.endTime);
  });

  document.addEventListener('moe-effect-unmute', function () {
    stopMuteGuard();
    var audio = getMainAudio();
    if (audio) { audio.muted = false; cancelUnmuteSafety(); console.log(P, '收到取消静音指令'); }
  });

  document.addEventListener('moe-effect-get-state', function () {
    var audio = getMainAudio();
    document.dispatchEvent(new CustomEvent('moe-effect-state-response', {
      detail: { currentEffect: state.currentEffect, audioCurrentTime: audio ? audio.currentTime : 0, audioPaused: audio ? audio.paused : true }
    }));
  });

  console.log(P, '注入脚本已初始化, 当前音效:', state.currentEffect, 'Audio状态:', state.audio ? '已捕获' : '等待捕获');

  if (state.currentEffect !== 'none') {
    console.log(P, '页面刷新后恢复音效:', state.currentEffect);
    setTimeout(function () {
      document.dispatchEvent(new CustomEvent('moe-effect-restore', {
        detail: { effect: state.currentEffect }
      }));
    }, 2000);
  }
})();
