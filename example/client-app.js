const request = require('request');
const http = require('http');
const https = require('https');
const fs = require('fs');
const ioClient = require('socket.io-client');

const argv = require('yargs')
    .usage('Usage: $0 -h [hostname] -p [port] -x [http-proxy]')
    .example('-h 1.2.3.4 -p 443 -x http://localhost:8080')
    .describe('h', 'Host name')
    .alias('h', 'hostName')
    .describe('p', 'Port number')
    .alias('p', 'port')
    .default('p', 9443)
    .describe('x', '[http://HOST:PORT]  Use proxy on given port')
    .alias('x', 'proxy')
    .describe('ns', 'Non secure (HTTP)')
    .boolean('ns')
    .describe('ws', 'Use WebSocket')
    .boolean('ws')
    .demandOption(['h'])
    .argv;

const tlsOptions = {
    isServer: false,
    //ca: fs.readFileSync('./security/app/app-ca-crt.pem'),
    cert: fs.readFileSync('./security/app/client1.cert.pem'),
    key: fs.readFileSync('./security/app/client1.key.pem'),
};

const reqOptions = {
    cert: tlsOptions.cert,
    key: tlsOptions.key,
    rejectUnauthorized: false,
    json: true,
    forever: true,
    // requestCertificate: true,
};

const socketIoOptions = {
    cert: tlsOptions.cert,
    key: tlsOptions.key,
    transports: ['websocket'],
    rejectUnauthorized: false,
};

const baseAutUrl = `${argv.ns ? 'http' : 'https'}://${argv.hostName}:${argv.port}`;

// Set proxy for request module.
if (argv.proxy) {
    process.env.HTTP_PROXY = argv.proxy;
    process.env.HTTPS_PROXY = argv.proxy;
}

function sendRequests() {
    request.get(`${baseAutUrl}/status`, reqOptions, (err, res, body) => {
        if (err) {
            console.log(`error: ${err}`);
            return;
        }
        console.log(`status res: ${body}`);
    });

    setTimeout(() => {
        request.get(`${baseAutUrl}/status-2`, reqOptions, (err, res, body) => {
            if (err) {
                console.log(`error: ${err}`);
                return;
            }
            console.log(`status-2 res: ${body}`);
        });
    }, 200);
}

sendRequests();

if (argv.ws) {
    let sioClient = ioClient.connect(baseAutUrl, socketIoOptions);

    sioClient.on('connect', () => {
        console.info(`Socket.io connected to server: ${baseAutUrl}`);
    });

    sioClient.on('statusSend', (data) => {
        console.log(`on statusSend: ${JSON.stringify(data)}`);
    });

    sioClient.on('statusSend2', (data) => {
        console.log(`on statusSend2: ${JSON.stringify(data)}`);
    });

    sioClient.emit('getStatus');

    sioClient.emit('getStatus2');
}
