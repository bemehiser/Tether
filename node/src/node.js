// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

// Hello, and welcome to hacking node.js!
//
// This file is invoked by node::Load in src/node.cc, and responsible for
// bootstrapping the node.js core. Special caution is given to the performance
// of the startup process, so many dependencies are invoked lazily.
(function(process) {
  this.global = this;

  function startup() {
    var EventEmitter = NativeModule.require('events').EventEmitter;

    process.__proto__ = Object.create(EventEmitter.prototype, {
      constructor: {
        value: process.constructor
      }
    });

    process.EventEmitter = EventEmitter; // process.EventEmitter is deprecated

    startup.globalVariables();
    startup.globalTimeouts();
    startup.globalConsole();

    startup.processAssert();
    startup.processConfig();
    startup.processNextTick();
    startup.processStdio();
    startup.processKillAndExit();
    startup.processSignalHandlers();

    startup.processChannel();

    startup.resolveArgv0();

    // There are various modes that Node can run in. The most common two
    // are running from a script and running the REPL - but there are a few
    // others like the debugger or running --eval arguments. Here we decide
    // which mode we run in.

    if (NativeModule.exists('_third_party_main')) {
      // To allow people to extend Node in different ways, this hook allows
      // one to drop a file lib/_third_party_main.js into the build
      // directory which will be executed instead of Node's normal loading.
      process.nextTick(function() {
        NativeModule.require('_third_party_main');
      });

    } else if (process.argv[1] == 'debug') {
      // Start the debugger agent
      var d = NativeModule.require('_debugger');
      d.start();

    } else if (process._eval != null) {
      // User passed '-e' or '--eval' arguments to Node.
      evalScript('[eval]');
    } else if (process.argv[1]) {
      // make process.argv[1] into a full path
      var path = NativeModule.require('path');
      process.argv[1] = path.resolve(process.argv[1]);

      // If this is a worker in cluster mode, start up the communiction
      // channel.
      if (process.env.NODE_UNIQUE_ID) {
        var cluster = NativeModule.require('cluster');
        cluster._setupWorker();

        // Make sure it's not accidentally inherited by child processes.
        delete process.env.NODE_UNIQUE_ID;
      }

      var Module = NativeModule.require('module');

      if (global.v8debug &&
          process.execArgv.some(function(arg) {
            return arg.match(/^--debug-brk(=[0-9]*)?$/);
          })) {

        // XXX Fix this terrible hack!
        //
        // Give the client program a few ticks to connect.
        // Otherwise, there's a race condition where `node debug foo.js`
        // will not be able to connect in time to catch the first
        // breakpoint message on line 1.
        //
        // A better fix would be to somehow get a message from the
        // global.v8debug object about a connection, and runMain when
        // that occurs.  --isaacs

        setTimeout(Module.runMain, 50);

      } else {
        // REMOVEME: nextTick should not be necessary. This hack to get
        // test/simple/test-exception-handler2.js working.
        // Main entry point into most programs:
        process.nextTick(Module.runMain);
      }

    } else {
      var Module = NativeModule.require('module');

      // If -i or --interactive were passed, or stdin is a TTY.
      if (process._forceRepl || NativeModule.require('tty').isatty(0)) {
        // REPL
        var opts = {
          useGlobal: true,
          ignoreUndefined: false
        };
        if (parseInt(process.env['NODE_NO_READLINE'], 10)) {
          opts.terminal = false;
        }
        if (parseInt(process.env['NODE_DISABLE_COLORS'], 10)) {
          opts.useColors = false;
        }
        var repl = Module.requireRepl().start(opts);
        repl.on('exit', function() {
          process.exit();
        });

      } else {
        // Read all of stdin - execute it.
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        var code = '';
        process.stdin.on('data', function(d) {
          code += d;
        });

        process.stdin.on('end', function() {
          process._eval = code;
          evalScript('[stdin]');
        });
      }
    }
  }

  startup.globalVariables = function() {
    global.process = process;
    global.global = global;
    global.GLOBAL = global;
    global.root = global;
    global.Buffer = NativeModule.require('buffer').Buffer;
  };

  startup.globalTimeouts = function() {
    global.setTimeout = function() {
      var t = NativeModule.require('timers');
      return t.setTimeout.apply(this, arguments);
    };

    global.setInterval = function() {
      var t = NativeModule.require('timers');
      return t.setInterval.apply(this, arguments);
    };

    global.clearTimeout = function() {
      var t = NativeModule.require('timers');
      return t.clearTimeout.apply(this, arguments);
    };

    global.clearInterval = function() {
      var t = NativeModule.require('timers');
      return t.clearInterval.apply(this, arguments);
    };
  };

  startup.globalConsole = function() {
    global.__defineGetter__('console', function() {
      return NativeModule.require('console');
    });
  };


  startup._lazyConstants = null;

  startup.lazyConstants = function() {
    if (!startup._lazyConstants) {
      startup._lazyConstants = process.binding('constants');
    }
    return startup._lazyConstants;
  };

  var assert;
  startup.processAssert = function() {
    // Note that calls to assert() are pre-processed out by JS2C for the
    // normal build of node. They persist only in the node_g build.
    // Similarly for debug().
    assert = process.assert = function(x, msg) {
      if (!x) throw new Error(msg || 'assertion error');
    };
  };

  startup.processConfig = function() {
    // used for `process.config`, but not a real module
    var config = NativeModule._source.config;
    delete NativeModule._source.config;

    // strip the gyp comment line at the beginning
    config = config.split('\n').slice(1).join('\n').replace(/'/g, '"');

    process.config = JSON.parse(config, function(key, value) {
      if (value === 'true') return true;
      if (value === 'false') return false;
      return value;
    });
  }

  startup.processNextTick = function() {
    var nextTickQueue = [];
    var nextTickIndex = 0;

    process._tickCallback = function() {
      var nextTickLength = nextTickQueue.length;
      if (nextTickLength === 0) return;

      while (nextTickIndex < nextTickLength) {
        var tock = nextTickQueue[nextTickIndex++];
        var callback = tock.callback;
        if (tock.domain) {
          if (tock.domain._disposed) continue;
          tock.domain.enter();
        }
        callback();
        if (tock.domain) {
          tock.domain.exit();
        }
      }

      nextTickQueue.splice(0, nextTickIndex);
      nextTickIndex = 0;
    };

    process.nextTick = function(callback) {
      var tock = { callback: callback };
      if (process.domain) tock.domain = process.domain;
      nextTickQueue.push(tock);
      process._needTickCallback();
    };
  };

  function evalScript(name) {
    var Module = NativeModule.require('module');
    var path = NativeModule.require('path');
    var cwd = process.cwd();

    var module = new Module(name);
    module.filename = path.join(cwd, name);
    module.paths = Module._nodeModulePaths(cwd);
    var script = process._eval;
    if (!Module._contextLoad) {
      var body = script;
      script = 'global.__filename = ' + JSON.stringify(name) + ';\n' +
               'global.exports = exports;\n' +
               'global.module = module;\n' +
               'global.__dirname = __dirname;\n' +
               'global.require = require;\n' +
               'return require("vm").runInThisContext(' +
               JSON.stringify(body) + ', ' +
               JSON.stringify(name) + ', true);\n';
    }
    var result = module._compile(script, name + '-wrapper');
    if (process._print_eval) console.log(result);
  }

  function errnoException(errorno, syscall) {
    // TODO make this more compatible with ErrnoException from src/node.cc
    // Once all of Node is using this function the ErrnoException from
    // src/node.cc should be removed.
    var e = new Error(syscall + ' ' + errorno);
    e.errno = e.code = errorno;
    e.syscall = syscall;
    return e;
  }

  function createWritableStdioStream(fd) {
    var stream;
    var tty_wrap = process.binding('tty_wrap');

    // Note stream._type is used for test-module-load-list.js

    switch (tty_wrap.guessHandleType(fd)) {
      case 'TTY':
        var tty = NativeModule.require('tty');
        stream = new tty.WriteStream(fd);
        stream._type = 'tty';

        // Hack to have stream not keep the event loop alive.
        // See https://github.com/joyent/node/issues/1726
        if (stream._handle && stream._handle.unref) {
          stream._handle.unref();
        }
        break;

      case 'FILE':
        var fs = NativeModule.require('fs');
        stream = new fs.SyncWriteStream(fd);
        stream._type = 'fs';
        break;

      case 'PIPE':
        var net = NativeModule.require('net');
        stream = new net.Stream(fd);

        // FIXME Should probably have an option in net.Stream to create a
        // stream from an existing fd which is writable only. But for now
        // we'll just add this hack and set the `readable` member to false.
        // Test: ./node test/fixtures/echo.js < /etc/passwd
        stream.readable = false;
        stream._type = 'pipe';

        // FIXME Hack to have stream not keep the event loop alive.
        // See https://github.com/joyent/node/issues/1726
        if (stream._handle && stream._handle.unref) {
          stream._handle.unref();
        }
        break;

      default:
        // Probably an error on in uv_guess_handle()
        throw new Error('Implement me. Unknown stream file type!');
    }

    // For supporting legacy API we put the FD here.
    stream.fd = fd;

    stream._isStdio = true;

    return stream;
  }

  startup.processStdio = function() {
    var stdin, stdout, stderr;

    process.__defineGetter__('stdout', function() {
      if (stdout) return stdout;
      stdout = createWritableStdioStream(1);
      stdout.destroy = stdout.destroySoon = function(er) {
        er = er || new Error('process.stdout cannot be closed.');
        stdout.emit('error', er);
      };
      if (stdout.isTTY) {
        process.on('SIGWINCH', function() {
          stdout._refreshSize();
        });
      }
      return stdout;
    });

    process.__defineGetter__('stderr', function() {
      if (stderr) return stderr;
      stderr = createWritableStdioStream(2);
      stderr.destroy = stderr.destroySoon = function(er) {
        er = er || new Error('process.stderr cannot be closed.');
        stderr.emit('error', er);
      };
      return stderr;
    });

    process.__defineGetter__('stdin', function() {
      if (stdin) return stdin;

      var tty_wrap = process.binding('tty_wrap');
      var fd = 0;

      switch (tty_wrap.guessHandleType(fd)) {
        case 'TTY':
          var tty = NativeModule.require('tty');
          stdin = new tty.ReadStream(fd);
          break;

        case 'FILE':
          var fs = NativeModule.require('fs');
          stdin = new fs.ReadStream(null, {fd: fd});
          break;

        case 'PIPE':
          var net = NativeModule.require('net');
          stdin = new net.Stream(fd);
          stdin.readable = true;
          break;

        default:
          // Probably an error on in uv_guess_handle()
          throw new Error('Implement me. Unknown stdin file type!');
      }

      // For supporting legacy API we put the FD here.
      stdin.fd = fd;

      // stdin starts out life in a paused state, but node doesn't
      // know yet.  Call pause() explicitly to unref() it.
      stdin.pause();

      // when piping stdin to a destination stream,
      // let the data begin to flow.
      var pipe = stdin.pipe;
      stdin.pipe = function(dest, opts) {
        stdin.resume();
        return pipe.call(stdin, dest, opts);
      };

      return stdin;
    });

    process.openStdin = function() {
      process.stdin.resume();
      return process.stdin;
    };
  };

  startup.processKillAndExit = function() {
    process.exit = function(code) {
      if (!process._exiting) {
        process._exiting = true;
        process.emit('exit', code || 0);
      }
      process.reallyExit(code || 0);
    };

    process.kill = function(pid, sig) {
      var r;

      // preserve null signal
      if (0 === sig) {
        r = process._kill(pid, 0);
      } else {
        sig = sig || 'SIGTERM';
        if (startup.lazyConstants()[sig]) {
          r = process._kill(pid, startup.lazyConstants()[sig]);
        } else {
          throw new Error('Unknown signal: ' + sig);
        }
      }

      if (r) {
        throw errnoException(errno, 'kill');
      }

      return true;
    };
  };

  startup.processSignalHandlers = function() {
    // Not supported on Windows.
    if (process.platform === 'win32')
      return;

    // Load events module in order to access prototype elements on process like
    // process.addListener.
    var signalWatchers = {};
    var addListener = process.addListener;
    var removeListener = process.removeListener;

    function isSignal(event) {
      return event.slice(0, 3) === 'SIG' && startup.lazyConstants()[event];
    }

    // Wrap addListener for the special signal types
    process.on = process.addListener = function(type, listener) {
      var ret = addListener.apply(this, arguments);
      if (isSignal(type)) {
        if (!signalWatchers.hasOwnProperty(type)) {
          var b = process.binding('signal_watcher');
          var w = new b.SignalWatcher(startup.lazyConstants()[type]);
          w.callback = function() { process.emit(type); };
          signalWatchers[type] = w;
          w.start();

        } else if (this.listeners(type).length === 1) {
          signalWatchers[type].start();
        }
      }

      return ret;
    };

    process.removeListener = function(type, listener) {
      var ret = removeListener.apply(this, arguments);
      if (isSignal(type)) {
        assert(signalWatchers.hasOwnProperty(type));

        if (this.listeners(type).length === 0) {
          signalWatchers[type].stop();
        }
      }

      return ret;
    };
  };


  startup.processChannel = function() {
    // If we were spawned with env NODE_CHANNEL_FD then load that up and
    // start parsing data from that stream.
    if (process.env.NODE_CHANNEL_FD) {
      var fd = parseInt(process.env.NODE_CHANNEL_FD, 10);
      assert(fd >= 0);

      // Make sure it's not accidentally inherited by child processes.
      delete process.env.NODE_CHANNEL_FD;

      var cp = NativeModule.require('child_process');

      // Load tcp_wrap to avoid situation where we might immediately receive
      // a message.
      // FIXME is this really necessary?
      process.binding('tcp_wrap');

      cp._forkChild(fd);
      assert(process.send);
    }
  }

  startup.resolveArgv0 = function() {
    var cwd = process.cwd();
    var isWindows = process.platform === 'win32';

    // Make process.argv[0] into a full path, but only touch argv[0] if it's
    // not a system $PATH lookup.
    // TODO: Make this work on Windows as well.  Note that "node" might
    // execute cwd\node.exe, or some %PATH%\node.exe on Windows,
    // and that every directory has its own cwd, so d:node.exe is valid.
    var argv0 = process.argv[0];
    if (!isWindows && argv0.indexOf('/') !== -1 && argv0.charAt(0) !== '/') {
      var path = NativeModule.require('path');
      process.argv[0] = path.join(cwd, process.argv[0]);
    }
  };

  // Below you find a minimal module system, which is used to load the node
  // core modules found in lib/*.js. All core modules are compiled into the
  // node binary, so they can be loaded faster.

  var Script = process.binding('evals').NodeScript;
  var runInThisContext = Script.runInThisContext;

  function NativeModule(id) {
    this.filename = id + '.js';
    this.id = id;
    this.exports = {};
    this.loaded = false;
  }

  NativeModule._source = process.binding('natives');
  NativeModule._cache = {};

  NativeModule.require = function(id) {
    if (id == 'native_module') {
      return NativeModule;
    }

    var cached = NativeModule.getCached(id);
    if (cached) {
      return cached.exports;
    }

    if (!NativeModule.exists(id)) {
      throw new Error('No such native module ' + id);
    }

    process.moduleLoadList.push('NativeModule ' + id);

    var nativeModule = new NativeModule(id);

    nativeModule.compile();
    nativeModule.cache();

    return nativeModule.exports;
  };

  NativeModule.getCached = function(id) {
    return NativeModule._cache[id];
  }

  NativeModule.exists = function(id) {
    return NativeModule._source.hasOwnProperty(id);
  }

  NativeModule.getSource = function(id) {
    return NativeModule._source[id];
  }

  NativeModule.wrap = function(script) {
    return NativeModule.wrapper[0] + script + NativeModule.wrapper[1];
  };

  NativeModule.wrapper = [
    '(function (exports, require, module, __filename, __dirname) { ',
    '\n});'
  ];

  NativeModule.prototype.compile = function() {
    var source = NativeModule.getSource(this.id);
    source = NativeModule.wrap(source);

    var fn = runInThisContext(source, this.filename, true);
    fn(this.exports, NativeModule.require, this, this.filename);

    this.loaded = true;
  };

  NativeModule.prototype.cache = function() {
    NativeModule._cache[this.id] = this;
  };

  startup();
});
