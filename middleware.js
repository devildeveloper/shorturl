/*
 * Module dependencies
 */

var models = require('./models')
  , main = global.main || {}
  ;

function loggedIn (req, res, next){
  if (req.session.user) next();
  else res.redirect('/signin');
};
exports.loggedIn = loggedIn;

function authenticateFromLoginToken (req, res, next){
  var cookie = JSON.parse(req.cookies.logintoken);

  models.LoginToken.findOne({ username: cookie.username,
                              series: cookie.series,
                              token: cookie.token }, function (err, token){
    if (!token) {
      req.flash('error', 'You must be logged in to use this feature.');
      req.session.redirect_to = req.originalUrl;
      res.redirect('/signin');
    } else if (token.username === main.set('user').username) {
        req.session.regenerate(function (){
          req.session.user = main.set('user');
          req.session.username = main.set('user').username;
          token.token = token.randomToken();
          token.save(function (){
            res.cookie('logintoken', token.cookieValue, { expires: new Date(Date.now() + 2 * 604800000), path: '/' }); // 2 weeks
            next();
          });
        });
    } else {
      req.flash('error', 'It looks like your session expired. You must be log back in to use this feature.');
      req.session.redirect_to = req.originalUrl;
      res.redirect('/signin');
    }
  });
}
exports.authenticateFromLoginToken = authenticateFromLoginToken;

function authUser (req, res, next){
  if (req.session && req.session.user && req.session.username) next();
  else if (req.apikey) next();
  else if (req.cookies.logintoken) {
    authenticateFromLoginToken(req, res, next);
  } else {
    req.flash('error', 'You must be logged in to use this feature.');
    req.session.originalUrl = req.originalUrl;
    res.redirect('/signin');
  }
}
exports.authUser = authUser;

function validateLongUrl (req, res, next){
  var longurl;
  if (!'params' in req) req.params = {};

  if (req.params && req.params.url) longurl = req.params.url;
  else if (req.body && req.body.url) req.params.url = longurl = req.body.url;
  else if (req.query && req.query.url) req.params.url = longurl = req.query.url;

  if (!longurl) next(); // No need to raise an error here
  else if (!/^[A-Za-z][A-Za-z0-9\+\.\-]+:\/\//.test(longurl)) next(new Error('Invalid URL'));
  else next();
}
exports.validateLongUrl = validateLongUrl;
