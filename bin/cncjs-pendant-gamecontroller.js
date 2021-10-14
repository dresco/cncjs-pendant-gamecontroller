#!/usr/bin/env node

// This code is used to connect a game controller to CNCjs, using node-hid for communciation with the controller.
// Uses the GRBL 1.1 smooth stepping commands, inspired by https://github.com/jheyman/shapeoko/blob/master/cncjs-pendant-raspi-jogdial

//
// TODO:
//  - joystick support with proportional control
//  - shut down timers etc on exit?
//
// DONE:
//  - wait/retry when opening HID device..
//  - need to care about 'ok' responses - sometimes the cancel command gets missed...
//  - set speed/distance to keep smooth progress at each speed (do not travel far enough to start slowing down)
//  - treat initial keypress as standard jogging to distance, switch to smooth jogging if button held down
//

var fs = require('fs');
var path = require('path');
var program = require('commander');
var serialport = require('serialport');
var inquirer = require('inquirer');
var pkg = require('../package.json');
var serverMain = require('../index');
var HID = require('node-hid');
const { sleep } = require('sleep');

program
	.version(pkg.version)
	.usage('-s <secret> -p <port> [options]')
	.option('-l, --list', 'list available ports then exit')
    .option('-s, --secret', 'the secret key stored in the ~/.cncrc file')
	.option('-p, --port <port>', 'path or name of serial port')
	.option('-b, --baudrate <baudrate>', 'baud rate (default: 115200)', 115200)
	.option('--socket-address <address>', 'socket address or hostname (default: localhost)', 'localhost')
	.option('--socket-port <port>', 'socket port (default: 8000)', 8000)
	.option('--controller-type <type>', 'controller type: Grbl|Smoothie|TinyG (default: Grbl)', 'Grbl')
    .option('--access-token-lifetime <lifetime>', 'access token lifetime in seconds or a time span string (default: 30d)', '30d')

program.parse(process.argv);

// process.stdin.resume(); //so the program will not close instantly

var options = {
    secret: program.secret,
    port: program.port,
    baudrate: program.baudrate,
    socketAddress: program.socketAddress,
    socketPort: program.socketPort,
    controllerType: program.controllerType,
    accessTokenLifetime: program.accessTokenLifetime
};

if (options.list) {
	serialport.list().then(function(ports) {
		ports.forEach(function(port) {
			console.log(port.path);
		});
	}).catch((err) => {
        console.error(err)
        process.exit(1)
    })
	return;
}

var store = {
    controller: {
        state: {},
        settings: {}
    },
    sender: {
        status: {}
    }
};

// Globals
var responsePending = 0;
var joggingTimer=null
var speed_1 = 0
var speed_10 = 0
var speed_100 = 0
var jogInProgress = 0;
var jogSpeed = 0;
var jogDistance = 0;
var jogCount = 0;

// Speed and distance need to be matched so that repeated jogging is smooth 
// (i.e. has not started decelerating for end of movement before the next request arrives)
// for instance, 1mm movement requested @ 10Hz = 10mm/s, jog speed of 500 mm/min = maximum movement of 8.33mm/s
const SINGLESTEP_X1_JOGDISTANCE = 0.1 // jog step in mm when X1 is selected
const SINGLESTEP_X10_JOGDISTANCE = 1 // jog step in mm when X10 is selected
const SINGLESTEP_X100_JOGDISTANCE = 10 // jog step in mm when X100 is selected
const SMOOTHJOG_X1_JOGSPEED = 50 // continuous jog speed in mm/min when X1 is selected
const SMOOTHJOG_X10_JOGSPEED = 500 // continuous jog speed in mm/min when X10 is selected
const SMOOTHJOG_X100_JOGSPEED = 5000 // continuous jog speed in mm/min when X100 is selected

// Callback for the interval timer triggered while jogging
function uponJoggingTimer() {

    // change to have tradional jogging for initial press, until timer threshold reached?


    // don't send unless any previous command has been acknowledged
    if (responsePending == 0) {
        //console.log("xJog: %i, yJog: %i, zJog: zJog", xJog, yJog,zJog);

        if (jogSpeed && jogDistance) {
            if (xJog) {
                jogInProgress = responsePending = 1;
                jogCount++;
                if (xJog > 0) {
                    socket.emit('write', options.port, "$J=G91 G21 X" + jogDistance +" F" + jogSpeed + "\n")
                } else if (xJog < 0) {
                    socket.emit('write', options.port, "$J=G91 G21 X -" + jogDistance + " F" + jogSpeed + "\n")
                } 
            }

            if (yJog) {
                jogInProgress = responsePending = 1;
                jogCount++;
                if (yJog > 0) {
                    socket.emit('write', options.port, "$J=G91 G21 Y" + jogDistance +" F" + jogSpeed + "\n")
                } else if (yJog < 0) {
                    socket.emit('write', options.port, "$J=G91 G21 Y -" + jogDistance + " F" + jogSpeed + "\n")
                } 
            }

            if (zJog) {
                jogInProgress = responsePending = 1;
                jogCount++;
                if (zJog > 0) {
                    socket.emit('write', options.port, "$J=G91 G21 Z" + jogDistance +" F" + jogSpeed + "\n")
                } else if (zJog < 0) {
                    socket.emit('write', options.port, "$J=G91 G21 Z -" + jogDistance + " F" + jogSpeed + "\n")
                } 
            }
        }
    } else {
        //console.log("not sending - response outstanding")
    }

    if (jogInProgress == 1 && xJog == 0 && yJog == 0 && zJog ==0) {
        // don't try and send a cancel command until previous command acknowleged..
        if (responsePending == 0) {
            //only send a cancel command if repeating, lets us move a predicable amount with single button presses
            if (jogCount > 1) {
                responsePending = 1
                socket.emit('write', options.port, "\x85\n")
            }
            jogInProgress = jogCount = 0
            }
    }

}

function setupGamepad() {
    // ensure controller is present
    // todo: consider instead using node-usb-detection instead of polling HID.devices()
    var gamepadConnected=false
    console.log("Searching for gamepad..");

    while(gamepadConnected==false) {
        var devices = HID.devices()
        devices.forEach(function(device) {
            // List Devices
            //console.log(device.vendorId + " | " + device.productId);
    
            // Check for gamepad HID
            if (device.vendorId == 0x0810 && device.productId == 0x0001) {
                console.log("..gamepad connected");
                gamepadConnected = true;
            }
        });
        if (gamepadConnected ==false) {
            // blocking sleep - okay I think, as we're not doing anything at this point..
            sleep(5);
        }
    }


    // connect to the controller 
    // todo: need some error checking
    device = new HID.HID(0x0810, 0x0001);

    // process the data packets
    device.on('data', function(data) {
        //console.log("got data:",data);

        // X axis jog
        if ((data[5] & 0b0000111) === 2)
            xJog = 1;
        else if ((data[5] & 0b0000111) === 6)
            xJog = -1;
        else 
            xJog = 0;

        // Y axis jog
        if ((data[5] & 0b0000111) === 0)
            yJog = 1;
        else if ((data[5] & 0b0000111) === 4)
            yJog = -1;
        else 
            yJog = 0;

        // Z axis jog
        if (data[6] >> 1 & 1)
            zJog = 1;
        else if (data[6] >> 3 & 1)
            zJog = -1;
        else 
            zJog = 0;

        // Speed control (buttons 1 -3)
        if (data[5] >> 4 & 1) {
            jogSpeed = SMOOTHJOG_X1_JOGSPEED
            jogDistance = SINGLESTEP_X1_JOGDISTANCE
        }
        else if (data[5] >> 5 & 1) {
            jogSpeed = SMOOTHJOG_X10_JOGSPEED
            jogDistance = SINGLESTEP_X10_JOGDISTANCE
        }
        else if (data[5] >> 6 & 1) {
            jogSpeed = SMOOTHJOG_X100_JOGSPEED
            jogDistance = SINGLESTEP_X100_JOGDISTANCE
        }
        else {
            jogSpeed = 0
            jogDistance = 0
            xJog = yJog = zJog = 0
        }
    });

    device.on('error', function(err) {
        console.log("error:",err);
    });
}

var createServer = function(options) {

    // will block until USB device is connected
    setupGamepad()

    // start a timer to check the key states
    joggingTimer = setInterval(uponJoggingTimer, 100);

    
     // Server Connection, boilerplate code.
    serverMain(options, function(err, socket) {
        // Grbl
        socket.on('Grbl:state', function(state) {
            store.controller.state = state;
        });
        socket.on('Grbl:settings', function(settings) {
            store.controller.settings = settings;
        });

        // Sender
        socket.on('sender:status', function(data) {
            store.sender.status = data;
        });

        // handle the event sent with socket.send()
        socket.on('serialport:read', function(data) {
            if (data.includes('ok') || data.includes('error')) {
                responsePending = 0
            } else {
                console.log('unhandled response:' + data)
            }
            
        });


    });
};

if (options.port) {
    createServer(options);
    return;
}

serialport.list().then(function (ports) {
    const choices = ports.map(function(port) {
        return port.path;
    });

    inquirer.prompt([{
        type: 'list',
        name: 'port',
        message: 'Specify which port you want to use?',
        choices: choices
    }]).then(function(answers) {
        options.port = answers.port;

        createServer(options);
    });
}).catch((err) => {
    console.error(err)
    process.exit(1)
})


// signals not being received, only when handler is in index.js...? :(

// Clean Proccess Kill
//process.on('SIGINT', function () {
//    console.log("ending..")
//	clearInterval(uponJoggingTimer);
//	uponJoggingTimer = null;
//});
//process.on('exit', function () {
//    console.log("ending..")
//	clearInterval(uponJoggingTimer);
//	uponJoggingTimer = null;
//});

// Using a single function to handle multiple signals
//function handle(signal) {
//    console.log('Received ${signal}');
//  }
//  
//  process.on('SIGINT', handle);
//  process.on('SIGTERM', handle);
