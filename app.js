/**
 * Shorturl - A url shortener
 */

/**
 * Module dependencies.
 */

var express = require('express')
  , expressMessages = require('express-messages-bootstrap')
  , mongoStore = require('connect-mongodb')
  , net = require('net')
  , models = require('./models')
  , routes = require('./routes')
  , auth = require('./scripts/newUser').auth
  , config = require('./config')
  , user = require('./user')
  ;

process.env.NODE_ENV = process.env.NODE_ENV || config.env || 'development';

process.on('uncaughtException', function (err) {
  console.error('%s - Caught exception: %s', new Date(), err);
});

var red = express.createServer();

red.configure('development', function(){
  red.set('db-uri', models.dbUri.development);
  red.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

red.configure('production', function(){
  red.set('db-uri', models.dbUri.production);
  red.use(express.errorHandler());
});

red.configure(function(){
  red.set('views', __dirname + '/views');
  red.set('view engine', 'jade');
  red.set('view options', { pretty: true });
  config.static && red.use(express.static(__dirname + '/public'));
  red.use(express.bodyParser());
  red.use(red.router);
});

red.param('format', function (req, res, next){
  req.params.format = req.params.format.toLowerCase();
  next();
});

red.get('/:shorturl([^\+\.]+)', function (req, res){
  models.Url.findByShorturl(req.params.shorturl).exec(function (err, doc){
    if (err) res.send(err.message, 500);
    else if (doc) {
      var timestamp = new Date()
        , hit = new models.Hits();
      hit.ip = req.headers['x-forwarded-for'] || req.connection['remoteAddress'];
      hit.referer = req.headers['referer'];
      hit.useragent = req.headers['user-agent'];
      hit.timestamp = timestamp;
      hit.url = doc._id;
      hit.save(function (err){
        if (err && !/E11000 duplicate key error index/.test(err.err)) console.error(err);
        else if (!err) {
          doc.hits.count++;
          doc.hits.lasttimestamp = timestamp;
          doc.save();
        }
      });
      res.redirect(doc.longurl, 301);
    }
    else res.send(404);
  });
});

red.get('/:shorturl([^\+\.]+):info([\+])?.:format?', function (req, res){
  if (!(req.params.info === '+' || req.params.format === 'json')) res.send(400);
  else {
    models.Url.findByShorturl(req.params.shorturl)
      .exec(function (err, result){
        if (err) res.send(err.message, 500);
        else if (result) {
          var doc = result.toJSON(config.BaseUrl);
          if (req.params.format === 'json')
            res.json(doc);
          else {
            res.render('info', {
              title: 'Info about ' + doc.shorturl
            , doc: doc
            });
          }
        }
        else res.send(404);
      });
  }
});

red.all('/', function (req, res){ res.redirect(config.ShortenerUrl); });

red.all('*', function (req, res){
  res.send(404);
});

main = exports.main = express.createServer();

// Configuration

main.set('user', user);

main.configure('development', function(){
  main.set('db-uri', models.dbUri.development);
  main.use(express.errorHandler({ dumpExceptions: true, showStack: true }));
});

main.configure('production', function(){
  main.set('db-uri', models.dbUri.production);
  main.use(express.errorHandler());
});

function checkApiKey (){
  return function (req, res, next){
    var key = null;
    if (req.body && req.body.apikey) key = req.body.apikey;
    else if (req.query && req.query.apikey) key = req.query.apikey;
    else if (req.headers['x-api-key']) key = req.headers['x-api-key'];
    if (key === null) {
      next();
    } else if (key === main.set('user')['api_key']) {
      req.apikey = key;
      req.session = {}; // Mock the session so it doesn't generate
      next();
    } else {
      var e = new Error('Unauthorized (bad API key)');
      e.status = 403;
      next(e);
    }
  };
}

function debug (){
  return function (req, res, next){
    console.log(req.session);
    console.log(req.body);
    next();
  };
}
main.configure(function(){
  main.set('views', __dirname + '/views');
  main.set('view engine', 'jade');
  main.set('view options', { pretty: true });
  config.static && main.use(express.static(__dirname + '/public'));
  main.use(express.query());
  main.use(express.bodyParser());
  main.use(express.methodOverride());
  main.use(express.cookieParser());
  main.use(checkApiKey());
  main.use(express.session({ store: new mongoStore({ url : main.set('db-uri') }), secret: config.SessionSecret }));
  main.use(express.csrf(    { 
      value: function (req){
        return (req.body && req.body._csrf) ||
          (req.query && req.query._csrf) ||
          (req.headers['x-csrf-token']) ||
          // Skip the CSRF check for API requests
          (req.apikey && req.session._csrf);
      }
    }
    ));
  //main.use(debug());
  main.use(main.router);
});

main.dynamicHelpers(
  { csrf: function(req,res){ return req.session && req.session._csrf; }
  , messages: expressMessages
  , loggedIn: function(req,res){
    // This is not a security function, just a hint that is used for the navbar
    return (req.session.username || req.cookies.logintoken);
    }
  }
);

// Params

main.param('format', function (req, res, next){
  req.params.format = req.params.format.toLowerCase();
  next();
});

// Routes

var middleware = require('./middleware');

main.error(function (err, req, res, next){
  if (err instanceof Error) {
    res.send(err.message, err.status);
  }
  else next();
});

main.get('/signin', function (req, res){
  if (req.session.username || req.cookies.logintoken) res.redirect('/create');
  else {
    res.render('signin',
      { title: 'Sign In' }
    );
  }
});

main.post('/sessions', function (req, res){

  if ((req.body.username === user.username) &&
      (req.body.password && auth(req.body.password, user.hashed_password, user.salt))) {
    var redirect_url = req.session.originalUrl;
    req.session.regenerate(function (){
      // Add the user data to the session variable for convenience
      req.session.user = user;
      req.session.username = user.username;

      // Store the user's primary key
      // in the session store to be retrieved,
      var loginToken = new models.LoginToken({ username: user.username });
      loginToken.save(function () {
        // Remember me
        if (req.body.rememberme) {
          res.cookie('logintoken', loginToken.cookieValue, { expires: new Date(Date.now() + 2 * 604800000), path: '/' }); // 2 weeks
        } else {
          res.cookie('logintoken', loginToken.cookieValue, { expires: false });
        }
        res.redirect(redirect_url || '/create');
      });
    });
  } else {
    req.flash('error', 'Your username and password did not match. Please try again.');
    res.redirect('back');
  }
});

main.del('/sessions', middleware.authUser, function (req, res){
  // destroy the user's session to log them out
  // will be re-created next request
  if (req.session) {
    models.LoginToken.remove({ username: req.session.username }, function() {} );
    req.session.destroy(function(){
      res.clearCookie('logintoken');
      res.redirect('/signin');
    });
  }
});

main.get('/create', middleware.authUser, middleware.validateLongUrl, function (req, res){
  res.render('create',
    { title: 'Create a New Short Url'
    , url: req.params.url || ''
    }
  );
});

function shorten (req, res){

  function respond (doc){
    if (req.params.format === 'json')
      res.json(doc);
    else
      res.send(doc.shorturl, { 'Content-Type': 'text/plain' }, 200);
  }

  if (!(req.params && req.params.url))
    return res.send(400);

  models.Url.findByUrl(req.params.url, function (err, doc){
    if (err) res.send(err.message, 500);
    else if (doc) respond(doc.toJSON(config.BaseUrl));
    else {
      var u = new models.Url({longurl: req.params.url });
      u.save(function (err){
        if (err) res.send(err.message, 500);
        else respond(u.toJSON(config.BaseUrl));
      });
    }
  });
}

main.get('/shorten.:format?', middleware.authUser, middleware.validateLongUrl, shorten);
main.post('/shorten.:format?', middleware.authUser, middleware.validateLongUrl, shorten);

main.get('/info.:format?', middleware.authUser, function (req, res){
  var query = {};
  if (req.query && req.query.since) query = { 'hits.lasttimestamp': { '$gte': new Date(+req.query.since) } };
  models.Url.find(query)
    .sort('hits.lasttimestamp', -1)
    .exec(function (err, docs){
      if (err) res.send(err.message, 500);
      else res.json(docs.map(function (u){return u.toJSON(config.BaseUrl);}));
    });
});

main.all('/', function (req, res){
  res.redirect('/signin');
});

main.all('*', function (req, res){
  res.send(404);
});

/* Only listen on $ node app.js */
if (!module.parent) {
  red.listen(config.port_redirector);
  console.log("Express server listening on port %d in %s mode", red.address().port, red.settings.env);
  if (config.port_REPL_redirector) {
    net.createServer(function (socket) {
      require('repl').start("node via TCP socket> ", socket).context.app = red;
    }).listen(config.port_REPL_redirector);
  }

  main.listen(config.port_main);
  console.log("Express server listening on port %d in %s mode", main.address().port, main.settings.env);
  if (config.port_REPL_main) {
    net.createServer(function (socket) {
      require('repl').start("node via TCP socket> ", socket).context.app = main;
    }).listen(config.port_REPL_main);
  }
}
