const http = require('http');
const httpProxy = require('http-proxy');
const url = require('url');
const logger = require('../utils/logger');
const config = require('../../config/default.json');

const PROXY_PORT = config.proxy.port || 8080;
const PROXY_HOST = config.proxy.host || '127.0.0.1';

let server = null;
let proxyInstance = null;
let bytesTransferred = { download: 0, upload: 0 };
let isRunning = false;
let onDataCallback = null;

const proxy = httpProxy.createProxyServer({
  changeOrigin: true,
  secure: false,
  proxyTimeout: 30000,
  timeout: 30000,
});

proxy.on('error', (err, req, res) => {
  logger.error('Proxy error', err.message);
  if (res && !res.headersSent) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Proxy error');
  }
});

const proxyServer = {
  start(port, host) {
    return new Promise((resolve, reject) => {
      if (isRunning) {
        resolve({ port: PROXY_PORT, host: PROXY_HOST });
        return;
      }

      const listenPort = port || PROXY_PORT;
      const listenHost = host || PROXY_HOST;

      server = http.createServer((req, res) => {
        const reqUrl = url.parse(req.url);
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);

        bytesTransferred.upload += contentLength;

        let bodyBytes = 0;
        const originalWrite = res.write;
        const originalEnd = res.end;
        const chunks = [];

        res.write = function (chunk) {
          if (chunk) {
            chunks.push(chunk);
            bodyBytes += Buffer.byteLength(chunk);
          }
          return originalWrite.apply(res, arguments);
        };

        res.end = function (chunk) {
          if (chunk) {
            chunks.push(chunk);
            bodyBytes += Buffer.byteLength(chunk);
          }
          bytesTransferred.download += bodyBytes;
          if (onDataCallback) {
            onDataCallback({ bytesOut: bodyBytes, bytesIn: contentLength, url: reqUrl.href });
          }
          return originalEnd.apply(res, arguments);
        };

        try {
          proxy.web(req, res, {
            target: req.url,
            prependPath: false,
            selfHandleResponse: false,
          });
        } catch (err) {
          logger.error('Request proxy failed', err.message);
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Proxy error');
          }
        }
      });

      server.on('connect', (req, clientSocket, head) => {
        const [hostname, port] = req.url.split(':');
        const targetPort = parseInt(port, 10) || 443;

        const serverSocket = require('net').connect(targetPort, hostname, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          serverSocket.write(head);

          let uploadBytes = 0;
          let downloadBytes = 0;

          serverSocket.on('data', (chunk) => {
            downloadBytes += chunk.length;
          });

          clientSocket.on('data', (chunk) => {
            uploadBytes += chunk.length;
          });

          serverSocket.on('close', () => {
            bytesTransferred.download += downloadBytes;
            bytesTransferred.upload += uploadBytes;
            if (onDataCallback) {
              onDataCallback({ bytesOut: downloadBytes, bytesIn: uploadBytes, url: `https://${hostname}:${targetPort}` });
            }
          });

          serverSocket.pipe(clientSocket);
          clientSocket.pipe(serverSocket);
        });

        serverSocket.on('error', () => {
          clientSocket.end();
        });

        clientSocket.on('error', () => {
          serverSocket.end();
        });
      });

      server.listen(listenPort, listenHost, () => {
        isRunning = true;
        logger.info(`Proxy server listening on ${listenHost}:${listenPort}`);
        resolve({ port: listenPort, host: listenHost });
      });

      server.on('error', (err) => {
        isRunning = false;
        reject(err);
      });
    });
  },

  stop() {
    return new Promise((resolve) => {
      if (!isRunning || !server) {
        isRunning = false;
        resolve();
        return;
      }
      server.close(() => {
        isRunning = false;
        logger.info('Proxy server stopped');
        resolve();
      });
      server.closeAll();
    });
  },

  getBytesTransferred() {
    return { ...bytesTransferred };
  },

  resetCounters() {
    bytesTransferred = { download: 0, upload: 0 };
  },

  setOnDataCallback(callback) {
    onDataCallback = callback;
  },

  isRunning() {
    return isRunning;
  },
};

module.exports = proxyServer;
