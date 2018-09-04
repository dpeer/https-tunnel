const fs = require('fs');
const HttpsTunnelAgent = require('../index').HttpsTunnelAgent;
const argv = require('yargs')
    .usage('Usage: $0 -h [hostname] -p [port] -x [http://host:port]')
    .example('-h 10.0.0.1 -p 443')
    .describe('h', 'Host name')
    .alias('h', 'host')
    .describe('p', 'Port number')
    .alias('p', 'port')
    .default('p', 443)
    .describe('x', '[http://HOST:PORT] Use proxy on given port')
    .alias('x', 'proxy')
    .demandOption(['h', 'p'])
    .argv;
const options = {
    key: fs.readFileSync('./security/tunnel/agent-key.pem'),
    cert: fs.readFileSync('./security/tunnel/agent-crt.pem'),
    host: argv.host,
    port: argv.port,
    httpProxy: argv.proxy,
    rejectUnauthorized: false,
};

let tpa = new HttpsTunnelAgent(options);
tpa.connect();

tpa.on('ready', ()=> {
    console.info('Connected to server');
});

tpa.on('connect_error', (err) => {
    console.error('Server connection error:', err.message);
});

tpa.on('disconnect', (err) => {
    console.error('Server disconnection:', err);
});

tpa.on('error', console.error);

tpa.on('tunnel-request', (tunnelData) => {
    console.log(`Tunnel request. Tunnel Id: ${tunnelData.id}, hostname: ${tunnelData.hostName}, port: ${tunnelData.port}`);
});

tpa.on('tunnel-completed', (tunnelId) => {
    console.log(`Tunnel completed. Tunnel Id: ${tunnelId}`);
});
