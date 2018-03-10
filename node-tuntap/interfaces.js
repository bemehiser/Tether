var os = require('os');
var child_process = require('child_process');
var buffers = require('buffers');
var net = require('net');
var put = require('put');
var binary = require('binary');
var dgram = require('dgram');
var fs = require('fs');
var path = require('path');

var protocols = require('./protocols');
var platform = require('./platform');

var interfaces = {};

var relayCount = 0;

function makeRelayForInterface(interface, tunIP) {
  var relayConnection = {};
  var ip = interface.ip;
  relayConnection.ip = ip;
  
  relayConnection.makeConnection = function(connection) {
    if (connection.destinationString == connection.tunIP) {
      // ignore any wacky connections going to the tun address
      connection.destroy();
      return;
    }

    var closed = true;
    if (connection.protocol === protocols.udp) {
      var s = connection.remote = dgram.createSocket('udp4');
      try {
        console.log('unterace!')
        s.bind(0, tunIP);
        s.bindToInterface(interface.name, tunIP);
      }
      catch (e) {
        console.log(e);
        return;
      }
      closed = false;
      relayCount++;
      // console.log(s.address());
      connection.send = function(data) {
        s.send(data, 0, data.length, connection.destinationPort, connection.destinationString);
      }
      
      s.on('message', function(message) {
        connection.write(message);
      });
    }
    else {
      var s = connection.remote = net.createConnection({
        port: connection.destinationPort,
        host: connection.destinationString,
        localAddress: ip,
        bindToInterface: interface.name,
        allowHalfOpen: true
      }, function(err) {
        if (err) {
          connection.destroy();
          return;
        }
        closed = false;
        relayCount++;
        connection.ready();
      });
      
      connection.send = function(data) {
        try {
          s.write(data);
        }
        catch (e) {
          connection.destroy();
        }
      }
      
      s.on('data', function(data) {
        connection.write(data);
      });
    }
    
    function updateCounters() {
      if (closed)
        return;
      closed = true;
      relayCount--;
    }
    
    connection.remote.on('error', function() {
      updateCounters();
      connection.destroy();
    });
    
    connection.remote.on('end', function() {
      updateCounters();
      connection.close();
    });
    
    connection.remote.on('close', function() {
      updateCounters();
      connection.close();
    });
  }
  
  relayConnection.connectRelay = function(connection) {
    var socket = connection.socket;
    function reportClose() {
      try {
        connection.close();
      }
      catch (e) {
      }
    }

    socket.on('close', reportClose);
    socket.on('end', reportClose);
    socket.on('error', reportClose);
  }
  
  relayConnection.closeAll = function () {
    // no need to close anything, the sockets will crap
    // out and close their counterparts
  }
  
  return relayConnection;
}

function getRelays() {
  var allRelays = [];
  for (var ip in interfaces) {
    interface = interfaces[ip];
    if (!interface)
      continue;
    if (!interface.relayConnection)
      interface.relayConnection = makeRelayForInterface(interface);
    allRelays.push(interface.relayConnection);
  }
  return allRelays;
}

function interfaceChecker() {
  // console.log('Checking interface status...');

  platform.runScript('get-interfaces', [], function(err, stdout, stderr) {
    setTimeout(interfaceChecker, 5000);
    if (!stdout)
      return;
    var newInterfaces = {};
    var lines = stdout.split('\n');
    for (var line in lines) {
      line = lines[line].trim();
      if (line.length == 0)
        continue;
      var split = line.split(' ');
      var name = split[0];
      var ip = split[1];
      newInterfaces[ip] = interfaces[ip];
      if (!newInterfaces[ip]) {
        console.log(ip + ' New interface found.');
        newInterfaces[ip] = {
          ip: ip,
          name: name,
          relayConnection: null
        };
      }
      delete interfaces[ip];
    }
    
    // clean up devices that disappeared...
    for (var ip in interfaces) {
      interface = interfaces[ip];
      if (!interface)
        continue;
      if (!interface.relayConnection)
        continue;
      interface.relayConnection.closeAll();
      console.log(ip + ' Disconnected from device.');
    }

    interfaces = newInterfaces;
  });
}

interfaceChecker();

exports.getRelays = getRelays;