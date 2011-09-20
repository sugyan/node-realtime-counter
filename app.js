/**
 * Module dependencies.
 */

var url = require('url');
var sio = require('socket.io');
var oauth = require('oauth');
var mongodb = require('mongodb');
var express = require('express');
var app = module.exports = express.createServer();

var db;

// Configuration

app.configure(function () {
    var RedisStore = require('connect-redis')(express);
    var parsed_url  = url.parse(process.env.REDISTOGO_URL || 'http://localhost:6379');
    var parsed_auth = (parsed_url.auth || '').split(':');

    app.set('views', __dirname + '/views');
    app.set('view engine', 'jade');
    app.use(express.bodyParser());
    app.use(express.methodOverride());
    app.use(express.cookieParser());
    app.use(express.session({
        secret: 'your secret here',
        store: new RedisStore({
            host: parsed_url.hostname,
            port: parsed_url.port,
            pass: parsed_auth[1]
        })
    }));
    app.use(app.router);
    app.use(express['static'](__dirname + '/public'));
});

app.configure('development', function () {
    app.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

app.configure('production', function () {
    app.use(express.errorHandler());
});

app.dynamicHelpers({
    session: function (req, res) {
        return req.session;
    }
});

// Routes

app.get('/', function (req, res) {
    res.render('index');
});

app.get('/signin', function (req, res) {
    var github = new oauth.OAuth2(
        process.env.GITHUB_CLIENT_ID     || process.env.npm_package_config__github_client_id,
        process.env.GITHUB_CLIENT_SECRET || process.env.npm_package_config__github_client_secret,
        'https://github.com/login'
    );
    var code = req.param('code');
    if (code) {
        github.getOAuthAccessToken(code, null, function (err, access_token) {
            if (err || ! access_token) {
                console.error(err || 'access_token failed.');
                res.send(500);
                return;
            }
            github.get('https://api.github.com/user', access_token, function (err, result) {
                if (err) {
                    console.error(err);
                    res.send(500);
                    return;
                }
                var obj = JSON.parse(result);
                req.session.user = {
                    id: obj.id,
                    name: obj.login,
                    image: obj.avatar_url
                };
                var redirect = req.session.redirect;
                if (redirect) {
                    delete req.session.redirect;
                    res.redirect(redirect);
                } else {
                    res.redirect('/');
                }
            });
        });
    } else {
        res.redirect(github.getAuthorizeUrl());
    }
});

app.get('/signout', function (req, res) {
    req.session.destroy();
    res.redirect('/');
});

app.get('/mypage', function (req, res) {
    if (! req.session.user) {
        req.session.redirect = '/mypage';
        res.redirect('/signin');
        return;
    }
    db.collection('counter', function (err, collection) {
        if (err) {
            console.error(err);
            res.send(500);
            return;
        }
        collection.find({ user: req.session.user.id }).toArray(function (err, results) {
            if (err) {
                console.error(err);
                res.send(500);
                return;
            }
            res.render('mypage', { counters: results });
        });
    });
});

app.post('/create', function (req, res) {
    if (! req.session.user) {
        res.send(400);
        return;
    }
    // TODO: validation
    db.collection('counter', function (err, collection) {
        if (err) {
            console.error(err);
            res.send(500);
            return;
        }
        var data = {
            count: 0,
            user: req.session.user.id,
            number: req.param('number'),
            name: req.param('name')
        };
        collection.update({
            user: req.session.user.id,
            number: req.param('number')
        }, { $set: data }, { upsert: true }, function (err) {
            if (err) {
                console.error(err);
                res.send(500);
                return;
            }
            res.redirect('/mypage');
        });
    });
});

// Start

var io = sio.listen(app);
io.set('transports', ['xhr-polling']);
io.sockets.on('connection', function (socket) {
    socket.on('join', function (room, callback) {
        db.collection('counter', function (err, collection) {
            if (err) {
                console.error(err);
                callback(null);
                return;
            }
            try {
                collection.findAndModify({
                    _id: collection.db.bson_serializer.ObjectID(room)
                }, [], {
                    $inc: { count: 1 }
                }, {
                    'new': true
                }, function (err, result) {
                    if (err) {
                        console.error(err);
                        callback(null);
                        return;
                    }
                    if (result) {
                        socket.join(room);
                        socket.broadcast.to(room).emit('increment', result.count);
                        socket.emit('increment', result.count);
                    }
                    callback(result);
                });
            } catch (e) {
                console.error(e);
                callback(null);
            }
        });
    });
});

app.listen(process.env.PORT || 3000, function () {
    console.log("Express server listening on port %d in %s mode", app.address().port, app.settings.env);
    var parsed_url  = url.parse(process.env.MONGOHQ_URL || 'mongodb://127.0.0.1:27017/realtime-counter');
    var parsed_auth = parsed_url.auth ? parsed_url.auth.split(':') : null;
    new mongodb.Db(
        parsed_url.pathname.substr(1),
        new mongodb.Server(parsed_url.hostname, parsed_url.port, {})
    ).open(function (err, client) {
        if (err) { throw err; }
        if (parsed_auth) {
            client.authenticate(parsed_auth[0], parsed_auth[1], function (err, result) {
                if (err) { throw err; }
                if (result) {
                    console.log('mongodb auth OK');
                    db = client;
                } else {
                    throw 'mongodb auth NG';
                }
            });
        } else {
            console.log('mongodb skip authentication');
            db = client;
        }
    });
});
