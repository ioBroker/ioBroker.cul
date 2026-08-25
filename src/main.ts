/*
 * ioBroker.cul - connects a Busware CUL / COC / SCC / CUNO running culfw to ioBroker
 *
 * Copyright (c) 2014-2017 hobbyquaker <hq@ccu.io>
 * Copyright (c) 2014-2026 bluefox <dogafox@gmail.com>
 *
 * Licensed under GPL-2.0-or-later, see LICENSE
 */
import { Adapter, type AdapterOptions } from '@iobroker/adapter-core';
import { createConnection, type Socket } from 'node:net';

import type { SerialPort } from 'serialport';
import type { Cul as CulDevice } from 'cul' with { 'resolution-mode': 'import' };
import type { MetaRole, MetaRoles, PortOption, SendMessage, SendRawMessage, Task } from './lib/types';

/** Serial device that is used when nothing is configured */
const DEFAULT_SERIAL_PORT = '/dev/ttyACM0';
/** Baud rate that is used when nothing is configured */
const DEFAULT_BAUD_RATE = 9600;
/** How long the CUNO gets to answer the TCP reachability check */
const CUNO_CHECK_TIMEOUT = 10_000;
/** Directory with the stable serial device symlinks on Linux */
const SERIAL_BY_ID_DIR = '/dev/serial/by-id';
/** Values that `cul` may deliver for a datapoint that ioBroker stores as boolean/number */
const TRUTHY_VALUES: unknown[] = ['true', true, 1, '1', 'on'];
const FALSY_VALUES: unknown[] = ['false', false, 0, '0', 'off'];

/** Shape of one entry of `SerialPort.list()` that this adapter uses */
interface SerialPortInfo {
    path: string;
    manufacturer?: string;
    pnpId?: string;
    /** only reported on Windows */
    friendlyName?: string;
}

class CulAdapter extends Adapter {
    /** The connection to the CUL. `cul` reconnects on its own, so this is created only once */
    private cul: CulDevice | null = null;
    /** `serialport` is a native module and may be missing - it is therefore loaded lazily */
    private serialPortClass: typeof SerialPort | null = null;
    /** `cul.meta.roles`.`native` - the templates for the states this adapter creates */
    private metaRoles: MetaRoles = {};
    /** Cache of all known objects of this instance, to skip redundant object writes */
    private readonly objects: Record<string, ioBroker.SettableObject> = {};
    /** Objects and states are written one after another through this queue */
    private readonly tasks: Task[] = [];
    private processingTasks = false;
    private checkConnectionTimer: ioBroker.Timeout | null = null;
    private unloaded = false;

    public constructor(options: Partial<AdapterOptions> = {}) {
        super({ ...options, name: 'cul' });

        this.on('ready', () => void this.onReady());
        this.on('stateChange', (id, state) => this.onStateChange(id, state));
        this.on('message', obj => this.onMessage(obj));
        this.on('unload', callback => void this.onUnload(callback));
    }

    private async onReady(): Promise<void> {
        await this.loadSerialPort();

        await this.setState('info.connection', false, true);

        const error = await this.checkPort();
        if (error) {
            this.log.error(`Cannot open port: ${error}`);
            return;
        }

        await this.main();
    }

    /**
     * Load the native `serialport` module. A missing binding is only fatal if the js-controller
     * cannot rebuild it by itself - in that case the error is re-thrown so that it does.
     */
    private async loadSerialPort(): Promise<void> {
        try {
            const serialport = await import('serialport');
            this.serialPortClass = serialport.SerialPort;
        } catch (e) {
            this.log.warn('Serial port is not available');
            if (!this.supportsFeature('CONTROLLER_NPM_AUTO_REBUILD')) {
                // re-throw the error to allow the rebuild of serialport in js-controller 3.0.18+
                throw e;
            }
        }
    }

    /** Check that the configured CUL can be reached, before the real connection is opened */
    private async checkPort(): Promise<string | null> {
        if (this.config.type === 'cuno') {
            if (!this.config.ip) {
                return 'IP address is not configured';
            }
            return this.checkConnection(this.config.ip, this.config.port, CUNO_CHECK_TIMEOUT);
        }

        if (!this.config.serialport) {
            return 'Port is not selected';
        }

        const SerialPortClass = this.serialPortClass;
        if (!SerialPortClass) {
            return 'Module serialport is not available';
        }

        return new Promise<string | null>(resolve => {
            let finished = false;
            let port: InstanceType<typeof SerialPortClass> | undefined;

            const finish = (error: string | null): void => {
                if (finished) {
                    return;
                }
                finished = true;
                try {
                    if (port?.isOpen) {
                        port.close();
                    }
                } catch {
                    // ignore - the port is only opened to see whether it can be opened
                }
                resolve(error);
            };

            try {
                port = new SerialPortClass({
                    path: this.config.serialport || DEFAULT_SERIAL_PORT,
                    baudRate: Number(this.config.baudrate) || DEFAULT_BAUD_RATE,
                    autoOpen: false,
                });
                port.on('error', err => finish(err.message));
                port.open(err => finish(err ? err.message : null));
            } catch (e) {
                finish((e as Error).message);
            }
        });
    }

    /** TCP reachability check for a CUNO */
    private checkConnection(host: string, port: number, timeout: number): Promise<string | null> {
        return new Promise<string | null>(resolve => {
            let finished = false;
            const socket: Socket = createConnection({ host, port });

            const finish = (error: string | null): void => {
                if (finished) {
                    return;
                }
                finished = true;
                if (this.checkConnectionTimer) {
                    this.clearTimeout(this.checkConnectionTimer);
                    this.checkConnectionTimer = null;
                }
                socket.end();
                resolve(error);
            };

            socket.on('connect', () => finish(null));
            socket.on('error', err => finish(err.message));

            this.checkConnectionTimer =
                this.setTimeout(() => {
                    this.checkConnectionTimer = null;
                    finish('Timeout');
                }, timeout) ?? null;
        });
    }

    private async main(): Promise<void> {
        const rolesObject = await this.getForeignObjectAsync('cul.meta.roles');
        if (!rolesObject) {
            this.log.error('Object cul.meta.roles does not exist - please reinstall adapter!');
            this.terminate(11);
            return;
        }
        this.metaRoles = rolesObject.native as MetaRoles;

        // Remember the objects that already exist, so that they are not written again
        for (const type of ['device', 'state'] as const) {
            const view = await this.getObjectViewAsync('system', type, {
                startkey: `${this.namespace}.`,
                endkey: `${this.namespace}.香`,
            });
            for (const row of view.rows) {
                if (row.value) {
                    this.objects[row.id] = row.value;
                }
            }
        }

        await this.connect();
        await this.subscribeStatesAsync('*');
    }

    private async connect(): Promise<void> {
        // `cul` is an ESM only package, so it cannot be required from this CommonJS build
        const { default: Cul } = await import('cul');

        const options: CulDevice.Options = {
            connectionMode: this.config.type === 'cuno' ? 'telnet' : 'serial',
            serialport: this.config.serialport || DEFAULT_SERIAL_PORT,
            mode: this.config.mode || 'SlowRF',
            baudrate: Number(this.config.baudrate) || DEFAULT_BAUD_RATE,
            scc: this.config.type === 'scc',
            coc: this.config.type === 'coc',
            host: this.config.ip,
            port: this.config.port,
            debug: true,
            logger: (...args: unknown[]) => this.log.debug(args.map(arg => String(arg)).join(' ')),
        };

        try {
            this.cul = new Cul(options);
        } catch (e) {
            // an unknown mode or a missing host makes the constructor throw
            this.log.error(`Cannot open CUL connection: ${(e as Error).message}`);
            return;
        }

        // `cul` reconnects by itself, `ready` is emitted again after every successful reconnect
        this.cul.on('ready', () => {
            this.log.debug('CUL is ready');
            void this.setState('info.connection', true, true);
        });

        this.cul.on('close', () => {
            if (!this.unloaded) {
                void this.setState('info.connection', false, true);
            }
        });

        this.cul.on('error', err => this.log.error(`Error on CUL connection: ${err.message}`));

        this.cul.on('data', (raw, message) => this.onCulData(raw, message));
    }

    private onCulData(raw: string, message: CulDevice.Message): void {
        this.log.debug(`RAW: ${raw}, ${JSON.stringify(message)}`);
        void this.setState('info.rawData', raw, true);

        if (!message?.protocol || message.address === undefined) {
            return;
        }

        const id = `${message.protocol}.${message.address}`;

        if (!this.objects[`${this.namespace}.${id}`]) {
            this.createDeviceObjects(id, message);
        }

        this.queueStates(id, message);

        void this.processTasks();
    }

    /** Build the device object and one state object per datapoint of the received message */
    private createDeviceObjects(id: string, message: CulDevice.Message): void {
        const native: Record<string, unknown> = { ...message };
        delete native.data;

        for (const name of Object.keys(message.data ?? {})) {
            const template: MetaRole =
                (message.device ? this.metaRoles[`${message.device}_${name}`] : undefined) ??
                this.metaRoles[name] ??
                this.metaRoles.undefined;

            const common = structuredClone(template) as ioBroker.StateCommon;
            common.name = `${name} ${message.device ? `${message.device} ` : ''}${id}`;

            const state: ioBroker.SettableObject = {
                _id: `${this.namespace}.${id}.${name}`,
                type: 'state',
                common,
                native: {},
            };

            this.objects[state._id!] = state;
            this.tasks.push({ type: 'object', id: state._id!, obj: state });
        }

        const device: ioBroker.SettableObject = {
            _id: `${this.namespace}.${id}`,
            type: 'device',
            common: {
                name: `${message.device ? `${message.device} ` : ''}${message.address}`,
            },
            native,
        };

        this.objects[device._id!] = device;
        this.tasks.push({ type: 'object', id: device._id!, obj: device });
    }

    /** Convert the values of a received message to the type of the according state and queue them */
    private queueStates(id: string, message: CulDevice.Message): void {
        for (const [name, rawValue] of Object.entries(message.data ?? {})) {
            const oid = `${this.namespace}.${id}.${name}`;
            const common = this.objects[oid]?.common as ioBroker.StateCommon | undefined;
            let value = rawValue as ioBroker.StateValue;

            if (common?.type === 'boolean') {
                value = TRUTHY_VALUES.includes(rawValue);
            } else if (common?.type === 'number') {
                if (TRUTHY_VALUES.includes(rawValue)) {
                    value = 1;
                } else if (FALSY_VALUES.includes(rawValue)) {
                    value = 0;
                } else {
                    value = parseFloat(rawValue as string);
                }
            }

            this.tasks.push({ type: 'state', id: oid, val: value });
        }
    }

    /**
     * Work through the queue. A burst of radio messages must not start dozens of parallel writes
     * into the objects DB, so only one pump runs at a time.
     */
    private async processTasks(): Promise<void> {
        if (this.processingTasks) {
            return;
        }
        this.processingTasks = true;

        while (this.tasks.length && !this.unloaded) {
            const task = this.tasks.shift();
            if (!task) {
                break;
            }

            try {
                if (task.type === 'state') {
                    await this.setForeignStateAsync(task.id, task.val, true);
                } else {
                    const existing = await this.getForeignObjectAsync(task.id);
                    if (!existing) {
                        await this.setForeignObjectAsync(task.id, task.obj);
                        this.log.info(`object ${task.id} created`);
                    } else if (JSON.stringify(existing.native) !== JSON.stringify(task.obj.native)) {
                        existing.native = task.obj.native;
                        await this.setForeignObjectAsync(task.id, existing);
                        this.log.info(`object ${task.id} updated`);
                    }
                }
            } catch (e) {
                this.log.warn(`Cannot process ${task.type} ${task.id}: ${(e as Error).message}`);
            }
        }

        this.processingTasks = false;
    }

    private onStateChange(id: string, state: ioBroker.State | null | undefined): void {
        if (!state || state.ack) {
            return;
        }
        this.log.debug(`State Change ${JSON.stringify(id)}, State: ${JSON.stringify(state)}`);

        // cul.0.FS20.123401.cmdRaw => 0: cul; 1: 0; 2: FS20; 3: 123401; 4: cmdRaw
        const parts = id.split('.');
        if (parts.length < 5) {
            this.log.error('Invalid id used');
            return;
        }
        const protocol = parts[2];
        const housecode = parts[3].substring(0, 4);
        const address = parts[3].substring(4, 6);

        if (protocol !== 'FS20' && !this.config.experimental) {
            this.log.error(
                'Only FS20 Devices are tested. Please contribute here: https://github.com/ioBroker/ioBroker.cul',
            );
            return;
        }

        if (parts[4] !== 'cmdRaw') {
            this.log.error(`Write of State ${parts[4]} currently not implemented`);
            return;
        }

        void this.sendCommand({ protocol, housecode, address, command: String(state.val) });
    }

    /** Send a command to the CUL, built by the protocol module of `cul` */
    private async sendCommand(message: SendMessage): Promise<void> {
        if (!this.cul) {
            this.log.warn('Cannot send command: no connection to the CUL');
            return;
        }
        this.log.info(
            `Send command received. Housecode: ${message.housecode}; address: ${message.address}; command: ${message.command}`,
        );
        try {
            await this.cul.cmd(message.protocol, message.housecode, message.address, message.command);
        } catch (e) {
            this.log.error(`Cannot send command: ${(e as Error).message}`);
        }
    }

    /** Write a raw culfw command, e.g. `F6C480111` */
    private async sendRaw(message: SendRawMessage): Promise<void> {
        if (!this.cul) {
            this.log.warn('Cannot send raw command: no connection to the CUL');
            return;
        }
        this.log.info(`Send RAW command received. ${message.command}`);
        try {
            await this.cul.write(message.command);
        } catch (e) {
            this.log.error(`Cannot send raw command: ${(e as Error).message}`);
        }
    }

    private onMessage(obj: ioBroker.Message): void {
        if (!obj) {
            return;
        }

        switch (obj.command) {
            case 'listUart':
                if (obj.callback) {
                    void this.listUartLegacy(obj);
                }
                break;

            case 'listUart5':
                if (obj.callback) {
                    void this.listUart(obj);
                }
                break;

            case 'send':
                void this.sendCommand(obj.message as SendMessage);
                break;

            case 'sendraw':
                void this.sendRaw(obj.message as SendRawMessage);
                break;

            default:
                this.log.error(`No such command: ${obj.command}`);
                break;
        }
    }

    /** Port list for `admin/jsonConfig.json` */
    private async listUart(obj: ioBroker.Message): Promise<void> {
        if (!this.serialPortClass) {
            this.log.warn('Module serialport is not available');
            this.sendTo(obj.from, obj.command, [{ label: 'Not available', value: '' }], obj.callback);
            return;
        }

        try {
            const ports: SerialPortInfo[] = await this.serialPortClass.list();
            this.log.info(`List of port: ${JSON.stringify(ports)}`);

            const result: PortOption[] = [];
            for (const port of ports) {
                result.push({ value: port.path, label: port.path });

                // Only on Linux `pnpId` is the name of the symlink below /dev/serial/by-id. On Windows it is a
                // registry hardware ID and on macOS it is not reported at all, so the path would be nonsense there.
                if (process.platform === 'linux' && port.pnpId) {
                    // the symlinks below /dev/serial/by-id survive a re-plug, the /dev/ttyUSBx does not
                    const byId = `${SERIAL_BY_ID_DIR}/${port.pnpId}`;
                    result.push({
                        value: byId,
                        label: `${byId}${port.manufacturer ? ` [${port.manufacturer}]` : ''}`,
                    });
                }
            }

            this.sendTo(obj.from, obj.command, result, obj.callback);
        } catch (e) {
            this.log.error(`Can not get serial port list: ${(e as Error).message}`);
            this.sendTo(obj.from, obj.command, [], obj.callback);
        }
    }

    /** Port list in the format of the removed HTML configuration dialog, kept for compatibility */
    private async listUartLegacy(obj: ioBroker.Message): Promise<void> {
        if (!this.serialPortClass) {
            this.log.warn('Module serialport is not available');
            this.sendTo(obj.from, obj.command, [{ comName: 'Not available' }], obj.callback);
            return;
        }

        try {
            const ports: SerialPortInfo[] = await this.serialPortClass.list();
            this.log.info(`List of port: ${JSON.stringify(ports)}`);
            this.sendTo(
                obj.from,
                obj.command,
                ports.map(port => ({
                    label: port.friendlyName || port.pnpId || port.manufacturer,
                    id: port.pnpId,
                    manufacturer: port.manufacturer,
                    comName: port.path,
                })),
                obj.callback,
            );
        } catch (e) {
            this.log.warn(`Can not get Serial port list: ${(e as Error).message}`);
            this.sendTo(obj.from, obj.command, [{ path: 'Not available' }], obj.callback);
        }
    }

    private async onUnload(callback: () => void): Promise<void> {
        this.unloaded = true;

        try {
            if (this.checkConnectionTimer) {
                this.clearTimeout(this.checkConnectionTimer);
                this.checkConnectionTimer = null;
            }

            if (this.cul) {
                const cul = this.cul;
                this.cul = null;
                await cul.close();
            }
        } catch (e) {
            this.log.error(`Cannot close serial port: ${(e as Error).message}`);
        }

        callback();
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    module.exports = (options: Partial<AdapterOptions> | undefined) => new CulAdapter(options);
} else {
    // otherwise start the instance directly
    (() => new CulAdapter())();
}
