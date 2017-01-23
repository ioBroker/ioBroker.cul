var util =                      require('util');
var EventEmitter =              require('events').EventEmitter;
var fs =                        require('fs');

var protocol = {
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
var commands = {
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

var CulDebug = function (options) {
    var that = this;

    options.initCmd =                                       0x01;
    options.mode =              options.mode        ||      'SlowRF';
    options.init =              options.init        ||      true;
    options.parse =             options.parse       ||      true;
    options.coc =               options.coc         ||      false;
    options.scc =               options.scc         ||      false;
    options.rssi =              options.rssi        ||      true;


    this.close = function (callback) {};

    var lines = fs.readFileSync(__dirname + '/rawData.txt').toString().split('\n');

    setTimeout(function () {
        that.emit('ready');

        var timer = setInterval(function (){
            if (!lines.length) {
                clearInterval(timer);
            } else {
                parse(lines.shift());
            }
        }, 100);
    }, 200);


    this.write = function send(data, callback) {
        console.log('->', data)
    };

    this.cmd = function cmd() {
        var args = Array.prototype.slice.call(arguments);

        if (typeof args[args.length - 1] === 'function') {
            var callback = args.pop();
        }

        if (typeof callback === 'function') callback('cmd ' + c + ' not implemented');
        return false;
    };

    function parse(data) {
        if (!data) return;
        data = data.toString();

        var message;
        var command;
        var p;
        var rssi;

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

    return this;
};

util.inherits(CulDebug, EventEmitter);

module.exports = CulDebug;
