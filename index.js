const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const axios = require('axios');
const NodeCache = require('node-cache');
const { Mutex } = require('async-mutex');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    delay,
    Browsers,
    makeCacheableSignalKeyStore,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { saveSession, getSession, deleteSession } = require('./mongo');

const app = express();
const port = 3000;
const msgRetryCounterCache = new NodeCache();
const mutex = new Mutex();

app.use(express.static(path.join(__dirname, 'pages')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'pages', 'dashboard.html'));
});

async function connector(Num, res, sessionId) {
    const sessionDir = './session';
    if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir);
    }

    const existingSession = await getSession(sessionId);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    if (existingSession) {
        state.creds = existingSession.creds;
        state.keys = existingSession.keys;
    }

    const session = makeWASocket({
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'fatal' }).child({ level: 'fatal' }))
        },
        printQRInTerminal: false,
        logger: pino({ level: 'fatal' }).child({ level: 'fatal' }),
        browser: Browsers.macOS("Safari"),
        markOnlineOnConnect: true,
        msgRetryCounterCache
    });

    if (!session.authState.creds.registered) {
        await delay(1500);
        Num = Num.replace(/[^0-9]/g, '');
        const code = await session.requestPairingCode(Num);
        if (!res.headersSent) {
            res.send({ code: code?.match(/.{1,4}/g)?.join('-'), sessionId });
        }
    }

    session.ev.on('creds.update', async () => {
        await saveCreds();
        await saveSession(sessionId, state);
    });

    session.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            console.log('Connected successfully');
            const data = JSON.stringify({ sessionId });
            const encodedData = Buffer.from(data).toString('base64');
            try {
                const output = await axios.post(
                    'http://paste.c-net.org/',
                    encodedData,
                    { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
                );
                const parts = output.data.split('/');
                if (parts.length > 3) {
                    let c = parts[3];
                    console.log('Extracted session ID:', c);
                    await session.sendMessage(session.user.id, { text: 'Secktor;;;' + c });
                } else {
                    console.error('Unexpected response format:', output.data);
                }
            } catch (error) {
                console.error('Error sending session data:', error);
            }
            console.log('[Session] Session online');
        } else if (connection === 'close') {
            const reason = lastDisconnect?.error?.output?.statusCode;
            console.log(`Connection closed. Reason: ${reason}`);
            await deleteSession(sessionId);
            reconn(reason, sessionId);
        }
    });
}

function reconn(reason, sessionId) {
    if ([DisconnectReason.connectionLost, DisconnectReason.connectionClosed, DisconnectReason.restartRequired].includes(reason)) {
        console.log('Connection lost, reconnecting...');
        connector(null, null, sessionId);
    } else {
        console.log(`Disconnected! Reason: ${reason}`);
    }
}

app.get('/pair', async (req, res) => {
    const Num = req.query.code;
    const sessionId = req.query.sessionId;
    if (!Num || !sessionId) {
        return res.status(418).json({ message: 'Phone number and session ID are required' });
    }
    const release = await mutex.acquire();
    try {
        await connector(Num, res, sessionId);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Server Error' });
    } finally {
        release();
    }
});

app.listen(port, () => {
    console.log(`Running on PORT:${port}`);
});
