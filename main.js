/* jshint -W097 */
/* jshint strict: false */
/* jslint node: true */

'use strict';
const Main = process.env.DEBUG ? require('./lib/debugCul.js') : require('cul');
const adapterName = require('./package.json').name.split('.').pop();

// you have to require the utils module and call adapter function
const utils = require('@iobroker/adapter-core'); // Get common adapter utils

let cul;
const objects   = {};
let metaRoles = {};
let SerialPort;
let Net;
let connectTimeout;
let checkConnectionTimer;

try {
    Net = require('node:net');
} catch (e) {
    console.warn('Net is not available');
}

let adapter;

function startAdapter(options) {
    options = options || {};
    Object.assign(options, {name: adapterName});
    adapter = new utils.Adapter(options);

    adapter.on('stateChange', (id, state) => {
        if (state && !state.ack) {
            adapter.log.debug(`State Change ${JSON.stringify(id)}, State: ${JSON.stringify(state)}`);
            //  State Change "cul.0.FS20.123401.cmd" State: {"val":2,"ack":false,"ts":1581365531968,"q":0,"from":"system.adapter.admin.0","user":"system.user.admin","lc":1581365531968}
            const oAddr = id.split('.');
            if (oAddr.length < 5) {
                adapter.log.error('Invalid id used');
                return;
            }
            // 0: cul; 1:0; 2:FS20; 3:123401; 4:cmd;
            const sHousecode = oAddr[3].substring(0, 4);
            const sAddress = oAddr[3].substring(4, 6);
            if (oAddr[2] === 'FS20' || adapter.config.experimental === true || adapter.config.experimental === 'true') {
                switch (oAddr[4]) {
                    case 'cmdRaw':
                        sendCommand({protocol: oAddr[2], housecode: sHousecode, address: sAddress, command: state.val});
                        break;

                    default:
                        adapter.log.error(`Write of State ${oAddr[4]} currently not implemented`);
                        break;
                }
            } else {
                adapter.log.error('Only FS20 Devices are tested. Please contribute here: https://github.com/ioBroker/ioBroker.cul');
            }
        }
    });

    adapter.on('unload', callback => {
        connectTimeout && clearTimeout(connectTimeout);
        connectTimeout = null;

        checkConnectionTimer && clearTimeout(checkConnectionTimer);
        checkConnectionTimer = null;

        if (cul) {
            try {
                cul.close();
                cul = null;
            } catch (e) {
                adapter.log.error(`Cannot close serial port: ${e.toString()}`);
            }
        }
        callback();
    });

    adapter.on('ready', () => {

        try {
            SerialPort = require('serialport').SerialPort;
        } catch (err) {
            console.warn('Serial port is not available');
            if (adapter.supportsFeature && !adapter.supportsFeature('CONTROLLER_NPM_AUTO_REBUILD')) {
                // re throw error to allow rebuild of serialport in js-controller 3.0.18+
                throw err;
            }
        }

        adapter.setState('info.connection', false, true);

        checkPort(err => {
            if (!err || process.env.DEBUG) {
                main();
            } else {
                adapter.log.error(`Cannot open port: ${err}`);
            }
        });
    });

    adapter.on('message', obj => {
        if (obj) {
            switch (obj.command) {
                case 'listUart':
                    if (obj.callback) {
                        if (SerialPort) {
                            // read all found serial ports
                            SerialPort.list().then(ports => {
                                adapter.log.info(`List of port: ${JSON.stringify(ports)}`);
                                //adapter.sendTo(obj.from, obj.command, ports, obj.callback);
                                adapter.sendTo(obj.from, obj.command, ports.map(item => ({
                                    label: item.friendlyName || item.pnpId || item.manufacturer,
                                    id: item.pnpId,
                                    manufacturer: item.manufacturer,
                                    comName: item.path
                                })), obj.callback);
                            }).catch(err => {
                                adapter.log.warn(`Can not get Serial port list: ${err}`);
                                adapter.sendTo(obj.from, obj.command, [{path: 'Not available'}], obj.callback);
                            });
                        } else {
                            adapter.log.warn('Module serialport is not available');
                            adapter.sendTo(obj.from, obj.command, [{comName: 'Not available'}], obj.callback);
                        }
                    }
                    break;

                case 'listUart5':
                    if (obj.callback) {
                        try {
                            if (SerialPort) {
                                // read all found serial ports
                                SerialPort.list()
                                    .then(ports => {
                                        adapter.log.info(`List of port: ${JSON.stringify(ports)}`);
                                        if (obj.message && obj.message.experimental) {
                                            const dirSerial = '/dev/serial/by-id';
                                            adapter.sendTo(obj.from, obj.command, ports.map(item => ({label: `${dirSerial}/${item.id}${item.manufacturer ? `[${item.manufacturer}]` : ''}`, value: `${dirSerial}/${item.id}`})), obj.callback);
                                        } else {
                                            adapter.sendTo(obj.from, obj.command, ports.map(item => ({label: item.path, value: item.path})), obj.callback);
                                        }
                                    })
                                    .catch(e => {
                                        adapter.sendTo(obj.from, obj.command, [], obj.callback);
                                        adapter.log.error(e)
                                    });
                            } else {
                                adapter.log.warn('Module serialport is not available');
                                adapter.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                            }
                        } catch (e) {
                            adapter.sendTo(obj.from, obj.command, [{label: 'Not available', value: ''}], obj.callback);
                        }
                    }
                    break;

                case 'send':
                    sendCommand({
                        protocol: obj.message.protocol,
                        housecode: obj.message.housecode,
                        address: obj.message.address,
                        command: obj.message.command
                    });
                    break;

                case 'sendraw':
                    sendRaw({
                        command: obj.message.command
                    });
                    break;

                default:
                    adapter.log.error('No such command: ' + obj.command);
                    break;
            }
        }
    });

    return adapter;
}

/***
 * Send a command to the cul module
 * @param {obj.message.protocol, obj.message.housecode, obj.message.address, obj.message.command}
 */
function sendCommand(o) {
    adapter.log.info(`Send command received. Housecode: ${o.housecode}; address: ${o.address}; command: ${o.command}`);
    cul.cmd(o.protocol, o.housecode, o.address, o.command);
}

function sendRaw(o) {
    adapter.log.info('Send RAW command received. ' + o.command);
	//cul.write('F6C480111'); // Raw command
    cul.write(o.command);
}

function checkConnection(host, port, timeout, callback) {
    timeout = timeout || 10000; // default 10 seconds

    checkConnectionTimer = setTimeout(() => {
        checkConnectionTimer = null;
        socket.end();
        callback && callback('Timeout');
        callback = null;
    }, timeout);

    const socket = Net.createConnection(port, host, () => {
        checkConnectionTimer && clearTimeout(checkConnectionTimer);
        checkConnectionTimer = null;
        socket.end();
        callback && callback(null);
        callback = null;
    });

    socket.on('error', err => {
        checkConnectionTimer && clearTimeout(checkConnectionTimer);
        checkConnectionTimer = null;
        socket.end();
        callback && callback(err);
        callback = null;
    });
}

function checkPort(callback) {
    if (adapter.config.type === 'cuno') {
        checkConnection(adapter.config.ip, adapter.config.port, 10000, err => {
            callback && callback(err);
            callback = null;
        });
    } else {
        if (!adapter.config.serialport) {
            callback && callback('Port is not selected');
            return;
        }
        let sPort;
        try {
            sPort = new SerialPort({
                path: adapter.config.serialport || '/dev/ttyACM0',
                baudRate: parseInt(adapter.config.baudrate, 10) || 9600,
                autoOpen: false
            });
            sPort.on('error', err => {
                sPort.isOpen && sPort.close();
                callback && callback(err);
                callback = null;
            });

            sPort.open(err => {
                sPort.isOpen && sPort.close();
                callback && callback(err);
                callback = null;
            });
        } catch (e) {
            adapter.log.error('Cannot open port: ' + e);
            try {
                sPort.isOpen && sPort.close();
            } catch (ee) {

            }
            callback && callback(e);
        }
    }
}

const tasks = [];

function processTasks() {
    if (tasks.length) {
        const task = tasks.shift();

        if (task.type === 'state') {
            adapter.setForeignState(task.id, task.val, true, () =>
                setImmediate(processTasks));
        } else if (task.type === 'object') {
            adapter.getForeignObject(task.id, (err, obj) => {
                if (!obj) {
                    adapter.setForeignObject(task.id, task.obj, (err, res) => {
                        adapter.log.info(`object ${adapter.namespace}.${task.id} created`);
                        setImmediate(processTasks);
                    });
                } else {
                    let changed = false;
                    if (JSON.stringify(obj.native) !== JSON.stringify(task.obj.native)) {
                        obj.native = task.obj.native;
                        changed = true;
                    }

                    if (changed) {
                        adapter.setForeignObject(obj._id, obj, (err, res) => {
                            adapter.log.info(`object ${adapter.namespace}.${obj._id} created`);
                            setImmediate(processTasks);
                        });
                    } else {
                        setImmediate(processTasks);
                    }
                }
            });
        }
    }
}

function setStates(obj) {
    const id = obj.protocol + '.' + obj.address;
    const isStart = !tasks.length;

    for (const state in obj.data) {
        if (!obj.data.hasOwnProperty(state)) {
            continue;
        }
        const oid  = `${adapter.namespace}.${id}.${state}`;
        const meta = objects[oid];
        let val  = obj.data[state];
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
    isStart && processTasks();
}

function connect(callback) {
    const options = {
        connectionMode: adapter.config.type === 'cuno' ? 'telnet' : 'serial' ,
        serialport: adapter.config.serialport || '/dev/ttyACM0',
        mode:       adapter.config.mode       || 'SlowRF',
        baudrate:   parseInt(adapter.config.baudrate, 10) || 9600,
        scc:        adapter.config.type === 'scc',
        coc:        adapter.config.type === 'coc',
        host:       adapter.config.ip,
        port:       adapter.config.port,
        debug:      true,
        logger:     adapter.log.debug
    };

    cul = new Main(options);

    cul.on('close', () => {
        adapter.setState('info.connection', false, true);
        // cul.close();
        connectTimeout = setTimeout(() => {
            connectTimeout = null;
            cul = null;
            connect();
        }, 10000);
    });

    cul.on('ready', () => {
        adapter.setState('info.connection', true, true);
        typeof callback === 'function' && callback();
    });

    cul.on('error', err =>
        adapter.log.error('Error on Cul connection: ' +  err));

    cul.on('data', (raw, obj) => {
        adapter.log.debug(`RAW: ${raw}, ${JSON.stringify(obj)}`);
        adapter.setState('info.rawData', raw, true);

        if (!obj || !obj.protocol || (!obj.address && obj.address !== 0)) {
            return;
        }
        const id = obj.protocol + '.' + obj.address;

        const isStart = !tasks.length;
        if (!objects[adapter.namespace + '.' + id]) {

            const newObjects = [];
            const tmp = JSON.parse(JSON.stringify(obj));
            delete tmp.data;

            const newDevice = {
                _id:    adapter.namespace + '.' + id,
                type:   'device',
                common: {
                    name: (obj.device ? obj.device + ' ' : '') + obj.address
                },
                native: tmp
            };
            for (const _state in obj.data) {
                if (!obj.data.hasOwnProperty(_state)) continue;
                let common;

                if (obj.device && metaRoles[obj.device + '_' + _state]) {
                    common = JSON.parse(JSON.stringify(metaRoles[obj.device + '_' + _state]));
                } else if (metaRoles[_state]) {
                    common = JSON.parse(JSON.stringify(metaRoles[_state]));
                } else {
                    common = JSON.parse(JSON.stringify(metaRoles['undefined']));
                }

                common.name = _state + ' ' + (obj.device ? obj.device + ' ' : '') + id;

                const newState = {
                    _id:    `${adapter.namespace}.${id}.${_state}`,
                    type:   'state',
                    common: common,
                    native: {}
                };

                objects[`${adapter.namespace}.${id}.${_state}`] = newState;
                tasks.push({type: 'object', id: newState._id, obj: newState});
            }
            objects[adapter.namespace + '.' + id] = newDevice;
            tasks.push({type: 'object', id: newDevice._id, obj: newDevice});
        }

        setStates(obj);
        isStart && processTasks();
    });

}

function main() {
    adapter.getForeignObject('cul.meta.roles', (err, res) => {
        if (err || !res) {
            adapter.log.error(`Object cul.meta.roles does not exists - please reinstall adapter! (${err})`);
            typeof adapter.terminate === 'function' ? adapter.terminate(11) : process.exit(11);
            return;
        }
        metaRoles = res.native;
        adapter.getObjectView('system', 'device', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, (err, res) => {
            for (let i = 0, l = res.rows.length; i < l; i++) {
                objects[res.rows[i].id] = res.rows[i].value;
            }
            adapter.getObjectView('system', 'state', {startkey: adapter.namespace + '.', endkey: adapter.namespace + '.\u9999'}, (err, res) => {
                for (let i = 0, l = res.rows.length; i < l; i++) {
                    objects[res.rows[i].id] = res.rows[i].value;
                }
                connect(() => adapter.subscribeStates('*'));
            });
        });
    });
}

// If started as allInOne/compact mode => return function to create instance
if (module && module.parent) {
    module.exports = startAdapter;
} else {
    // or start the instance directly
    startAdapter();
}
