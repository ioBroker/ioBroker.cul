/*
 * Reports the serial port this instance has open to the per-host registry of exclusive resources
 * js-controller 8 keeps (`system.host.<hostname>.usedResources.<type>`).
 *
 * The registry answers "who already holds this serial port", so a second instance configured for the
 * same stick is visible instead of only failing to open it. For an adapter that declares nothing,
 * js-controller derives an entry from `native.port` - which is wrong here twice over: a serial port
 * is never derived, and `native.port` is the telnet port of a CUNO, a port on *another* machine that
 * this host does not occupy at all.
 *
 * So the adapter declares its resources itself (`common.declareUsedResources: true` in
 * io-package.json), which also stops that derivation, and reports here what was really opened.
 *
 * Nothing in this module is required for the adapter to work - every failure is logged and swallowed.
 */

/** Feature a js-controller announces once it maintains the registry. Since js-controller 8. */
const USED_RESOURCES_FEATURE = 'CONTROLLER_USED_RESOURCES';

/** A serial port occupied by this instance */
export interface UsedSerialPort {
    /** Path or name of the port as it is opened, e.g. `/dev/ttyACM0`, a `/dev/serial/by-id/...` link or `COM3` */
    port: string;
    /** Baud rate the port is opened with */
    baudRate?: number;
}

/** One entry of the registry, as `checkUsedResource` returns it */
export interface RegisteredSerialPort {
    /** Instance that occupies the port, e.g. `cul.1` */
    instance: string;
    /** Whether that instance is running and really holds it now */
    isBlocked: boolean;
    /** The port it holds */
    data: UsedSerialPort;
}

/**
 * The part of the adapter API this module uses, all of it optional: the methods exist since
 * js-controller 8, and `supportsFeature()` is typed against a union of known features that does not
 * contain {@link USED_RESOURCES_FEATURE} in older types - this adapter builds against those.
 */
interface UsedResourcesApi {
    registerUsedResource?: (type: 'serialPort', data: UsedSerialPort) => Promise<void>;
    freeUsedResource?: (type: 'serialPort', data?: Partial<UsedSerialPort>) => Promise<void>;
    checkUsedResource?: (type: 'serialPort', data?: Partial<UsedSerialPort>) => Promise<RegisteredSerialPort[]>;
    supportsFeature?: (feature: string) => boolean;
}

/** `common` of the instance object, with the flag deciding who fills the registry for it */
type UsedResourcesCommon = ioBroker.AdapterCommon & {
    /**
     * `true`: the adapter declares its resources itself, which is what this module does.
     * Not set: js-controller derives them from `native.port`. `false`: the instance has no entries.
     */
    declareUsedResources?: boolean;
};

/**
 * Log without ever throwing.
 *
 * A free arrives while the adapter is being torn down, at which point its logger can already be
 * gone. A throwing log statement in one of these calls would end up as a rejection nobody listens
 * to, which terminates the adapter - a lot of damage for a line that only says a port was reported.
 *
 * @param adapter the ioBroker adapter
 * @param level the log level to write with
 * @param message what to write
 */
function log(adapter: ioBroker.Adapter, level: 'debug' | 'warn', message: string): void {
    try {
        adapter.log[level](message);
    } catch {
        // There is nothing left that could report this
    }
}

/**
 * How a port is named in the log.
 *
 * @param data the port and the baud rate it is opened with
 */
function describe(data: Partial<UsedSerialPort>): string {
    return `${data.port}${data.baudRate ? ` @ ${data.baudRate}` : ''}`;
}

/**
 * Whether this instance may report its used resources to the host.
 *
 * All three reasons against it are perfectly normal - an older controller, an adapter built against
 * an older `@iobroker/adapter-core`, an instance that leaves the registry to the controller - so
 * none is worth more than a debug line. A host that knows no `registerUsedResource` does not refuse
 * the call, it simply never answers it, so every single one would first sit out the five second
 * timeout of the adapter API. That is why the feature is asked for before anything is sent.
 *
 * @param adapter the ioBroker adapter
 */
function canReportUsedResources(adapter: ioBroker.Adapter): boolean {
    const api = adapter as unknown as UsedResourcesApi;

    if (typeof api.registerUsedResource !== 'function' || typeof api.freeUsedResource !== 'function') {
        // Told apart from the feature below only to name the half that is missing: this one can be
        // fixed by the adapter, by updating its @iobroker/adapter-core
        log(adapter, 'debug', 'Used resources are not reported: @iobroker/adapter-core is older than js-controller 8');
        return false;
    }

    if (typeof api.supportsFeature !== 'function' || !api.supportsFeature(USED_RESOURCES_FEATURE)) {
        log(
            adapter,
            'debug',
            `Used resources are not reported: js-controller keeps no registry of used resources (feature "${USED_RESOURCES_FEATURE}")`,
        );
        return false;
    }

    if ((adapter.common as UsedResourcesCommon | undefined)?.declareUsedResources !== true) {
        // The host would refuse the registration in this case, and asking it first only to be told
        // so costs a message round-trip
        log(
            adapter,
            'debug',
            'Used resources are not reported: "common.declareUsedResources" is not true in io-package.json',
        );
        return false;
    }

    return true;
}

/**
 * Report the serial port as occupied by this instance.
 *
 * The host drops what this instance registered before whenever it starts, so a stale registration of
 * a previous configuration cannot survive a restart.
 *
 * @param adapter the ioBroker adapter
 * @param data the port that is open
 * @returns whether the host accepted the registration
 */
export async function registerUsedSerialPort(adapter: ioBroker.Adapter, data: UsedSerialPort): Promise<boolean> {
    if (!canReportUsedResources(adapter)) {
        return false;
    }

    try {
        await (adapter as unknown as UsedResourcesApi).registerUsedResource!('serialPort', data);
        log(adapter, 'debug', `Registered serial port ${describe(data)} as used by this instance`);
        return true;
    } catch (e: any) {
        log(adapter, 'warn', `Could not register serial port ${describe(data)} as used: ${e.message}`);
        return false;
    }
}

/**
 * Take the reported serial port back.
 *
 * `data` is a filter and not the exact payload: every field it names has to match, fields it leaves
 * out are ignored - so omitting it frees every serial port of this instance. Freeing on shutdown is
 * not needed, the host marks the entries of a stopped instance as no longer held by itself.
 *
 * @param adapter the ioBroker adapter
 * @param data the fields identifying the port to free; every serial port of this instance without it
 * @returns whether the host accepted the request
 */
export async function freeUsedSerialPort(adapter: ioBroker.Adapter, data?: Partial<UsedSerialPort>): Promise<boolean> {
    if (!canReportUsedResources(adapter)) {
        return false;
    }

    try {
        await (adapter as unknown as UsedResourcesApi).freeUsedResource!('serialPort', data);
        log(adapter, 'debug', `Freed serial port ${data ? describe(data) : 'registrations'} of this instance`);
        return true;
    } catch (e: any) {
        log(adapter, 'warn', `Could not free serial port ${data ? describe(data) : 'registrations'}: ${e.message}`);
        return false;
    }
}

/**
 * Say in the log which other instance holds the port this adapter is about to open.
 *
 * Asked before opening it: afterwards the operating system has already decided the conflict, and all
 * this could do is improve the wording of the error. The answer is a hint and not a permission - the
 * registry knows what adapters declare, so an empty result does not promise the port is free, and a
 * program outside ioBroker holding it is not in the registry at all.
 *
 * @param adapter the ioBroker adapter
 * @param data the port that is about to be opened
 * @param what which part of this adapter wants it, for the log line
 */
export async function reportSerialPortConflict(
    adapter: ioBroker.Adapter,
    data: Partial<UsedSerialPort>,
    what: string,
): Promise<RegisteredSerialPort[]> {
    if (!canReportUsedResources(adapter)) {
        return [];
    }

    let holders: RegisteredSerialPort[];
    try {
        holders = (await (adapter as unknown as UsedResourcesApi).checkUsedResource!('serialPort', data)) || [];
    } catch (e: any) {
        log(adapter, 'debug', `Could not ask which instance uses serial port ${describe(data)}: ${e.message}`);
        return [];
    }

    if (holders.length) {
        const running = holders.filter(holder => holder.isBlocked);
        log(
            adapter,
            'warn',
            `Serial port ${describe(data)} for ${what} is declared by ${holders
                .map(holder => holder.instance)
                .join(', ')}${running.length ? '' : ' (not running at the moment)'}`,
        );
    }

    return holders;
}
