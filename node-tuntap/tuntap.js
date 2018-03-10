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

var protocols = require('./protocols');
var platform = require('./platform');

String.prototype.trim=function(){return this.replace(/^\s\s*/, '').replace(/\s\s*$/, '');};

var tcpCatcherPort = 50001;

function getIPValue(ip) {
  var split = ip.split('.');
  var ret = 0;
  for (var i = 0; i < 4; i++) {
    ret <<= 8;
    ret |= Number(split[i]);
  }
  return ret;
}

function getIPString(ip) {
  var sourceIP = [];
  for (var i = 0; i < 4; i++) {
    var dot = (ip >> (i * 8)) & 0xff;
    sourceIP[3 - i] = dot;
  }
  return sourceIP.join('.');
}

function calculateIPChecksum(buffer, size, offset) {
  var checksum = 0;
  var i = 0;
  if (offset != null)
    i += offset;

  while (size > 1) {
    var toadd = (buffer.readUInt8(i + 1) << 8) + buffer.readUInt8(i);
    checksum += toadd;
    size -= 2;
    i += 2;
  }
  
  if (size > 0) {
    checksum += buffer.readUInt8(i);
    i++;
  }
  
  checksum = (checksum >> 16) + (checksum & 0xffff);
  checksum += (checksum >> 16);

  checksum = ~checksum & 0xffff;
  return checksum;
}

function trimConnection(c) {
  return {
      source: c.source,
      sourcePort: c.sourcePort,
      destination: c.destination,
      destinationPort: c.destinationPort,
      destinationString: c.destinationString,
      sourceString: c.sourceString,
      protocol: c.protocol,
      tunIP: c.tunIP,
      acceptInfo: c.acceptInfo,
      catcherPort: c.catcherPort
  };
}

function tun(device, tunIP, options) {
  options = options || {};
  var tunIPValue = this.IPValue = getIPValue(tunIP);
  this.device = device;
  this.IP = tunIP;
  var tunthis = this;
  var tunFile;
  var catcherEmitter = new events.EventEmitter();

  this.close = function(cb) {
    tunthis.removeAllListeners();
    if (tunFile) {
      fs.closeSync(tunFile);
      tunFile = null;
    }
    if (tunthis.tcpCatcher) {
      try {
        tunthis.tcpCatcher.close();
      }
      catch (e) {
      }
    }
    platform.runScript('interface-shutdown', [path.basename(device)], cb);
  }
  
  console.log('Opening tun device: ' + device);
  os.setupTun(function(err, fd) {
    tunFile = fd;
    if (err) {
      console.log('Unable to open tun device! Exiting.');
      console.log(err);
      process.exit(1);
      return;
    }

    var packetWriting = false;
    var packetQueue = [];
    function packetPump(packet) {
      assert(packet != null || !packetWriting);
      if (packet && packetQueue.length > 0) {
        var buffer = new Buffer(packet.length);
        packet.copy(buffer, 0, 0, packet.length);
        packetQueue.push(buffer);
        packet = null;
      }
      if (packetWriting)
        return;
      
      if (!packet)
        packet = packetQueue.pop();
      if (!packet)
        return;
      if (!tunFile)
        return;
      packetWriting = true;
      fs.write(tunFile, packet, 0, packet.length, null, function(err, written, buffer) {
        if (written != buffer.length || written != packet.length) {
          console.log('wtf');
          console.log(written);
          console.log(packet.length);
          console.log(buffer.length);
        }
        packetWriting = false;
        packetPump();
      });
    }
    
    function queuePacket(packet) {
      if (os.platform() == 'win32') {
        fs.writeSync(tunFile, packet, 0, packet.length);
      }
      else {
        packetPump(packet);
      }
    }

    var tcpConnections = {
      type: 'tcp',
      port: tcpCatcherPort,
      isCatcherPort: function(port) {
        return port == 50001;
      },
      add: function(connection, port) {
        connection.catcherPort = 50001;
        tcpConnections[port] = connection;
      },
      checksumOffset: 16
    };
    
    var udpConnections = {
      type: 'udp',
      catchers: {},
      isCatcherPort: function(port) {
        return udpConnections.catchers[port] != null;
      },
      add: function(connection, port) {
        udpConnections[port] = connection;
        udpConnections.catchers[connection.catcherPort] = connection;
      },
      checksumOffset: 6
    };
    
    var protocolConnections = {
    }
    protocolConnections[protocols.tcp] = tcpConnections;
    protocolConnections[protocols.udp] = udpConnections;
    
    function rewritePacket(connections, packet, source, sourcePort, destination, destinationPort, vars) {
      var headerLength = (vars.first & 0xf) * 4;
      var payloadLength = vars.totalLength - headerLength;

      // console.log(sprintf('original checksum: %x', packet.readUInt16BE(10)));
      packet.writeUInt32BE(source, 12);
      packet.writeUInt32BE(destination, 16);
      // clear out the old checksum
      packet.writeUInt16BE(0, 10);
      
      var headerLength = (vars.first & 0xf) * 4;
      var ipChecksum = calculateIPChecksum(packet, headerLength);
      // write the new checksum
      packet.writeUInt16LE(ipChecksum, 10);
      // console.log(sprintf('new checksum: %x', packet.readUInt16BE(10)));
      // ipChecksum = calculateIPChecksum(packet, headerLength);
      // console.log(sprintf('verified checksum: %x', ipChecksum));
      
      var stashedIPHeader = new Buffer(headerLength);
      packet.copy(stashedIPHeader, 0, 0, headerLength);
      // console.log(stashedIPHeader);

      // now create a pseudo header for the tcp checksum, in place.
      var startOffset = headerLength - 12;
      packet.writeUInt32BE(source, startOffset);
      packet.writeUInt32BE(destination, startOffset + 4);
      packet.writeUInt8(0, startOffset + 8);
      packet.writeUInt8(vars.protocol, startOffset + 9);
      packet.writeUInt16BE(payloadLength, startOffset + 10);
      // this completes the rewrite of the tcp checksum pseudo-header
      // rewrite the ports and clear out the old checksum
      packet.writeUInt16BE(sourcePort, headerLength);
      packet.writeUInt16BE(destinationPort, headerLength + 2);
      // console.log(sprintf('original tcp checksum: %x', packet.readUInt16BE(headerLength + 16)));
      // clear out the old checksum
      packet.writeUInt16BE(0, headerLength + connections.checksumOffset);

      // pseudo header is complete, checksum it and store
      var tcpChecksum = calculateIPChecksum(packet, 12 + payloadLength, startOffset);
      packet.writeUInt16LE(tcpChecksum, headerLength + connections.checksumOffset);
      // console.log(sprintf('new tcp checksum: %x', packet.readUInt16BE(headerLength + 16)));
      // tcpChecksum = calculateIPChecksum(packet, 12 + payloadLength, startOffset);
      // console.log(sprintf('verified tcp checksum: %x', tcpChecksum));
      
      // tcp checksum is complete, so let's restore the original ip header
      // console.log(packet);
      stashedIPHeader.copy(packet, 0, 0, headerLength);
      // console.log(packet)
      
      // we can now send this packet off to the tun device.
      queuePacket(packet.slice(0, vars.totalLength));
    }
    
    function acceptConnection(c) {
      // c = trimConnection(c);
      var acceptInfo = c.acceptInfo;
      delete c.acceptInfo;
      var vars = acceptInfo.vars;
      var packet = new Buffer(acceptInfo.packet, 'base64');
      var connections = protocolConnections[c.protocol];
      connections.add(c, vars.sourcePort);
      // console.log('master table size (' + connections.type + '): ' + Object.keys(connections).length);
      // console.log(c);
      rewritePacket(connections, packet, vars.destination, vars.sourcePort, vars.source, c.catcherPort, vars);
    }
    
    function closeConnection(c) {
      var connections = protocolConnections[c.protocol];

      if (connections.catchers)
        delete connections.catchers[c.catcherPort];
      delete connections[c.sourcePort];

      // console.log('master table size (' + connections.type + '): ' + Object.keys(connections).length);
    }
    
    tunthis.acceptConnection = acceptConnection;
    tunthis.closeConnection = closeConnection;
    
    tunthis.on('tun-accept', function(c) {
      acceptConnection(c);
    });
    tunthis.on('tun-close', function(c) {
      // console.log('master got tun-close for ');
      // console.log(c);
      closeConnection(c);
    });

    function newConnection(packet, vars, connections, bytesRead) {
      var c = {
          source: vars.source,
          sourcePort: vars.sourcePort,
          destination: vars.destination,
          destinationPort: vars.destinationPort,
          destinationString: getIPString(vars.destination),
          sourceString: getIPString(vars.source),
          protocol: vars.protocol,
          tunIP: tunIP,
          acceptInfo: {
            vars: vars,
            packet: packet.toString('base64', 0, bytesRead)
          }
      };
      // console.log('connection request');
      catcherEmitter.emit(connections.type + '-outgoing', c);
    }
    
    var recvWindow = 0;
    var recvWindowTime = 0;

    function doWindow(more) {
      recvWindow += more;
      if (Date.now() > recvWindowTime + 5000) {
        console.log('tun/tap MBps: ' + (recvWindow / 1024 / 1024 / 5));
        recvWindowTime = Date.now();
        recvWindow = 0;
      }
    }

    // find the existing connection for a packet, if it exists.
    // if it not exist, create it.
    function handleConnection(packet, vars, parser, connections, bytesRead) {
      // connections are stored in a dictionary with the destination and *source* port as the key.
      // the source port/destination is unique in the tcp/ip stack and can be used
      // to as a way to track connections.
      var headerLength = (vars.first & 0xf) * 4;
      
      // skip the first 20 bytes
      if (headerLength > 20) {
        parser = parser
        .word32bu('options')
      }

      parser = parser
      .word16bu('sourcePort')
      .word16bu('destinationPort')
      
      // console.log('source');
      // console.log(getIPString(vars.source));
      // console.log(vars.sourcePort);
      // console.log('destination');
      // console.log(getIPString(vars.destination));
      // console.log(vars.destinationPort);

      vars = parser.vars;

      var options = vars.options;
      if (options === null)
        options = 0;

      if (vars.source == tunIPValue) {
        // console.log(getIPString(vars.source));
        // console.log(vars.sourcePort);
        // console.log(getIPString(vars.destination));
        // console.log(vars.destinationPort);

        // see if this packet is originating from a traffic catcher
        if (connections.isCatcherPort(vars.sourcePort)) {
          var localConnection = connections[vars.destinationPort];
          if (localConnection != null) {
            // doWindow(vars.totalLength);
            // console.log('rewriting packet: ' + getIPString(localConnection.destination) + ' of len ' + vars.totalLength);
            rewritePacket(connections, packet, localConnection.destination, localConnection.destinationPort, localConnection.source, localConnection.sourcePort, vars);
          }
          else {
            // hrm this seems to occur sometimes. i think due to a race condition
            // when a tcp connection is accepted and written to before
            // the tcpConnections on the tun side has been made aware of it.
            // event emitter.emit on next tick lag.
            // it's a non issue, since tcp will correct for this.
            // console.log('where the f');
          }
          // console.log('rewriting tcp catcher response');
          return;
        }
        else {
          // see if this packet is already part of an accepted connection
          // and needs to be directed to a traffic catcher
          var localConnection = connections[vars.sourcePort];
          
          if (localConnection) {
            // console.log('rewriting local response: ' + getIPString(vars.destination));
            rewritePacket(connections, packet, vars.destination, vars.sourcePort, vars.source, localConnection.catcherPort, vars);
            return;
          }
        }
      }

      newConnection(packet, vars, connections, bytesRead);
    }

    function reader(err, bytesRead, packet) {
      if (err) {
        console.log('error in reader');
        console.log(err);
        return;
      }
      var parser = binary.parse(packet)
      .word8('first')
      .word8('dcps-ecn')
      .word16be('totalLength')
      .word16be('identification')
      .word16be('flags-fragmentOffset')
      .word8('ttl')
      .word8('protocol')
      .word16be('headerChecksum')
      .word32be('source')
      .word32be('destination');

      var vars = parser.vars;

      var source = vars.source;

      var version = vars.first >> 4;
      var headerLength = (vars.first & 0xf) * 4;

      // skip the first 20 bytes
      if (headerLength > 20) {
        parser = parser
        .word32bu('options')
      }

      switch (vars.protocol) {
        case protocols.tcp:
          handleConnection(packet, vars, parser, tcpConnections, bytesRead);
          break;
        case protocols.udp:
          // queuePacket(packet.slice(0, vars.totalLength));
          handleConnection(packet, vars, parser, udpConnections, bytesRead);
          break;
        case protocols.icmp:
          // console.log('ignoring icmp');
          break;
        default:
          // console.log('unknown protocol: ' + vars.protocol);
          break;
      }
    }

    function postSetupInternal() {
      console.log('Tun/tap device IP: ' + tunIP);
      
      if (!options.noCatcher)
        startCatcher(tunIP, tunthis, catcherEmitter);
      
      // tunthis.tcpCatcher = tcpCatcher;

      var b = new Buffer(65536);

      function readCallback(err, bytesRead, buffer) {
        reader(err, bytesRead, buffer);
        // console.log('actually read from device was: '  + bytesRead);

        if (tunFile)
          fs.read(tunFile, b, 0, b.length, null, readCallback);
      }

      console.log('Reading tun/tap device... ');
      fs.read(tunFile, b, 0, b.length, null, readCallback);
    }
    
    function postSetup() {
      if (os.platform() == 'win32') {
        console.log('Waiting for interface to get ready... (postSetup, waiting 5 seconds)');
        setTimeout(postSetupInternal, 5000);
      }
      else {
        postSetupInternal();
      }
    }

    platform.runScript('interface-setup', [tunIP, path.basename(device)], postSetup);
  });
  
  tunthis.setCatcherWorker = function(worker) {
    catcherEmitter.on('tcp-outgoing', function(c) {
      worker.send({
        message: 'tcp-outgoing',
        c: c
      });
    });
    catcherEmitter.on('udp-outgoing', function(c) {
      worker.send({
        message: 'udp-outgoing',
        c: c
      });
    });
    
    worker.on('exit', function() {
      console.log('TCP Catcher worker has died. Exiting.');
      console.log(arguments);
      process.exit(1);
    });

    worker.on('message', function(message) {
      if (message.message == 'tun-accept') {
        tunthis.emit('tun-accept', message.c);
      }
      else if (message.message == 'tun-close') {
        tunthis.emit('tun-close', message.c);
      }
    });
  }
}

function startCatcher(tunIP, tunthis, catcherEmitter) {
  var tcpConnectionsProxy = {};
  
  catcherEmitter.on('tcp-outgoing', function(c) {
    c.accept = function() {
      tcpConnectionsProxy[c.sourcePort] = c;
      setTimeout(function() {
        // if for some reason it is not accepted, just nuke it in 5 seconds
        delete tcpConnectionsProxy[c.sourcePort];
      }, 5000);
      // console.log('slave tcp table size: ' + Object.keys(tcpConnectionsProxy).length);
      tunthis.emit('tun-accept', trimConnection(c));
    }
    tunthis.emit('tcp-outgoing', c);
  });
  catcherEmitter.on('udp-outgoing', function(c) {
    c.accept = function() {
      var socket = dgram.createSocket("udp4");
      socket.bind(0, tunIP);
      socket.on('close', function() {
        tunthis.emit('tun-close', trimConnection(c));
      });
      c.socket = socket;
      c.catcherPort = socket.address().port;
      // console.log('catcher port: ' + connection.catcherPort);
      tunthis.emit('udp-connect', c);
      tunthis.emit('tun-accept', trimConnection(c));
    }
    tunthis.emit('udp-outgoing', c);
  });
  var tcpCatcher = net.createServer({ allowHalfOpen: true }, function(socket) {
    var remotePort = socket.remotePort;
    var c = tcpConnectionsProxy[remotePort];
    if (!c) {
      console.log('could not find matching connection?');
      return;
    }
    delete tcpConnectionsProxy[remotePort];
    // console.log('slave tcp table size: ' + Object.keys(tcpConnectionsProxy).length);

    socket.on('close', function() {
      // HACK: after a socket closes, we don't want to immediately delete it from
      // the list of handled tcp connections... socket closing is a bit noisy
      // so add a timeout to clean it up after the noise finishes.
      setTimeout(function() {
        tunthis.emit('tun-close', trimConnection(c));
      }, 2000);
    });

    c.socket = socket;
    tunthis.emit('tcp-connect', c);
  });
  tcpCatcher.on('error', function(e) {
    console.log('Fatal error setting up TCP listener. (Exiting)');
    if (e.errno === 'EADDRNOTAVAIL') {
      console.log('A possible cause may be that a "node.exe" processes was left dangling.');
      if (os.platform() === 'win32')
        console.log('Please kill node.exe using Task Manager, if you find it.');
      else
        console.log('Please kill any node processes you find running.');
      console.log('This may also be cause by a firewall that disallows connections to Tether.');
      exitTether();
    }
    console.log(e);
  });
  tcpCatcher.listen(tcpCatcherPort, tunIP, function() {
    console.log('Listening on tether port...');
  });
}

tun.prototype = new events.EventEmitter();

exports.tun = tun;
exports.startMasterTunWorker = function(tunIP) {
  assert(cluster.isWorker);

  var tunthis = new events.EventEmitter();
  tunthis.on('tun-accept', function(c) {
    process.send({
      'message': 'tun-accept',
      c: c
    });
  });
  
  tunthis.on('tun-close', function(c) {
    process.send({
      'message': 'tun-close',
      c: c
    });
  });
  
  var catcherEmitter = new events.EventEmitter();
  process.on('message', function(message) {
    if (message.message == 'tcp-outgoing') {
      catcherEmitter.emit('tcp-outgoing', message.c);
    }
    else if (message.message == 'udp-outgoing') {
      catcherEmitter.emit('udp-outgoing', message.c);
    }
  });
  
  startCatcher(tunIP, tunthis, catcherEmitter);

  return tunthis;
}