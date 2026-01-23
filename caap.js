#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const { CodeartifactClient, GetAuthorizationTokenCommand } = require("@aws-sdk/client-codeartifact");

let creds = '';
try {
  creds = fs.readFileSync('/aws/credentials', 'utf8');
}catch(e){}

const ARGS = process.argv
    .filter(e => e.indexOf('=') !== -1)
    .reduce((acc, value) => {
        let kv = value.split('=');
        acc[kv[0].replace(/^-*/g, '')] = kv[1];
        return acc;
    }, {});

let credFileLines = creds.split('\n');

const DEFAULT_CONFIG = {
    port: ARGS.port ?? (process.env.PORT || 9999),
    domain: ARGS.domain,
    owner: ARGS.owner,
    region: ARGS.region,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? credFileLines.find((l) => l.includes('aws_access_key_id')).split(' = ')[1],
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? credFileLines.find((l) => l.includes('aws_secret_access_key')).split(' = ')[1]
    }
};

const mavenProxyName = ARGS.mvnProxy || 'mvn-proxy';
const npmProxyName = ARGS.mvnProxy || 'npm-proxy';

const MAVEN_CONFIG = {
    ...DEFAULT_CONFIG,
    repo: mavenProxyName,
}
const NPM_CONFIG = {
    ...DEFAULT_CONFIG,
    repo: npmProxyName,
}

// console.log('config', CONFIG);

const state = {
    maven : {
        config : MAVEN_CONFIG,
        client : new CodeartifactClient(MAVEN_CONFIG),
        token : null,
        expiry: 0
    },
    npm : {
        config : NPM_CONFIG,
        client: new CodeartifactClient(NPM_CONFIG),
        token: null,
        expiry: 0
    }
};

async function getAuthToken(type) {
    const now = Date.now();
    let config = state[type];
    if (config.token && config.expiry > now + 5 * 60 * 1000){
        return config.token;
    }

    console.log(`Refreshing CodeArtifact Auth Token[${type}]...`);
    const command = new GetAuthorizationTokenCommand({
        domain: config.config.domain,
        domainOwner: config.config.owner,
        durationSeconds: 3600
    });
    const response = await config.client.send(command);
    config.token = response.authorizationToken;
    config.expiry = response.expiration.getTime();
    return config.token;
}

const caap = http.createServer(async (req, res) => {
    if (req.url === '/health') {
        res.writeHead(200); res.end('OK');
        return;
    }
    let isGet = req.method.toLowerCase() === 'get';

    try {
        let type = 'maven';
        if(req.url.includes(`npm/${npmProxyName}`)) {
            type = 'npm';
        }

        const token = await getAuthToken(type);
        const config = state[type].config;
        let upstreamHost = `${config.domain}-${config.owner}.d.codeartifact.${config.region}.amazonaws.com`;
        if(!isGet) {
            upstreamHost = 'registry.npmjs.org';
        }

        let authHeader;

        if(isGet) {
            if (req.url.includes('/npm/')) {
                authHeader = `Bearer ${token}`;
            } else {
                const credentials = Buffer.from(`aws:${token}`).toString('base64');
                authHeader = `Basic ${credentials}`;
            }
        }

        const options = {
            hostname: upstreamHost,
            port: 443,
            path: isGet ? req.url :  req.url.replace(`/npm/${npmProxyName}`, ''),
            method: req.method,
            headers: {
                ...req.headers,
                'host': upstreamHost,
                [isGet ? 'authorization' : 'x-nope']: authHeader ?? 'nope'
            },
            body : req.body
        };

        // console.log('options:', options);

        const proxyReq = https.request(options, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res, { end: true });
        });

        proxyReq.on('error', (err) => {
            console.error(err);
            if (!res.headersSent) { res.writeHead(502); res.end('Bad Gateway'); }
        });

        req.pipe(proxyReq, { end: true });

    } catch (err) {
        console.error(err);
        if (!res.headersSent) { res.writeHead(500); res.end('Server Error'); }
    }
});

caap.listen(DEFAULT_CONFIG.port, () => console.log(`Proxy running on port ${DEFAULT_CONFIG.port}`));
