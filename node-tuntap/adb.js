var os = require('os');
var child_process = require('child_process');
var buffers = require('buffers');
var net = require('net');
var put = require('put');
var binary = require('binary');
var assert = require('assert');
var path = require('path');

var protocols = require('./protocols');

var adbConnected = false;
var adbDevices = {};
var adbLocalConnectPortCounter = 30002;
var isTransmitting = false;


var adbPath = '../' + os.platform() + '/adb';
if (os.platform() == 'win32')
  adbPath = (adbPath + '.exe').replace(/\//g, '\\');

adbPath = '"' + path.join(process.cwd(), adbPath) + '"';

console.log('adb binary path: ' + adbPath);

function getRelays() {
  var allRelays = [];
  for (var adbDevice in adbDevices) {
    adbDevice = adbDevices[adbDevice];
    if (!adbDevice.relayConnection)
      makeRelayForDevice(adbDevice);
    if (adbDevice.relayConnection)
      allRelays.push(adbDevice.relayConnection);
  }

  return allRelays;
}

var relayCount = 0;

function makeRelayForDevice(adbDevice) {
  console.log(adbDevice.deviceId + ' Creating relay for device.');
  var relayConnection;
  var relays = {};
  var relayData = buffers();
  
  function makeConnection(connection) {
    relayCount++;
    // console.log('(open) relays open: ' + relayCount);
    var identifier = connection.sourcePort;
    // udp and tcp can have the same port, which would cause an identifier clash.
    // so to prevent overlapping, give the identifier an extra bit.
    if (connection.protocol === protocols.udp)
      identifier |= 0x00010000;

    connection.identifier = identifier;

    if (!relayConnection)
      return;

    function wrapper() {
      var packet = put()
      .word32be(identifier)
      .word8(2)
      .word32be(9)
      .word8be(connection.protocol)
      .word32be(connection.destination)
      .word32be(connection.destinationPort)
      .buffer();

      relayConnection.write(packet);

      relayConnection.relays[identifier] = connection;
    }

    if (!relayConnection.connected) {
      relayConnection.on('connect', function() {
        wrapper();
      });
    }
    else {
      wrapper();
    }

    connection.send = function(data) {
      var packet = put()
      .word32be(identifier)
      .word8(1)
      .word32be(data.length)
      .put(data)
      .buffer();

      try {
        relayConnection.write(packet);
      }
      catch (e) {
        // console.log(e);
        if (relayConnection)
          relayConnection.closeAll();
      }
    }


    if (connection.protocol === protocols.udp && relayConnection.phoneTetherVersion < 4) {
      var oldSend = connection.send;
      connection.send = function(message) {
        var packet = put()
        .word32be(message.length)
        .put(message)
        .buffer();
        oldSend(packet);
      }
    }
  }
  

  function connectRelay(connection) {
    var socket = connection.socket;
    var identifier = connection.identifier;

    function reportClose() {
      var closing = relays[identifier];
      delete relays[identifier];
      try {
        connection.close();
      }
      catch (e) {
      }

      if (!relayConnection || !relayConnection.connected || !closing) {
        return;
      }
      // console.log("close reported");

      relayCount--;
      // console.log('(close) relays open: ' + relayCount);

      var packet = put()
      .word32be(identifier)
      .word8(0)
      .word32be(0)
      .buffer();
      try {
        relayConnection.write(packet);
      }
      catch (e) {
        closeAll();
      }
    }

    socket.on('close', reportClose);
    socket.on('end', reportClose);
    socket.on('error', reportClose);
  }

  function closeAll() {
    console.log('cleaing up relay connection');
    for (var i in relays) {
      var connection = relays[i];
      connection.destroy();
    }
    relays = {};
    relayData = buffers();
    if (relayConnection) {
      try {
        relayConnection.destroy();
      }
      catch (e) {
      }
    }
    relayConnection = null;
    adbDevice.relayConnection = null;
    adbDevice.adbConnected = false;

    console.log(adbDevice.deviceId + ' Tether connection closed.');
  }

  relayConnection = new net.Socket({ allowHalfOpen: true });
  relayConnection.connect(adbDevice.adbForwardPort, '127.0.0.1');
  relayConnection.on('connect', function(err) {
    console.log(adbDevice.deviceId + ' Tether has connected.');
    relayConnection.connected = true;
    var tetherVersion = 6;
    var versionPacket = put()
    .word32be(tetherVersion)
    .word8(3)
    .word32be(0)
    .buffer();
    try {
      console.log(adbDevice.deviceId + ' Notifying client of Tether version: ' + tetherVersion + '.');
      relayConnection.write(versionPacket);
    }
    catch (e) {
    }
  });

  relayConnection.on('end', function() {
    adbDevice.hasGottenData = false;
    closeAll();
  });

  relayConnection.on('close', function() {
    adbDevice.hasGottenData = false;
    closeAll();
  });

  relayConnection.on('error', function() {
    adbDevice.hasGottenData = false;
    console.log(adbDevice.deviceId + ' Tether error:');
    console.log(arguments);
    closeAll();
  });

  var payloadRemaining = 0;
  var payloadConnection = null;
  
  var recvWindow = 0;
  var recvWindowTime = 0;
  
  function doWindow(more) {
    recvWindow += more;
    if (Date.now() > recvWindowTime + 5000) {
      console.log('MBps: ' + (recvWindow / 1024 / 1024 / 5));
      recvWindowTime = Date.now();
      recvWindow = 0;
    }
  }
  
  function handleData(data) {
    if (relayData.length == 0 && data && payloadRemaining > 0 && data.length <= payloadRemaining) {
      // attempt to write the entire data directly
      // console.log('quick write: ' + data.length);
      payloadRemaining -= data.length;
      // doWindow(data.length);
      if (payloadConnection) {
        // console.log(payloadConnection.socket.bytesWritten);
        try {
            payloadConnection.write(data);
        }
        catch (e) {
          console.log(e);
        }
      }
      return false;
    }

    if (data) {
      relayData.push(data);
    }
    
    if (relayData.length == 0)
      return false;
    
    if (payloadRemaining > 0) {
      // console.log('relay write: ' + relayData.length + 'available for ' + payloadRemaining + ' remaining');
      taken = Math.min(relayData.length, payloadRemaining);
      var prevLength = relayData.length;
      var writing = relayData.splice(0, taken).toBuffer();
      payloadRemaining -= taken;
      // doWindow(taken);
      // assert(prevLength == taken + relayData.length);
      // assert(writing.length == taken);
      if (payloadConnection) {
        // console.log(payloadConnection.socket.bytesWritten);
        try {
            payloadConnection.write(writing);
        }
        catch (e) {
          console.log(e);
        }
      }
    }

    // grab the header, to see if we can parse a full packet
    if (relayData.length < 9) {
      return;
    }
    var headerLength = 9;
    var parser = binary.parse(relayData)
    .word32be('identifier')
    .word8('command')
    .word32be('size');

    var identifier = parser.vars.identifier;

    if (parser.vars.command == 3) {
      // assert(parser.vars.size == 0);
      relayData = relayData.splice(headerLength, relayData.length - headerLength);
      relayConnection.phoneTetherVersion = identifier;
      console.log(adbDevice.deviceId + ' Tether.apk version: ' + relayConnection.phoneTetherVersion);
      return true;
    }

    var connection = relays[identifier];
    if (!connection) {
      // console.log('unknown connection for command: ' + parser.vars.command);
      relayData = relayData.splice(headerLength, relayData.length - headerLength);
      // bypass the parser to eat/read past it...
      payloadConnection = null;
      payloadRemaining = parser.vars.size;
      return true;
    }

    // check if close is requested
    if (parser.vars.command == 0) {
      // assert(parser.vars.size == 0);
      delete relays[identifier];
      relayCount--;
      relayData = relayData.splice(headerLength, relayData.length - headerLength);
      connection.close();
      return true;
    }
    else if (parser.vars.command == 2) {
      // assert(parser.vars.size == 0);
      // connection successful for the given port
      relayData = relayData.splice(headerLength, relayData.length - headerLength);
      connection.ready();
      return true;
    }
    else if (parser.vars.command == 1) {
      var packetLength = parser.vars.size + 9;
      // need more data
      if (connection.protocol == protocols.udp) {
        // console.log('udp');
        if (packetLength > relayData.length) {
          // console.log('waiting for udp packet of size: ' + packetLength);
          // console.log('remaining: ' + (packetLength - relayData.length))
          return false;
        }
        // console.log('udp of length' + parser.vars.size);
        parser = parser
        .buffer('data', parser.vars.size);
        relayData = relayData.splice(packetLength, relayData.length - packetLength);
        try {
          connection.write(parser.vars.data);
        }
        catch (e) {
        }
        return true;        
      }
      else {
        // console.log('tcp : ' + parser.vars.size);
        payloadConnection = connection;
        payloadRemaining = parser.vars.size;
        relayData = relayData.splice(headerLength, relayData.length - headerLength);
        return true;
      }
    }

    // no idea what this packet is for?
    console.log('payload for unknown command');
    payloadConnection = null;
    payloadRemaining = parser.vars.size;
    relayData = relayData.splice(headerLength, relayData.length - headerLength);
    return true;
  }

  relayConnection.on('data', function(data) {
    adbDevice.hasGottenData = true;
    while (handleData(data)) {
      data = null;
    }
  });
  
  relayConnection.closeAll = closeAll;
  relayConnection.connectRelay = connectRelay;
  relayConnection.relays = relays;
  relayConnection.makeConnection = makeConnection;
  
  return adbDevice.relayConnection = relayConnection;
}

function adbError() {
  if (adbConnected)
    console.log('STATUS: Tether has disconnected.');
  adbConnected = false;
  // console.log('STATUS: Phone could not be detected. See log for details.');
  // console.log('Phone not detected by adb!');
  // console.log('Connect your phone to your computer and make sure "USB Debugging" is enabled.');
  // console.log('You may need to set your phone to be in "Charge Only Mode".');
  if (os.platform() == 'win32') {
    console.log('You may need to install a driver for your phone to allow the computer to connect to it.');
    console.log('Consult the menu above to install the "adb drivers" for your phone.');
    console.log('If your manufacturer is not listed, please search Google for "adb drivers my-manufacturer name".');
  }
}

function startTetherOnDevice(adbDevice) {
  var adbCmd = adbPath + ' -s ' + adbDevice.deviceId + ' ';
  console.log(adbDevice.deviceId + ' Setting up adb port forwarding to port 30002.');
  child_process.exec(adbCmd + ' forward tcp:' + adbDevice.adbForwardPort + ' tcp:30002', function(err, stdout, stderr) {
    console.log(adbDevice.deviceId + " adb port forwarding results:");
    console.log(arguments);
    if (err) {
      adbDevice.adbConnected = false;
      console.log(adbDevice.deviceId + ' Error forwarding: ');
      console.log(err);
      return;
    }
    
    console.log(adbDevice.deviceId + ' Starting Tether service.');
    child_process.exec(adbCmd + ' shell am startservice -n com.koushikdutta.tether/com.koushikdutta.tether.TetherService --user 0', function(err, stdout, stderr) {
      console.log(adbDevice.deviceId + ' Results from starting Tether service:');
      console.log(arguments);
      if (err) {
        adbDevice.adbConnected = false;
        console.log(adbDevice.deviceId + ' Error starting tether service: ');
        console.log(err);
      }
      adbDevice.adbConnected = true;
    });

    console.log(adbDevice.deviceId + ' Starting Tether activity.');
    child_process.exec(adbCmd + ' shell am start -n com.koushikdutta.tether/com.koushikdutta.tether.TetherActivity', function(err, stdout, stderr) {
      console.log(adbDevice.deviceId + ' Results from starting Tether activity:');
      console.log(arguments);
    });
  });
}

function connectAdb(adbDevice) {
  var adbCmd = adbPath + ' -s ' + adbDevice.deviceId + ' ';
  // set up the forwarding connection
  console.log(adbDevice.deviceId + ' Checking if package is installed.');
  child_process.exec(adbCmd + ' shell pm list packages', function(err, stdout, stderr) {
    if (err) {
      console.log('Error listing pacakges. Assuming Tether.apk is already installed.');
      startTetherOnDevice(adbDevice);
    }
    else {
      var packages = stdout.split('\n');
      for (var package in packages) {
        package = packages[package];
        // console.log(package);
        package = package.trim();
        if (package === 'package:com.koushikdutta.tether') {
          console.log(adbDevice.deviceId + ' Found that APK is already installed. Starting tether on phone.');
          startTetherOnDevice(adbDevice);
          return;
        }
      }

      console.log('Installing Tether APK on the phone.');
      child_process.exec(adbCmd + ' install ../common/Tether.apk', function(err, stdout, stderr) {
        console.log('Results from APK installation:');
        console.log(arguments);
        startTetherOnDevice(adbDevice);
      });
    }
  });
}

function adbChecker() {
  console.log('Checking phone status...');

  try {
    // console.log(process.cwd());
    // console.log(adbPath);
    child_process.exec(adbPath + ' devices', function(err, stdout, stderr) {
      setTimeout(adbChecker, 5000);
      if (err) {
        console.log(err);
        adbError();
      }
      else {
        var lines = stdout.replace('List of devices attached', '').trim();
        lines = lines.split('\n');
        var newDevices = {};
        for (var line in lines) {
          line = lines[line].trim();
          if (line.length == 0)
            continue;
          var deviceId = line.split(' ', 1);
          deviceId = line.split('\t', 1);
          newDevices[deviceId] = adbDevices[deviceId];
          delete adbDevices[deviceId];
        }

        // clean up devices that disappeared...
        for (var deviceId in adbDevices) {
          adbDevice = adbDevices[deviceId];
          if (!adbDevice)
            continue;
          if (!adbDevice.relayConnection)
            continue;
          adbDevice.relayConnection.closeAll();
          console.log(deviceId + ' Disconnected from device.');
        }

        // and now we have our new device set
        adbDevices = newDevices;

        if (Object.keys(adbDevices).length == 0) {
          adbError();
          return;
        }

        var isAnyTransmitting = false;
        var isAnyConnected = false;
        // with the newly found devices, set up adb connections
        for (var deviceId in adbDevices) {
          var adbDevice = adbDevices[deviceId];
          if (!adbDevice) {
            console.log(deviceId + ' New device found.');
            adbDevices[deviceId] = adbDevice = {
              deviceId: deviceId,
              adbForwardPort: adbLocalConnectPortCounter++,
              adbConnected: false,
              relayConnection: null
            };
          }
          else {
            // console.log(deviceId + ' is still connected.');
          }
          if (adbDevice.adbConnected === false) {
            // null means in progress
            adbDevice.adbConnected = null;
            console.log(deviceId + ' Connecting to device.');
            connectAdb(adbDevice);
          }
          if (adbDevice.adbConnected)
            isAnyConnected = true;
          if (adbDevice.hasGottenData)
            isAnyTransmitting = true;
        }

        if (adbConnected && !isAnyConnected) {
          console.log('STATUS: Tether has disconnected.');
          isTransmitting = false;
        }
        else if (!adbConnected && isAnyConnected) {
          console.log('STATUS: Connected to phone. Waiting for tether connection.');
        }

        if (isAnyTransmitting && !isTransmitting) {
          console.log('STATUS: Tether has connected.');
        }

        isTransmitting = isAnyTransmitting;
        adbConnected = isAnyConnected;
      }
    })
  }
  catch (e) {
    console.log('adb devices error: ');
    console.log(e);
    setTimeout(adbChecker, 5000);
  }
}

adbChecker();

exports.closeAll = function() {
  for (var adbDevice in adbDevices) {
    adbDevice = adbDevices[adbDevice];
    if (adbDevice.relayConnection)
      adbDevice.relayConnection.closeAll();
  }
}
exports.getRelays = getRelays;
