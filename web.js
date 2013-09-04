'use strict';

var http = require('http'),
    util = require('util'),
    fs = require('fs'),
    path = require('path'),
    httpPort = process.env.PORT || 8080,
    wwwRoot = 'www',
    log,
    buffer = '',
    respond,
    respondJSON,
    redirect,
    types,
    sendFile,
    handlers,
    serve,
    run,
    dummy;

log = function () {
    var str = util.format.apply(util, arguments);
    console.log('%s', str);
    buffer += '\n' + str;
}

respond = function (response, code, type, body, headers) {
    if (!response) {
        log('null response');
        return;
    }
    if (response.responded) {
        log('Already responded (now: ' + code + ')');
        log(body);
        return;
    }
    log(response.request.connection.remoteAddress + ' ' +
            response.request.connection.remotePort + ' ' +
            response.request.url + ' ' + code + ' ' + type);
    if (code != 200 || type === types.manifest) {
        log(body);
    }
    if (!headers) {
        headers = {};
    }
    headers['Content-type'] = type;
    response.responded = true;
    response.writeHead(code, headers);
    response.end(body);
};

respondJSON = function (response, obj) {
    respond(response, 200, 'application/json', util.format('%j', obj));
};

redirect = function (response, loc) {
    respond(response, 302, 'text/html', util.format(
            '<html><body>The content is <a href="%s">here</a>.</body></html>',
            loc), {'Location': loc});
};

types = {
    'manifest': 'text/cache-manifest',
    'html': 'text/html',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'mp4': 'video/mp4',
    'js': 'text/javascript',
    'css': 'text/css',
    '': 'text/plain',
    null: 'application/octet-stream'
};

sendFile = function (response, pathName) {
    var name, stat, i, type, size, rs, code, match, options, headers;
    name = pathName;
    if (/\/\./.test(name) || name[0] !== '/') {
        throw new Error("Bad file");
    }
    if (name !== '/') {
        name = name.substr(1);
    }
    name = path.join(wwwRoot, name);
    stat = fs.existsSync(name) && fs.statSync(name);
    if (stat && stat.isDirectory() && name[name.length - 1] !== '/') {
        redirect(response, pathName + '/');
        return;
    }
    if (name[name.length - 1] === '/') {
        name += 'index.html';
    }
    i = name.lastIndexOf('.');
    if (i < 0) {
        i = name.lastIndexOf('/');
    }
    type = name.substr(i + 1);
    if (!types.hasOwnProperty(type)) {
        type = null;
    }
    stat = fs.existsSync(name) && fs.statSync(name);
    if (!stat || !stat.isFile()) {
        if (type === 'manifest') {
            i = name.lastIndexOf('/');
            respond(response, 200, types[type], util.format(
                    'CACHE MANIFEST\n# %s\n', 
                    fs.statSync(name.substr(0, i + 1) + 'index.html').mtime));
            return;
        }
        respond(response, 404, 'text/plain', 'Not found');
        return;
    }
    size = stat.size;
    code = 200;
    options = undefined;
    headers = {'Content-type': types[type], 'Content-length': size};
    if (response.request.headers.hasOwnProperty('range')) {
        match = /bytes=(\d*)-(\d*)/.exec(response.request.headers.range);
        code = 206
        options = {start: 0, end: size - 1};
        if (match[1]) {
            options.start = parseInt(match[1]);
        }
        if (match[2]) {
            options.end = parseInt(match[2]);
        }
        headers['Content-length'] = options.end - options.start + 1;
        headers['Content-range'] =
            'bytes ' + options.start + '-' + options.end + '/' + size;
    } 
    rs = fs.createReadStream(name, options);
    response.writeHead(code, headers);
    log(response.request.connection.remoteAddress + ' ' +
            response.request.url + ' ' + code + ' ' +
            headers['Content-type'] + ' ' + headers['Content-length']);
    rs.pipe(response);
};

handlers = {};

serve = function (request, response) {
    var req = require('url').parse(request.url, true),
        doLater;
    response.responded = false;
    response.request = request;
    doLater = function (delay, callback) {
        setTimeout(function () {
            try {
                callback();
            }
            catch (e) {
                respond(response, 500, 
                        'text/plain', util.format(
                                'Failed to handle:\n%j\n%s',
                                req, e.stack));
            }
        }, delay);
    };
    doLater(0, function () {
        if (req.pathname === '/favicon.ico') {
            respond(response, 404, 'text/plain', '');
            return;
        }
        if (!handlers.hasOwnProperty(req.pathname)) {
            sendFile(response, req.pathname);
            return;
        }
        handlers[req.pathname](response, req.query);
    });
};

run = function () {
    http.createServer(serve).listen(httpPort);
    log('Server running at port %d', httpPort);
}

run();
