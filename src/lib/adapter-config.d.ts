// Augments the globally declared ioBroker types with everything this adapter adds.
// The attributes of `AdapterConfig` must be kept in sync with `native` in io-package.json
// and with admin/jsonConfig.json.

declare global {
    namespace ioBroker {
        interface AdapterConfig {
            /** Serial device, e.g. `COM3` or `/dev/ttyACM0`. Not used with `type: 'cuno'` */
            serialport: string;
            /** Baud rate of the serial connection */
            baudrate: number;
            /** RF mode the CUL is switched to */
            mode: 'SlowRF' | 'MORITZ' | 'AskSin';
            /** Hardware flavour. `cuno` connects over the network, everything else over serial */
            type: 'cul' | 'coc' | 'scc' | 'cuno';
            /** IP address or hostname of the CUNO, only used with `type: 'cuno'` */
            ip: string;
            /** Telnet port of the CUNO, only used with `type: 'cuno'` */
            port: number;
            /** Accept write commands for protocols other than FS20 */
            experimental: boolean;
        }
    }
}

// this is required so the above is treated as a module
export {};
