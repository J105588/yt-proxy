require('dotenv').config();
const express = require('express');
const { spawn, execSync, spawnSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

// GAS 連携設定 (start.bat と合わせる)
const GAS_URL = process.env.GAS_URL;
const GAS_KEY = process.env.GAS_KEY;

// シンプルなメモリキャッシュ
const CACHE = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10分
function fetchCache(args) {
    const key = JSON.stringify(args);
    const entry = CACHE.get(key);
    if (entry && (Date.now() - entry.time < CACHE_TTL)) return entry.data;
    return null;
}
function setCache(args, data) {
    if (!data) return;
    CACHE.set(JSON.stringify(args), { data, time: Date.now() });
    // キャッシュが大きくなりすぎないよう古いものを削除 (簡易実装)
    if (CACHE.size > 200) CACHE.delete(CACHE.keys().next().value);
}



// ユーザー管理・認証
const USERS_FILE = 'users.json';
const SESSIONS_FILE = 'sessions.json';
const HISTORY_DIR = path.join(__dirname, 'history');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR);
const FAVORITES_DIR = path.join(__dirname, 'favorites');
if (!fs.existsSync(FAVORITES_DIR)) fs.mkdirSync(FAVORITES_DIR);
const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);
const OP_LOG_FILE = path.join(LOGS_DIR, 'operations.jsonl');

const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

function hashPasswordSync(password, salt) {
    return crypto.scryptSync(password, salt, 64).toString('hex');
}

async function hashPassword(password, salt) {
    const derivedKey = await scryptAsync(password, salt, 64);
    return derivedKey.toString('hex');
}

function generateSalt() {
    return crypto.randomBytes(16).toString('hex');
}

function getNicoUserSessionFromCookies() {
    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (!fs.existsSync(cookiesPath)) return null;
    try {
        const content = fs.readFileSync(cookiesPath, 'utf8');
        const lines = content.split(/\r?\n/);
        for (const line of lines) {
            if (line.startsWith('#') || !line.trim()) continue;
            const parts = line.split('\t');
            if (parts.length >= 7 && parts[0].includes('nicovideo.jp') && parts[5] === 'user_session') {
                return parts[6].trim();
            }
        }
    } catch (e) {
        console.error('Failed to parse cookies.txt:', e.message);
    }
    return null;
}

function getUsers() {
    if (!fs.existsSync(USERS_FILE)) return [];
    try {
        return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    } catch (e) { return []; }
}

function saveUsers(users) {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// 既存ユーザーのマイグレーションと初期管理者ユーザーの作成
(function migrateAndInitAdmin() {
    let users = getUsers();
    let updated = false;

    // 既存ユーザーのマイグレーション (固定ソルト 'yt-proxy-salt' を割り当て)
    users.forEach(u => {
        if (!u.salt) {
            u.salt = 'yt-proxy-salt';
            updated = true;
        }
    });

    if (users.length === 0) {
        console.log('======================================================');
        console.log('[Init] Creating default admin user...');
        
        // ランダムな12文字の英数字パスワードを生成
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let randomPassword = '';
        for (let i = 0; i < 12; i++) {
            randomPassword += chars.charAt(Math.floor(Math.random() * chars.length));
        }

        const salt = generateSalt();
        const adminUser = {
            username: 'admin',
            salt: salt,
            password: hashPasswordSync(randomPassword, salt),
            role: 'admin',
            created: Date.now()
        };
        users.push(adminUser);
        updated = true;

        console.log('\n  ★ INITIAL ADMIN PASSWORD GENERATED ★');
        console.log(`  Username: admin`);
        console.log(`  Password: ${randomPassword}`);
        console.log('  Please log in and change your password immediately!\n');
        console.log('======================================================');
    }

    if (updated) {
        saveUsers(users);
    }
})();

// 簡易セッション管理 (ファイル永続化)
let SESSIONS = new Map();
function loadSessions() {
    if (!fs.existsSync(SESSIONS_FILE)) return;
    try {
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        SESSIONS = new Map(Object.entries(data));
    } catch (e) { SESSIONS = new Map(); }
}
function saveSessions() {
    try {
        const obj = Object.fromEntries(SESSIONS);
        fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) { }
}
loadSessions();

function createSession(user) {
    const token = crypto.randomUUID();
    SESSIONS.set(token, { username: user.username, role: user.role, time: Date.now() });
    saveSessions();
    return token;
}

function getSession(token) {
    const session = SESSIONS.get(token);
    if (session && (Date.now() - session.time < 24 * 60 * 60 * 1000)) {
        session.time = Date.now(); // 最終アクティブ時間を更新
        saveSessions();
        return session;
    }
    return null;
}

// 認証ミドルウェア
function auth(req, res, next) {
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else {
        // HTML要素 (img, video) の直接リクエストなどのためクエリパラメータもフォールバックとして許容
        token = req.query.token || req.headers['authorization'];
    }
    const session = getSession(token);
    if (!session) return res.status(401).json({ error: 'Unauthorized' });
    req.user = session;
    next();
}

// 操作ログの記録用ミドルウェア
function logOperation(req, res, next) {
    const pathName = req.path;
    // 静的ファイルや無関係なルートを除外して、APIとストリーム再生ルートのみ記録
    if (!pathName.startsWith('/api') && !pathName.startsWith('/stream')) {
        return next();
    }

    const start = Date.now();

    res.on('finish', () => {
        // 頻繁に呼び出されるノイズ系ルートは除外
        if (pathName === '/api/me' || pathName === '/api/favorites/check' ||
            pathName === '/stop-stream' || pathName === '/proxy-img') {
            return;
        }

        const duration = Date.now() - start;
        const status = res.statusCode;

        // ユーザー情報の特定
        // authミドルウェアを通らないルート（/stream-bytes 等）では req.user が未設定のため、
        // クエリパラメータまたはAuthorizationヘッダーのトークンからSESSIONSを直接ルックアップして補完する
        let username = 'guest';
        let role = '-';
        if (req.user) {
            username = req.user.username;
            role = req.user.role;
        } else {
            // トークンをクエリパラメータまたはAuthorizationヘッダーから取得
            let rawToken = req.query.token;
            if (!rawToken) {
                const authHeader = req.headers['authorization'];
                if (authHeader && authHeader.startsWith('Bearer ')) {
                    rawToken = authHeader.substring(7);
                } else if (authHeader) {
                    rawToken = authHeader;
                }
            }
            if (rawToken) {
                const sess = SESSIONS.get(rawToken);
                if (sess) {
                    username = sess.username;
                    role = sess.role;
                }
            } else if (req.query.user || req.query.username) {
                // ログインAPIなど認証前リクエストの場合はユーザー名パラメータを使用
                username = req.query.user || req.query.username;
            }
        }

        // アクション名と詳細情報の整理（クエリ等から機密情報を削除）
        let action = 'APIリクエスト';
        let details = {};

        const queryParams = { ...req.query };
        delete queryParams.pass;
        delete queryParams.newPass;
        delete queryParams.token;

        if (pathName === '/api/login') {
            action = 'ログイン';
            details = { user: queryParams.user };
        } else if (pathName === '/api/signup') {
            action = 'ユーザー作成';
            details = { user: queryParams.user };
        } else if (pathName === '/api/admin/delete-user') {
            action = 'ユーザー削除';
            details = { user: queryParams.user };
        } else if (pathName === '/api/admin/change-password') {
            action = 'パスワード変更';
            details = { user: queryParams.user };
        } else if (pathName === '/api/admin/impersonate') {
            action = 'なりすましログイン';
            details = { impersonatedUser: queryParams.username };
        } else if (pathName === '/api/admin/logs') {
            action = 'システムログ閲覧';
        } else if (pathName === '/api/admin/command') {
            action = 'サーバー再起動';
        } else if (pathName === '/api/favorites/add') {
            action = 'お気に入り追加';
            details = { id: queryParams.id, title: queryParams.title };
        } else if (pathName === '/api/favorites/remove') {
            action = 'お気に入り削除';
            details = { id: queryParams.id };
        } else if (pathName === '/api/search') {
            action = '動画検索';
            details = { q: queryParams.q };
        } else if (pathName === '/api/video') {
            action = '動画情報取得';
            details = { id: queryParams.id };
        } else if (pathName.startsWith('/stream')) {
            action = '動画ストリーミング';
            details = { id: queryParams.id || queryParams.v };
        } else if (pathName === '/api/channel') {
            action = 'チャンネル情報取得';
            details = { id: queryParams.id };
        } else {
            action = `API: ${pathName}`;
            details = queryParams;
        }

        const ip = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';

        const logEntry = {
            time: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
            timestamp: Date.now(),
            username,
            role,
            action,
            path: pathName,
            ip,
            status,
            duration,
            details: Object.keys(details).length > 0 ? JSON.stringify(details) : '-'
        };

        try {
            fs.appendFileSync(OP_LOG_FILE, JSON.stringify(logEntry) + '\n', 'utf8');
        } catch (e) {
            console.error('Failed to write operation log:', e);
        }
    });

    next();
}

app.use(logOperation);

// 閲覧履歴の記録
function recordHistory(user, video) {
    const username = path.basename(user.username);
    const historyFile = path.join(HISTORY_DIR, `${username}.json`);
    let history = [];
    try {
        if (fs.existsSync(historyFile)) {
            history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
        }
    } catch (e) { }

    const entry = {
        id: video.id,
        title: video.title,
        uploader: video.uploader,
        thumbnail: video.thumbnail || '',
        isNico: !!video.isNico,
        time: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    };

    // 重複削除して先頭に追加
    history = [entry, ...history.filter(h => h.id !== video.id)];
    if (history.length > 500) history = history.slice(0, 500);

    try {
        fs.writeFileSync(historyFile, JSON.stringify(history, null, 2), 'utf8');
    } catch (e) { }
}

// yt-dlp 実行ヘルパー (同期版)
function runYtDlp(args, timeout = 30000) {
    const cached = fetchCache(args);
    if (cached) return cached;

    // スピード向上のための共通引数
    const finalArgs = [
        '--no-check-certificate',
        '--no-call-home',
        '--retries', '10',
        '--fragment-retries', '10',
        '--socket-timeout', '20',
        ...args
    ];

    const cookiesPath = path.join(__dirname, 'cookies.txt');
    if (fs.existsSync(cookiesPath)) {
        finalArgs.push('--cookies', cookiesPath);
    }

    try {
        const res = spawnSync('yt-dlp', finalArgs, { timeout, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
        if (res.error) {
            console.error('yt-dlp spawn error:', res.error);
            return '';
        }
        const out = res.stdout || '';
        setCache(args, out);
        return out;
    } catch (e) {
        console.error('yt-dlp execution exception:', e.message);
        return '';
    }
}

// --- ニコニコ動画用ヘルパー関数 ---
function isNicoId(id) {
    if (!id) return false;
    return /^(sm|so|nm|am|fz|ut|sp|ax|ca|yo|nl|ig|na|sd|lv)\d+$/.test(id) || /^\d+$/.test(id);
}

function formatDuration(sec) {
    if (!sec) return '0:00';
    const hrs = Math.floor(sec / 3600);
    const mins = Math.floor((sec % 3600) / 60);
    const secs = sec % 60;
    let ret = "";
    if (hrs > 0) {
        ret += hrs + ":" + (mins < 10 ? "0" : "");
    }
    ret += mins + ":" + (secs < 10 ? "0" : "");
    ret += secs;
    return ret;
}

function getNicoStreamInfo(id) {
    const args = ['--no-cache-dir', '--dump-json', `https://www.nicovideo.jp/watch/${id}`];
    const cached = fetchCache(args);
    if (cached) {
        try { return JSON.parse(cached); } catch (e) { }
    }

    try {
        const out = runYtDlp(args, 20000);
        if (!out) return null;
        const info = JSON.parse(out);
        setCache(args, out);
        return info;
    } catch (e) {
        console.error('getNicoStreamInfo error:', e.message);
        return null;
    }
}

async function getNicoStreamInfoAsync(id) {
    const args = ['--no-cache-dir', '--dump-json', `https://www.nicovideo.jp/watch/${id}`];
    const cached = fetchCache(args);
    if (cached) {
        try { return JSON.parse(cached); } catch (e) { }
    }

    try {
        const out = await runYtDlpAsync(args, 20000);
        if (!out) return null;
        const info = JSON.parse(out);
        setCache(args, out);
        return info;
    } catch (e) {
        console.error('getNicoStreamInfoAsync error:', e.message);
        return null;
    }
}

// --- 認証API ---

app.get('/api/signup', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { user, pass } = req.query;
    if (!user || !pass) return res.status(400).json({ error: 'IDとパスワードが必要です' });

    // ユーザー名の文字種制限 (英数字、ハイフン、アンダースコア、3-20文字)
    if (!/^[a-zA-Z0-9_-]{3,20}$/.test(user)) {
        return res.status(400).json({ error: 'ユーザー名は3〜20文字の半角英数字、ハイフン、アンダースコアのみ使用できます' });
    }

    let users = getUsers();
    if (users.find(u => u.username === user)) return res.status(400).json({ error: '既に使用されているユーザー名です' });

    const salt = generateSalt();
    const newUser = {
        username: user,
        salt: salt,
        password: await hashPassword(pass, salt),
        role: 'user', // 管理者が作成するのは一般ユーザー
        created: Date.now()
    };
    users.push(newUser);
    saveUsers(users);

    const token = createSession(newUser);
    res.json({ token, username: newUser.username, role: newUser.role });
});

app.get('/api/login', async (req, res) => {
    const { user, pass } = req.query;
    if (!user || !pass) return res.status(400).json({ error: 'ユーザー名とパスワードが必要です' });

    const users = getUsers();
    const target = users.find(u => u.username === user);
    if (!target) return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });

    // 個別ソルトを用いてパスワードハッシュを計算して比較
    const calculatedHash = await hashPassword(pass, target.salt || 'yt-proxy-salt');
    if (target.password !== calculatedHash) {
        return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });
    }

    const token = createSession(target);
    res.json({ token, username: target.username, role: target.role });
});

app.get('/api/me', auth, (req, res) => {
    res.json(req.user);
});

// --- 歴史API ---
app.get('/api/history', auth, (req, res) => {
    const username = path.basename(req.user.username);
    const historyFile = path.join(HISTORY_DIR, `${username}.json`);
    if (!fs.existsSync(historyFile)) return res.json([]);
    try {
        res.json(JSON.parse(fs.readFileSync(historyFile, 'utf8')));
    } catch (e) { res.json([]); }
});

// --- お気に入りAPI ---
app.get('/api/favorites', auth, (req, res) => {
    const username = path.basename(req.user.username);
    const favFile = path.join(FAVORITES_DIR, `${username}.json`);
    if (!fs.existsSync(favFile)) return res.json([]);
    try {
        res.json(JSON.parse(fs.readFileSync(favFile, 'utf8')));
    } catch (e) { res.json([]); }
});

app.get('/api/favorites/add', auth, (req, res) => {
    const { id, title, uploader, isNico, thumbnail } = req.query;
    if (!id) return res.status(400).json({ error: 'IDが必要です' });

    const username = path.basename(req.user.username);
    const favFile = path.join(FAVORITES_DIR, `${username}.json`);
    let favorites = [];
    try {
        if (fs.existsSync(favFile)) {
            favorites = JSON.parse(fs.readFileSync(favFile, 'utf8'));
        }
    } catch (e) { }

    if (favorites.some(f => f.id === id)) {
        return res.json({ success: true, message: 'すでにお気に入りに追加されています' });
    }

    const entry = {
        id: id,
        title: title || '無題',
        uploader: uploader || '不明',
        isNico: isNico === 'true' || isNico === true,
        thumbnail: thumbnail || '',
        time: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
    };

    favorites = [entry, ...favorites];
    if (favorites.length > 500) favorites = favorites.slice(0, 500);

    try {
        fs.writeFileSync(favFile, JSON.stringify(favorites, null, 2), 'utf8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/favorites/remove', auth, (req, res) => {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'IDが必要です' });

    const username = path.basename(req.user.username);
    const favFile = path.join(FAVORITES_DIR, `${username}.json`);
    if (!fs.existsSync(favFile)) return res.json({ success: true });

    let favorites = [];
    try {
        favorites = JSON.parse(fs.readFileSync(favFile, 'utf8'));
    } catch (e) { }

    favorites = favorites.filter(f => f.id !== id);

    try {
        fs.writeFileSync(favFile, JSON.stringify(favorites, null, 2), 'utf8');
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/favorites/check', auth, (req, res) => {
    const { id } = req.query;
    if (!id) return res.json({ isFavorite: false });

    const username = path.basename(req.user.username);
    const favFile = path.join(FAVORITES_DIR, `${username}.json`);
    if (!fs.existsSync(favFile)) return res.json({ isFavorite: false });

    try {
        const favorites = JSON.parse(fs.readFileSync(favFile, 'utf8'));
        const isFavorite = favorites.some(f => f.id === id);
        res.json({ isFavorite });
    } catch (e) {
        res.json({ isFavorite: false });
    }
});

// --- 管理者API ---
app.get('/api/admin/users', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const users = getUsers().map(u => ({ username: u.username, role: u.role, created: u.created }));
    res.json(users);
});

app.get('/api/admin/impersonate', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { username } = req.query;
    if (!username) return res.status(400).json({ error: 'ユーザー名が必要です' });

    const users = getUsers();
    const targetUser = users.find(u => u.username === username);
    if (!targetUser) return res.status(404).json({ error: '指定されたユーザーが見つかりません' });

    // ターゲットユーザーのセッションを作成してトークンを発行
    const token = createSession(targetUser);
    console.log(`[Admin] Impersonated login as user: ${username} by admin: ${req.user.username}`);
    
    res.json({ token, username: targetUser.username, role: targetUser.role });
});

app.get('/api/admin/all-history', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    try {
        const users = getUsers();
        const allHistory = {};
        users.forEach(u => {
            const username = path.basename(u.username);
            const historyFile = path.join(HISTORY_DIR, `${username}.json`);
            if (fs.existsSync(historyFile)) {
                try {
                    allHistory[u.username] = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
                } catch (e) {
                    allHistory[u.username] = [];
                }
            } else {
                allHistory[u.username] = [];
            }
        });
        res.json(allHistory);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/user-history', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { user } = req.query;
    if (!user) return res.status(400).json({ error: 'ユーザー名が必要です' });

    const username = path.basename(user);
    const historyFile = path.join(HISTORY_DIR, `${username}.json`);
    if (!fs.existsSync(historyFile)) return res.json([]);
    try {
        res.json(JSON.parse(fs.readFileSync(historyFile, 'utf8')));
    } catch (e) {
        res.json([]);
    }
});


app.get('/api/admin/delete-user', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { user } = req.query;
    let users = getUsers();
    users = users.filter(u => u.username !== user);
    saveUsers(users);
    res.json({ success: true });
});

app.get('/api/admin/change-password', auth, async (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const { user, newPass } = req.query;
    if (!user || !newPass) return res.status(400).json({ error: 'ユーザー名と新しいパスワードが必要です' });

    let users = getUsers();
    const targetIdx = users.findIndex(u => u.username === user);
    if (targetIdx === -1) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    // パスワード変更時に新しいランダムソルトを生成して適用
    const salt = generateSalt();
    users[targetIdx].salt = salt;
    users[targetIdx].password = await hashPassword(newPass, salt);
    saveUsers(users);
    res.json({ success: true });
});

app.get('/api/admin/logs', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    const logPath = path.join(__dirname, 'tunnel.log');
    if (!fs.existsSync(logPath)) return res.json({ logs: 'Log file not found.' });

    try {
        const stats = fs.statSync(logPath);
        const size = stats.size;
        const readSize = Math.min(size, 50000); // 末尾50KB
        const fd = fs.openSync(logPath, 'r');
        const buffer = Buffer.alloc(readSize);
        fs.readSync(fd, buffer, 0, readSize, size - readSize);
        fs.closeSync(fd);
        res.json({ logs: buffer.toString('utf8') });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/operation-logs', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    if (!fs.existsSync(OP_LOG_FILE)) return res.json([]);

    try {
        const content = fs.readFileSync(OP_LOG_FILE, 'utf8');
        const lines = content.trim().split('\n').filter(Boolean);
        const targetLines = lines.slice(-2000).reverse();
        const logs = targetLines.map(line => JSON.parse(line));
        res.json(logs);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/api/admin/command', auth, (req, res) => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });

    res.json({
        stdout: 'Restarting server... Please wait 10-20 seconds and refresh.',
        stderr: '',
        error: null
    });

    const { spawn } = require('child_process');
    const child = spawn('cmd.exe', ['/c', 'start', 'restart.bat'], {
        detached: true,
        stdio: 'ignore',
        cwd: __dirname
    });
    child.unref();

    setTimeout(() => {
        console.log("Server self-exiting for restart...");
        process.exit(0);
    }, 1000);
});
function runYtDlpAsync(args, timeout = 30000) {
    const cached = fetchCache(args);
    if (cached) return Promise.resolve(cached);

    return new Promise((resolve) => {
        let stdout = '';
        const finalArgs = [
            '--no-check-certificate',
            '--no-call-home',
            '--retries', '10',
            '--fragment-retries', '10',
            '--socket-timeout', '20',
            '--extractor-args', 'youtube:player_client=android,mweb;lang=ja;region=jp',
            ...args
        ];
        const cookiesPath = path.join(__dirname, 'cookies.txt');
        if (fs.existsSync(cookiesPath)) {
            finalArgs.push('--cookies', cookiesPath);
        }
        const proc = spawn('yt-dlp', finalArgs);

        const timeoutId = setTimeout(() => {
            proc.kill();
            console.error('yt-dlp async timeout:', args.join(' '));
            resolve('');
        }, timeout);

        proc.stdout.on('data', (data) => { stdout += data; });

        proc.on('close', (code) => {
            clearTimeout(timeoutId);
            setCache(args, stdout);
            resolve(stdout);
        });

        proc.on('error', (err) => {
            clearTimeout(timeoutId);
            console.error('yt-dlp async spawn error:', err);
            resolve('');
        });
    });
}

// SPA メイン
app.get('/', (req, res) => {
    try {
        const filePath = path.join(__dirname, 'public', 'index.html');
        let html = fs.readFileSync(filePath, 'utf8');
        const proto = req.headers['x-forwarded-proto'] || req.protocol;
        const tunnelUrl = `${proto}://${req.get('host')}`;
        html = html.replace(/\{\{TUNNEL_URL\}\}/g, tunnelUrl);
        const gasUrl = process.env.GAS_URL || '';
        html = html.replace(/\{\{GAS_URL\}\}/g, gasUrl);
        res.send(html);
    } catch (e) {
        console.error("Failed to load index.html:", e.message);
        res.status(500).send("Error loading page");
    }
});

// yt-dlp結果を分類するヘルパー
function classifyResult(item) {
    if (!item) return null;
    const id = item.id || '';

    // 11文字の動画ID
    if (/^[a-zA-Z0-9_-]{11}$/.test(id)) {
        item._resultType = 'video';
        return item;
    }
    // チャンネル (UC prefix or channel browse page)
    if (id.startsWith('UC') || (item.ie_key === 'YoutubeTab' && item.url && item.url.includes('/browse/UC'))) {
        item._resultType = 'channel';
        item._channelId = id.startsWith('UC') ? id : (item.url ? item.url.split('/').pop() : id);
        item._channelName = item.title || item.playlist_title || id;
        return item;
    }
    // プレイリスト (PL prefix, RD prefix, OL prefix)
    if (id.startsWith('PL') || id.startsWith('RD') || id.startsWith('OL') || id.startsWith('UU')) {
        item._resultType = 'playlist';
        item._playlistId = id;
        item._playlistTitle = item.title || item.playlist_title || id;
        return item;
    }
    // その他 (アルバム等 MPRE prefix)
    if (id.startsWith('MPRE') || item.ie_key === 'YoutubeTab') {
        item._resultType = 'album';
        return item;
    }
    // 不明だがIDがあるもの（スキップ）
    return null;
}

// JSON API 検索
app.get('/api/search', auth, async (req, res) => {
    let q = req.query.q || "";
    let type = req.query.type || "all";
    let start = parseInt(req.query.start) || 1;

    // 急上昇モード: クエリが空のとき
    let isTrending = false;
    if (!q) {
        if (type === 'music') q = '人気の曲 2024';
        else if (type === 'live') q = '配信中 ライブ';
        else if (type === 'nico') {
            // 何もしない (qは空のまま検索へ進む)
        } else {
            isTrending = true;
        }
    }

    try {
        const langArgs = ['--extractor-args', 'youtube:lang=ja;region=jp'];

        if (type === 'nico') {
            const searchUrl = 'https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search';
            const params = {
                fields: 'contentId,title,viewCounter,lengthSeconds,thumbnailUrl,startTime,userId,channelId',
                _sort: '-viewCounter',
                _offset: Math.max(0, start - 1),
                _limit: 20,
                _context: 'yt-proxy'
            };
            if (q) {
                params.q = q;
                params.targets = 'title,description,tags';
            } else {
                params.q = '';
                params['filters[viewCounter][gte]'] = 10000;
            }

            // ニコニコの履歴からキーワードを抽出し、検索する（おすすめモードのみ）
            let nicoResults = [];
            let seenNicoIds = new Set();
            if (!q) {
                let nicoKeywords = [];
                try {
                    const historyFile = path.join(HISTORY_DIR, `${req.user.username}.json`);
                    if (fs.existsSync(historyFile)) {
                        const historyData = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
                        const nicoHistory = historyData.filter(item => item.isNico);
                        
                        let sampledItems = [];
                        const latestCount = 5;
                        const olderCount = 5;
                        
                        sampledItems = sampledItems.concat(nicoHistory.slice(0, latestCount));
                        
                        const olderPool = nicoHistory.slice(latestCount);
                        if (olderPool.length > 0) {
                            if (olderPool.length <= olderCount) {
                                sampledItems = sampledItems.concat(olderPool);
                            } else {
                                const step = olderPool.length / olderCount;
                                for (let i = 0; i < olderCount; i++) {
                                    const idx = Math.min(Math.floor(i * step), olderPool.length - 1);
                                    sampledItems.push(olderPool[idx]);
                                }
                            }
                        }

                        for (const item of sampledItems) {
                            const kw = extractKeywordFromTitle(item.title);
                            if (kw && !nicoKeywords.includes(kw)) {
                                nicoKeywords.push(kw);
                            }
                        }
                    }
                } catch (e) {
                    console.error("[Nico Recommend] History extract failed:", e.message);
                }

                const targetNicoKeywords = nicoKeywords.slice(0, 3);
                console.log("[Nico Recommend] History Keywords:", targetNicoKeywords);

                // 履歴ワードで並列検索
                const nicoTasks = targetNicoKeywords.map(kw => searchNico(kw, 3));
                const nicoTaskResults = await Promise.all(nicoTasks);
                nicoTaskResults.forEach(results => {
                    (results || []).forEach(v => {
                        if (v && v.id && !seenNicoIds.has(v.id)) {
                            seenNicoIds.add(v.id);
                            nicoResults.push(v);
                        }
                    });
                });
            }

            const response = await axios.get(searchUrl, {
                params,
                headers: {
                    'User-Agent': 'yt-proxy/1.0',
                    'X-Frontend-Id': '70',
                    'X-Frontend-Version': '0'
                },
                timeout: 10000
            });

            const data = response.data;
            if (data && data.meta && data.meta.status === 200) {
                const searchResults = (data.data || []).map(item => {
                    let uploader = 'ニコニコユーザー';
                    if (item.channelId) uploader = `チャンネル: ${item.channelId}`;
                    else if (item.userId) uploader = `ユーザー: ${item.userId}`;

                    return {
                        id: item.contentId,
                        title: item.title,
                        uploader: uploader,
                        uploader_id: item.userId ? String(item.userId) : (item.channelId ? String(item.channelId) : ''),
                        view_count: item.viewCounter || 0,
                        duration_string: formatDuration(item.lengthSeconds),
                        thumbnail: item.thumbnailUrl,
                        isNico: true,
                        _resultType: 'video'
                    };
                });

                // 履歴ワード検索結果を先頭にしてマージ
                const combined = [];
                nicoResults.forEach(v => {
                    combined.push(v);
                });
                searchResults.forEach(v => {
                    if (!seenNicoIds.has(v.id)) {
                        seenNicoIds.add(v.id);
                        combined.push(v);
                    }
                });

                return res.json({
                    results: combined.slice(0, 20),
                    next_start: start + 20
                });
            } else {
                throw new Error(data && data.meta ? data.meta.errorMessage : 'Niconico API error');
            }
        }

        // --- 急上昇モード: GASトレンドキーワード + 人気カテゴリ検索 ---
        if (isTrending && start === 1) {
            const seenIds = new Set();
            let allResults = [];

            // (1) ユーザーの閲覧履歴からYouTube動画履歴を取得し、その「関連動画」を取得（YouTube本家基準）
            try {
                const historyFile = path.join(HISTORY_DIR, `${req.user.username}.json`);
                if (fs.existsSync(historyFile)) {
                    const historyData = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
                    const ytHistory = historyData.filter(item => !item.isNico);
                    
                    // 直近最大5件の動画IDを対象とする
                    const recentYtIds = ytHistory.slice(0, 5).map(item => item.id);
                    if (recentYtIds.length > 0) {
                        console.log(`[Recommend] Generating recommendations from user history (${recentYtIds.length} videos)`);
                        
                        // 各履歴動画の関連動画を並列フェッチ
                        const relatedPromises = recentYtIds.map(id => getRelatedVideosFromYouTube(id));
                        const relatedResultsRaw = await Promise.all(relatedPromises);
                        
                        // ラウンドロビン方式でブレンドマージする
                        // 例：[動画1の関連1, 動画2の関連1, 動画3の関連1, 動画1の関連2, ...]
                        let maxLen = Math.max(...relatedResultsRaw.map(list => list.length));
                        for (let i = 0; i < maxLen; i++) {
                            for (let j = 0; j < relatedResultsRaw.length; j++) {
                                const list = relatedResultsRaw[j];
                                if (i < list.length) {
                                    const v = list[i];
                                    if (v && v.id && !seenIds.has(v.id)) {
                                        seenIds.add(v.id);
                                        allResults.push(v);
                                    }
                                }
                            }
                        }
                        console.log(`[Recommend] Extracted ${allResults.length} related videos from history.`);
                    }
                }
            } catch (e) {
                console.error("[Recommend] Failed to generate history recommendations:", e.message);
            }

            // (2) 不足分、または履歴がない場合はトレンドキーワードで補完 (最大24件)
            if (allResults.length < 24) {
                const neededCount = 24 - allResults.length;
                console.log(`[Recommend] Filling ${neededCount} missing spots with trending searches.`);
                
                // RSSからトレンドキーワードを取得
                let trendKeywords = [];
                try {
                    const trends = await getTrendsFromRSS();
                    if (trends && trends.keywords) {
                        trendKeywords = trends.keywords;
                    }
                } catch (e) {
                    console.error("[Trending] RSS fetch failed:", e.message);
                }
                
                // フォールバック: 日本で人気のある検索カテゴリ
                if (trendKeywords.length === 0) {
                    const now = new Date();
                    const year = now.getFullYear();
                    trendKeywords = [
                        `${year} MV 新曲`,
                        'ゲーム実況 最新',
                        'アニメ OP ED',
                        'バラエティ 面白い',
                        'ニュース 速報 今日',
                        'Vtuber 切り抜き',
                    ];
                }

                // トレンドワードで順次検索を実行
                // 枠の不足分を満たすため、各キーワードから2〜3件ずつ検索結果をマージする
                const trendRaw = [];
                for (const kw of trendKeywords) {
                    const out = await runYtDlpAsync([
                        `ytsearch3:${kw}`,
                        '--dump-json',
                        '--flat-playlist',
                        '--no-warnings',
                        ...langArgs
                    ], 25000).catch(() => "");
                    trendRaw.push(out);
                }

                trendRaw.forEach(out => {
                    if (!out) return;
                    out.split('\n').filter(l => l.trim()).forEach(l => {
                        try {
                            const v = JSON.parse(l);
                            if (v && v.id && !seenIds.has(v.id)) {
                                seenIds.add(v.id);
                                allResults.push(v);
                            }
                        } catch (e) { }
                    });
                });
            }

            return res.json({ results: allResults.slice(0, 24), next_start: 25, trending: true });
        }

        // --- 通常検索モード ---
        // 音楽タイプ: YouTube本体で音楽カテゴリフィルタを使用（music.youtube.comはアルバム等が返って再生不能）
        let searchUrl;
        const maxResults = start + 19;
        if (q.startsWith('http')) {
            // qがURLの場合はそのまま使用 (再生リストのURLなどが渡された場合)
            searchUrl = q;
        } else if (type === 'music') {
            searchUrl = `ytsearch${maxResults}:${q} 公式MV`;
        } else if (type === 'live') {
            searchUrl = `ytsearch${maxResults}:${q} live`;
        } else {
            searchUrl = `ytsearch${maxResults}:${q}`;
        }

        const out = await runYtDlpAsync([
            searchUrl,
            '--dump-json',
            '--flat-playlist',
            '--playlist-start', String(start),
            '--playlist-end', String(maxResults),
            '--no-warnings',
            ...langArgs
        ], 20000);

        const rawResults = out.split('\n').filter(l => l.trim()).map(l => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(v => v);

        // 分類
        const classified = rawResults.map(classifyResult).filter(v => v);

        // 動画のみ抽出
        const videoResults = classified.filter(v => v._resultType === 'video');

        // チャンネルとプレイリストも別途返す
        const channels = classified.filter(v => v._resultType === 'channel').slice(0, 3);
        const playlists = classified.filter(v => v._resultType === 'playlist').slice(0, 3);

        // 音楽タイプの場合はMUSICバッジを付与
        if (type === 'music') {
            videoResults.forEach(v => v.isMusic = true);
        }

        res.json({
            results: videoResults,
            channels,
            playlists,
            next_start: start + 20
        });
    } catch (e) {
        console.error("SEARCH CRASH:", e.message, e.stack);
        res.status(500).json({ error: e.message });
    }
});

// JSON API チャンネル
app.get('/api/channel', auth, async (req, res) => {
    let id = req.query.id || '';
    const tab = req.query.tab || 'videos';
    const start = parseInt(req.query.start) || 1;
    if (!id) return res.status(400).json({ error: 'IDが必要です' });

    try {
        const isNicoChannel = /^ch\d+$/.test(id);
        const isNicoUser = /^\d+$/.test(id);
        const isNico = isNicoChannel || isNicoUser;

        if (isNico) {
            let channelInfo = {
                title: '',
                uploader_id: id,
                channel_id: id,
                description: '',
                subscriber_count: '非表示',
                avatar: '',
                banner: ''
            };
            let results = [];

            if (isNicoChannel) {
                console.log(`[Channel] Fetching Niconico Channel RSS: ${id}`);
                const rssUrl = `https://ch.nicovideo.jp/${id}/video?rss=2.0`;
                const response = await axios.get(rssUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0' },
                    timeout: 10000
                });
                const xmlText = response.data || '';

                const channelTitleMatch = xmlText.match(/<title>([^<]+)<\/title>/);
                const channelDescMatch = xmlText.match(/<description>([^<]+)<\/description>/);

                channelInfo.title = channelTitleMatch ? channelTitleMatch[1].replace(' チャンネル動画‐niconico', '') : id;
                channelInfo.description = channelDescMatch ? channelDescMatch[1] : '';
                channelInfo.avatar = `https://secure-dcdn.cdn.nimg.jp/comch/channel-icon/128x128/${id}.jpg`;

                const itemRegex = /<item>([\s\S]*?)<\/item>/g;
                let match;
                while ((match = itemRegex.exec(xmlText)) !== null) {
                    const itemContent = match[1];
                    const titleMatch = itemContent.match(/<title>([^<]+)<\/title>/);
                    const linkMatch = itemContent.match(/<link>([^<]+)<\/link>/);
                    const descMatch = itemContent.match(/<description>([\s\S]*?)<\/description>/);

                    if (titleMatch && linkMatch) {
                        const title = titleMatch[1];
                        const link = linkMatch[1];
                        const videoIdMatch = link.match(/watch\/([a-z0-9]+)/);
                        const videoId = videoIdMatch ? videoIdMatch[1] : '';

                        let thumbnail = '';
                        if (descMatch) {
                            const thumbMatch = descMatch[1].match(/src="([^"]+)"/);
                            if (thumbMatch) thumbnail = thumbMatch[1];
                        }

                        if (videoId) {
                            results.push({
                                id: videoId,
                                title: title,
                                thumbnail: thumbnail,
                                uploader: channelInfo.title,
                                uploader_id: id,
                                duration_string: '--:--',
                                view_count: 0,
                                isNico: true,
                                _resultType: 'video'
                            });
                        }
                    }
                }
            } else {
                console.log(`[Channel] Fetching Niconico User Profile: ${id}`);
                const profileUrl = `https://nvapi.nicovideo.jp/v1/users/${id}`;
                const videosUrl = `https://nvapi.nicovideo.jp/v3/users/${id}/videos`;

                const headers = {
                    'User-Agent': 'Mozilla/5.0',
                    'X-Frontend-Id': '70',
                    'X-Frontend-Version': '0'
                };

                const [profileRes, videosRes] = await Promise.all([
                    axios.get(profileUrl, { headers, timeout: 10000 }).catch(() => null),
                    axios.get(videosUrl, {
                        params: { sortKey: 'registeredAt', sortOrder: 'desc', pageSize: 30, page: 1 },
                        headers,
                        timeout: 10000
                    }).catch(() => null)
                ]);

                if (profileRes && profileRes.data && profileRes.data.data) {
                    const u = profileRes.data.data.user;
                    channelInfo.title = u.nickname || id;
                    channelInfo.description = u.description || '';
                    channelInfo.avatar = u.icons ? (u.icons.large || u.icons.small) : '';
                    channelInfo.subscriber_count = u.followerCount !== undefined ? u.followerCount.toLocaleString() : '非表示';
                } else {
                    channelInfo.title = `ユーザー: ${id}`;
                }

                if (videosRes && videosRes.data && videosRes.data.data && videosRes.data.data.items) {
                    results = videosRes.data.data.items.map(item => {
                        const ess = item.essential;
                        return {
                            id: ess.id,
                            title: ess.title,
                            thumbnail: ess.thumbnail ? (ess.thumbnail.url || ess.thumbnail.largeUrl || ess.thumbnail.listingUrl) : '',
                            uploader: channelInfo.title,
                            uploader_id: id,
                            duration_string: formatDuration(ess.duration),
                            view_count: ess.count ? ess.count.view : 0,
                            isNico: true,
                            _resultType: 'video'
                        };
                    });
                }
            }

            return res.json({
                channelInfo,
                results,
                next_start: start + results.length
            });
        }

        const langArgs = ['--extractor-args', 'youtube:lang=ja;region=jp'];

        let tabEndpoint = 'videos';
        if (tab === 'home') tabEndpoint = 'featured';
        else if (tab === 'shorts') tabEndpoint = 'shorts';
        else if (tab === 'streams') tabEndpoint = 'streams';
        else if (tab === 'playlists') tabEndpoint = 'playlists';

        let channelUrl;
        if (id.startsWith('@')) {
            channelUrl = `https://www.youtube.com/${id}/${tabEndpoint}`;
        } else if (id.startsWith('UC')) {
            channelUrl = `https://www.youtube.com/channel/${id}/${tabEndpoint}`;
        } else {
            channelUrl = `https://www.youtube.com/@${id}/${tabEndpoint}`;
        }

        console.log(`[Channel] Fetching: ${channelUrl}`);

        let metaPromise = Promise.resolve(null);
        if (start === 1) {
            let baseUrl = channelUrl;
            const parts = channelUrl.split('/');
            if (parts[3] === 'channel' && parts[4]) {
                baseUrl = `https://www.youtube.com/channel/${parts[4]}`;
            } else if (parts[3]) {
                baseUrl = `https://www.youtube.com/${parts[3]}`;
            }
            metaPromise = runYtDlpAsync([
                baseUrl,
                '--dump-single-json',
                '--playlist-end', '1',
                '--no-warnings',
                ...langArgs
            ], 15000).then(res => {
                try { return JSON.parse(res); } catch (e) { return null; }
            }).catch(() => null);
        }

        const entriesPromise = runYtDlpAsync([
            channelUrl,
            '--dump-json',
            '--flat-playlist',
            '--playlist-start', String(start),
            '--playlist-end', String(start + 29),
            '--no-warnings',
            ...langArgs
        ], 25000);

        const [metaData, entriesOut] = await Promise.all([metaPromise, entriesPromise]);

        const results = entriesOut ? entriesOut.split('\n').filter(l => l.trim()).map(l => {
            try { return JSON.parse(l); } catch (e) { return null; }
        }).filter(v => v) : [];

        const meta = metaData || results[0] || {};

        let channelInfo = {
            title: meta.title || meta.playlist_channel || meta.uploader || meta.channel || id.replace('@', ''),
            uploader_id: meta.uploader_id || meta.playlist_uploader_id || id,
            channel_id: meta.channel_id || meta.playlist_channel_id || id,
            description: meta.description || meta.playlist_description || "",
            subscriber_count: meta.channel_follower_count || meta.subscriber_count || "非表示",
            avatar: meta.avatar || "",
            banner: meta.banner || ""
        };

        if (meta.thumbnails) {
            const avatar = meta.thumbnails.find(t => t.id === 'avatar_uncropped' || (t.url && t.url.toLowerCase().includes('avatar')) || (t.id && t.id.toLowerCase().includes('avatar')));
            const banner = meta.thumbnails.find(t => t.id === 'banner_uncropped' || (t.url && t.url.toLowerCase().includes('banner')) || (t.id && t.id.toLowerCase().includes('banner')));
            if (avatar && !channelInfo.avatar) channelInfo.avatar = avatar.url;
            if (banner && !channelInfo.banner) channelInfo.banner = banner.url;
        }

        if (!channelInfo.avatar) {
            channelInfo.avatar = "https://www.gstatic.com/youtube/media/ytm/images/p2w/profile_avatar.png";
        }

        const videoResults = results.filter(v => v.id && v._type !== 'playlist' && v._type !== 'url' || (v._type === 'url' && !v.url.includes('playlist')));
        const playlistResults = results.filter(v => v.id && (v._type === 'playlist' || (v._type === 'url' && v.url.includes('playlist'))));

        res.json({
            channelInfo,
            results: tab === 'playlists' ? playlistResults : videoResults,
            next_start: start + 30
        });
    } catch (e) {
        console.error("[Channel] Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// JSON API 動画詳細
app.get('/api/video', auth, async (req, res) => {
    let id = req.query.id || "";
    if (id.includes('&')) id = id.split('&')[0];

    try {
        const langArgs = ['--extractor-args', 'youtube:lang=ja;region=jp'];

        if (isNicoId(id)) {
            console.log(`[Video] Niconico ID detected: ${id}`);

            // 1. メイン情報とコメントを並列で取得
            const userSession = getNicoUserSessionFromCookies();
            const headers = {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'X-Frontend-Id': '6',
                'X-Frontend-Version': '0'
            };

            let watchUrl;
            if (userSession) {
                headers['Cookie'] = `user_session=${userSession}`;
                watchUrl = `https://www.nicovideo.jp/api/watch/v3/${id}?actionTrackId=ytproxy_${Date.now()}`;
            } else {
                watchUrl = `https://www.nicovideo.jp/api/watch/v3_guest/${id}?actionTrackId=ytproxy_${Date.now()}`;
            }

            const watchResponse = await axios.get(watchUrl, { headers, timeout: 10000 });
            const watchData = watchResponse.data.data;

            if (!watchData || !watchData.video) {
                throw new Error("ニコニコ動画情報の取得に失敗しました");
            }

            // 履歴記録
            recordHistory(req.user, {
                id: id,
                title: watchData.video.title,
                uploader: watchData.owner ? watchData.owner.nickname : 'ニコニコユーザー',
                thumbnail: watchData.video.thumbnail.ogp || watchData.video.thumbnail.largeUrl || watchData.video.thumbnail.url,
                isNico: true
            });

            // 2. コメント取得
            let comments = [];
            try {
                const nv = watchData.comment.nvComment;
                if (nv && nv.server && nv.threadKey) {
                    const payload = {
                        params: nv.params,
                        threadKey: nv.threadKey,
                        additionals: {}
                    };
                    const cres = await axios.post(nv.server + '/v1/threads', payload, {
                        headers: {
                            'User-Agent': headers['User-Agent'],
                            'X-Frontend-Id': '70',
                            'X-Frontend-Version': '0',
                            'Content-Type': 'application/json'
                        },
                        timeout: 5000
                    });
                    const commentsList = (cres.data.data.threads || []).flatMap(t => t.comments || []);
                    commentsList.sort((a, b) => b.no - a.no);
                    comments = commentsList.slice(0, 40).map(c => ({
                        author: c.userId || 'ゲスト',
                        author_id: c.userId,
                        author_thumbnail: '',
                        text: c.body || '',
                        time: c.postedAt ? new Date(c.postedAt).toLocaleDateString('ja-JP') : ''
                    }));
                }
            } catch (ce) {
                console.error("[Video] Nico comments fetch failed:", ce.message);
            }

            // 3. 関連動画取得 (動画の最初のタグをキーにしてニコニコ検索APIから取得)
            let related = [];
            try {
                const queryTag = (watchData.tag.items && watchData.tag.items[0]) ? watchData.tag.items[0].name : '';
                if (queryTag) {
                    const searchResponse = await axios.get('https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search', {
                        params: {
                            q: queryTag,
                            targets: 'tagsExact',
                            fields: 'contentId,title,viewCounter,lengthSeconds,thumbnailUrl,startTime',
                            _sort: '-viewCounter',
                            _limit: 15,
                            _context: 'yt-proxy'
                        },
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            'Referer': 'https://www.nicovideo.jp/'
                        },
                        timeout: 5000
                    });
                    related = (searchResponse.data.data || [])
                        .filter(item => item.contentId !== id)
                        .map(item => ({
                            id: item.contentId,
                            title: item.title,
                            uploader: 'ニコニコ動画',
                            view_count: item.viewCounter || 0,
                            duration_string: formatDuration(item.lengthSeconds),
                            thumbnail: item.thumbnailUrl
                        }));
                }
            } catch (re) {
                console.error("[Video] Nico related fetch failed:", re.message);
            }

            const isChannelVideo = !!watchData.channel;
            const mappedInfo = {
                id: id,
                title: watchData.video.title,
                description: watchData.video.description,
                uploader: isChannelVideo ? watchData.channel.name : (watchData.owner ? watchData.owner.nickname : 'ニコニコユーザー'),
                uploader_id: isChannelVideo ? watchData.channel.id : (watchData.owner ? String(watchData.owner.id) : ''),
                uploader_url: isChannelVideo ? (watchData.channel.thumbnail ? watchData.channel.thumbnail.url : '') : (watchData.owner ? watchData.owner.iconUrl : ''),
                view_count: watchData.video.viewCounter,
                duration: watchData.video.duration,
                duration_string: formatDuration(watchData.video.duration),
                thumbnail: watchData.video.thumbnail.ogp || watchData.video.thumbnail.largeUrl || watchData.video.thumbnail.url,
                isNico: true
            };

            return res.json({ info: mappedInfo, related, comments });
        }

        // IDが11文字の動画IDでない場合（ミックスリスト RD..., プレイリスト PL... 等）
        if (id && !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
            console.log(`[Video] Non-standard ID detected: ${id}`);

            // yt-dlpで直接URL指定して最初の動画を取得
            const urls = [
                `https://www.youtube.com/watch?v=&list=${id}`,
                `https://www.youtube.com/playlist?list=${id}`,
                `https://www.youtube.com/watch?list=${id}`,
                `https://www.youtube.com/watch?v=${id}`
            ];

            let resolved = false;
            for (const url of urls) {
                try {
                    const resolveOut = await runYtDlpAsync([
                        url,
                        '--flat-playlist',
                        '--playlist-end', '1',
                        '--dump-json',
                        '--no-warnings'
                    ], 25000);

                    if (resolveOut) {
                        const lines = resolveOut.split('\n').filter(l => l.trim());
                        for (const line of lines) {
                            try {
                                const item = JSON.parse(line);
                                // webpage_url から v=XXXX を抽出するのも有効 (プレイリスト自体がヒットした場合など)
                                let foundId = item.id;
                                if (!foundId || !/^[a-zA-Z0-9_-]{11}$/.test(foundId)) {
                                    const match = (item.webpage_url || "").match(/[?&]v=([a-zA-Z0-9_-]{11})/);
                                    const match2 = (item.url || "").match(/[?&]v=([a-zA-Z0-9_-]{11})/);
                                    if (match) foundId = match[1];
                                    else if (match2) foundId = match2[1];
                                }

                                if (foundId && /^[a-zA-Z0-9_-]{11}$/.test(foundId)) {
                                    console.log(`[Video] Resolved to: ${foundId}`);
                                    id = foundId;
                                    resolved = true;
                                    break;
                                }
                            } catch (e) { }
                        }
                    }
                } catch (e) { }
                if (resolved) break;
            }
        }

        if (!id || !/^[a-zA-Z0-9_-]{11}$/.test(id)) {
            return res.status(400).json({ error: '動画IDの特定に失敗しました。この動画は再生できない可能性があります。' });
        }

        // 1. メイン情報 2. 関連動画 3. コメント をすべて並列でリクエスト
        const [mainOut, relOut, commentsRaw] = await Promise.all([
            runYtDlpAsync([
                `https://www.youtube.com/watch?v=${id}`,
                '--dump-json',
                '--no-warnings',
                '--no-playlist',
                '--extractor-args', 'youtube:player_client=android,mweb'
            ], 35000),
            runYtDlpAsync([
                `https://www.youtube.com/watch?v=${id}&list=RD${id}`,
                '--flat-playlist',
                '--dump-json',
                '--playlist-end', '15',
                '--no-warnings'
            ], 35000).catch(() => ""),
            runYtDlpAsync([
                `https://www.youtube.com/watch?v=${id}`,
                '--get-comments',
                '--playlist-items', '0',
                '--dump-json',
                '--no-warnings',
                '--extractor-args', 'youtube:max_comments=20'
            ], 35000).catch(() => "")
        ]);

        const info = JSON.parse(mainOut);
        
        // チャンネルのアイコン画像URL（uploader_avatar）を優先してuploader_urlに格納
        info.uploader_url = info.uploader_avatar || info.uploader_url || "";

        // 履歴記録
        recordHistory(req.user, {
            id: id,
            title: info.title,
            uploader: info.uploader,
            thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
            isNico: false
        });

        // 関連動画の抽出
        let related = info.related_videos || [];
        if (related.length === 0 && relOut) {
            related = relOut.split('\n').filter(l => l.trim()).map(l => {
                try { return JSON.parse(l); } catch (e) { return null; }
            }).filter(v => v && v.id && /^[a-zA-Z0-9_-]{11}$/.test(v.id) && v.id !== id);
        }

        // コメントのパース
        let comments = [];
        if (commentsRaw) {
            try {
                const cData = JSON.parse(commentsRaw);
                comments = (cData.comments || []).map(c => ({
                    author: c.author || c.author_id || '匿名',
                    author_id: c.author_id,
                    author_thumbnail: c.author_thumbnail,
                    text: c.text || '',
                    time: c.timestamp ? new Date(c.timestamp * 1000).toLocaleDateString('ja-JP') : ''
                }));
            } catch (e) { }
        }

        res.json({ info, related, comments });
    } catch (e) {
        console.error("[Video] Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// 変換管理 (プロセス、最終アクセス時刻、ライブ配信かどうかのフラグ)
const conversions = new Map();
const startingConversions = new Map();

function getFileSize(filePath) {
    try {
        if (fs.existsSync(filePath)) {
            return fs.statSync(filePath).size;
        }
    } catch (e) {}
    return 0;
}

async function ensureConversion(id, quality) {
    const isNico = isNicoId(id);
    const convKey = isNico ? id : `${id}_${quality}`;
    const tmpPath = path.join(TMP_DIR, `${convKey}.mp4`);

    if (conversions.has(convKey)) {
        const data = conversions.get(convKey);
        data.lastSeen = Date.now();
        return;
    }

    if (startingConversions.has(convKey)) {
        await startingConversions.get(convKey);
        return;
    }

    const promise = (async () => {
        // 同じ動画IDの他の画質の変換プロセスがあればクリーンアップ (再生中画質切り替え対策)
        for (const [key, data] of conversions.entries()) {
            if (key !== convKey && key.startsWith(id + '_')) {
                console.log(`Killing older quality conversion process for: ${key} (via ensureConversion)`);
                if (data.proc) {
                    try { data.proc.kill('SIGKILL'); } catch (e) {}
                }
                conversions.delete(key);
                const tmpPathOld = path.join(TMP_DIR, `${key}.mp4`);
                if (fs.existsSync(tmpPathOld)) {
                    fs.unlink(tmpPathOld, () => {});
                }
            }
        }

        console.log(`Starting background conversion for: ${convKey} (via ensureConversion)`);
        
        let ffmpeg;
        if (isNico) {
            const info = await getNicoStreamInfoAsync(id);
            if (!info) throw new Error("Could not fetch Niconico stream info");

            const formats = info.formats || [];
            const videoFormat = [...formats].reverse().find(f => f.vcodec !== 'none' && f.acodec === 'none');
            const audioFormat = [...formats].reverse().find(f => f.vcodec === 'none' && f.acodec !== 'none');

            if (!videoFormat || !audioFormat) throw new Error("Separate audio/video formats not found");

            const videoUrl = videoFormat.url;
            const audioUrl = audioFormat.url;
            const cookies = videoFormat.cookies || '';
            const userAgent = (videoFormat.http_headers && videoFormat.http_headers['User-Agent']) ||
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

            const headers = `Cookie: ${cookies}\r\nUser-Agent: ${userAgent}\r\n`;

            ffmpeg = spawn('ffmpeg', [
                '-headers', headers,
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-i', videoUrl,
                '-headers', headers,
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-i', audioUrl,
                '-map', '0:v',
                '-map', '1:a',
                '-f', 'mp4',
                '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                '-c:a', 'aac', '-b:a', '128k',
                '-y', tmpPath
            ]);
        } else {
            let formatStr = 'bestvideo[height<=720]+bestaudio/best[height<=720]/best';
            if (quality === '1080p') {
                formatStr = 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best';
            } else if (quality === '480p') {
                formatStr = 'bestvideo[height<=480]+bestaudio/best[height<=480]/best';
            } else if (quality === '360p') {
                formatStr = 'bestvideo[height<=360]+bestaudio/best[height<=360]/best';
            }

            const directUrl = (await runYtDlpAsync([
                '-g', `https://www.youtube.com/watch?v=${id}`,
                '-f', formatStr,
                '--no-warnings',
                '--no-playlist'
            ], 25000)).trim();

            if (!directUrl) throw new Error("directUrl is empty");

            const urls = directUrl.split('\n').map(u => u.trim()).filter(Boolean);

            if (urls.length >= 2) {
                ffmpeg = spawn('ffmpeg', [
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5',
                    '-i', urls[0],
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5',
                    '-i', urls[1],
                    '-map', '0:v',
                    '-map', '1:a',
                    '-f', 'mp4',
                    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                    '-c:a', 'aac', '-b:a', '128k',
                    '-y', tmpPath
                ]);
            } else {
                ffmpeg = spawn('ffmpeg', [
                    '-reconnect', '1',
                    '-reconnect_streamed', '1',
                    '-reconnect_delay_max', '5',
                    '-i', urls[0],
                    '-f', 'mp4',
                    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
                    '-c:a', 'aac', '-b:a', '128k',
                    '-y', tmpPath
                ]);
            }
        }

        conversions.set(convKey, { proc: ffmpeg, lastSeen: Date.now() });

        ffmpeg.on('close', (code) => {
            console.log(`Conversion process closed for ${convKey} with code ${code}`);
            const data = conversions.get(convKey);
            if (data) {
                data.proc = null;
            }
            if (code !== 0 && code !== null) {
                console.log(`Conversion failed for ${convKey}. Cleaning up.`);
                conversions.delete(convKey);
                if (fs.existsSync(tmpPath)) {
                    fs.unlink(tmpPath, () => { });
                }
            }
        });

        // ffmpegが起動してファイルが出力され始めるのを最大5秒待つ
        await new Promise((resolve) => {
            const checkFile = setInterval(() => {
                if (getFileSize(tmpPath) > 0) {
                    clearInterval(checkFile);
                    resolve();
                }
            }, 250);
            setTimeout(() => {
                clearInterval(checkFile);
                resolve();
            }, 5000);
        });
    })();

    startingConversions.set(convKey, promise);
    try {
        await promise;
    } finally {
        startingConversions.delete(convKey);
    }
}

const TMP_DIR = path.join(__dirname, 'tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR);

function killAllConversions() {
    console.log('[Shutdown] Cleaning up active conversion processes...');
    for (const [id, data] of conversions.entries()) {
        if (data.proc) {
            try {
                console.log(`[Shutdown] Killing ffmpeg process for: ${id}`);
                data.proc.kill('SIGKILL');
            } catch (e) {
                console.error(`[Shutdown] Failed to kill ffmpeg for ${id}:`, e.message);
            }
        }
    }
}

process.on('exit', () => {
    killAllConversions();
});

process.on('SIGINT', () => {
    process.exit(0);
});

process.on('SIGTERM', () => {
    process.exit(0);
});

// 古いプロセスのクリーンアップ (5分間アクセスがないプロセスを終了)
setInterval(() => {
    const now = Date.now();
    for (const [id, data] of conversions.entries()) {
        if (now - data.lastSeen > 300000) { // 5分無活動でキル
            console.log(`Auto-stopping inactive conversion: ${id}`);
            if (data.proc) data.proc.kill();
            conversions.delete(id);
            // テンポラリファイルも削除を試みる
            const tmpPath = path.join(TMP_DIR, `${id}.mp4`);
            if (fs.existsSync(tmpPath)) fs.unlink(tmpPath, () => { });
        }
    }
}, 30000); // 30秒おきにチェック

// バイト単位のリレー (MediaSource用)
app.get('/stream-bytes', async (req, res) => {
    const id = String(req.query.id || "").trim();
    const start = parseInt(req.query.start) || 0;
    const end = parseInt(req.query.end) || 0;
    
    // トークン検証と 1080p 制限
    const token = req.query.token;
    const session = SESSIONS.get(token);
    const isAdmin = session && session.role === 'admin';
    
    let quality = req.query.quality || '480p';
    if (quality === '1080p' && !isAdmin) {
        quality = '720p'; // 一般ユーザーは 720p に強制制限
    }

    if (!id || !/^[a-zA-Z0-9_-]{3,20}$/.test(id)) return res.status(400).send("Invalid ID");

    const isNico = isNicoId(id);
    const convKey = isNico ? id : `${id}_${quality}`;
    const tmpPath = path.join(TMP_DIR, `${convKey}.mp4`);

    try {
        await ensureConversion(id, quality);
    } catch (e) {
        console.error('Conversion start error:', e.message);
        return res.status(500).end();
    }

    // ファイルから指定範囲を読み取る
    try {
        let attempts = 0;
        const maxAttempts = 40;
        while (!fs.existsSync(tmpPath) || fs.statSync(tmpPath).size <= start) {
            const conv = conversions.get(convKey);
            if (!conv || (!conv.proc && getFileSize(tmpPath) <= start)) {
                return res.status(404).send("Not ready");
            }
            if (attempts > maxAttempts) return res.status(404).send("Not ready");
            await new Promise(r => setTimeout(r, 500));
            attempts++;
        }

        const stats = fs.statSync(tmpPath);
        const actualEnd = Math.min(end, stats.size - 1);

        res.status(206);
        res.set({
            'Content-Type': 'video/mp4',
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes ${start}-${actualEnd}/${stats.size}`,
            'Content-Length': (actualEnd - start + 1)
        });

        const readStream = fs.createReadStream(tmpPath, { start, end: actualEnd });
        readStream.pipe(res);
    } catch (e) {
        res.status(500).end();
    }
});

// 明示的な停止エンドポイント
app.get('/stop-stream', (req, res) => {
    const id = String(req.query.id || "").trim();
    if (id && /^[a-zA-Z0-9_-]{3,20}$/.test(id)) {
        console.log(`Explicitly stopping conversion for id: ${id}`);
        for (const [key, data] of conversions.entries()) {
            if (key === id || key.startsWith(id + '_')) {
                if (data.proc) {
                    try { data.proc.kill('SIGKILL'); } catch (e) { }
                }
                conversions.delete(key);
                const tmpPath = path.join(TMP_DIR, `${key}.mp4`);
                if (fs.existsSync(tmpPath)) {
                    fs.unlink(tmpPath, () => { });
                }
            }
        }
    }
    res.send("OK");
});

// 従来のエンドポイント (互換性のために維持)
app.get('/stream-part', async (req, res) => {
    const id = String(req.query.id || "").trim();
    const ss = req.query.ss || "0"; // 開始秒数
    const duration = req.query.t || "10"; // 取得秒数

    if (!id || !/^[a-zA-Z0-9_-]{3,20}$/.test(id)) {
        return res.status(400).send("Invalid ID");
    }

    try {
        const directUrl = (await runYtDlpAsync([
            '-g', `https://www.youtube.com/watch?v=${id}`,
            '-f', 'best[height<=720][ext=mp4]/best[height<=720]/best',
            '--no-warnings',
            '--no-playlist'
        ], 25000)).trim();

        if (!directUrl) throw new Error("Could not get direct URL");

        // ffmpegで指定秒数から断片化MP4として出力
        const ffmpegArgs = [
            '-ss', ss,
            '-reconnect', '1',
            '-reconnect_streamed', '1',
            '-reconnect_delay_max', '5',
            '-i', directUrl,
            '-t', duration,
            '-f', 'mp4',
            '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
            '-pix_fmt', 'yuv420p',
            '-vcodec', 'libx264',
            '-profile:v', 'baseline', // 互換性の高いプロファイルに固定
            '-level', '3.0',
            '-acodec', 'aac',
            '-b:v', '1000k',
            'pipe:1'
        ];

        const ffmpeg = spawn('ffmpeg', ffmpegArgs);
        res.set('Content-Type', 'video/mp4');
        ffmpeg.stdout.pipe(res);

        req.on('close', () => ffmpeg.kill());
    } catch (e) {
        console.error('Stream Part Error:', e.message);
        res.status(500).end();
    }
});

// ストリーミング (従来のRangeプロキシも残しておく)
app.get('/stream', async (req, res) => {
    const id = String(req.query.id || "").trim();
    if (!id || !/^[a-zA-Z0-9_-]{3,20}$/.test(id)) {
        return res.status(400).send("Invalid ID");
    }

    try {
        const isNico = isNicoId(id);
        const isNicoLive = id.startsWith('lv');
        let directUrl = '';
        let isLive = isNicoLive;

        // 1. ライブ配信URLの解決および判定
        if (isNicoLive) {
            console.log(`[Stream] Resolving Niconico Live URL: ${id}`);
            directUrl = (await runYtDlpAsync([
                '-g', `https://live.nicovideo.jp/watch/${id}`,
                '--no-warnings'
            ], 15000)).trim();
        } else if (!isNico) {
            // YouTubeライブ判定のためURLを取得 (通常動画なら18番などを優先してm3u8化を防ぐ)
            directUrl = (await runYtDlpAsync([
                '-g', `https://www.youtube.com/watch?v=${id}`,
                '-f', '18/best',
                '--no-warnings',
                '--no-playlist'
            ], 25000)).trim();

            if (directUrl.includes('manifest/hls_live_itags') || directUrl.includes('live=1')) {
                isLive = true;
            }
        }

        // 2. ライブ配信のダイレクトパイプライン（ディスク書き込みなし、自動クリーンアップ）
        if (isLive) {
            if (!directUrl) throw new Error("Could not get direct URL for live stream");
            console.log(`[Stream] Starting live direct transcode pipe for: ${id}`);

            const ffmpegArgs = [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-i', directUrl,
                '-c:v', 'libx264',
                '-preset', 'ultrafast',
                '-tune', 'zerolatency',
                '-c:a', 'aac',
                '-b:a', '128k',
                '-f', 'mp4',
                '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
                'pipe:1'
            ];

            const ffmpeg = spawn('ffmpeg', ffmpegArgs);
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Cache-Control', 'no-cache');

            ffmpeg.stdout.pipe(res);

            req.on('close', () => {
                console.log(`[Stream] Live client disconnected. Killing ffmpeg: ${id}`);
                ffmpeg.kill('SIGKILL');
            });
            return;
        }

        // トークン検証と 1080p 制限
        const token = req.query.token;
        const session = SESSIONS.get(token);
        const isAdmin = session && session.role === 'admin';

        let quality = req.query.quality || '480p';
        if (quality === '1080p' && !isAdmin) {
            quality = '720p'; // 一般ユーザーは 720p に強制制限
        }

        const convKey = isNico ? id : `${id}_${quality}`;
        const tmpPath = path.join(TMP_DIR, `${convKey}.mp4`);

        try {
            await ensureConversion(id, quality);
        } catch (e) {
            console.error('Stream transcode start error:', e.message);
            return res.status(500).send("Transcoding failed");
        }

        // ファイルの進捗を待つ (少なくとも192KB書き込まれるのを待つ)
        let attempts = 0;
        const maxAttempts = 40;
        while (getFileSize(tmpPath) < 192 * 1024) {
            const conv = conversions.get(convKey);
            if (!conv || (!conv.proc && getFileSize(tmpPath) < 192 * 1024)) {
                return res.status(404).send("Stream not ready");
            }
            if (attempts > maxAttempts) return res.status(404).send("Stream not ready");
            await new Promise(r => setTimeout(r, 500));
            attempts++;
        }

        if (req.query.download === '1') {
            const rawTitle = req.query.title || '';
            const sanitizedTitle = rawTitle ? String(rawTitle).replace(/[\\/:*?"<>|]/g, '_') : id;
            return res.download(tmpPath, `${sanitizedTitle}_${quality}.mp4`);
        }

        const sendOptions = {
            headers: {
                'Content-Type': 'video/mp4',
                'Accept-Ranges': 'bytes'
            }
        };
        return res.sendFile(tmpPath, sendOptions);
    } catch (e) {
        console.error('Stream Proxy Error:', e.message);
        if (!res.headersSent) {
            res.status(500).send("Streaming failed");
        }
    }
});

// 画像プロキシ
function isValidProxyUrl(urlStr) {
    try {
        const parsed = new URL(urlStr);
        const host = parsed.hostname.toLowerCase();
        const allowedDomains = [
            'ytimg.com',
            'ggpht.com',
            'gstatic.com',
            'googleusercontent.com',
            'nicovideo.jp',
            'nimg.jp'
        ];
        return allowedDomains.some(domain => host === domain || host.endsWith('.' + domain));
    } catch (e) {
        return false;
    }
}

app.get('/proxy-img', async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).end();

    if (!isValidProxyUrl(targetUrl)) {
        return res.status(400).send("Forbidden target URL");
    }

    try {
        const isNico = targetUrl.includes('nicovideo.jp') || targetUrl.includes('nimg.jp');
        const response = await axios.get(targetUrl, {
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': isNico ? 'https://www.nicovideo.jp/' : 'https://www.youtube.com/'
            },
            timeout: 8000
        });
        res.set('Content-Type', response.headers['content-type'] || 'image/jpeg');
        res.set('Cache-Control', 'public, max-age=86400');
        response.data.pipe(res);
    } catch (e) {
        res.status(404).end();
    }
});

async function searchNico(keyword, limit = 4) {
    const searchUrl = 'https://snapshot.search.nicovideo.jp/api/v2/snapshot/video/contents/search';
    const params = {
        q: keyword,
        targets: 'title,description,tags',
        fields: 'contentId,title,viewCounter,lengthSeconds,thumbnailUrl,startTime,userId,channelId',
        _sort: '-viewCounter',
        _limit: limit,
        _context: 'yt-proxy'
    };
    try {
        const response = await axios.get(searchUrl, {
            params,
            headers: {
                'User-Agent': 'yt-proxy/1.0',
                'X-Frontend-Id': '70',
                'X-Frontend-Version': '0'
            },
            timeout: 5000
        });
        const data = response.data;
        if (data && data.meta && data.meta.status === 200) {
            return (data.data || []).map(item => {
                let uploader = 'ニコニコユーザー';
                if (item.channelId) uploader = `チャンネル: ${item.channelId}`;
                else if (item.userId) uploader = `ユーザー: ${item.userId}`;
                return {
                    id: item.contentId,
                    title: item.title,
                    uploader: uploader,
                    uploader_id: item.userId ? String(item.userId) : (item.channelId ? String(item.channelId) : ''),
                    view_count: item.viewCounter || 0,
                    duration_string: formatDuration(item.lengthSeconds),
                    thumbnail: item.thumbnailUrl,
                    isNico: true,
                    _resultType: 'video'
                };
            });
        }
    } catch (e) {
        console.error(`Nico search failed for keyword "${keyword}":`, e.message);
    }
    return [];
}

// HTML特殊文字エスケープ
function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// メンテナンス機能: 一時ファイルのクリーンアップ
function cleanupTmp() {
    if (!fs.existsSync(TMP_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(TMP_DIR);
    let count = 0;
    files.forEach(file => {
        const p = path.join(TMP_DIR, file);
        try {
            const stats = fs.statSync(p);
            // 4時間以上経過したファイルを削除
            if (now - stats.mtimeMs > 4 * 60 * 60 * 1000) {
                fs.unlinkSync(p);
                count++;
            }
        } catch (e) { }
    });
    if (count > 0) console.log(`[Maintenance] Cleaned up ${count} old files.`);
}

// 30分ごとにクリーンアップ実行
setInterval(cleanupTmp, 30 * 60 * 1000);
cleanupTmp(); // 起動時にも実行

// メンテナンス機能: 定期再起動用タイマー (4時間後に自ら終了)
const RESTART_INTERVAL = 4 * 60 * 60 * 1000;
setTimeout(() => {
    console.log("[Maintenance] 4 hours elapsed. Shutting down for scheduled restart...");
    // 進行中のリクエストを考慮せず強制終了 (start.batが再起動する)
    process.exit(0);
}, RESTART_INTERVAL);

// 自己疎通監視 (Cloudflare Tunnel の失効対策)
function startSelfPing() {
    const tempUrlPath = path.join(__dirname, 'temp_url.txt');
    let failCount = 0;
    
    setInterval(async () => {
        if (!fs.existsSync(tempUrlPath)) return;
        try {
            const url = fs.readFileSync(tempUrlPath, 'utf8').trim();
            if (!url) return;
            
            // 認証不要なトップページを取得してみる
            const response = await axios.get(url, { 
                timeout: 10000,
                headers: { 'User-Agent': 'yt-proxy-self-ping' } 
            });
            
            if (response.status === 200) {
                failCount = 0; // 成功したらリセット
            } else {
                failCount++;
            }
        } catch (e) {
            failCount++;
            console.warn(`[Self-Ping] Connection failed (${failCount}/3): ${e.message}`);
        }
        
        if (failCount >= 3) {
            console.error(`[Self-Ping] Cloudflare Tunnel appears to be dead. Exiting for restart...`);
            process.exit(0);
        }
    }, 3 * 60 * 1000); // 3分おきにチェック
}
// 起動3分後にチェック開始
setTimeout(startSelfPing, 3 * 60 * 1000);


function extractKeywordFromTitle(title) {
    if (!title) return "";
    const stopWords = ['公式', 'アニメ', '動画', 'ゲーム', '実況', '配信', '放送', 'プレビュー', 'まとめ', 'オリジナル', '歌ってみた', '踊ってみた', '叩いてみた', 'チャンネル', '特報', '予告', '映像', '紹介', '比較', '検証', '解説', 'ライブ', 'LIVE', 'Live', 'official', 'Official', 'OFFICIAL', '最新', '情報', '決定', '記念'];

    const isInvalid = (w) => {
        if (!w || w.length < 3 || w.length > 15) return true;
        if (/[がのはで行をにとも]$/.test(w)) return true; // 助詞で終わるものは除外
        if (stopWords.includes(w.toLowerCase())) return true; // ストップワード
        return false;
    };

    // ① 括弧【】「」『』の中身を優先抽出
    const bracketsMatch = title.match(/[【「『]([^】」』]+)[】」』]/);
    if (bracketsMatch) {
        const candidate = bracketsMatch[1].trim();
        if (!isInvalid(candidate)) {
            return candidate;
        }
    }

    // ② 括弧がない、または括弧の中身が使えない場合、記号やスペースで分割して最適なものを探す
    const cleanTitle = title.replace(/[【】「」『』()（）[\]]/g, ' ');
    const filteredTitle = cleanTitle
        .replace(/(feat\.|オリジナル曲|まとめ|実況|歌ってみた|叩いてみた|踊ってみた)/gi, ' ')
        .trim();
    const parts = filteredTitle.split(/[・，,、。\s\-\_]/).map(p => p.trim());
    
    // フィルターをパスする最初のパートを探す
    const validPart = parts.find(p => !isInvalid(p));
    if (validPart) return validPart;

    // パスするものがなければ、最初の3文字以上15文字以下のパート
    const fallbackPart = parts.find(p => p.length >= 3 && p.length <= 15);
    if (fallbackPart) return fallbackPart;

    return filteredTitle.substring(0, 10);
}

// 関連動画キャッシュ用のオブジェクト (メモリキャッシュ: 1時間有効)
const relatedCache = {};

// 再帰的に動画オブジェクトを検索するヘルパー（YouTube watch page解析用）
function searchVideosRecursive(obj, results) {
    if (!obj || typeof obj !== 'object') return;
    
    // 従来の videoRenderer や compactVideoRenderer のパース
    if (obj.compactVideoRenderer || obj.videoRenderer) {
        const video = obj.compactVideoRenderer || obj.videoRenderer;
        if (video && video.videoId) {
            const title = video.title.simpleText || (video.title.runs && video.title.runs[0] && video.title.runs[0].text);
            
            let uploader = "";
            let channelId = "";
            if (video.shortBylineText && video.shortBylineText.runs && video.shortBylineText.runs[0]) {
                uploader = video.shortBylineText.runs[0].text;
                if (video.shortBylineText.runs[0].navigationEndpoint && video.shortBylineText.runs[0].navigationEndpoint.browseEndpoint) {
                    channelId = video.shortBylineText.runs[0].navigationEndpoint.browseEndpoint.browseId;
                }
            }
            if (!uploader && video.longBylineText && video.longBylineText.runs && video.longBylineText.runs[0]) {
                uploader = video.longBylineText.runs[0].text;
            }
            if (!uploader && video.ownerText && video.ownerText.runs && video.ownerText.runs[0]) {
                uploader = video.ownerText.runs[0].text;
            }
            
            results.push({
                id: video.videoId,
                title: title || 'No Title',
                uploader: uploader || 'Unknown',
                channel: uploader || 'Unknown',
                channel_id: channelId || '',
                duration_string: video.lengthText ? (video.lengthText.simpleText || (video.lengthText.runs && video.lengthText.runs[0] && video.lengthText.runs[0].text)) : null,
                view_count: video.viewCountText ? (video.viewCountText.simpleText || (video.viewCountText.runs && video.viewCountText.runs[0] && video.viewCountText.runs[0].text)) : null
            });
            return;
        }
    }
    
    // 新しい lockupViewModel のパース
    if (obj.lockupViewModel) {
        const lvm = obj.lockupViewModel;
        let videoId = "";
        let title = "";
        let uploader = "";
        let channelId = "";
        let duration = "";
        
        // badgeから再生時間などを取得
        if (lvm.contentImage && lvm.contentImage.thumbnailViewModel && lvm.contentImage.thumbnailViewModel.overlays) {
            const overlays = lvm.contentImage.thumbnailViewModel.overlays;
            for (const o of overlays) {
                if (o.thumbnailBottomOverlayViewModel && o.thumbnailBottomOverlayViewModel.badges) {
                    for (const b of o.thumbnailBottomOverlayViewModel.badges) {
                        if (b.thumbnailBadgeViewModel) {
                            if (b.thumbnailBadgeViewModel.animationActivationTargetId) {
                                videoId = b.thumbnailBadgeViewModel.animationActivationTargetId;
                            }
                            if (b.thumbnailBadgeViewModel.text) {
                                duration = b.thumbnailBadgeViewModel.text;
                            }
                        }
                    }
                }
            }
        }
        
        if (!videoId && lvm.onTap && lvm.onTap.innertubeCommand && lvm.onTap.innertubeCommand.watchEndpoint) {
            videoId = lvm.onTap.innertubeCommand.watchEndpoint.videoId;
        }
        
        if (lvm.metadata && lvm.metadata.lockupMetadataViewModel) {
            const meta = lvm.metadata.lockupMetadataViewModel;
            if (meta.title && meta.title.content) {
                title = meta.title.content;
            }
            
            // Extract channel name from contentMetadataViewModel
            if (meta.metadata && meta.metadata.contentMetadataViewModel) {
                const rows = meta.metadata.contentMetadataViewModel.metadataRows;
                if (rows && rows[0] && rows[0].metadataParts && rows[0].metadataParts[0]) {
                    const part = rows[0].metadataParts[0];
                    if (part.text && part.text.content) {
                        uploader = part.text.content;
                    }
                }
            }
            
            // Fallback channel name from a11yLabel
            if (!uploader && meta.image && meta.image.decoratedAvatarViewModel) {
                const a11y = meta.image.decoratedAvatarViewModel.a11yLabel;
                if (a11y) {
                    const chMatch = a11y.match(/チャンネル「([^」]+)」/);
                    if (chMatch) {
                        uploader = chMatch[1];
                    }
                }
            }
            
            // Extract channelId (browseId)
            if (meta.image && meta.image.decoratedAvatarViewModel && meta.image.decoratedAvatarViewModel.rendererContext) {
                const ctx = meta.image.decoratedAvatarViewModel.rendererContext;
                if (ctx.commandContext && ctx.commandContext.onTap && ctx.commandContext.onTap.innertubeCommand) {
                    const cmd = ctx.commandContext.onTap.innertubeCommand;
                    if (cmd.browseEndpoint && cmd.browseEndpoint.browseId) {
                        channelId = cmd.browseEndpoint.browseId;
                    }
                }
            }
        }
        
        if (videoId && title) {
            if (!results.some(r => r.id === videoId)) {
                results.push({
                    id: videoId,
                    title: title,
                    uploader: uploader || 'Unknown',
                    channel: uploader || 'Unknown',
                    channel_id: channelId || '',
                    duration_string: duration || null
                });
            }
            return;
        }
    }
    
    for (const k in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
            searchVideosRecursive(obj[k], results);
        }
    }
}

// YouTubeのwatchページから関連動画を取得
async function getRelatedVideosFromYouTube(videoId) {
    const now = Date.now();
    if (relatedCache[videoId] && (now - relatedCache[videoId].time < 60 * 60 * 1000)) {
        return relatedCache[videoId].data;
    }

    try {
        console.log(`[Recommend] Fetching official related videos for ID: ${videoId}`);
        const response = await axios.get(`https://www.youtube.com/watch?v=${videoId}`, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8'
            },
            timeout: 8000
        });
        const html = response.data;
        
        const regex = /ytInitialData\s*=\s*({.+?});/;
        const match = html.match(regex);
        let dataStr = "";
        if (match) {
            dataStr = match[1];
        } else {
            const altRegex = /window\["ytInitialData"\]\s*=\s*({.+?});/;
            const altMatch = html.match(altRegex);
            if (altMatch) {
                dataStr = altMatch[1];
            }
        }

        if (dataStr) {
            const data = JSON.parse(dataStr);
            const list = [];
            searchVideosRecursive(data, list);
            if (list.length > 0) {
                relatedCache[videoId] = { time: now, data: list };
                return list;
            }
        }
    } catch (e) {
        console.error(`[Recommend] Failed to fetch related videos for ${videoId}:`, e.message);
    }
    return [];
}

async function getTrendsFromRSS() {
    const cacheKey = 'google_trends_data';
    const cached = fetchCache([cacheKey]);
    if (cached) return JSON.parse(cached);

    // 1. Google Trends Daily RSS (Primary)
    try {
        console.log("[Trends] Fetching daily trends from Google Trends RSS...");
        const response = await axios.get('https://trends.google.com/trending/rss?geo=JP', {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 8000
        });
        const xml = response.data;
        const titles = [];
        const regex = /<title>([^<]+)<\/title>/g;
        let match;
        while ((match = regex.exec(xml)) !== null) {
            titles.push(match[1]);
        }

        if (titles.length > 1) {
            // First title is "Daily Search Trends" channel title, skip it
            const keywords = titles.slice(1).map(k => k.trim()).filter(k => k.length > 0);
            if (keywords.length >= 5) {
                const uniqueKeywords = [];
                for (const kw of keywords) {
                    if (!uniqueKeywords.includes(kw)) {
                        uniqueKeywords.push(kw);
                    }
                    if (uniqueKeywords.length >= 12) break; // Cap at 12 keywords for layout balance
                }
                
                const result = { keywords: uniqueKeywords };
                setCache([cacheKey], JSON.stringify(result));
                console.log("[Trends] Successfully loaded from Google Trends RSS:", uniqueKeywords);
                return result;
            }
        }
    } catch (e) {
        console.warn("[Trends] Google Trends RSS failed, falling back to Google News:", e.message);
    }

    // 2. Google News RSS (Fallback)
    try {
        console.log("[Trends] Fetching trends from Google News RSS...");
        const response = await axios.get('https://news.google.com/rss?hl=ja&gl=JP&ceid=JP:ja', { timeout: 8000 });
        const xml = response.data;

        const titles = [];
        const regex = /<title>([^<]+)<\/title>/g;
        let match;
        while ((match = regex.exec(xml)) !== null) {
            titles.push(match[1]);
        }

        const items = titles.slice(1);
        const keywords = [];

        for (const title of items) {
            const cleanTitle = title.split(' - ')[0];
            const parts = cleanTitle.split(/[・，,、。\s「」『』…ー\-]/);
            
            // Filter out short words and common particles at the end (e.g. が, の, は, で, を)
            let keyword = parts.find(p => {
                if (p.length < 3 || p.length > 15) return false;
                if (/[がのはで行をにとも]$/.test(p)) return false;
                return true;
            });
            
            if (!keyword) {
                keyword = cleanTitle.substring(0, 10);
            }

            if (keyword && !keywords.includes(keyword)) {
                keywords.push(keyword);
            }
            if (keywords.length >= 10) break;
        }

        if (keywords.length > 0) {
            const result = { keywords };
            setCache([cacheKey], JSON.stringify(result));
            console.log("[Trends] Loaded fallback keywords from Google News RSS:", keywords);
            return result;
        }
    } catch (e) {
        console.error("[Trends] Google News RSS error:", e.message);
    }
    return null;
}

// URL解析解決API (新規追加)
app.get('/api/resolve-url', auth, async (req, res) => {
    const targetUrl = req.query.url;
    if (!targetUrl) return res.status(400).json({ error: 'URLが必要です' });

    try {
        console.log(`[Resolve] Resolving URL: ${targetUrl}`);
        const out = await runYtDlpAsync([
            targetUrl,
            '--dump-single-json',
            '--flat-playlist',
            '--no-warnings'
        ], 15000);

        if (!out) throw new Error("URLの解析に失敗しました");
        const info = JSON.parse(out);

        let type = 'video';
        let id = info.id;

        if (info._type === 'playlist' || info.playlist_id || (info.url && info.url.includes('playlist'))) {
            type = 'playlist';
        }

        // ニコニコ動画のドメイン判定とID抽出
        if (targetUrl.includes('nicovideo.jp') || targetUrl.includes('nico.ms')) {
            const match = targetUrl.match(/(sm|so|nm|am|fz|ut|sp|ax|ca|yo|nl|ig|na|sd)?\d+/);
            if (match) {
                id = match[0];
                type = 'video';
            }
        }

        res.json({
            success: true,
            type,
            id,
            title: info.title || id,
            extractor: info.extractor || info.extractor_key
        });
    } catch (e) {
        console.error("[Resolve] Error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ヘルスチェックエンドポイント (start.bat の監視ループが HTTP 応答を確認するために使用)
app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime(), timestamp: Date.now() });
});

const server = app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`  YT Proxy Server is now READY`);
    console.log(`  Local URL: http://localhost:${PORT}`);
    console.log(`=========================================`);
});
server.on('error', (err) => {
    console.error('[System] Server listen error:', err.message);
    process.exit(1);
});

// プロセスクラッシュや終了時のゾンビ一掃制御 (SIGTERM, SIGINT, Exception等)
process.on('exit', () => {
    killAllConversions();
});
process.on('SIGINT', () => {
    console.log('[System] SIGINT received. Cleaning up...');
    killAllConversions();
    process.exit(0);
});
process.on('SIGTERM', () => {
    console.log('[System] SIGTERM received. Cleaning up...');
    killAllConversions();
    process.exit(0);
});
process.on('uncaughtException', (err) => {
    console.error('[System] Uncaught Exception:', err.message || err);
    if (err.stack) console.error(err.stack);
    // 壊れた状態で動き続けないよう終了し、start.bat の再起動ループに委ねる
    killAllConversions();
    process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('[System] Unhandled Rejection at:', promise, 'reason:', reason);
    // Promise の拒否もクラッシュ扱いとして終了し、自動再起動に委ねる
    killAllConversions();
    process.exit(1);
});