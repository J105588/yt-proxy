const KEY = "jH4wcTyjsrmQyPdJtkdxsXoQ";
const getUrl = () => PropertiesService.getScriptProperties().getProperty('URL');

function doPost(e) {
  if (e.parameter.key === KEY) {
    PropertiesService.getScriptProperties().setProperty('URL', e.parameter.url);
    return ContentService.createTextOutput("OK");
  }
}

function doGet(e) {
  if (e.parameter.action === 'download') {
    try {
      const id = e.parameter.id;
      const quality = e.parameter.quality || '480p';
      const token = e.parameter.token || '';
      const title = e.parameter.title || '';
      const pcUrl = getUrl();
      if (!pcUrl) throw new Error("PC URL not set");
      
      const tStr = title ? `&title=${encodeURIComponent(title)}` : '';
      const targetUrl = `${pcUrl}/stream?id=${id}&quality=${quality}&download=1&token=${encodeURIComponent(token)}${tStr}`;
      const res = UrlFetchApp.fetch(targetUrl, { muteHttpExceptions: true });
      if (res.getResponseCode() !== 200) {
        throw new Error(`Failed to fetch from PC server (status: ${res.getResponseCode()})`);
      }
      
      const base64Data = Utilities.base64Encode(res.getBlob().getBytes());
      const sanitizedTitle = title ? title.replace(/[\\/:*?"<>|]/g, '_') : id;
      const filename = `${sanitizedTitle}_${quality}.mp4`;
      
      const htmlOutput = `
      <!DOCTYPE html>
      <html>
      <head><title>Downloading...</title></head>
      <body style="background:#0f172a; color:#f8fafc; font-family:sans-serif; text-align:center; padding-top:100px;">
        <h2>動画を生成しました</h2>
        <p>まもなくダウンロードが開始されます。開始されない場合は以下をクリックしてください。</p>
        <div style="margin-top:20px;">
          <a id="dl-link" href="#" style="background:#0284c7; color:#fff; padding:10px 20px; text-decoration:none; border-radius:6px; font-weight:bold;">手動でダウンロード</a>
        </div>
        <script>
          var base64Data = "${base64Data}";
          var filename = "${filename}";
          
          var binary = atob(base64Data);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
          }
          var blob = new Blob([bytes.buffer], { type: "video/mp4" });
          var blobUrl = URL.createObjectURL(blob);
          
          var link = document.getElementById("dl-link");
          link.href = blobUrl;
          link.download = filename;
          
          var a = document.createElement("a");
          a.href = blobUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        </script>
      </body>
      </html>
      `;
      
      return HtmlService.createHtmlOutput(htmlOutput)
        .setTitle("Downloading Video...")
        .addMetaTag('viewport', 'width=device-width, initial-scale=1');
        
    } catch (err) {
      return HtmlService.createHtmlOutput(`<h2 style="color:red; text-align:center; margin-top:40px;">ダウンロードに失敗しました</h2><p style="text-align:center;">${err.toString()}</p>`);
    }
  }

  if (e.parameter.action === 'getTrends') {
    try {
      return ContentService.createTextOutput(JSON.stringify(fetchYTTrends())).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      return ContentService.createTextOutput(JSON.stringify({ error: err.toString() })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  const pcUrl = getUrl();
  if (!pcUrl) {
    return HtmlService.createHtmlOutput(
      "<h2 style='text-align:center;margin-top:40px;'>PC Offline (URL未設定)</h2>" +
      "<p style='text-align:center;color:#666;'>サーバーからの起動通知待ちです。再起動したばかりの場合は数秒お待ちください。</p>"
    );
  }

  const path = e.parameter.path || "/";
  const params = Object.keys(e.parameter)
    .filter(k => k !== 'path' && k !== 'key')
    .map(k => `${k}=${encodeURIComponent(e.parameter[k])}`)
    .join('&');

  const targetUrl = `${pcUrl}${path}${params ? '?' + params : ''}`;

  try {
    const res = UrlFetchApp.fetch(targetUrl, { muteHttpExceptions: true });
    let html = res.getContentText();
    html = html.replace(/\{\{GAS_URL\}\}/g, ScriptApp.getService().getUrl())
               .replace(/\{\{TUNNEL_URL\}\}/g, pcUrl);

    return HtmlService.createHtmlOutput(html)
      .setTitle("YT Proxy")
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return HtmlService.createHtmlOutput(
      `<h2 style='color:red;text-align:center;margin-top:40px;'>サーバーへの接続に失敗しました。</h2>
      <p style='text-align:center;color:#666;'>PCが起動しているか、ネット接続を確認してください。<br>現在設定されているURL: <code style='background:#eee;padding:2px 5px;'>${pcUrl}</code></p>
      <div style='text-align:center;margin-top:20px;'><button onclick='location.reload()' style='padding:8px 16px;cursor:pointer;'>再試行</button></div>`
    );
  }
}

function proxyBinary(path, params) {
  const u = getUrl();
  if (!u) return null;
  
  const token = params ? params.token : null;
  const headers = {};
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  
  const sendParams = {};
  if (params) {
    Object.keys(params).forEach(k => {
      if (k !== 'token') sendParams[k] = params[k];
    });
  }

  const q = Object.keys(sendParams).map(k => `${k}=${encodeURIComponent(sendParams[k])}`).join('&');
  try {
    return Utilities.base64Encode(UrlFetchApp.fetch(u + path + (q ? '?' + q : ''), {
      headers: headers,
      muteHttpExceptions: true
    }).getBlob().getBytes());
  } catch (e) { return null; }
}

function proxyVideoChunk(id, ss, t) {
  const u = getUrl();
  if (!u) return null;
  try {
    return Utilities.base64Encode(UrlFetchApp.fetch(`${u}/stream-part?id=${id}&ss=${ss}&t=${t || 10}`, { muteHttpExceptions: true }).getBlob().getBytes());
  } catch (e) { return null; }
}

function proxyVideoBytes(id, start, end, quality, token) {
  const u = getUrl();
  if (!u) return null;
  const qStr = quality ? `&quality=${encodeURIComponent(quality)}` : '';
  const tStr = token ? `&token=${encodeURIComponent(token)}` : '';
  const headers = {};
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  try {
    const res = UrlFetchApp.fetch(`${u}/stream-bytes?id=${id}&start=${start}&end=${end}${qStr}${tStr}`, {
      headers: headers,
      muteHttpExceptions: true
    });
    return res.getResponseCode() === 404 ? "RETRY" : Utilities.base64Encode(res.getBlob().getBytes());
  } catch (e) { return null; }
}

function proxyFetch(path, params) {
  const u = getUrl();
  if (!u) return JSON.stringify({ error: 'Offline', status: 503 });
  
  const token = params ? params.token : null;
  const headers = {};
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  
  const sendParams = {};
  if (params) {
    Object.keys(params).forEach(k => {
      if (k !== 'token') sendParams[k] = params[k];
    });
  }

  const q = Object.keys(sendParams).map(k => `${k}=${encodeURIComponent(sendParams[k])}`).join('&');
  try {
    const res = UrlFetchApp.fetch(u + path + (q ? '?' + q : ''), {
      headers: headers,
      muteHttpExceptions: true
    });
    return res.getResponseCode() === 401 ? JSON.stringify({ error: 'Unauthorized', status: 401 }) : res.getContentText();
  } catch (e) {
    return JSON.stringify({ error: e.toString(), status: 500 });
  }
}

function proxyStop(id) {
  const u = getUrl();
  if (!u) return null;
  try {
    UrlFetchApp.fetch(`${u}/stop-stream?id=${id}`, { muteHttpExceptions: true });
    return "OK";
  } catch (e) { return null; }
}

function fetchYTTrends() {
  const req = { "comparisonItem": [{ "geo": "JP", "time": "now 7-d" }], "category": 0, "property": "youtube" };
  const exploreUrl = "https://trends.google.co.jp/trends/api/explore?hl=ja&tz=-540&req=" + encodeURIComponent(JSON.stringify(req));
  const options = {
    "headers": {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36",
      "Referer": "https://trends.google.co.jp/explore?geo=JP&gprop=youtube"
    },
    "muteHttpExceptions": true
  };

  const getCleanText = (url) => {
    const res = UrlFetchApp.fetch(url, options).getContentText();
    return res.indexOf(")]}',") === 0 ? res.substring(5) : res;
  };

  const json = JSON.parse(getCleanText(exploreUrl));
  const widget = json.widgets.find(w => w.id === 'RELATED_QUERIES');
  if (!widget) throw new Error("No RELATED_QUERIES widget found");

  const widgetUrl = "https://trends.google.co.jp/trends/api/widgetdata/relatedqueries?hl=ja&tz=-540&req=" + encodeURIComponent(JSON.stringify(widget.request)) + "&token=" + widget.token;
  const trendsJson = JSON.parse(getCleanText(widgetUrl));
  const lists = trendsJson.default.rankedList;

    return {
      top: (lists[0] && lists[0].rankedKeyword) ? lists[0].rankedKeyword.map(k => k.query) : [],
      rising: (lists[1] && lists[1].rankedKeyword) ? lists[1].rankedKeyword.map(k => k.query) : []
    };
}

function downloadVideo(id, quality, token, title) {
  const pcUrl = getUrl();
  if (!pcUrl) throw new Error("PC URL not set");
  
  const tStr = title ? `&title=${encodeURIComponent(title)}` : '';
  const targetUrl = `${pcUrl}/stream?id=${id}&quality=${quality || '480p'}&download=1&token=${encodeURIComponent(token)}${tStr}`;
  const res = UrlFetchApp.fetch(targetUrl, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) {
    throw new Error(`Failed to fetch from PC server (status: ${res.getResponseCode()})`);
  }
  
  const base64Data = Utilities.base64Encode(res.getBlob().getBytes());
  const sanitizedTitle = title ? title.replace(/[\\/:*?"<>|]/g, '_') : id;
  const filename = `${sanitizedTitle}_${quality || '480p'}.mp4`;
  return {
    success: true,
    base64Data: base64Data,
    filename: filename
  };
}