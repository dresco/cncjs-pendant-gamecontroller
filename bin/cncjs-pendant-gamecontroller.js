#!/usr/bin/env node

// This code is used to connect a game controller to CNCjs, using node-hid for communciation with the controller.
// Uses the GRBL 1.1 smooth stepping commands, inspired by https://github.com/jheyman/shapeoko/blob/master/cncjs-pendant-raspi-jogdial

var fs = require('fs');
var path = require('path');
var program = require('commander');
var serialport = require('serialport');
var inquirer = require('inquirer');
var vorpal = require('vorpal')();
var pkg = require('../package.json');
var serverMain = require('../index');
var sleep = require('sleep');
var HID = require('node-hid');
//var GameController = require('./gamecontroller.js');

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
var joggingTimer=null
var speed_1 = 0
var speed_10 = 0
var speed_100 = 0
var jogInProgress = 0;
var jogSpeed = 0;
var jogDistance = 0;
const SINGLESTEP_X1_JOGDISTANCE = 0.1 // jog step in mm when X1 is selected
const SINGLESTEP_X10_JOGDISTANCE = 1 // jog step in mm when X10 is selected
const SINGLESTEP_X100_JOGDISTANCE = 10 // jog step in mm when X100 is selected
const SMOOTHJOG_X1_JOGSPEED = 100 // continuous jog speed in mm/min when X1 is selected
const SMOOTHJOG_X10_JOGSPEED = 1000 // continuous jog speed in mm/min when X10 is selected
const SMOOTHJOG_X100_JOGSPEED = 5000 // continuous jog speed in mm/min when X100 is selected

// Callback for the interval timer triggered while jogging
function uponJoggingTimer() {

    // change to have tradional jogging for initial press, until timer threshold reached?


    //console.log("xJog: %i, yJog: %i, zJog: zJog", xJog, yJog,zJog);

    if (jogSpeed && jogDistance) {
        if (xJog) {
            jogInProgress = 1;
            if (xJog > 0) {
                socket.emit('write', options.port, "$J=G91 G21 X" + jogDistance +" F" + jogSpeed + "\n")
            } else if (xJog < 0) {
                socket.emit('write', options.port, "$J=G91 G21 X -" + jogDistance + " F" + jogSpeed + "\n")
            } 
        }

        if (yJog) {
            jogInProgress = 1;
            if (yJog > 0) {
                socket.emit('write', options.port, "$J=G91 G21 Y" + jogDistance +" F" + jogSpeed + "\n")
            } else if (yJog < 0) {
                socket.emit('write', options.port, "$J=G91 G21 Y -" + jogDistance + " F" + jogSpeed + "\n")
            } 
        }

        if (zJog) {
            jogInProgress = 1;
            if (zJog > 0) {
                socket.emit('write', options.port, "$J=G91 G21 Z" + jogDistance +" F" + jogSpeed + "\n")
            } else if (zJog < 0) {
                socket.emit('write', options.port, "$J=G91 G21 Z -" + jogDistance + " F" + jogSpeed + "\n")
            } 
        }



    }


    if (jogInProgress == 1 && xJog == 0 && yJog == 0 && zJog ==0) {
        jogInProgress = 0
        socket.emit('write', options.port, "\x85\n")
    }
        

}

var createServer = function(options) {

    // connect to the controller - need some error checking/retries around this
    device = new HID.HID(0x0810, 0x0001);

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