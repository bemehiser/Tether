var os = require('os');
var fs = require('fs');
var child_process = require('child_process');

var osScriptExtension = {
  win32: '.bat',
  darwin: '.sh',
  linux: '.sh'
}

function getOSScriptExtension() {
  return osScriptExtension[os.platform()];
}

exports.getOSScriptExtension = getOSScriptExtension;

exports.runScript = function(script, args, cb) {
  var script = './' + os.platform() + '/' + script + getOSScriptExtension();
  try {
    fs.statSync(script);
    child_process.exec(script + ' ' + args.join(' '), cb);
  }
  catch (e) {
    if (cb)
      cb();
  }
}