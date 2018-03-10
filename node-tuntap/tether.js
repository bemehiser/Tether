// Copyright 2011 ClockworkMod, LLC.

var fs = require('fs');
var child_process = require('child_process');
var binary = require('binary');
var put = require('put');
var events = require('events');
var net = require('net');
var sprintf = require('sprintf').sprintf;
var util = require("util");
var dgram = require('dgram');
var buffers = require('buffers');
var os = require('os');
var path = require('path');
var assert = require('assert');
var rl = require('readline');
var cluster = require('cluster');

var adb;

var protocols = require('./protocols');
var platform = require('./platform');

var tun = require('./tuntap');

var myWorker;
var t;
function createTun(withWorker) {
  console.log('Opening tun device.');
  if (!withWorker || cluster.isMaster) {
    try {
      fs.statSync('/dev/tun1');
      t = new tun.tun('/dev/tun1', '10.0.0.1', { noCatcher: withWorker });
    }
    catch (e) {
      try {
        fs.statSync('/dev/net/tun');
        t = new tun.tun('/dev/net/tun', '10.0.0.1', { noCatcher: withWorker });
      }
      catch (e) {
        try {
          t = new tun.tun(null, '10.0.0.1', { noCatcher: withWorker });
        }
        catch (e) {
          console.log('unable to open tun/tap device.');
          console.log(e);
          process.exit();
        }
      }
    }
    
    if (withWorker) {
      function forker() {
        // not having this console.log here makes Windows crap out on the fork.
        // hangs the process. stdout needs pumping? Dunno.
        console.log('Forking worker.');
        t.setCatcherWorker(myWorker = cluster.fork());
      }
      if (os.platform() == 'win32') {
        console.log('Waiting for interface to get ready... (forker, waiting 5 seconds)');
        setTimeout(forker, 5000);
      }
      else {
        forker();
      }
    }

    t.on('ready', function() {
      console.log('STATUS: Tether interface is ready.');
    });
  }
  else {
    t = tun.startMasterTunWorker('10.0.0.1');
  }
  
  if (!withWorker || !cluster.isMaster) {
    adb = require('./adb');
    var interfaces;
    if (process.env.USE_INTERFACES)
      interfaces = require('./interfaces');
    function getRelay() {
      var allRelays = adb.getRelays();
      if (interfaces)
        allRelays = allRelays.concat(interfaces.getRelays());
      if (allRelays.length == 0)
        return null;
      var rand = Math.round(Math.random() * (allRelays.length - 1));
      return allRelays[rand];
    }
  }
  
  var pendingConnections = {};
  
  var relayCount = 0;

  t.on('tcp-outgoing', function(connection) {
    var existing = pendingConnections[connection.sourcePort];
    // console.log('pending: ' + Object.keys(pendingConnections).length)
    if (existing)
      return;

    var relayConnection = getRelay();
    if (!relayConnection)
      return;

    connection.ready = function() { 
      delete pendingConnections[connection.sourcePort];
      connection.accept();
    }
    connection.close = function() {
      // console.log('conn closed');
      delete pendingConnections[connection.sourcePort];
      if (connection.connected) {
        // console.log('tuntap.js relay count: ' + relayCount);
        connection.connected = false;
        relayCount--;
      }
      try {
        connection.socket.destroy();
      }
      catch (e) {
      }
    }
    connection.write = function(data) {
      if (!connection.socket) {
        if (!connection.pending)
          connection.pending = new buffers();
        connection.pending.push(data);
        return;
      }
      connection.socket.write(data);
    }
    connection.destroy = function() {
      connection.close();
      try {
        connection.socket.destroy();
      }
      catch (e) {
      }
    }
    
    relayConnection.makeConnection(connection);
    connection.relayConnection = relayConnection;

    pendingConnections[connection.sourcePort] = true;
  });

  t.on('tcp-connect', function (connection) {
    relayCount++;
    connection.connected = true;
    // console.log('tuntap.js relay count: ' + relayCount);
    
    var relayConnection = connection.relayConnection;
    relayConnection.connectRelay(connection);
    if (connection.pending) {
      var packet = put()
      .put(connection.pending)
      .write(connection.socket);

      connection.pending = null;
    }
    connection.socket.on('data', connection.send);
  });


  t.on('udp-connect', function(connection) {
    var relayConnection = connection.relayConnection;
    if (!relayConnection)
      return;
    relayConnection.connectRelay(connection);

    var timeout;
    var duration = 10000;

    function scheduleAutocleanup() {
      if (timeout)
        clearTimeout(timeout);
      timeout = setTimeout(function() {
        try {
          connection.close();
        }
        catch (e) {
        }
      }, duration);
    }

    scheduleAutocleanup();
    connection.socket.on('message', function(message, rinfo) {
      connection.send(message);

      // if (connection.destinationPort === 53)
        // duration = 2000;
      scheduleAutocleanup();
    });
  });

  t.on('udp-outgoing', function(connection) {
    var relayConnection = getRelay();
    if (!relayConnection)
      return;

    connection.write = function(data) {
      var socket = connection.socket;
      socket.send(data, 0, data.length, connection.sourcePort, connection.destinationString, function(err, bytes) {
        if (err)
          console.log(err);
      });
    }
    connection.close = function() {
      connection.socket.close();
    }
    connection.ready = function() {
    }
    connection.destroy = function() {
      connection.socket.close();
    }
    relayConnection.makeConnection(connection);
    connection.relayConnection = relayConnection;

    connection.accept();
  });
}

function exitTether() {
  process.exit();
  console.log('Closing tether adapter.');
  if (myWorker) {
    myWorker.destroy();
    myWorker = null;
  }
  if (adb)
    adb.closeAll();
  t.close(function() {
    console.log('Tether is exiting.');
    process.exit();
  });
}

var useWorker = true;
if (process.env.NO_TUNWORKER)
  useWorker = false;
createTun(useWorker);
if (cluster.isMaster) {
  var inputInterface = rl.createInterface(process.stdin, process.stdout, null);

  inputInterface.on('line', function(line) {
    line = line.trim();
    if (line == 'quit') {
      console.log('Quit command received.');
      exitTether();
    }
    else if (line == 'close') {
      if (t)
        t.close();
      t = null;
    }
    else if (line == 'open') {
      if (t)
        t.close();
      t = null;
      createTun(useWorker);
    }
  });

  inputInterface.on('close', function(line) {
    exitTether();
  });
}
else {
  console.log('tun worker initialized.');
}