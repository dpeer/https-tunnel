const fs = require('fs');
const HttpsTunnelServer = require('../index').HttpsTunnelServer;
const argv = require('yargs')
    .usage('Usage: $0 -p [port] -x [proxy-port]')
    .example('-p 443 -x 8080')
    .describe('p', 'Port number')
    .alias('p', 'port')
    .default('p', 443)
    .describe('x', 'Proxy port number')
    .alias('x', 'proxyPort')
    .default('x', 8080)
    .demandOption(['p', 'x'])
    .argv;
const options = {
    key: fs.readFileSync('./security/tunnel/server-key.pem'),
    cert: fs.readFileSync('./security/tunnel/server-crt.pem'),
    rejectUnauthorized: false,
    port: argv.port,
    proxyPort: argv.proxyPort,
};

let hts = new HttpsTunnelServer(options);
hts.listen();

hts.on('ready', ()=> {
    console.info('Server ready');
});

hts.on('agent-connect', (data) => {
    console.info(`Agent connected via WS. Client: ${data.remoteAddress}:${data.id}`);
});

hts.on('agent-disconnect', (reason) => {
    console.error(`Agent disconnected via WS. Reason: ${reason}`);
});

hts.on('tunnel-request', (tunnelData) => {
    console.log(`Tunnel request. Tunnel Id: ${tunnelData.id}, hostname: ${tunnelData.hostName}, port: ${tunnelData.port}`);
});

hts.on('tunnel-completed', (tunnelId) => {
    console.log(`Tunnel completed. Tunnel Id: ${tunnelId}`);
});

hts.on('error', console.error);

