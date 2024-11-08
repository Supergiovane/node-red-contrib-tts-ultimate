const { Readable } = require('stream');

module.exports = function (RED) {
  'use strict';

  var fs = require('fs');
  var path = require('path');
  const sonos = require('sonos');
  const crypto = require("crypto");

  function slug(_text) {
    var sRet = _text;
    sRet = sRet.toString().replace(/\./g, "_stop_");
    sRet = sRet.toString().replace(/\?/g, "_qm_");
    sRet = sRet.toString().replace(/\!/g, "_em_");
    sRet = sRet.toString().replace(/\,/g, "_pause_");
    sRet = sRet.toString().replace(/\:/g, "_colon_");
    sRet = sRet.toString().replace(/\;/g, "_semicolon_");
    sRet = sRet.toString().replace(/\</g, "_less_");
    sRet = sRet.toString().replace(/\>/g, "_greater_");
    sRet = sRet.toString().replace(/\//g, "_sl_");
    sRet = sRet.toString().replace(/\'/g, "_ap_");
    sRet = sRet.toString().replace(/\=/g, "_ug_");
    sRet = sRet.toString().replace(/\\/g, "_bs_");
    sRet = sRet.toString().replace(/\(/g, "_pa_");
    sRet = sRet.toString().replace(/\)/g, "_pc_");
    sRet = sRet.toString().replace(/\*/g, "_as_");
    sRet = sRet.toString().replace(/\[/g, "_qa_");
    sRet = sRet.toString().replace(/\]/g, "_qc_");
    sRet = sRet.toString().replace(/\^/g, "_fu_");
    sRet = sRet.toString().replace(/\|/g, "_pi_");
    sRet = sRet.toString().replace(/\"/g, "_dc_");
    sRet = sRet.toString().replace(/\#/g, "_");
    // slug.charmap['.'] = '_stop_';
    // slug.charmap['?'] = '_qm_';
    // slug.charmap['!'] = '_em_';
    // slug.charmap[','] = '_pause_';
    // slug.charmap[':'] = '_colon_';
    // slug.charmap[';'] = '_semicolon_';
    // slug.charmap['<'] = '_less_';
    // slug.charmap['>'] = '_greater_';
    return sRet;
  }


  // Node Register
  function PollyNode(config) {
    RED.nodes.createNode(this, config);
    var node = this;
    node.server = RED.nodes.getNode(config.config);
    if (!node.server) {
      RED.log.error('Missing Polly config');
      return;
    }
    node.ssml = config.ssml;
    node.oTimerSonosConnectionCheck = null;
    node.sSonosIPAddress = "";
    node.sonosCoordinatorGroupName = "";
    node.sonoshailing = "0"; // Hailing file
    node.sSonosIPAddress = config.sonosipaddress.trim();
    node.voiceId = config.voice || 0;
    node.sSonosVolume = config.sonosvolume;
    node.sonoshailing = config.sonoshailing;
    node.msg = {}; // 08/05/2019 Node message
    node.msg.completed = true;
    node.msg.connectionerror = true;
    node.userDir = node.server.TTSRootFolderPath === undefined ? path.join(RED.settings.userDir, "sonospollyttsstorage") : node.server.TTSRootFolderPath;
    node.oAdditionalSonosPlayers = []; // 20/03/2020 Contains other players to be grouped
    node.rules = config.rules || [{}];
    node.sNoderedURL = "";
    node.oTimerCacheFlowMSG = null; // 05/12/2020
    node.tempMSGStorage = []; // 04/12/2020 Temporary stores the flow messages
    node.bBusyPlayingQueue = false; // 04/12/2020 is busy during playing of the queue
    node.currentMSGbeingSpoken = {}; // Stores the current message being spoken
    node.sonosCoordinatorPreviousVolumeSetByApp = 0; // 05/07/2021 stores the main payer volume set by the sonos app
    node.playertype = config.playertype === undefined ? "sonos" : config.playertype; // 20/09/2021 Player type
    node.speakingpitch = config.speakingpitch === undefined ? "0" : config.speakingpitch; // 21/09/2021 AudioConfig speakingpitch
    node.speakingrate = config.speakingrate === undefined ? "1" : config.speakingrate; // 21/09/2021 AudioConfig speakingrate
    node.unmuteIfMuted = config.unmuteIfMuted === undefined ? false : config.unmuteIfMuted; // 21/10/2021 Unmute if previiously muted.
    node.sonosCoordinatorIsPreviouslyMuted = false;
    node.passThroughMessage = {};
    node.bTimeOutPlay = false;

    if (typeof node.server !== "undefined" && node.server !== null) {
      node.sNoderedURL = node.server.sNoderedURL || "";
    }

    // 20/11/2019 Used to call the status update
    node.setNodeStatus = ({ fill, shape, text }) => {
      try {
        var dDate = new Date();
        node.status({ fill: fill, shape: shape, text: text + " (" + dDate.getDate() + ", " + dDate.toLocaleTimeString() + ")" });
      } catch (error) { }

    }

    //#region ASYNC DECLARATIONS
    // 30/12/2020 we are at the end of this crazy 2020
    function getMusicQueue(_oPlayer = node.SonosClient) {
      return new Promise(function (resolve, reject) {
        var oRet = null;
        _oPlayer.currentTrack().then(track => {
          oRet = track;// .queuePosition || 1; // Get the current track  in the queue.
          _oPlayer.getCurrentState().then(state => {
            // A music queue is playing and no TTS is speaking?
            oRet.state = state;
            resolve(oRet);
          }).catch(err => {
            //console.log('ttsultimate: getCurrentState: Error occurred %j', err);
            reject(err);
          })
        }).catch(err => {
          reject(err);
          //console.log('ttsultimate: Error currentTrackoccurred %j', err);
        });
      });
    };


    let iWaitAfterSync = 100;
    // 24/08/2021 Sync wrapper
    function PLAYSync(_toPlay, _oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.play(_toPlay).then(result => {
          if (iWaitAfterSync > 2000) console.log("PLAYSYNC")
          let t = setTimeout(() => {
            resolve(true);
          }, iWaitAfterSync);
        }).catch(err => {
          RED.log.error("ttsultimate: Error PLAYSync: " + err.message);
          reject(err);
        });
      });
    }

    // 24/08/2021 Sync wrapper
    function SEEKSync(_Position, _oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.seek(_Position).then(result => {
          if (iWaitAfterSync > 2000) console.log("SEEKSync", _Position)
          let t = setTimeout(() => {
            resolve(true);
          }, iWaitAfterSync);
        }).catch(err => {
          //RED.log.error("ttsultimate: Error SEEKSync: " + err.message);
          reject(err);
        });
      });
    }

    // 24/08/2021 Sync wrapper
    function SELECTQUEUESync(_oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.selectQueue().then(result => {
          if (iWaitAfterSync > 2000) console.log("SELECTQUEUESync")
          try {
            STOPSync(); // The SetQueue automatically starts playing, so i need to stop it now!
          } catch (error) {
          }
          let t = setTimeout(() => {
            resolve(true);
          }, iWaitAfterSync);
        }).catch(err => {
          RED.log.error("ttsultimate: Error SELECTQUEUESync: " + err.message);
          reject(err);
        });
      });
    }

    // 24/08/2021 Sync wrapper
    function SELECTTRACKSync(_queuePosition, _oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.selectTrack(_queuePosition).then(result => {
          if (iWaitAfterSync > 2000) console.log("SELECTTRACKSync", _queuePosition)
          let t = setTimeout(() => {
            resolve(true);
          }, iWaitAfterSync);
        }).catch(err => {
          RED.log.error("ttsultimate: Error SELECTTRACKSync: " + err.message);
          reject(err);
        });
      });
    }

    // 24/08/2021 Sync wrapper
    function STOPSync(_oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.stop().then(result => {
          if (iWaitAfterSync > 2000) console.log("STOPSync")
          let t = setTimeout(() => {
            resolve(true);
          }, iWaitAfterSync);
        }).catch(err => {
          //RED.log.error("ttsultimate: Error STOPSync: " + err.message);
          reject(err);
        });
      });
    }

    // 24/08/2021 Sync wrapper
    function GETVOLUMESync(_oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.getVolume().then(volume => {
          if (iWaitAfterSync > 2000) console.log("GETVOLUMESync", volume)
          resolve(volume);
        }).catch(err => {
          RED.log.error("ttsultimate: Error GETVOLUMESync: " + err.message);
          reject(err);
        });
      });
    }

    // 24/08/2021 Sync wrapper
    function SETVOLUMESync(_volume, _oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.setVolume(_volume).then(result => {
          if (iWaitAfterSync > 2000) console.log("SETVOLUMESync", _volume)
          resolve(true);
        }).catch(err => {
          RED.log.error("ttsultimate: Error SETVOLUMESync: " + err.message);
          reject(err);
        });
      });
    }

    // 24/08/2021 Sync wrapper
    function setAVTransportURISync(_Uri, _oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.setAVTransportURI(_Uri).then(volume => {
          if (iWaitAfterSync > 2000) console.log("setAVTransportURISync", _Uri)
          resolve(true);
        }).catch(err => {
          RED.log.error("ttsultimate: Error setAVTransportURISync: " + err.message);
          reject(err);
        });
      });
    }

    // 24/08/2021 Sync wrapper
    function getCurrentStateSync(_oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.getCurrentState().then(state => {
          resolve(state);
        }).catch(err => {
          RED.log.error("ttsultimate: Error getCurrentStateSync: " + err.message);
          reject(err);
        });
      });
    }

    // 21/10/2021 Sync wrapper
    function GETMutedSync(_oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.getMuted().then(state => {
          resolve(state);
        }).catch(err => {
          RED.log.error("ttsultimate: Error GETMutedSync: " + err.message);
          reject(err);
        });
      });
    }

    // 21/10/2021 Sync wrapper
    function SETMutedSync(_muted, _oPlayer = node.SonosClient) {
      return new Promise((resolve, reject) => {
        _oPlayer.setMuted(_muted).then(state => {
          resolve(state);
        }).catch(err => {
          RED.log.error("ttsultimate: Error SETMutedSync: " + err.message);
          reject(err);
        });
      });
    }

    // 20/03/2020 Join Coordinator queue
    // ######################################################
    async function groupSpeakersSync() {
      // 05/07/2021 Get the main coordinator player previous volume set by app
      try {
        node.sonosCoordinatorPreviousVolumeSetByApp = await GETVOLUMESync();
        node.sonosCoordinatorIsPreviouslyMuted = await GETMutedSync();
      } catch (error) {
        node.sonosCoordinatorPreviousVolumeSetByApp = node.sSonosVolume;
        node.sonosCoordinatorIsPreviouslyMuted = false;
      }
      // 30/03/2020 in the middle of coronavirus emergency. Group Speakers
      for (let index = 0; index < node.oAdditionalSonosPlayers.length; index++) {
        let element = node.oAdditionalSonosPlayers[index].oPlayer;

        // 02/07/2021 Get the additional's player's volume set by app and the current track, to be set again in ungroupspealers
        try {
          element.additionalPlayerPreviousVolumeSetByApp = await element.getVolume();
          element.additionalPlayerCurrentTrack = await getMusicQueue(element);
        } catch (error) {
          RED.log.warn("ttsultimate: Error setting volume of joined device " + error.message);
        }
        // 21/10/2021 set the previous mute/unmute state
        try {
          element.isPreviouslyMuted = await element.getMuted();
        } catch (error) {
          RED.log.warn("ttsultimate: Error getMuted of joined device " + error.message);
        }

        try {
          await element.joinGroup(node.sonosCoordinatorGroupName);
        } catch (error) {
          RED.log.warn("ttsultimate: Error joining device " + error.message);
        }
      };
    }

    // 20/03/2020 Ungroup Coordinator queue
    async function ungroupSpeakersSync() {
      // 05/07/2021, set the previous app volume for main coordinator player
      try {
        await SETVOLUMESync(node.sonosCoordinatorPreviousVolumeSetByApp);
      } catch (error) {
        RED.log.warn("ttsultimate: Error set preious volume on main coordinator in ungroupSpeakers " + error.message);
      }
      // 21/10/2021 Unmute?
      if (node.unmuteIfMuted && node.sonosCoordinatorIsPreviouslyMuted) {
        try {
          await SETMutedSync(true);
        } catch (error) {
          RED.log.warn("ttsultimate: Error set preivous mute state on main coordinator in ungroupSpeakers " + error.message);
        }
      }

      for (let index = 0; index < node.oAdditionalSonosPlayers.length; index++) {
        let element = node.oAdditionalSonosPlayers[index].oPlayer;
        try {
          await element.leaveGroup();
        } catch (error) {
          // Dont care
          RED.log.warn("ttsultimate: Error leaving group device " + error.message);
        }
        if (element.additionalPlayerPreviousVolumeSetByApp !== undefined) {
          try {
            await element.setVolume(element.additionalPlayerPreviousVolumeSetByApp);
          } catch (error) {
            RED.log.warn("ttsultimate: Error set previous volume on group device " + error.message);
          }
        }
        // 21/10/2021 Unmute?
        if (node.unmuteIfMuted && element.isPreviouslyMuted) {
          try {
            await element.setMuted(true);
          } catch (error) {
            RED.log.warn("ttsultimate: Error set previous mute state on group device " + error.message);
          }
        }
      }
    }
    // ######################################################

    async function delay(ms) {
      return new Promise(function (resolve, reject) {
        try {
          node.timerWait = setTimeout(resolve, ms);
        } catch (error) {
          reject();
        }
      });
    }

    //#endregion


    // 27/11/2019 Check Sonos connection health

    node.CheckSonosConnection = () => {
      if (node.playertype === "sonos") {
        node.SonosClient.getCurrentState().then(state => {

          // 11/12/202020 The connection with Sonos is OK. 
          if (node.msg.connectionerror == true) {
            node.flushQueue();
            node.setNodeStatus({ fill: "green", shape: "dot", text: "Sonos is connected." });
            node.msg.connectionerror = false;
            node.send([null, { payload: node.msg.connectionerror }]);
          }
          node.oTimerSonosConnectionCheck = setTimeout(function () { node.CheckSonosConnection(); }, 5000);

        }).catch(err => {
          node.setNodeStatus({ fill: "red", shape: "dot", text: "Sonos connection is DOWN: " + err.message });
          node.flushQueue();
          // 11/12/2020 Set node output to signal connectio error
          if (node.msg.connectionerror == false) {
            node.msg.connectionerror = true;
            node.send([null, { payload: node.msg.connectionerror }]);
          }
          node.oTimerSonosConnectionCheck = setTimeout(function () { node.CheckSonosConnection(); }, 10000);
        });
      } else {
        node.setNodeStatus({ fill: "green", shape: "dot", text: "Ready." });
        node.msg.connectionerror = false;
        node.send([null, { payload: node.msg.connectionerror }]);
      }

    }

    // 20/09/2021 If Sonos, do init
    if (node.playertype === "sonos") {
      // Create sonos client & groups 
      node.SonosClient = new sonos.Sonos(node.sSonosIPAddress);
      // 20/03/2020 Set the coorinator's zone name
      node.SonosClient.getName().then(info => {
        node.sonosCoordinatorGroupName = info;
        RED.log.info("ttsultimate: ZONE COORDINATOR " + JSON.stringify(info));
      }).catch(err => {

      });
      // Fill the node.oAdditionalSonosPlayers with all sonos object in the rules
      for (let index = 0; index < node.rules.length; index++) {
        let element = node.rules[index]; // Rule row is {host:"192.168.1.12,hostVolumeAdjust:0}
        // 12/04/2022 Create an object containing the addidtional player and the adapted volume
        node.oAdditionalSonosPlayers.push({ oPlayer: new sonos.Sonos(element.host), hostVolumeAdjust: Number(element.hostVolumeAdjust) });
        RED.log.info("ttsultimate: FOUND ADDITIONAL PLAYER " + element.host + " Adjusted volume: " + element.hostVolumeAdjust);
      }
      // 27/11/2019 Start the connection healty check
      node.oTimerSonosConnectionCheck = setTimeout(function () { node.CheckSonosConnection(); }, 5000);
    } else if (node.playertype === "noplayer") {
      node.msg.connectionerror = false;
    }

    node.setNodeStatus({ fill: 'grey', shape: 'ring', text: 'Initialized.' });

    // 22/09/2020 Flush Queue and set to stopped
    node.flushQueue = () => {
      // 10/04/2018 Remove the TTS message from the queue
      node.tempMSGStorage = [];
      // Exit whatever cycle
      node.bTimeOutPlay = true;
      node.bBusyPlayingQueue = false;
      node.currentMSGbeingSpoken = {};
      if (node.server.whoIsUsingTheServer === node.id) node.server.whoIsUsingTheServer = "";
    }

    // 30/12/2020 Supergiovane resume queue for radio, queue music, TV in , line in etc.
    async function resumeMusicQueue(_oTrack, _oPlayer = node.SonosClient) {

      if (_oTrack !== null) {
        // Do some checks on the track.
        if (_oTrack.hasOwnProperty("duration") && _oTrack.duration === 0 ||
          (_oTrack.uri.startsWith("x-sonosprog-http") || _oTrack.uri.startsWith("x-sonosapi-hls-static") || _oTrack.uri.startsWith("x-sonos-spotify"))) {
          // Stream
          _oTrack.trackType = "stream";
        } else if (_oTrack.hasOwnProperty("duration") && isNaN(_oTrack.duration)) {
          // Line input
          _oTrack.trackType = "lineinput";
        } else {
          // Music queue
          _oTrack.trackType = "musicqueue";
        }
      } else {
        // Track is null, nothing to resume.
        return false;
      }

      // It's a radio station or a generic stream, not a queue.
      if (_oTrack.trackType === "stream") {
        if (_oTrack.state === "playing") {
          // 03/09/2021 Play if it was playing
          try {
            await PLAYSync(_oTrack.uri, _oPlayer);
          } catch (error) {
            return error;
          }
          try {
            await delay(1000);
            await SEEKSync(_oTrack.position, _oPlayer);
          } catch (error) {
            // Don't care
          }
        }
      } else {
        if (_oTrack.trackType === "musicqueue") { // This indicates that is an audio file or stream station
          try {
            await SELECTQUEUESync(_oPlayer);
          } catch (error) {
            return error;
          }
          try {
            await delay(1000);
            await SELECTTRACKSync(_oTrack.queuePosition, _oPlayer);
          } catch (error) {
            return error;
          }
          try {
            await delay(1000);
            await SEEKSync(_oTrack.position, _oPlayer);
          } catch (error) {
            // Don't care
          }
          if (_oTrack.state === "playing") {
            // 24/08/2021 Play if it was playing
            try {
              await PLAYSync(_oPlayer);
            } catch (error) {
              return error;
            }
          } else {
            /// 03/09/2021
            try {
              await STOPSync(_oPlayer);
            } catch (error) {
              return error;
            }
          }
        } else if (_oTrack.trackType === "lineinput") {
          // Line in, TV in, etc...
          if (_oTrack.state === "playing") {
            try {
              await setAVTransportURISync(_oTrack.uri, _oPlayer);
            } catch (error) {
              return error;
            }
          }
        }
      }
      let t = setTimeout(() => { return true; }, 5000); // Wait some seconds 
    };

    // Handle the queue
    async function HandleQueue() {
      node.bBusyPlayingQueue = true;
      node.server.whoIsUsingTheServer = node.id; // Signal to other ttsultimate node, that i'm using the Sonos device
      try {

        if (node.playertype !== "noplayer") {
          // Get the current music queue, if one
          var oCurTrack = null;
          try {
            oCurTrack = await getMusicQueue();
            // 19/04/2022 The current track of additional players is read in the groupSpeakerySync function
          } catch (error) {
            oCurTrack = null;
          }

          // 05/12/2020 Set "completed" to false and send it
          node.msg.completed = false;
          try {
            await groupSpeakersSync(); // 20/03/2020 Group Speakers toghether and reads each current track   
          } catch (error) {
            // Don't care.
            node.setNodeStatus({ fill: "red", shape: "ring", text: "Error grouping speakers: " + error.message });
            RED.log.error("ttsultimate: Error grouping speakers: " + error.message);
          }

          node.send([{ passThroughMessage: node.passThroughMessage, payload: node.msg.completed }, null]);

          // 24/08/2021 If something was playing, stop the player https://github.com/Supergiovane/node-red-contrib-tts-ultimate/issues/32
          try {
            //await node.SonosClient.stop(); //.then(result => {
            await STOPSync();
          } catch (error) {
            //RED.log.error("ttsultimate: Error stopping in HandleSend: " + error.message);
          }
        } else {
          node.msg.completed = false;
          node.send([{ passThroughMessage: node.passThroughMessage, payload: node.msg.completed }, null]);
        }

        while (node.tempMSGStorage.length > 0) {
          node.currentMSGbeingSpoken = node.tempMSGStorage.shift()//node.tempMSGStorage[0];// Advise the whole node of the currently spoken MSG
          const msg = node.currentMSGbeingSpoken.payload.toString(); // Get the text to be spoken
          //node.tempMSGStorage.splice(0, 1); // Remove the first item in the array
          node.sFileToBePlayed = "";
          node.setNodeStatus({ fill: "gray", shape: "ring", text: "Read " + msg });

          // 04/12/2020 check what really is the file to be played
          if (msg.toLowerCase().startsWith("http://") || msg.toLowerCase().startsWith("https://")) {
            RED.log.info('ttsultimate: HTTP filename: ' + msg);
            node.sFileToBePlayed = msg;
          } else if (msg.indexOf("OwnFile_") !== -1) {
            RED.log.info('ttsultimate: OwnFile .MP3, skip tts, filename: ' + msg);
            node.sFileToBePlayed = path.join(node.userDir, "ttspermanentfiles", msg);
          } else if (msg.indexOf("Hailing_") !== -1) {
            RED.log.info('ttsultimate: Hailing .MP3, skip tts, filename: ' + msg);
            node.sFileToBePlayed = path.join(node.userDir, "hailingpermanentfiles", msg);
          } else {
            try {
              // No file in cache. Download from tts service
              var data = undefined;
              if (node.server.ttsservice === "polly") {
                var params = {
                  OutputFormat: "mp3",
                  SampleRate: '22050',
                  Text: msg,
                  TextType: node.ssml ? 'ssml' : 'text'
                };
                // 02/03/2022 check wether standard or neural engine is POLLY is selected
                if (node.voiceId.includes("#engineType:")) {
                  params.VoiceId = node.voiceId.split("#engineType:")[0];
                  params.Engine = node.voiceId.split("#engineType:")[1];
                } else {
                  params.VoiceId = node.voiceId;
                }
                // Download or read from cache
                node.sFileToBePlayed = getFilename(msg, params);
                node.sFileToBePlayed = path.join(node.userDir, "ttsfiles", node.sFileToBePlayed);
                if (!fs.existsSync(node.sFileToBePlayed)) {
                  node.setNodeStatus({ fill: 'blue', shape: 'ring', text: 'Download using ' + node.server.ttsservice });
                  data = await synthesizeSpeechPolly([node.server.polly, params]);
                } else {
                  node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Reading offline from cache' });
                }
              } else if (node.server.ttsservice === "googletts") {
                // VoiceId is: name + "#" + languageCode + "#" + ssmlGender 
                // speakingRate tra 0.25 e 4.0
                // pitch tra -20.0 e 20.0
                const params = {
                  voice: { name: node.voiceId.split("#")[0], languageCode: node.voiceId.split("#")[1], ssmlGender: node.voiceId.split("#")[2] },
                  audioConfig: { audioEncoding: "MP3", speakingRate: parseFloat(node.speakingrate), pitch: parseFloat(node.speakingpitch), },
                };
                params.input = node.ssml === false ? { text: msg } : { ssml: msg };

                // Download or read from cache
                node.sFileToBePlayed = getFilename(msg, params);
                node.sFileToBePlayed = path.join(node.userDir, "ttsfiles", node.sFileToBePlayed);
                if (!fs.existsSync(node.sFileToBePlayed)) {
                  node.setNodeStatus({ fill: 'blue', shape: 'ring', text: 'Download using ' + node.server.ttsservice });
                  data = await synthesizeSpeechGoogleTTS([node.server.googleTTS, params]);
                } else {
                  node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Reading offline from cache' });
                }
              } else if (node.server.ttsservice === "googletranslate") {
                // VoiceId is: code. SSML is not supported by google translate
                if (node.voiceId === "cmn-Hant-TW") node.voiceId = "zh-CN"; // 06/08/2022 fix for a wrong voiceid sent by google translate as voice code
                const params = {
                  text: msg,
                  voice: node.voiceId,
                  slow: false // optional
                };

                // Download or read from cache
                node.sFileToBePlayed = getFilename(msg, params);
                node.sFileToBePlayed = path.join(node.userDir, "ttsfiles", node.sFileToBePlayed);
                if (!fs.existsSync(node.sFileToBePlayed)) {
                  node.setNodeStatus({ fill: 'blue', shape: 'ring', text: 'Download using ' + node.server.ttsservice });
                  data = await synthesizeSpeechGoogleTranslate(node.server.googleTranslateTTS, params);
                } else {
                  node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Reading offline from cache' });
                }
              } else if (node.server.ttsservice === "microsoftazuretts") {
                // VoiceId is: code 
                const params = {
                  text: msg,
                  voice: node.voiceId
                };

                // Download or read from cache
                node.sFileToBePlayed = getFilename(msg, params);
                node.sFileToBePlayed = path.join(node.userDir, "ttsfiles", node.sFileToBePlayed);
                if (!fs.existsSync(node.sFileToBePlayed)) {
                  node.setNodeStatus({ fill: 'blue', shape: 'ring', text: 'Download using ' + node.server.ttsservice });
                  data = await synthesizeSpeechMicrosoftAzureTTS(node.server.microsoftAzureTTS, params);
                } else {
                  node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Reading offline from cache' });
                }
              } else if (node.server.ttsservice === "elevenlabs") {
                // VoiceId is: code 
                const params = {
                  text: msg,
                  voice: node.voiceId,
                  model_id: "eleven_monolingual_v1",
                  voice_settings: {
                    stability: config.elevenlabsStability,
                    similarity_boost: config.elevenlabsSimilarity_boost
                  }
                };
                // Download or read from cache
                node.sFileToBePlayed = getFilename(msg, params);
                node.sFileToBePlayed = path.join(node.userDir, "ttsfiles", node.sFileToBePlayed);
                if (!fs.existsSync(node.sFileToBePlayed)) {
                  node.setNodeStatus({ fill: 'blue', shape: 'ring', text: 'Download using ' + node.server.ttsservice });
                  data = await synthesizeSpeechElevenLabs(node.server.elevenlabsTTS, params);
                } else {
                  node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Reading offline from cache' });
                }
              } else if (node.server.ttsservice === "elevenlabsv2") {
                // VoiceId is: code 
                const params = {
                  stream: false,
                  text: msg,
                  voice: node.voiceId,
                  model_id: "eleven_multilingual_v2",
                  voice_settings: {
                    stability: config.elevenlabsStability,
                    similarity_boost: config.elevenlabsSimilarity_boost,
                    style: config.elevenlabsStyle || 0,
                    use_speaker_boost: config.elevenlabsUse_speaker_boost === undefined ? true : config.elevenlabsUse_speaker_boost
                  }
                };
                // Download or read from cache
                node.sFileToBePlayed = getFilename(msg, params);
                node.sFileToBePlayed = path.join(node.userDir, "ttsfiles", node.sFileToBePlayed);
                if (!fs.existsSync(node.sFileToBePlayed)) {
                  node.setNodeStatus({ fill: 'blue', shape: 'ring', text: 'Download using ' + node.server.ttsservice });
                  data = await synthesizeSpeechElevenLabsV2(node.server.elevenlabsTTS, params);
                } else {
                  node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Reading offline from cache' });
                }
              }

              // Save the downloaded file into the cache
              if (data !== undefined) {
                try {
                  //console.log("Salvelox " + node.sFileToBePlayed)
                  fs.writeFileSync(node.sFileToBePlayed, data);
                } catch (error) {
                  RED.log.error("ttsultimate: node id: " + node.id + " Unable to save the file " + error.message);
                  node.setNodeStatus({ fill: "red", shape: "ring", text: "Unable to save the file " + node.sFileToBePlayed + " " + error.message });
                  throw (error);
                }
              }

            } catch (error) {
              RED.log.error("ttsultimate: node id: " + node.id + " Error Downloading TTS: " + error.message + ". THE TTS SERVICE MAY BE DOWN.");
              node.setNodeStatus({ fill: 'red', shape: 'ring', text: 'Error Downloading TTS:' + error.message });
              node.sFileToBePlayed = "";
            }
          }

          // Ready to play
          if (node.sFileToBePlayed !== "") {

            //#region Now i am ready to play the file
            if (node.playertype === "sonos") {

              // Play with Sonos
              node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Play ' + msg });

              // Play directly files starting with http://
              if (!node.sFileToBePlayed.toLowerCase().startsWith("http://") && !node.sFileToBePlayed.toLowerCase().startsWith("https://")) {
                node.sFileToBePlayed = node.sNoderedURL + "/tts/tts.mp3?f=" + encodeURIComponent(node.sFileToBePlayed);
              }

              // Set Volume
              try {
                let volTemp = 0;
                if (node.currentMSGbeingSpoken.hasOwnProperty("volume")) {
                  volTemp = Number(node.currentMSGbeingSpoken.volume);
                } else {
                  volTemp = Number(node.sSonosVolume);
                }
                await SETVOLUMESync(volTemp);
                if (node.unmuteIfMuted) await SETMutedSync(false); // 21/10/2021 Unmute

                if (node.oAdditionalSonosPlayers.length > 0) {
                  // 05/07/2021 set the volume of additional coordinators
                  for (let index = 0; index < node.oAdditionalSonosPlayers.length; index++) {
                    let element = node.oAdditionalSonosPlayers[index].oPlayer;
                    //node.oAdditionalSonosPlayers.push({ oPlayer: new sonos.Sonos(element.host), hostVolumeAdjust: element.hostVolumeAdjust });
                    try {
                      // 12/04/20222 Set the adjusted volume, based on the main player volume + the adjusted volume in %
                      let iAdjustedVol = Number(volTemp) + Number((node.oAdditionalSonosPlayers[index].hostVolumeAdjust || 0));
                      if (iAdjustedVol < 0) iAdjustedVol = 0;
                      if (iAdjustedVol > 100) iAdjustedVol = 100;
                      await element.setVolume(iAdjustedVol);
                      if (node.unmuteIfMuted) await element.setMuted(false); // 21/10/2021 Unmute
                    } catch (error) {
                      RED.log.error("ttsultimate: Handlequeue: Unable to set the volume on additional player " + error.message);
                    }
                  };
                };

              } catch (error) {
                RED.log.error("ttsultimate: Unable to set the volume for " + node.sFileToBePlayed);
              }
              try {

                await setAVTransportURISync(node.sFileToBePlayed);

                // Wait for start playing
                var state = "";
                if (node.timerbTimeOutPlay !== null) clearTimeout(node.timerbTimeOutPlay);
                node.bTimeOutPlay = false;
                node.timerbTimeOutPlay = setTimeout(() => {
                  node.bTimeOutPlay = true;
                }, 10000);
                while (state !== "playing" && !node.bTimeOutPlay) {
                  try {
                    //state = await node.SonosClient.getCurrentState();
                    state = await getCurrentStateSync();
                  } catch (error) {
                    node.setNodeStatus({ fill: 'yellow', shape: 'ring', text: 'Error getCurrentState of playing ' + msg });
                    RED.log.error("ttsultimate: Error getCurrentState of playing " + error.message);
                    throw new MessageEvent("Error getCurrentState of playing " + error.message);
                  }
                }
                if (node.timerbTimeOutPlay !== null) clearTimeout(node.timerbTimeOutPlay);
                switch (node.bTimeOutPlay) {
                  case false:
                    node.setNodeStatus({ fill: 'green', shape: 'dot', text: 'Playing ' + msg });
                    break;
                  default:
                    node.setNodeStatus({ fill: 'grey', shape: 'dot', text: 'Timeout waiting start play state: ' + msg });
                    break;
                }

                // Wait for end
                if (node.timerbTimeOutPlay !== null) clearTimeout(node.timerbTimeOutPlay);
                node.bTimeOutPlay = false;
                state = "";
                node.timerbTimeOutPlay = setTimeout(() => {
                  node.bTimeOutPlay = true;
                }, 60000 * 10); // 10 minutes timeout
                while (state !== "stopped" && !node.bTimeOutPlay) {
                  try {
                    state = await getCurrentStateSync();
                  } catch (error) {
                    node.setNodeStatus({ fill: 'yellow', shape: 'ring', text: 'Error getCurrentState of stopped ' + msg });
                    RED.log.error("ttsultimate: Error  getCurrentState of stopped " + error.message);
                    throw new MessageEvent("Error  getCurrentState of stopped " + error.message);
                  }
                }
                if (node.timerbTimeOutPlay !== null) clearTimeout(node.timerbTimeOutPlay);
                switch (node.bTimeOutPlay) {
                  case false:
                    node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'End playing ' + msg });
                    break;
                  default:
                    node.setNodeStatus({ fill: 'grey', shape: 'dot', text: 'Timeout waiting end play state: ' + msg });
                    break;
                }

              } catch (error) {
                if (node.timerbTimeOutPlay !== null) clearTimeout(node.timerbTimeOutPlay); // Clear the player timeout
                RED.log.error("ttsultimate: Error HandleQueue for " + node.sFileToBePlayed + " " + error.message);
                node.setNodeStatus({ fill: 'red', shape: 'dot', text: 'Error ' + msg + " " + error.message });
              }

            } else if (node.playertype === "noplayer") {
              // Output only the filename
              if (noPlayerFileArray === undefined || noPlayerFileArray === null) var noPlayerFileArray = [];
              noPlayerFileArray.push({ file: node.sFileToBePlayed });
            }
          }
          //#endregion


        }; // End Loop

        // End task
        if (node.playertype === "sonos") {
          // Ends the tasks of Sonos

          // Ungroup speaker
          try {
            await ungroupSpeakersSync(); // Ungroup speakers 
          } catch (error) {
            // Don't care.
            node.setNodeStatus({ fill: "red", shape: "ring", text: "Error ungrouping speakers: " + error.message });
          }

          await delay(2000);

          // Resume music
          try {
            if (oCurTrack !== null && (!oCurTrack.hasOwnProperty("title") || oCurTrack.title.indexOf(".mp3") === -1)) {
              node.setNodeStatus({ fill: 'grey', shape: 'ring', text: "Resuming original queue..." });
              await resumeMusicQueue(oCurTrack);
              node.setNodeStatus({ fill: 'green', shape: 'ring', text: "Done resuming queue." });
            } else {
              // 28/08/2021 There was no queue playing. Delete the TTS from the queue
              node.setNodeStatus({ fill: 'green', shape: 'ring', text: "No queue to resume." });
            }
          } catch (error) {
            node.setNodeStatus({ fill: 'red', shape: 'ring', text: "Error resuming queue: " + error.message });
          }


          // 19/04/2022 Resume music queue of additional players
          for (let index = 0; index < node.oAdditionalSonosPlayers.length; index++) {
            let addPlayer = node.oAdditionalSonosPlayers[index].oPlayer;
            let trackAddPlayer = addPlayer.additionalPlayerCurrentTrack;
            if (trackAddPlayer !== null) {
              try {
                await resumeMusicQueue(trackAddPlayer, addPlayer);
                node.setNodeStatus({ fill: 'green', shape: 'ring', text: "Done resuming queue additional player " + addPlayer.host || "" });
              } catch (error) {
                // Dont care
                RED.log.warn("ttsultimate: Error resuming music queue of additional player " + error.message + " " + addPlayer.host || "");
              }
            } else {
              node.setNodeStatus({ fill: 'green', shape: 'ring', text: "No queue to resume for " + addPlayer.host || "" });
            }
          }

          // Signal end playing
          let t = setTimeout(() => {
            node.msg.completed = true;
            node.currentMSGbeingSpoken = {};
            node.send([{ passThroughMessage: node.passThroughMessage, payload: node.msg.completed }, null]);
            node.bBusyPlayingQueue = false
            node.server.whoIsUsingTheServer = ""; // Signal to other ttsultimate node, that i'm not using the Sonos device anymore
          }, 500)

        } else if (node.playertype === "noplayer") {
          // End task if no player is selected.
          // Output the array of files
          // Signal end playing
          //let t = setTimeout(() => {
          node.msg.completed = true;
          node.currentMSGbeingSpoken = {};
          node.send([{ passThroughMessage: node.passThroughMessage, payload: node.msg.completed, filesArray: noPlayerFileArray }, null]);
          node.bBusyPlayingQueue = false
          node.server.whoIsUsingTheServer = ""; // Signal to other ttsultimate node, that i'm not using the Sonos device anymore
          //}, 1000)
        }

      } catch (error) {
        // Should'nt be there
        RED.log.error("ttsultimate: BIG Error HandleQueue MAIN " + error.message);
        node.setNodeStatus({ fill: "grey", shape: "ring", text: "Error Handlequeue " + error.message });
        node.flushQueue();
      }

    }

    node.on('input', function (msg) {
      // if (msg.hasOwnProperty("banana")) {
      //     node.SonosClient.setMuted(msg.banana);
      //     return;
      // }

      // 05/01/2022 Set the passtrough message o come cazzo si scrive
      node.passThroughMessage = RED.util.cloneMessage(msg);

      // 09/01/2021 Set the main player and groups IP on request
      // *********************************
      if (msg.hasOwnProperty("setConfig")) {
        if (msg.setConfig.hasOwnProperty("setMainPlayerIP")) {
          node.sSonosIPAddress = msg.setConfig.setMainPlayerIP;
          RED.log.info("ttsultimate: new main player set by msg: " + node.sSonosIPAddress);
          node.setNodeStatus({ fill: 'grey', shape: 'ring', text: "Main Player changed to " + node.sSonosIPAddress });
          // RE-Create sonos client & groups 
          node.SonosClient = new sonos.Sonos(node.sSonosIPAddress);
          node.SonosClient.getName().then(info => {
            node.sonosCoordinatorGroupName = info;
            RED.log.info("ttsultimate: new zone coordinator set by msg: " + JSON.stringify(info));
          }).catch(err => {
          });
        };
        if (msg.setConfig.hasOwnProperty("setPlayerGroupArray")) {
          node.setNodeStatus({ fill: 'grey', shape: 'ring', text: "Group players changed" });
          // Fill the node.oAdditionalSonosPlayers with all sonos IPs in the setPlayerGroupArray
          node.oAdditionalSonosPlayers = [];
          for (let index = 0; index < msg.setConfig.setPlayerGroupArray.length; index++) {
            const sRow = msg.setConfig.setPlayerGroupArray[index];
            let host = "";
            let hostVolumeAdjust = 0;
            if (sRow.includes("#")) {
              host = sRow.split("#")[0];
              hostVolumeAdjust = sRow.split("#")[1];
            } else {
              host = sRow;
            }
            //node.oAdditionalSonosPlayers.push({ oPlayer: new sonos.Sonos(element.host), hostVolumeAdjust: element.hostVolumeAdjust });
            node.oAdditionalSonosPlayers.push({ oPlayer: new sonos.Sonos(host), hostVolumeAdjust: Number(hostVolumeAdjust) });
            RED.log.info("ttsultimate: new group player set by msg: " + host + " adjusted volume: " + Number(hostVolumeAdjust));
          }
        };
      };
      // *********************************

      // In case of connection error, doesn't accept any message
      if (node.msg.connectionerror && node.playertype !== "noplayer") {
        RED.log.warn("ttsultimate: Sonos is offline. The new msg coming from the flow will be rejected.");
        node.setNodeStatus({ fill: 'red', shape: 'ring', text: "Sonos is offline. The msg has been rejected." });
        return;
      }

      // 27/01/2021 Stop whatever in play.
      if (msg.hasOwnProperty("stop") && msg.stop === true) {
        node.flushQueue();
        try {
          STOPSync();
        } catch (error) {
        }
        node.setNodeStatus({ fill: 'red', shape: 'ring', text: "Forced stop." });
        return;
      }

      if (!msg.hasOwnProperty("payload")) {
        notifyError(msg, 'msg.payload must be of type String');
        return;
      }


      // 21/10/2021 force unmute
      if (msg.hasOwnProperty("unmute")) {
        node.unmuteIfMuted = msg.unmute;
      }

      // 23/01/2024 allow input to set voice
      if (msg.hasOwnProperty("voiceId")) {
        node.voiceId = msg.voiceId;
      }

      // 05/12/2020 handling Hailing
      var hailingMSG = null;
      if (msg.hasOwnProperty("nohailing") && (msg.nohailing == "1" || msg.nohailing.toLowerCase() == "true")) {
        hailingMSG = null;
      } else {

        // Backward compatibiliyy, to remove with the next Version
        // ################
        if (config.sonoshailing === "0") {
          // Remove the hailing.mp3 default file
          RED.log.info('ttsultimate: Hailing disabled');
        } else if (config.sonoshailing == "1") {
          RED.log.warn("ttsultimate you've an old hailing setting. PLEASE SET AGAIN THE HAILING IN THE CONFIG NODE");
          config.sonoshailing = "Hailing_Hailing.mp3";
        } else if (config.sonoshailing == "2") {
          RED.log.warn("ttsultimate you've an old hailing setting. PLEASE SET AGAIN THE HAILING IN THE CONFIG NODE");
          config.sonoshailing = "Hailing_ComputerCall.mp3";
        } else if (config.sonoshailing == "3") {
          RED.log.warn("ttsultimate you've an old hailing setting. PLEASE SET AGAIN THE HAILING IN THE CONFIG NODE");
          config.sonoshailing = "Hailing_VintageSpace.mp3";
        }
        // ################
        if (config.sonoshailing !== "0") {
          hailingMSG = { payload: config.sonoshailing };
        } else {
          hailingMSG = null;
        }
        if (msg.hasOwnProperty("sonoshailing")) hailingMSG = { payload: "Hailing_" + msg.sonoshailing + ".mp3" };
      }

      // 27/01/2021 Handling priority messages
      // ########################
      if (msg.hasOwnProperty("priority") && msg.priority === true) {
        // 10/04/2018 Take only the TTS message from the queue, that are not prioritized and removes others.
        let arrayTemp = [];
        for (let index = 0; index < node.tempMSGStorage.length; index++) {
          const element = node.tempMSGStorage[index];
          if (element.hasOwnProperty("priority") && element.priority === true) {
            arrayTemp.push(element);
          }
        }
        node.tempMSGStorage = arrayTemp;

        // If the queue is empty and if i can play the Haniling, add the hailing file first
        if (node.tempMSGStorage.length == 0 && hailingMSG !== null) {
          node.tempMSGStorage.push(hailingMSG);
          node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Queued Hail in priority mode' });
        }

        // Priority checks
        if (node.currentMSGbeingSpoken.hasOwnProperty("priority") && node.currentMSGbeingSpoken.priority === true) {
          // There is already a priority message being spoken, do nothing
          node.setNodeStatus({ fill: 'grey', shape: 'ring', text: 'There is already a priority message being spoken...queuing' });
        } else {
          if (node.playertype !== 'noplayer') {
            node.SonosClient.stop().then(result => {
              node.bTimeOutPlay = true;
              node.currentMSGbeingSpoken = msg; // Set immediately, otherwise if comes new flow messages, currentMSGbeingSpoken is too old.
            }).catch(err => {
              // Don't care
              node.bTimeOutPlay = true;
              node.currentMSGbeingSpoken = msg;// Set immediately, otherwise if comes new flow messages, currentMSGbeingSpoken is too old.
            })
          } else {
            node.currentMSGbeingSpoken = msg; // Set immediately, otherwise if comes new flow messages, currentMSGbeingSpoken is too old.
          }
        }

      } else {
        // If the queue is empty and if i can play the Haniling, add the hailing file first
        if (node.tempMSGStorage.length == 0 && hailingMSG !== null && !node.bBusyPlayingQueue) {
          node.tempMSGStorage.push(hailingMSG);
          node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Queued Hail' });
        }
      }
      // ########################

      // Starts main queue watching
      node.tempMSGStorage.push(msg);
      node.waitForQueue();

    });

    // This starts a timer watching for queue each second.
    node.waitForQueue = () => {
      // Allow some time to wait for all messages from flow
      if (node.oTimerCacheFlowMSG !== null) clearTimeout(node.oTimerCacheFlowMSG);
      node.oTimerCacheFlowMSG = setTimeout(() => {
        // Checks if someone else is using the server node
        if (node.server.whoIsUsingTheServer === "" || node.server.whoIsUsingTheServer === node.id) {
          if (!node.bBusyPlayingQueue && node.tempMSGStorage.length > 0) {
            HandleQueue();
          } else {
            if (node.tempMSGStorage.length > 0) node.setNodeStatus({ fill: 'grey', shape: 'ring', text: "Busy with " + node.tempMSGStorage.length + " items in queue. Retry..." });
          }
        } else {
          node.setNodeStatus({ fill: 'yellow', shape: 'ring', text: "Sonos is occupied by " + node.server.whoIsUsingTheServer + " Retry..." });
        }
        node.waitForQueue();
      }, node.playertype === "noplayer" ? 100 : 1000);

    }

    node.on('close', function (done) {
      clearTimeout(node.oTimerSonosConnectionCheck);
      if (node.timerbTimeOutPlay !== null) clearTimeout(node.timerbTimeOutPlay);
      node.msg.completed = true;
      node.send([{ passThroughMessage: node.passThroughMessage, payload: node.msg.completed }, null]);
      node.setNodeStatus({ fill: "green", shape: "ring", text: "Shutdown" });
      node.flushQueue();
      done();

    });

    // Amazon AWS Service
    function synthesizeSpeechPolly([ttsService, params]) {
      return new Promise((resolve, reject) => {
        ttsService.synthesizeSpeech(params, function (err, data) {
          if (err !== null) {
            return reject(err);
          }
          resolve(data.AudioStream);
        });
      });
    }
    // 23/12/2020 Google TTS Service
    function synthesizeSpeechGoogleTTS([ttsService, params]) {
      return new Promise((resolve, reject) => {
        ttsService.synthesizeSpeech(params, function (err, data) {
          if (err !== null) {
            return reject(err);
          }
          resolve(data.audioContent);
        });
      });
    }
    // 26/12/2020 Google TTS Service
    async function synthesizeSpeechGoogleTranslate(ttsService, params) {
      try {
        // 30/01/2021 changed how google handles voices 
        // https://github.com/ncpierson/google-translate-tts/issues/5#issuecomment-770209715
        if (params.voice.includes("-")) params.voice = params.voice.split("-")[0];

        const buffer = await ttsService.synthesize(params);
        return (buffer);
      } catch (error) {
        throw (error);
      }
    };
    // 12/10/2021 Microsoft Azure TTS Service
    async function synthesizeSpeechMicrosoftAzureTTS(ttsService, params) {

      return new Promise(function (resolve, reject) {
        try {

          // Microsoft fa sempre tutto diverso dagli altri, per cui mi tocca reinstanziare l'oggetto
          ttsService = node.server.setMicrosoftAzureVoice(params.voice);

          ttsService.speakTextAsync(
            params.text,
            result => {
              ttsService.close();
              resolve(Buffer.from(result.audioData));
            },
            error => {
              ttsService.close();
              reject(error);
            });
        } catch (error) {
          reject(error);
        }
      });
    };
    // elevenLabs TTS Service
    function synthesizeSpeechElevenLabs(ttsService, params) {
      // const params = {
      //     text: msg,
      //     voice: node.voiceId
      // };
      function stream2buffer(stream) {
        return new Promise((resolve, reject) => {
          try {
            const _buf = [];

            stream.on("data", (chunk) => _buf.push(chunk));
            stream.on("end", () => resolve(Buffer.concat(_buf)));
            stream.on("error", (err) => reject(err));
          } catch (error) {
          }
        });
      }
      return new Promise((resolve, reject) => {
        // "model_id": "eleven_multilingual_v1",
        ttsService.textToSpeechStream(node.server.credentials.elevenlabsKey, params.voice, params.text, null, null, "eleven_multilingual_v1").then((res) => {
          try {
            if (res !== undefined) {
              resolve(stream2buffer(res));
            } else {
              reject(new Error("Please check credentials. The stream cannot be read from the elevenlabs TTS server"))
            }
          } catch (error) {
            reject(error)
          }
        });
      });
    }
    // elevenLabs TTS Service
    async function synthesizeSpeechElevenLabsV2(ttsService, params) {
      try {
        const audioStream = await ttsService.generate(params);
        const chunks = [];
        for await (const chunk of audioStream) {
          chunks.push(chunk);
        }
        const content = Buffer.concat(chunks);
        return content;
      } catch (error) {
        throw (error);
      }
    }

    // 04/01/2021 hashing filename to avoid issues with long filenames.
    function getFilename(_text, _params) {
      let sTextToBeHashed = _text.concat(JSON.stringify(_params));
      const hashSum = crypto.createHash('md5');
      hashSum.update(sTextToBeHashed);
      return hashSum.digest('hex') + ".mp3";
    }

    function notifyError(msg, err) {
      var errorMessage = err.message;
      // Output error to console
      node.setNodeStatus({
        fill: 'red',
        shape: 'dot',
        text: 'notifyError: ' + errorMessage
      });
      // Set error in message
      msg.error = errorMessage;
    }


  }
  RED.nodes.registerType('ttsultimate', PollyNode);


}
