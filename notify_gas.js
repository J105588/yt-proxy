const axios = require('axios');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const gasUrl = process.env.GAS_URL;
const gasKey = process.env.GAS_KEY;

let newUrl = process.argv[2];
if (!newUrl && fs.existsSync(path.join(__dirname, 'temp_url.txt'))) {
    newUrl = fs.readFileSync(path.join(__dirname, 'temp_url.txt'), 'utf8').trim();
}

if (!gasUrl || !gasKey) {
    console.error('[!] GAS_URL or GAS_KEY is not defined in .env.');
    process.exit(1);
}

if (!newUrl || !newUrl.startsWith('http')) {
    console.error('[!] Invalid or missing new URL to notify:', newUrl);
    process.exit(1);
}

const targetUrl = `${gasUrl}?action=updateUrl&key=${encodeURIComponent(gasKey)}&url=${encodeURIComponent(newUrl)}`;

async function notify() {
    console.log(`Sending notification to GAS... URL: ${newUrl}`);
    
    // Attempt 1: GET request (handles 302 redirect conversion reliably where doGet receives query parameters)
    try {
        const getRes = await axios.get(targetUrl, {
            timeout: 15000,
            maxRedirects: 5
        });
        if (getRes.data && typeof getRes.data === 'string' && getRes.data.includes('OK')) {
            console.log(`GAS notified successfully via GET.`);
            process.exit(0);
        } else {
            console.warn(`[!] GET attempt returned unexpected data: ${getRes.data}. Trying POST fallback...`);
        }
    } catch (e) {
        console.warn(`[!] GET attempt failed: ${e.message}. Trying POST fallback...`);
    }

    // Attempt 2: POST request fallback
    try {
        const params = new URLSearchParams();
        params.append('key', gasKey);
        params.append('url', newUrl);
        params.append('action', 'updateUrl');

        const postRes = await axios.post(targetUrl, params.toString(), {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 15000,
            maxRedirects: 5
        });

        if (postRes.data && typeof postRes.data === 'string' && postRes.data.includes('OK')) {
            console.log(`GAS notified successfully via POST.`);
            process.exit(0);
        } else {
            console.error('[!] GAS POST responded with unexpected data:', postRes.data);
            process.exit(1);
        }
    } catch (e) {
        console.error('[!] GAS POST notification failed:', e.message);
        process.exit(1);
    }
}

notify();
