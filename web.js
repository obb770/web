/*jshint node:true */
'use strict';

var http = require('http'),
    util = require('util'),
    fs = require('fs'),
    path = require('path'),
    httpPort = process.env.PORT || 8080,
    wwwRoot = 'www',
    log,
    debug,
    buffer = '',
    redirect,
    types,
    sendFile,
    sendManifest,
    handleSocket,
    apps,
    serve,
    run;

log = function () {
    var str = util.format.apply(util, arguments);
    console.log('%s', str);
    buffer += '\n' + str;
};

debug = function () {
    if (true) {
        log.apply(this, arguments);
    }
};

http.ServerResponse.prototype.start = function (code, type, headers, body) {
    var msg;
    if (this.responded) {
        log('Already responded (now: ' + code + ')');
        log(body);
        return;
    }
    this.responded = true;
    headers['content-type'] = type;
    msg = this.request.connection.remoteAddress + ' ' +
        this.request.connection.remotePort + ' ' +
        this.request.url + ' ' + code + ' ' + type;
    if (headers.hasOwnProperty('content-length')) {
        msg += ' ' + headers['content-length'];
    }
    this.writeHead(code, headers);
    if (typeof body !== 'undefined') {
        this.end(body);
    }
    log(msg);
    if (Math.floor(code / 10) * 10 !== 200 || type === types.manifest) {
        log(body);
    }
};

redirect = function (response, loc) {
    response.start(302, 'text/html', {'Location': loc}, util.format(
            '<html><body>The content is <a href="%s">here</a>.</body></html>',
            loc));
};

types = {
    'manifest': 'text/cache-manifest',
    'webapp': 'application/x-web-app-manifest+json',
    'html': 'text/html',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'mp4': 'video/mp4',
    'mp3': 'audio/mpeg',
    'wav': 'audio/vnd.wav',
    'js': 'text/javascript',
    'css': 'text/css',
    'txt': 'text/plain',
    '': 'text/plain',
    null: 'application/octet-stream'
};

sendFile = function (response, name) {
    var stat, i, type, size, rs, code, match, options, headers;
    i = name.lastIndexOf('.');
    if (i < 0) {
        i = name.lastIndexOf('/');
    }
    type = name.substr(i + 1);
    if (!types.hasOwnProperty(type)) {
        type = null;
    }
    stat = fs.existsSync(name) && fs.statSync(name);
    if (type === 'manifest') {
        i = name.lastIndexOf('/');
        sendManifest(response, name, stat, name.substr(0, i + 1));
        return;
    }
    if (!stat || !stat.isFile()) {
        response.start(404, 'text/plain', {}, 'Not found');
        return;
    }
    size = stat.size;
    code = 200;
    options = undefined;
    headers = {'content-length': size};
    if (response.request.headers.hasOwnProperty('range')) {
        match = /bytes=(\d*)-(\d*)/.exec(response.request.headers.range);
        code = 206;
        options = {start: 0, end: size - 1};
        if (match[1]) {
            options.start = parseInt(match[1]);
        }
        if (match[2]) {
            options.end = parseInt(match[2]);
        }
        headers['content-length'] = options.end - options.start + 1;
        headers['content-range'] =
            'bytes ' + options.start + '-' + options.end + '/' + size;
    }
    rs = fs.createReadStream(name, options);
    response.start(code, types[type], headers);
    rs.on('error', function (e) {
        log(e.stack);
    });
    rs.pipe(response);
};

sendManifest = function (response, name, stat, prefix) {
    var data, addTimestamp, lines, i;
    if (stat && stat.isFile()) {
        data = fs.readFileSync(name, {'encoding': 'utf8'});
    }
    else {
        data = 'CACHE MANIFEST';
    }
    lines = data.split('\n');
    data = [];
    addTimestamp = function(f) {
        var ts, stat;
        try {
            stat = fs.statSync(prefix + f);
            if (stat && stat.isFile()) {
                ts = util.format(
                    '# %s', fs.statSync(prefix + f).mtime);
                data.push(ts);
            }
        }
        catch (e) {
        }
    };
    for (i = 0; i < lines.length; i++) {
        data.push(lines[i]);
        if (lines[i].substr(0, 1) !== '/') {
            addTimestamp(lines[i]);
        }
    }
    addTimestamp('index.html');
    data = data.join('\n');
    response.start(200, types.manifest, {}, data);
};

handleSocket = function (sock) {
    var request = sock.request,
        respond,
        token = request.headers['sec-websocket-key'],
        LIMIT = 100,
        MAX_MESSAGE = 0x100000,
        MAX_FRAME = 0x20000;

    respond = function (token, message, headers) {
        var status = token ? ' 101 websocket' : (' 400' + ' ' + message);
        log(request.connection.remoteAddress + ' ' +
            request.connection.remotePort + ' ' +
            request.url + status);
        if (token) {
            sock.write('HTTP/1.1 101 Switching Protocols\r\n' +
                'Upgrade: websocket\r\n' +
                'Connection: Upgrade\r\n' +
                'Sec-WebSocket-Accept: ' + token + '\r\n' +
                '\r\n');
            return;
        }
        sock.write('HTTP/1.1' + status + '\r\n' +
            headers.join('\r\n') + '\r\n' +
            'Content-Length: 0\r\n' +
            '\r\n');
    };

    if (request.headers.upgrade.toLowerCase() !== 'websocket') {
        respond(null, 'Non websocket upgrade', []);
        return;
    }
    if (request.headers.connection.toLowerCase() !== 'upgrade') {
        respond(null, 'Non upgrade connection', []);
        return;
    }
    if (request.headers['sec-websocket-version'] !== '13') {
        respond(null, 'Bad version', ['Sec-WebSocket-Version: 13']);
        return;
    }
    if (new Buffer(token, 'base64').length !== 16) {
        respond(null, 'Bad key length', []);
        return;
    }
    token += '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
    token = require('crypto').createHash('sha1').update(
        token).digest('base64');
    respond(token);

    sock.setTimeout(0);
    sock.canRead = true;
    sock.serverClosed = false;
    sock.clientClosed = false;

    sock.close = function (code, reason) {
        var buf = new Buffer(125), len = 2;
        debug('close: %d "%s"', code, reason);
        if (sock.serverClosed) {
            debug('close: already closed');
            return;
        }
        buf.writeUInt16BE(code, 0);
        if (reason) {
            len += buf.write(reason, 2);
        }
        sock.send(buf.slice(0, len), 8);
        sock.serverClosed = true;
        if (sock.clientClosed) {
            sock.end();
        }
    };

    // FIXME: fragment large messages
    sock.send = function (msg, opcode) {
        var len = msg.length,
            hlen = 2,
            header = new Buffer(10);
        if (sock.serverClosed) {
            debug('send: closed, ignoring');
            return;
        }
        header[0] = 0x80 | opcode;
        header[1] = len;
        if (len > 125) {
            if (len < 0x10000) {
                hlen = 4;
                header[1] = 126;
                header.writeUInt16BE(len, 2);
            }
            else {
                hlen = 10;
                header[1] = 127;
                header.writeUInt32BE(Math.floor(len / 0x100000000), 2);
                header.writeUInt32BE(len & 0xffffffff, 6);
            }
        }
        debug('send header: ' + header.slice(0, hlen).toString('hex'));
        sock.write(header.slice(0, hlen));
        debug('send message: ' + msg.toString('hex', 0, LIMIT) +
            (msg.length > LIMIT ? '...' : ''));
        sock.write(msg);
    };

    sock.on('data', (function () {
        var readBuf,
            state = 'head',
            msgOpcode,
            message = null,
            isFin,
            frameOpcode,
            frameLen,
            frame,
            buf = new Buffer(2),
            bufOff = 0;

        readBuf = function (data) {
            var max = buf.length - bufOff;
            if (max > data.length) {
                max = data.length;
            }
            data.copy(buf, bufOff, 0, max);
            bufOff += max;
            data = data.slice(max, data.length);
            if (bufOff < buf.length) {
                return null;
            }
            return data;
        };
        return function (data) {
            var frame, i;
            if (sock.clientClosed || !sock.canRead) {
                debug('ignoring data [' + data.length + ']');
                return;
            }
            debug('data[' + data.length + ']: ' +
                data.toString('hex', 0, LIMIT) +
                (data.length > LIMIT ? '...' : ''));
            while (true) {
                data = readBuf(data);
                if (!data) {
                    return;
                }
                bufOff = 0;
                if (state === 'head') {
                    debug('frame head: ' + buf.toString('hex'));
                    isFin = (buf[0] & 0x80) !== 0;
                    if ((buf[1] & 0x80) === 0) {
                        sock.close(1002, 'no masking');
                        sock.canRead = false;
                        return;
                    }
                    if ((buf[0] & 0x70) !== 0) {
                        sock.close(1002, 'non zero reserved bits');
                        sock.canRead = false;
                        return;
                    }
                    frameOpcode = buf[0] & 0x0f;
                    if (frameOpcode >= 3 && frameOpcode <= 7 ||
                            frameOpcode >= 0xb) {
                        sock.close(1002, 'unknown opcode');
                        sock.canRead = false;
                        return;
                    }
                    frameLen = buf[1] & 0x7f;
                    if (frameLen <= 125) {
                        state = 'data';
                        buf = new Buffer(4 + frameLen);
                    }
                    else {
                        state = 'len';
                        buf = new Buffer(frameLen === 126 ? 2 : 8);
                    }
                    continue;
                }
                if (state === 'len') {
                    frameLen = buf.length === 2 ? buf.readUInt16BE(0) :
                            buf.readUInt32BE(0) * 0x100000000 +
                                buf.readUInt32BE(4);
                    debug('frame len: ' + buf.toString('hex'));
                    if (frameLen > MAX_FRAME) {
                        sock.close(1009, 'frame is too big');
                        sock.canRead = false;
                        return;
                    }
                    if (frameLen +
                            (message === null ? 0 : message.length) >
                            MAX_MESSAGE) {
                        sock.close(1009, 'message is too big');
                    }
                    state = 'data';
                    buf = new Buffer(4 + frameLen);
                    continue;
                }
                if (state === 'data') {
                    state = 'head';
                    frame = buf;
                    buf = new Buffer(2);
                    debug('frame: ' + frameOpcode + ' ' + frame.length +
                        ' - ' + 4);
                    for (i = 4; i < frame.length; i++) {
                        frame[i] ^= frame[i % 4];
                    }
                    frame = frame.slice(4);
                    if (frameOpcode <= 2) {
                        if (frameOpcode !== 0) {
                            if (message !== null) {
                                sock.close(1002, 'incomplete message');
                                continue;
                            }
                            message = frame;
                            msgOpcode = frameOpcode;
                        }
                        else {
                            frame = Buffer.concat([message, frame]);
                        }
                        if (!isFin) {
                            message = frame;
                            continue;
                        }
                        message = null;
                        debug('message[' + frame.length + ']: ' +
                            frame.toString('hex', 0, LIMIT) +
                            (frame.length > LIMIT ? '...' : ''));
                        sock.onmessage(frame, msgOpcode);
                        continue;
                    }
                    debug('control: ' + frame.toString('hex'));
                    if (!isFin) {
                        sock.close(1002, 'fragmented control');
                        continue;
                    }
                    if (frameOpcode === 8) {  // close
                        debug('client close: ' + frame.readUInt16BE(0));
                        sock.clientClosed = true;
                        if (sock.serverClosed) {
                            sock.end();
                        }
                        else {
                            sock.close(frame.readUInt16BE(0));
                        }
                        return;
                    }
                    if (frameOpcode === 9) {  // ping
                        debug('ping...');
                        sock.send(frame, 10);
                        continue;
                    }
                    if (frameOpcode === 10) {  // pong
                        debug('pong...');
                        continue;
                    }
                }
            }
        };
    }()));

    sock.on('end', function () {
        // FIXME: do something
        log('socket ended...');
    });
};

apps = {};

serve = function (request, response, head) {
    var req = require('url').parse(request.url, true),
        isUpgrade = typeof head !== 'undefined',
        doLater;
    request.on('error', function (e) {
        log(e.stack);
    });
    response.on('error', function (e) {
        log(e.stack);
    });
    response.request = request;
    response.responded = false;
    doLater = function (delay, callback) {
        setTimeout(function () {
            try {
                callback();
            }
            catch (e) {
                if (isUpgrade) {
                    response.write('HTTP/1.1 500 ' + e + '\r\n' +
                        'Content-Length: 0\r\n' +
                        '\r\n');
                }
                else {
                    response.start(500, 'text/plain', {}, util.format(
                        'Failed to handle:\n%j\n%s', req, e.stack));
                }
            }
        }, delay);
    };
    doLater(0, function () {
        var name, stat, appDir, appObj, appIndex, script, token;
        if (req.pathname === '/favicon.ico') {
            response.start(404, 'text/plain', {}, 'Not found');
            return;
        }
        name = req.pathname;
        if (/\/\./.test(name) || name[0] !== '/') {
            throw new Error("Bad file");
        }
        if (name !== '/') {
            name = name.substr(1);
        }
        name = path.join(wwwRoot, name);
        name = path.normalize(name);
        name = path.resolve(name);
        stat = fs.existsSync(name) && fs.statSync(name);
        if (stat && stat.isDirectory()) {
            if (req.pathname[req.pathname.length - 1] !== '/') {
                redirect(response, req.pathname + '/');
                return;
            }
            name = path.join(name, 'index.html');
        }
        appDir = path.dirname(name);
        appObj = {'handlers': null};
        if (!apps.hasOwnProperty(appDir)) {
            appIndex = path.join(appDir, 'index.js');
            if (fs.existsSync(appIndex)) {
                appObj.handlers = require(appIndex).handlers;
            }
            apps[appDir] = appObj;
        }
        script = '';
        if (req.pathname[req.pathname.length - 1] !== '/') {
            script = path.basename(req.pathname);
        }
        appObj = apps[appDir];
        if (appObj.handlers && appObj.handlers.hasOwnProperty(script)) {
            if (isUpgrade) {
                handleSocket(response);
            }
            appObj.handlers[script](response, req.query);
            return;
        }
        sendFile(response, name);
    });
};

run = function () {
    var server = http.createServer(serve);
    server.on('upgrade', serve);
    server.listen(httpPort);
    log('Server running at port %d', httpPort);
};

run();
