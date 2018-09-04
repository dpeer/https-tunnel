const http = require('http');
const https = require('https');
const EventEmitter = require('events');
const url = require('url');
const socketIo = require('socket.io');
const uuidv1 = require('uuid/v1');
const NestedError = require('nested-error-stacks');

/**
 * Create a `HttpsTunnelServer` instance.
 *
 * @param {Object} options Configuration options
 * @param {<string> | <string[]> | <Buffer> | <Buffer[]> | <Object[]>} options.key As in tls.createSecureContext
 * @param {<string> | <string[]> | <Buffer> | <Buffer[]>} options.cert As in tls.createSecureContext
 * @param {Boolean} options.rejectUnauthorized As in tls.createServer (Default: true)
 * @param {Number} options.port HTTPS Server port number (Default: 443)
 * @param {Number} options.proxyPort HTTP Proxy server port number (Default: 8080)
 */
class HttpsTunnelServer extends EventEmitter {
    constructor(options) {
        super();

        if (!options.key || !options.cert) {
            throw new Error('missing or invalid options');
        }

        this._options = Object.assign({
            requestCert: true,
            rejectUnauthorized: true,
            port: 443,
            proxyPort: 8080,
        }, options);
        this._ctrlSocket = null;
        this._clientSockets = new Map();
        this._httpsServer = null;
        this._io = null;
        this._proxyServer = null;
        this._isReady = false;
    }

    // HTTP CONNECTION response with empty body
    static get httpConnectRes() {
        return [
            'HTTP/1.1 200 Connection Established',
            'Proxy-agent: Node-VPN',
            '\r\n']
            .join('\r\n');
    }

    // discard all request to proxy server except HTTP/1.1 CONNECT method
    static requestHandler() {
        return (req, res) => {
            res.writeHead(405, {'Content-Type': 'text/plain'});
            res.end('Method not allowed');
        };
    }

    /**
     * Create the HTTPS server and HTTP proxy and start listening.
     */
    listen() {
        this.createHttpsServer();
        this.createHttpProxyServer();
    }

    emitReady() {
        if (!this._isReady && this._httpsServer && this._httpsServer.listening && this._proxyServer && this._proxyServer.listening) {
            this._isReady = true;
            this.emit('ready');
        }
    }

    get isReady() { return this._isReady; }

    createHttpsServer() {
        this._httpsServer = https.createServer(this._options, HttpsTunnelServer.requestHandler);
        this._io = socketIo(this._httpsServer);

        this._httpsServer.listen(this._options.port, (err) => {
            if (!err) {
                this.emitReady();
            }
        });

        this._io.on('connection', (socket) => {
            this._ctrlSocket = socket;

            socket.on('disconnect', (reason) => {
                this._ctrlSocket = null;
                this.emit('agent-disconnect', reason);
            });
            socket.on('createTunnel_timeout', (data) => { this.createTunnelTimeoutHandler(data); });
            socket.on('createTunnel_error', (data) => { this.createTunnelErrorHandler(data); });
            socket.on('createAgentTunnel_error', (data) => { this.createAgentTunnelErrorHandler(data); });
            this.emit('agent-connect', {
                remoteAddress: socket.conn.remoteAddress,
                id: socket.conn.id
            });
        });

        // HTTPS Proxy for agent to create new tunnel
        this._httpsServer.on('connect', (req, agentSocket, head) => { this.onAgentTunnelConnection(req, agentSocket, head); });

        this._httpsServer.on('error', (err) => {
            this.emit('error', new NestedError('Error in HTTPS Server.', err));
        });
    }

    onAgentTunnelConnection(req, agentSocket, head) {
        const tunnelId = req.url;
        if (!tunnelId) {
            let errMsg = `No tunnelId in request`;
            agentSocket.end(`HTTP/1.1 400 ${errMsg}\r\n`);
            agentSocket.destroy();
            return;
        }

        let clientSocket = this._clientSockets.get(tunnelId);
        if (!clientSocket || clientSocket.destroyed) {
            let errMsg = `No client socket for tunnelId: ${tunnelId} or socket is destroyed`;
            agentSocket.end(`HTTP/1.1 400 ${errMsg}\r\n`);
            agentSocket.destroy();
            return;
        }

        const agentErrorHandler = (err) => {
            if (clientSocket && !clientSocket.destroyed) {
                clientSocket.end(`HTTP/1.1 500 ${err.message}\r\n`);
                clientSocket.destroy();
            }
            this.emit('error', new NestedError(`Agent tunnel error. Tunnel Id: ${tunnelData.id}.`, err));
        };
        const agentEndHandler = () => {
            if (clientSocket && !clientSocket.destroyed) {
                clientSocket.end();
                clientSocket.destroy();
            }
        };
        const clientErrorHandler = (err) => {
            if (agentSocket && !agentSocket.destroyed) {
                agentSocket.end(`HTTP/1.1 500 ${err.message}\r\n`);
                agentSocket.destroy();
            }
            this.emit('error', new NestedError(`Client error. Tunnel Id: ${tunnelData.id}.`, err));
        };
        const clientEndHandler = () => {
            if (agentSocket && !agentSocket.destroyed) {
                agentSocket.end();
                agentSocket.destroy();
            }
        };
        const clientCloseHandler = () => {
            this._clientSockets.delete(tunnelId);
        };

        clientSocket.on('error', clientErrorHandler);
        clientSocket.on('end', clientEndHandler);
        clientSocket.on('close', clientCloseHandler);
        agentSocket.on('error', agentErrorHandler);
        agentSocket.on('end', agentEndHandler);

        agentSocket.write(HttpsTunnelServer.httpConnectRes);
        clientSocket.write(HttpsTunnelServer.httpConnectRes);

        clientSocket.pipe(agentSocket, {end: false});
        agentSocket.pipe(clientSocket, {end: false});

        this.emit('tunnel-completed', tunnelId);
    }

    onClientConnect(req, clientSocket) {
        if (!this._ctrlSocket) {
            clientSocket.end('HTTP/1.1 500 No agent connected\r\n');
            clientSocket.destroy();
            return;
        }

        const { port, hostname } = url.parse(`//${req.url}`, false, true); // extract destination host and port from CONNECT request
        if (!hostname) {
            clientSocket.end('HTTP/1.1 400 Bad Request\r\n');
            clientSocket.destroy();
            return;
        }

        let tunnelData = {
            id: uuidv1(),
            hostName: hostname,
            port: port || 443
        };
        this.emit('tunnel-request', tunnelData);
        this._clientSockets.set(tunnelData.id, clientSocket);
        this._ctrlSocket.emit('createTunnel', tunnelData);
    }

    createHttpProxyServer() {
        this._proxyServer = http.createServer(HttpsTunnelServer.requestHandler);

        this._proxyServer.listen(this._options.proxyPort, (err) => {
            if (!err) {
                this.emitReady();
            }
        });

        // HTTPS proxy for clients to create new tunnel
        this._proxyServer.on('connect', (req, clientSocket) => {
            this.onClientConnect(req, clientSocket);
        });

        this._proxyServer.on('error', (err) => {
            this.emit('error', new NestedError('Error in HTTP Proxy Server.', err));
        });
    }

    createTunnelTimeoutHandler(data) {
        let clientSocket = this._clientSockets.get(data.tunnelData.id);
        clientSocket.end(`HTTP/1.1 504 connect ETIMEDOUT ${data.tunnelData.hostName}:${data.tunnelData.port}\r\n`);
        clientSocket.destroy();
        this._clientSockets.delete(data.tunnelData.id);
        this.emit('error', new Error(`Agent connection to target timed out. Tunnel ID: ${data.tunnelData.id}.`));
    }

    createTunnelErrorHandler(data) {
        this.emit('error', new Error(data.err));
    }

    createAgentTunnelErrorHandler(data) {
        this.emit('error', new Error(data.err));
    }
}

module.exports = HttpsTunnelServer;
