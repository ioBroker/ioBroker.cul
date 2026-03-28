const util =                      require('node:util');
const EventEmitter =              require('node:events').EventEmitter;
const fs =                        require('node:fs');

const protocol = {
    em:                         require('cul/lib/em.js'),
    //esa:                      require('cul//lib/esa.js'),
    //fht:                      require('cul/lib/fht.js'),
    fs20:                       require('cul/lib/fs20.js'),
    hms:                        require('cul/lib/hms.js'),
    moritz:                     require('cul/lib/moritz.js'),
    //tx:                       require('cul/lib/tx.js'),
    //uniroll:                  require('cul/lib/uniroll.js'),
    ws:                         require('cul/lib/ws.js')
};
// http://culfw.de/commandref.html
const commands = {
    'F':                        'FS20',
    'T':                        'FHT',
    'E':                        'EM',
    'W':                        'WS',
    'H':                        'HMS',
    'S':                        'ESA',
    'R':                        'Hoermann',
    'A':                        'AskSin',
    'V':                        'MORITZ',
    'Z':                        'MORITZ',
    'o':                        'Obis',
    't':                        'TX',
    'U':                        'Uniroll',
    'K':                        'WS'
};

const CulDebug = function (options) {
    const that = this;

    options.initCmd =                                       0x01;
    options.mode =              options.mode        ||      'SlowRF';
    options.init =              options.init        ||      true;
    options.parse =             options.parse       ||      true;
    options.coc =               options.coc         ||      false;
    options.scc =               options.scc         ||      false;
    options.rssi =              options.rssi        ||      true;


    this.close = function (callback) {};

    const lines = fs.readFileSync(__dirname + '/rawData.txt').toString().split('\n');

    setTimeout(() => {
        this.emit('ready');

        const timer = setInterval(() => {
            if (!lines.length) {
                clearInterval(timer);
            } else {
                parse(lines.shift());
            }
        }, 100);
    }, 200);


    this.write = function send(data, callback) {
        console.log('->', data);
    };

    this.cmd = function cmd() {
        const args = Array.prototype.slice.call(arguments);
        let callback;

        if (typeof args[args.length - 1] === 'function') {
            callback = args.pop();
        }

        typeof callback === 'function' && callback('cmd ' + c + ' not implemented');
        return false;
    };

    function parse(data) {
        if (!data) {
            return;
        }
        data = data.toString();

        let message;
        let command;
        let p;
        let rssi;

        if (options.parse) {
            command = data[0];
            message = {};
            if (commands[command]) {
                p = commands[command].toLowerCase();
                if (protocol[p] && typeof protocol[p].parse === 'function') {
                    message = protocol[p].parse(data);
                }
            }
            if (options.rssi) {
                rssi = parseInt(data.slice(-2), 16);
                message.rssi =  (rssi >= 128 ? ((rssi - 256) / 2 - 74) : (rssi / 2 - 74));
            }
        }
        that.emit('data', data, message);
    }
};

util.inherits(CulDebug, EventEmitter);

module.exports = CulDebug;
