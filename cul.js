/* jshint -W097 */// jshint strict:false
/*jslint node: true */

'use strict';
var Cul = process.env.DEBUG ? require(__dirname + '/lib/debugCul.js') : require('cul');

// you have to require the utils module and call adapter function
var utils = require(__dirname + '/lib/utils'); // Get common adapter utils

var cul;
var objects   = {};
var metaRoles = {};
var SerialPort;
var Net;
var Promise;

var adapter = utils.Adapter('cul');

try {
    SerialPort = require('serialport');//.SerialPort;
} catch (e) {
    console.warn('Serial port is not available');
}
try {
    Net = require('net');
} catch (e) {
    console.warn('Net is not available');
}
try {
    Promise = require('bluebird');
} catch (e) {
    console.warn('Bluebird is not available');
}

adapter.on('stateChange', function (id, state) {
    //if (cul) cul.cmd();
});

adapter.on('unload', function (callback) {
    if (cul) {
        try {
            cul.close();
        } catch (e) {
            adapter.log.error('Cannot close serial port: ' + e.toString());
        }
    }
    callback();
});

adapter.on('ready', function () {
    checkPort(function (err) {
        if (!err || process.env.DEBUG) {
            main();
        } else {
            adapter.log.error('Cannot open port: ' + err);
        }
    });
});

adapter.on('message', function (obj) {
    if (obj) {
        switch (obj.command) {
            case 'listUart':
                if (obj.callback) {
                    if (SerialPort) {
                        // read all found serial ports
                        SerialPort.list(function (err, ports) {
                            adapter.log.info('List of port: ' + JSON.stringify(ports));
                            adapter.sendTo(obj.from, obj.command, ports, obj.callback);
                        });
                    } else {
                        adapter.log.warn('Module serialport is not available');
                        adapter.sendTo(obj.from, obj.command, [{comName: 'Not available'}], obj.callback);
                    }
                }

                break;
        }
    }
});

function checkConnection(host, port, timeout) {
    return new Promise(function(resolve, reject) {
        timeout = timeout || 10000; //default 10 seconds
        var timer = setTimeout(function() {
            reject("Timeout");
            socket.end();
        }, timeout);
        var socket = Net.createConnection(port, host, function() {
            clearTimeout(timer);
            resolve();
            socket.end();
        });
        socket.on('error', function(err) {
            clearTimeout(timer);
            reject(err);
        });
    });
}

function checkPort(callback) {
    if(adapter.config.type === 'cuno') {
        checkConnection(adapter.config.ip, adapter.config.port).then(function() {
            if (callback) callback(null);
            callback = null;
	}, function(err) {
            if (callback) callback(err);
            callback = null;
        })
    } else {
        if (!adapter.config.serialport) {
            if (callback) callback('Port is not selected');
            return;
        }
        var sPort;
        try {
            sPort = new SerialPort(adapter.config.serialport || '/dev/ttyACM0', {
                baudRate: parseInt(adapter.config.baudrate, 10) || 9600,
                autoOpen: false
            });
            sPort.on('error', function (err) {
                if (sPort.isOpen) sPort.close();
                if (callback) callback(err);
                callback = null;
            });

            sPort.open(function (err) {
                if (sPort.isOpen) sPort.close();

                if (callback) callback(err);
                callback = null;
            });
        } catch (e) {
            adapter.log.error('Cannot open port: ' + e);
            try {
                if (sPort.isOpen) sPort.close();
            } catch (ee) {

            }
            if (callback) callback(e);
        }
    }
}

var tasks = [];

function processTasks() {
    if (tasks.length) {
        var task = tasks.shift();
        if (task.type === 'state') {
            adapter.setForeignState(task.id, task.val, true, function () {
                setTimeout(processTasks, 0);
            });
        } else if (task.type === 'object') {
            adapter.getForeignObject(task.id, function (err, obj) {
                if (!obj) {
                    adapter.setForeignObject(task.id, task.obj, function (err, res) {
                        adapter.log.info('object ' + adapter.namespace + '.' + task.id + ' created');
                        setTimeout(processTasks, 0);
                    });
                } else {
                    var changed = false;
                    if (JSON.stringify(obj.native) !== JSON.stringify(task.obj.native)) {
                        obj.native = task.obj.native;
                        changed = true;
                    }

                    if (changed) {
                        adapter.setForeignObject(obj._id, obj, function (err, res) {
                            adapter.log.info('object ' + adapter.namespace + '.' + obj._id + ' created');
                            setTimeout(processTasks, 0);
                        });
                    } else {
                        setTimeout(processTasks, 0);
                    }
                }
            });
        }
    }
}

function setStates(obj) {
    var id = obj.protocol + '.' + obj.address;
    var isStart = !tasks.length;

    for (var state in obj.data) {
        if (!obj.data.hasOwnProperty(state)) continue;
        var oid  = adapter.namespace + '.' + id + '.' + state;
        var meta = objects[oid];
        var val  = obj.data[state];
        if (meta) {
            if (meta.common.type === 'boolean') {
                val = val === 'true' || val === true || val === 1 || val === '1' || val === 'on';
            } else if (meta.common.type === 'number') {
                if (val === 'on'  || val === 'true'  || val === true)  val = 1;
                if (val === 'off' || val === 'false' || val === false) val = 0;
                val = parseFloat(val);
            }
        }
        tasks.push({type: 'state', id: oid, val: val});
    }
    if (isStart) processTasks();
}

function connect() {
    var options = {
        connectionMode: adapter.config.type === 'cuno' ? 'telnet' : 'serial' ,
        serialport: adapter.config.serialport || '/dev/ttyACM0',
        mode:       adapter.config.mode       || 'SlowRF',
        baudrate:   parseInt(adapter.config.baudrate, 10) || 9600,
        scc:        adapter.config.type === 'scc',
        coc:        adapter.config.type === 'coc',
        host:       adapter.config.ip,
        port:       adapter.config.port,
    };

    cul = new Cul(options);

    cul.on('close', function () {
        adapter.setState('info.connection', false, true);
        //cul.close();
        setTimeout(function () {
            cul = null;
            connect();
        }, 10000);
    });

    cul.on('ready', function () {
        adapter.setState('info.connection', true, true);
    });

    cul.on('data', function (raw, obj) {
        adapter.log.debug('RAW: ' + raw + ', ' + JSON.stringify(obj));
        adapter.setState('info.rawData', raw, true);

        if (!obj || !obj.protocol || !obj.address) return;
        var id = obj.protocol + '.' + obj.address;

        var isStart = !tasks.length;
        if (!objects[adapter.namespace + '.' + id]) {

            var newObjects = [];
            var tmp = JSON.parse(JSON.stringify(obj));
            delete tmp.data;

            var newDevice = {
                _id:    adapter.namespace + '.' + id,
                type:   'device',
                common: {
                    name: (obj.device ? obj.device + ' ' : '') + obj.address
                },
                native: tmp
            };
            for (var _state in obj.data) {
                if (!obj.data.hasOwnProperty(_state)) continue;
                var common;

                if (obj.device && metaRoles[obj.device + '_' + _state]) {
                    common = JSON.parse(JSON.stringify(metaRoles[obj.device + '_' + _state]));
                } else if (metaRoles[_state]) {
                    common = JSON.parse(JSON.stringify(metaRoles[_state]));
                } else {
                    common = JSON.parse(JSON.stringify(metaRoles['undefined']));
                }

                common.name = _state + ' ' + (obj.device ? obj.device + ' ' : '') + id;

                var newState = {
                    _id:    adapter.namespace + '.' + id + '.' + _state,
                    type:   'state',
                    common: common,
                    native: {}
                };

                objects[adapter.namespace + '.' + id + '.' + _state] = newState;
                tasks.push({type: 'object', id: newState._id, obj: newState});
            }
            objects[adapter.namespace + '.' + id] = newDevice;
            tasks.push({type: 'object', id: newDevice._id, obj: newDevice});
        }

        setStates(obj);
        if (isStart) processTasks();
    });

}

function insertObjects(objs, cb) {
    if (objs && objs.length) {
        var newObject = objs.pop();

    } else if (cb) {
        cb();
    }
}

function main() {

    adapter.objects.getObject('cul.meta.roles', function (err, res) {
        metaRoles = res.native;
        adapter.objects.getObjectView('system', 'device', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, function (err, res) {
            for (var i = 0, l = res.rows.length; i < l; i++) {
                objects[res.rows[i].id] = res.rows[i].value;
            }
            adapter.objects.getObjectView('system', 'state', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, function (err, res) {
                for (var i = 0, l = res.rows.length; i < l; i++) {
                    objects[res.rows[i].id] = res.rows[i].value;
                }
                connect();
            });
        });
    });
}
