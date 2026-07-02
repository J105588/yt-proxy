const https = require('https');

async function getYouTubeTrends() {
    return new Promise((resolve, reject) => {
        const exploreReq = encodeURIComponent(JSON.stringify({"comparisonItem":[{"geo":"JP","time":"now 7-d"}],"category":0,"property":"youtube"}));
        const exploreUrl = `https://trends.google.co.jp/trends/api/explore?hl=ja&tz=-540&req=${exploreReq}`;

        https.get(exploreUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Referer': 'https://trends.google.co.jp/explore?geo=JP&gprop=youtube'
            }
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (data.startsWith(')]}\',\\n')) {
                    data = data.slice(5);
                } else if (data.startsWith(')]}\'\n')) {
                    data = data.slice(5);
                }
                let json;
                try {
                    json = JSON.parse(data);
                } catch(e) {
                    return reject('Failed to parse explore JSON: ' + data.slice(0, 500));
                }

                const widget = json.widgets.find(w => w.id === 'RELATED_QUERIES');
                if (!widget) return reject('No RELATED_QUERIES widget found');

                const token = widget.token;
                const reqParam = encodeURIComponent(JSON.stringify(widget.request));

                const widgetUrl = `https://trends.google.co.jp/trends/api/widgetdata/relatedqueries?hl=ja&tz=-540&req=${reqParam}&token=${token}`;

                https.get(widgetUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
                        'Referer': 'https://trends.google.co.jp/explore?geo=JP&gprop=youtube'
                    }
                }, (res) => {
                    let wdata = '';
                    res.on('data', chunk => wdata += chunk);
                    res.on('end', () => {
                        if (wdata.startsWith(')]}\'\n')) wdata = wdata.slice(5);
                        try {
                            const wjson = JSON.parse(wdata);
                            const queries = wjson.default.rankedList[0].rankedKeyword.map(k => k.query);
                            resolve(queries);
                        } catch(e) {
                            reject('Failed to parse widget JSON: ' + wdata.slice(0,500));
                        }
                    });
                }).on('error', reject);
            });
        }).on('error', reject);
    });
}

getYouTubeTrends().then(queries => {
    console.log("SUCCESS:", queries);
}).catch(console.error);
