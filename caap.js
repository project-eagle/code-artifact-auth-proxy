#!/usr/bin/env node

const http = require('http');
const https = require('https');
const fs = require('fs');
const zlib = require('zlib');
const cluster = require('cluster');
const os = require('os');
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
            // if (req.url.includes('/npm/')) {
            //     authHeader = `Bearer ${token}`;
            // } else {
                const credentials = Buffer.from(`aws:${token}`).toString('base64');
                authHeader = `Basic ${credentials}`;
            // }
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
            const contentEncoding = proxyRes.headers['content-encoding'];
            const isGzip = contentEncoding === 'gzip';

            let bodyChunks = [];
            proxyRes.on('data', (chunk) => {
                bodyChunks.push(chunk);
            });

            proxyRes.on('end', () => {
                let body = Buffer.concat(bodyChunks);

                if (isGzip) {
                    zlib.gunzip(body, (err, decompressed) => {
                        if (err) {
                            console.error('Gunzip error:', err);
                            const headers = { ...proxyRes.headers };
                            delete headers['transfer-encoding'];
                            headers['content-length'] = body.length;
                            res.writeHead(proxyRes.statusCode, headers);
                            res.end(body);
                            return;
                        }

                        let text = decompressed.toString('utf8');
                        const originalUrl = `https://${upstreamHost}/`;
                        const replacementUrl = `http://localhost:${DEFAULT_CONFIG.port}/`;
                        
                        if (text.includes(originalUrl)) {
                            // console.log(`Replacing URLs in gzipped response for ${req.url}`);
                            text = text.split(originalUrl).join(replacementUrl);
                            zlib.gzip(text, (err, compressed) => {
                                if (err) {
                                    console.error('Gzip error:', err);
                                    const headers = { ...proxyRes.headers };
                                    delete headers['transfer-encoding'];
                                    headers['content-length'] = body.length;
                                    res.writeHead(proxyRes.statusCode, headers);
                                    res.end(body);
                                    return;
                                }
                                const headers = { ...proxyRes.headers };
                                delete headers['transfer-encoding'];
                                headers['content-length'] = compressed.length;
                                res.writeHead(proxyRes.statusCode, headers);
                                res.end(compressed);
                            });
                        } else {
                            const headers = { ...proxyRes.headers };
                            delete headers['transfer-encoding'];
                            headers['content-length'] = body.length;
                            res.writeHead(proxyRes.statusCode, headers);
                            res.end(body);
                        }
                    });
                } else {
                    let text = body.toString('utf8');
                    const originalUrl = `https://${upstreamHost}/`;
                    const replacementUrl = `http://localhost:${DEFAULT_CONFIG.port}/`;

                    if (text.includes(originalUrl)) {
                        // console.log(`Replacing URLs in non-gzipped response for ${req.url}`);
                        text = text.split(originalUrl).join(replacementUrl);
                        const updatedBody = Buffer.from(text, 'utf8');
                        const headers = { ...proxyRes.headers };
                        delete headers['transfer-encoding'];
                        headers['content-length'] = updatedBody.length;
                        res.writeHead(proxyRes.statusCode, headers);
                        res.end(updatedBody);
                    } else {
                        const headers = { ...proxyRes.headers };
                        delete headers['transfer-encoding'];
                        headers['content-length'] = body.length;
                        res.writeHead(proxyRes.statusCode, headers);
                        res.end(body);
                    }
                }
            });

            // console.log(req.url, proxyRes.statusCode);
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

if (cluster.isMaster) {
    const numCPUs = Math.max(2, Math.min(6, os.cpus().length));
  
    console.log(`Master ${process.pid} is running. Forking ${numCPUs} workers...`);
    
    for (let i = 0; i < numCPUs; i++) {
        cluster.fork();
    }

    cluster.on('exit', (worker, code, signal) => {
        console.log(`Worker ${worker.process.pid} died. Forking a replacement...`);
        cluster.fork();
    });
} else {
    caap.listen(DEFAULT_CONFIG.port, () => console.log(`Worker ${process.pid} started. Proxy running on port ${DEFAULT_CONFIG.port}`));
}
