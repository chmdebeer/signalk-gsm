const exec = require('child_process').exec;
const cron = require('node-cron');
const axios = require('axios');
const serialportgsm = require('serialport-gsm');

module.exports = function (app) {
  var plugin = {};

  plugin.id = 'signalk-gsm';
  plugin.name = 'Signal K GSM/GPRS';
  plugin.description = 'Signal K GSM/GPRS Interface';

  var unsubscribes = [];

  var gsmModem = serialportgsm.Modem();

  let modemOptions = {
    baudRate: 115200,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    xon: false,
    rtscts: false,
    xoff: false,
    xany: false,
    autoDeleteOnReceive: false,
    enableConcatenation: true,
    incomingCallIndication: true,
    incomingSMSIndication: true,
    pin: '',
    logger: undefined
  };

  var boatData = {
    gsm: {
      open: false,
      init: false,
      ppp: false,
      route: false,
      serverUpdated: false
    }
  };

  var startPPP = function() {
    app.debug('Starting PPP');
    exec('sudo pon gprs', (error, stdout, stderr) => {
      if (error) {
        app.error(`exec error: ${error}`);
      } else {
        boatData.gsm.ppp = true;
        boatData.gsm.serverUpdated = false;
      }
    });
  }

  var addRoute = function() {
    app.debug('Adding route');
    exec('sudo route add -net 0.0.0.0 ppp0', (error, stdout, stderr) => {
      if (error) {
        app.error(`exec error: ${error}`);
      } else {
        boatData.gsm.route = true;
      }
    });
  }

  var stopPPP = function() {
    app.debug('Stopping PPP');
    exec('sudo poff gprs', (error, stdout, stderr) => {
      if (error) {
        app.error(`exec error: ${error}`);
      } else {
        boatData.gsm.ppp = false;
        boatData.gsm.route = false;
      }
    });
  }

  var getSignalStrength = function() {
    app.debug('Getting signal strength');
    // get the Network signal strength
    gsmModem.getNetworkSignal((result, err) => {
      if (err) {
        app.error(`Error retrieving Signal Strength - ${err}`);
      } else {
        boatData.gsmSignal = result.data;
        app.debug('Signal strength = ' + result.data.signalStrength);
      }
    });
  }

  var readSMS = function() {
    app.debug('Read SMS');
    var shouldStart;
    var foundMessages = false;
    gsmModem.getSimInbox((result, err) => {
      if(err) {
        app.error(`Failed to get SimInbox ${err}`);
      } else {
        result.data.forEach((message) => {
          foundMessages = true;
          if (message.message == 'pon') {
            shouldStart = true;
          } else if (message.message == 'poff') {
            shouldStart = false;
          }
        });
        if (foundMessages) {
          gsmModem.deleteAllSimMessages((result, err) => {
            if(err) {
              app.debug(`Failed to delete SMS ${err}`);
            } else {
              if (shouldStart === true) {
                startPPP();
              } else if (shouldStart === false) {
                stopPPP();
              }
            }
          }, true, 30000);
        }
      }
    });
  }

  var initModem = function() {
    app.debug('Initializing modem');
    gsmModem.initializeModem((msg, err) => {
      if (err) {
        app.error(`Error Initializing Modem - ${err}`);
      } else {
        boatData.gsm.init = true;
        gsmModem.setModemMode((msg,err) => {
          if (err) {
            app.error(`Error Setting Modem Mode - ${err}`);
          } else {
            // console.log(`Set Mode: ${JSON.stringify(msg)}`);
          }
        }, 'PDU');
      }
    });
  }

  var updateServer = function() {
    app.debug('Update server');
    if (boatData.gsm.ppp) {
      axios.post('https://chmdebeer.ca/reflections/signalk', {
        json: app.signalk,
        gsm: boatData.gsmSignal
      })
      .then(function (response) {
        app.debug(`statusCode: ${response.statusCode}`)
        boatData.gsm.serverUpdated = true;
      })
      .catch(function (error) {
        app.error(`Error sending data to server: ${error}`)
      });
    }
  }

  gsmModem.on('open', () => {
    app.debug('Modem Open');
    boatData.gsm.open = true;

    initModem();

    gsmModem.on('onNewMessage', data => {
      app.debug('New message');
      readSMS();
    });

    gsmModem.on('close', data => {
      app.debug('Modem closed');
      boatData.gsm.open = false;
      boatData.gsm.init = false;
    });

  });


  plugin.start = function (options, restartPlugin) {
    // Here we put our plugin logic
    app.debug('GSM Plugin Start on ' + options.port);
    let value = app.getSelfPath('uuid');
    app.debug('uuid = ', value);

    let localSubscription = {
      context: 'vessels.self',
      subscribe: [{
        path: '*',
        period: 10000
      }]
    };

    app.subscriptionmanager.subscribe(
      localSubscription,
      unsubscribes,
      subscriptionError => {
        app.error('Error:' + subscriptionError);
      },
      delta => {
        //udpateServer();
        // app.debug(delta);
      }
    );

    cron.schedule('0 * * * * *', () => {
      app.debug('minute');
      if (!boatData.gsm.open) {
        app.debug('Opening modem ' + options.port);
        gsmModem.open('/dev/' + options.port, modemOptions, () => {
        });
      }
      if (boatData.gsm.open && !boatData.gsm.init) {
        initModem();
      }
      if (boatData.gsm.open && boatData.gsm.init) {
        getSignalStrength();
        readSMS();
      }
      if (boatData.gsm.ppp && !boatData.gsm.route) {
        addRoute();
      }
      if (boatData.gsm.ppp && boatData.gsm.route && !boatData.gsm.serverUpdated) {
        updateServer();
      }
    });

    cron.schedule('0 0 * * * *', () => {
      app.debug('Hourly');
      if (!boatData.gsm.ppp) {
        startPPP();
      }
    });

    cron.schedule('0 2 * * * *', () => {
      app.debug('Hourly + 2');
      if (boatData.gsm.ppp) {
        updateServer();
      }
    });

    cron.schedule('0 5 * * * *', () => {
      app.debug('Hourly + 5');
      if (boatData.gsm.ppp) {
        stopPPP();
      }
    });

    stopPPP();

  };

  plugin.stop = function () {
    unsubscribes.forEach(f => f());
    unsubscribes = [];
    app.debug('Plugin stopped');
  };

  plugin.schema = {
    type: 'object',
    properties: {
      port: {
        type: 'string',
        title: 'Modem port',
        default: 'serial0'
      }
    }
  };

  return plugin;
};
