/** `common` of a state, as it is stored in the `native` of the `cul.meta.roles` object */
export type MetaRole = Partial<ioBroker.StateCommon>;

/**
 * Content of `cul.meta.roles`.`native` - the template for the states this adapter creates.
 * The key is either `<device>_<datapoint>`, `<datapoint>` or the literal `undefined`,
 * which is the fallback for everything the map does not know.
 */
export type MetaRoles = Record<string, MetaRole>;

/** Write a value to an already existing state */
export interface StateTask {
    type: 'state';
    id: string;
    val: ioBroker.StateValue;
}

/** Create the object if it does not exist yet, or update its `native` */
export interface ObjectTask {
    type: 'object';
    id: string;
    obj: ioBroker.SettableObject;
}

/**
 * Objects and states are written through one queue, so that a burst of radio messages cannot
 * start dozens of parallel writes into the objects DB.
 */
export type Task = StateTask | ObjectTask;

/** One entry of the port list that the admin dialog requests via `listUart5` */
export interface PortOption {
    value: string;
    label: string;
}

/** Payload of the `send` message */
export interface SendMessage {
    protocol: string;
    housecode: string;
    address: string;
    command: string;
}

/** Payload of the `sendraw` message */
export interface SendRawMessage {
    command: string;
}

/** Payload of the `listUart5` message */
export interface ListUartMessage {
    experimental?: boolean;
}
