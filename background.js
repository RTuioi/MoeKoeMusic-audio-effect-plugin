console.log('[AudioEffectPlugin BG] Background service worker 已初始化');

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  if (request.type === 'fetch-audio') {
    var url = request.url;
    if (!url) {
      sendResponse({ error: '缺少URL参数' });
      return true;
    }

    fetch(url, { mode: 'cors', credentials: 'include' })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        var contentType = response.headers.get('Content-Type') || 'audio/mpeg';
        return response.arrayBuffer().then(function (buffer) {
          return { data: arrayBufferToBase64(buffer), contentType: contentType };
        });
      })
      .then(function (result) {
        sendResponse({ data: result.data, contentType: result.contentType });
      })
      .catch(function (err) {
        console.warn('[AudioEffectPlugin BG] fetch-audio 失败:', err.message, 'URL:', url.substring(0, 80));
        sendResponse({ error: err.message });
      });

    return true;
  }
});

function arrayBufferToBase64(buffer) {
  var chunks = [];
  var bytes = new Uint8Array(buffer);
  var chunkSize = 8192;
  for (var i = 0; i < bytes.length; i += chunkSize) {
    var chunk = bytes.subarray(i, i + chunkSize);
    var str = '';
    for (var j = 0; j < chunk.length; j++) {
      str += String.fromCharCode(chunk[j]);
    }
    chunks.push(str);
  }
  return btoa(chunks.join(''));
}
