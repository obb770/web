/*jshint node:true */
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
    redirect,
    types,
    sendFile,
    sendManifest,
    apps,
    serve,
    run;

log = function () {
    var str = util.format.apply(util, arguments);
    console.log('%s', str);
    buffer += '\n' + str;
};

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
    'mp3': 'audio/mpeg',
    'wav': 'audio/vnd.wav',
    'js': 'text/javascript',
    'css': 'text/css',
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
        respond(response, 404, 'text/plain', 'Not found');
        return;
    }
    size = stat.size;
    code = 200;
    options = undefined;
    headers = {'Content-type': types[type], 'Content-length': size};
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
    respond(response, 200, types.manifest, data);
};

apps = {};

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
        var name, stat, appDir, appObj, appIndex, script, params;
        if (req.pathname === '/favicon.ico') {
            respond(response, 404, 'text/plain', '');
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
        appObj = apps[appDir];
        if (appObj.handlers) {
            script = path.basename(req.pathname);
            if (appObj.handlers.hasOwnProperty(script)) {
                params = appObj.handlers[script](response, req.query);
                params.unshift(response);
                respond.apply(undefined, params);
                return;
            }
            respond(response, 404, 'text/plain', '');
            return;
        }
        sendFile(response, name);
    });
};

run = function () {
    http.createServer(serve).listen(httpPort);
    log('Server running at port %d', httpPort);
};

run();
