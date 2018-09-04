const http = require('http');
const https = require('https');
const fs = require('fs');
const express = require('express');
const app = express();

const options = {
    key: fs.readFileSync('./security/app/app-server-key.pem'),
    cert: fs.readFileSync('./security/app/app-server-crt.pem'),
    //requestCert: true,            //add for client cert
    //rejectUnauthorized: false     //add for client cert
};
const argv = require('yargs')
    .usage('Usage: $0 -p [port]')
    .example('-p 443')
    .describe('p', 'Port number')
    .alias('p', 'port')
    .default('p', 9443)
    .describe('ns', 'Non secure (HTTP)')
    .boolean('ns')
    .describe('ws', 'Use WebSocket')
    .boolean('ws')
    .argv;

let server;

if (argv.ns) {
    server = http.createServer(app);
    console.log(`Starting express HTTP server on port ${argv.port}`);
} else {
    server = https.createServer(options, app);
    console.log(`Starting express HTTPS server on port ${argv.port}`);
}
server.listen(argv.port);

server.on('connection', function(socket) {
    console.log("A new connection was made by a client.");
    socket.setTimeout(30 * 1000);
    // 30 second timeout. Change this as you see fit.
});

app.get('/status', (req, res) => {
    console.log('status req');
    res.send('OK');
});

app.get('/status-2', (req, res) => {
    console.log('status-2 req');
    res.send('NOT OK');
});

const io = require('socket.io')(server);
io.on('connection', function (socket) {
    console.info(`Socket.io connected. Client: ${socket.conn.remoteAddress}:${socket.conn.id}`);

    socket.on('disconnect', function (reason) {
        console.info(`Socket.io disconnected. Client: ${socket.conn.remoteAddress}:${socket.conn.id}. Reason: ${reason}`);
    });

    socket.on('getStatus', () => {
        console.log('on getStatus');
        socket.emit('statusSend', {status: 'OK'});
    });
    socket.on('getStatus2', () => {
        console.log('on getStatus2');
        socket.emit('statusSend2', {status: 'Not OK'});
    });
});
