const http = require('http');
const https = require('https');
const net = require('net');
const EventEmitter = require('events');
const url = require('url');
const tunnelAgent = require('tunnel-agent');
const ioClient = require('socket.io-client');
const NestedError = require('nested-error-stacks');

/**
 * Create a `HttpsTunnelAgent` instance.
 *
 * @param {Object} options Configuration options
 * @param {<string> | <string[]> | <Buffer> | <Buffer[]> | <Object[]>} options.key As in tls.createSecureContext
 * @param {<string> | <string[]> | <Buffer> | <Buffer[]>} options.cert As in tls.createSecureContext
 * @param {Boolean} options.rejectUnauthorized As in tls.createServer (Default: true)
 * @param {string} options.host HTTPS Server host
 * @param {Number} options.port HTTPS Server port number (Default: 443)
 * @param {string} options.httpProxy HTTP proxy URL. Set to null to avoid using environment parameter.
 */
class HttpsTunnelAgent extends EventEmitter {
    constructor(options) {
        super();

        if (!options.key || !options.cert) {
            throw new Error('missing or invalid options');
        }

        this._options = Object.assign({
            requestCert: true,
            rejectUnauthorized: true,
            port: 443,
        }, options);
        this._tlsOptions = {
            key: this._options.key,
            cert: this._options.cert,
            requestCert: this._options.requestCert,
            rejectUnauthorized: this._options.rejectUnauthorized,
        };
        this._socketIoOptions = Object.assign({
            reconnectionDelay: 1000,
            reconnection:true,
            reconnectionAttempts: 10,
            transports: ['websocket'],
            agent: false,
            upgrade: false,
        }, this._tlsOptions);
        this._ctrlSocket = null;
        this._serverUrl = `https://${this._options.host}:${this._options.port}`;
        this._proxyExists = false;
        this._tunnelingAgentHttpsOverHttp = null;

        if (this._options.httpProxy !== null) {  // If explicitly set to null, don't configure proxy
            if (this._options.httpProxy) {
                this._proxyUrl = url.parse(this._options.httpProxy, false, true);
                this._proxyExists = true;
            } else if (process.env.HTTP_PROXY || process.env.http_proxy) {
                this._proxyUrl = url.parse(process.env.HTTP_PROXY || process.env.http_proxy, false, true);
                this._proxyExists = true;
                this._tunnelingAgentHttpsOverHttp = tunnelAgent.httpsOverHttp(Object.assign({
                    path: `${this._options.host}:${this._options.port}`,
                    proxy: { hostname: this._proxyUrl.hostname, host: this._proxyUrl.hostname, port: this._proxyUrl.port },
                    hostname: this._options.host,
                    host: this._options.host,
                }, this._tlsOptions));
                this._socketIoOptions.agent = this._tunnelingAgentHttpsOverHttp;
            }
        }

        this._isLocalServer = [ 'localhost', '127.0.0.1', '::1' ].includes(this._options.host);
    }

    /**
     * Connect to server via WS for control messages.
     */
    connect() {
        this._ctrlSocket = ioClient.connect(this._serverUrl, this._socketIoOptions);

        this._ctrlSocket.on('connect', () => {
            this.emit('ready');
        });

        this._ctrlSocket.on('connect_error', (err) => {
            this.emit('connect_error', err);
        });

        this._ctrlSocket.on('createTunnel', (tunnelData) => { this.createTunnel(tunnelData); });

        this._ctrlSocket.on('disconnect', (reason) => {
            this.emit('disconnect', reason);
        });
    }

    /**
     * Connects to the target, then to the server and then pipes the sockets.
     *
     * @param tunnelData
     */
    createTunnel(tunnelData) {
        this.emit('tunnel-request', tunnelData);
        let targetSocket;
        const targetConnectionHandler = this.connectToTarget(tunnelData);

        // this handler is used until a connection to the target is made and then it's removed.
        function targetConnectionErrorHandler(err) {
            this.emit('error', new NestedError(`Failed to connect to target. Tunnel Id: ${tunnelData.id}.`, err));
            this._ctrlSocket.emit('createTunnel_error', {
                tunnelData: tunnelData,
                err: `Failed to connect to target. Tunnel Id: ${tunnelData.id}. ${err}`
            });
        }

        targetConnectionHandler.on('error', targetConnectionErrorHandler);

        targetConnectionHandler.once('socket', (socket) => {
            targetSocket = socket;

            targetSocket.setTimeout(10e3, () => {
                targetSocket.destroy();
                this._ctrlSocket.emit('createTunnel_timeout', {
                    tunnelData: tunnelData
                });
                this.emit(new Error(`Connection to target timed out. Tunnel Id: ${tunnelData.id}`));
            });

            targetSocket.on('error', targetConnectionErrorHandler);
        });

        targetConnectionHandler.once('connect', (socket) => {
            // remove connecting to target timeout event.
            targetSocket.setTimeout(0);
            // remove targetConnectionErrorHandler after connection
            targetSocket.removeListener('error', targetConnectionErrorHandler);

            // create tunnel to server
            const tunnelRequest = this.connectToServer(tunnelData, (tunnelSocket) => {

                const serverTunnelErrorHandler = (err) => {
                    if (targetSocket && !targetSocket.destroyed) {
                        targetSocket.end(`HTTP/1.1 500 ${err.message}\r\n`);
                        targetSocket.destroy();
                    }
                    this.emit('error', new NestedError(`Server tunnel error. Tunnel Id: ${tunnelData.id}.`, err));
                };
                const serverTunnelEndHandler = () => {
                    if (targetSocket && !targetSocket.destroyed) {
                        targetSocket.end();
                        targetSocket.destroy();
                    }
                };
                const targetErrorHandler = (err) => {
                    if (tunnelSocket && !tunnelSocket.destroyed) {
                        tunnelSocket.end(`HTTP/1.1 500 ${err.message}\r\n`);
                        tunnelSocket.destroy();
                    }
                    this.emit('error', new NestedError(`Target tunnel error. Tunnel Id: ${tunnelData.id}.`, err));
                };
                const targetEndHandler = () => {
                    if (tunnelSocket && !tunnelSocket.destroyed) {
                        tunnelSocket.end();
                        tunnelSocket.destroy();
                    }
                };

                targetSocket.on('error', targetErrorHandler);
                targetSocket.on('end', targetEndHandler);
                tunnelSocket.on('error', serverTunnelErrorHandler);
                tunnelSocket.on('end', serverTunnelEndHandler);

                targetSocket.pipe(tunnelSocket, {end: false});
                tunnelSocket.pipe(targetSocket, {end: false});

                this.emit('tunnel-completed', tunnelData.id);
            });

            tunnelRequest.on('error', (err) => {
                targetSocket.end(`HTTP/1.1 500 \r\n`);
                targetSocket.destroy();
                this._ctrlSocket.emit('createAgentTunnel_error', {
                    tunnelData: tunnelData,
                    err: `Failed to create agent tunnel. Tunnel Id: ${tunnelData.id}. ${err}`
                });
                this.on('error', new NestedError(`Failed to create agent tunnel. Tunnel Id: ${tunnelData.id}.`, err));
            });
        });
    }

    /**
     * Connect to the target directly or via proxy
     *
     * @param tunnelData
     */
    connectToTarget(tunnelData) {
        const emitter = new EventEmitter();
        if (this._proxyExists) {
            // make a request for tunneling proxy
            const options = {
                hostname: this._proxyUrl.hostname,
                host: this._proxyUrl.hostname,
                method: 'CONNECT',
                path: `${tunnelData.hostName}:${tunnelData.port}`,
                port: this._proxyUrl.port,
                agent: false,
                rejectUnauthorized: false,
            };

            const req = http.request(options);
            req.end();

            req.on('connect', (res, socket) => { emitter.emit('connect', socket); });
            req.on('socket', (socket) => { emitter.emit('socket', socket); });
            req.on('error', (err) => { emitter.emit('error', err); });
        } else {
            const targetSocket = net.connect(tunnelData.port, tunnelData.hostName, () => {
                emitter.emit('connect', targetSocket);
            });
            process.nextTick(() => {
                emitter.emit('socket', targetSocket);
            });
        }

        return emitter;
    }

    /**
     * Connect to the server
     *
     * @param tunnelData
     * @param {Function} callback
     * @returns {http.ClientRequest}
     */
    connectToServer(tunnelData, callback) {
        const options = Object.assign({
            hostname: this._options.host,
            host: this._options.host,
            method: 'CONNECT',
            path: `${tunnelData.id}`,
            port: this._options.port,
            agent: (this._proxyExists && !this._isLocalServer) ? this._tunnelingAgentHttpsOverHttp : false,
        }, this._tlsOptions);

        const req = https.request(options);
        req.end();

        req.on('connect', (res, socket) => {
            callback(socket);
        });

        return req;
    }
}

module.exports = HttpsTunnelAgent;
