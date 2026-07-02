const fs = require('fs');
try {
    if (!fs.existsSync('tunnel.log')) return;
    const log = fs.readFileSync('tunnel.log', 'utf8');
    // 全てのURLを検索し、最後のものを取得する
    const matches = [...log.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/g)];
    if (matches.length > 0) {
        // 一番最後のマッチ（最新のURL）を使用
        process.stdout.write(matches[matches.length - 1][0]);
    }
} catch (e) {}