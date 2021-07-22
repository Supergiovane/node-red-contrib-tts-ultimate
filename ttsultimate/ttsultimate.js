const { clear } = require('console');
const { clearInterval } = require('timers');

module.exports = function (RED) {
    'use strict';

    var fs = require('fs');
    var MD5 = require('crypto-js').MD5;
    var util = require('util');
    var path = require('path');
    const sonos = require('sonos');


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
        node.oTimerSonosConnectionCheck;
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
        node.userDir = path.join(RED.settings.userDir, "sonospollyttsstorage"); // 09/03/2020 Storage of ttsultimate (otherwise, at each upgrade to a newer version, the node path is wiped out and recreated, loosing all custom files)
        node.oAdditionalSonosPlayers = []; // 20/03/2020 Contains other players to be grouped
        node.rules = config.rules || [{}];
        node.sNoderedURL = "";
        node.oTimerCacheFlowMSG = null; // 05/12/2020
        node.tempMSGStorage = []; // 04/12/2020 Temporary stores the flow messages
        node.bBusyPlayingQueue = false; // 04/12/2020 is busy during playing of the queue
        node.currentMSGbeingSpoken = {}; // Stores the current message being spoken
        node.sonosCoordinatorPreviousVolumeSetByApp = 0; // 05/07/2021 stores the main payer volume set by the sonos app

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

        // 27/11/2019 Check Sonos connection healt
        node.CheckSonosConnection = () => {

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

        }

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
            const element = node.rules[index];
            node.oAdditionalSonosPlayers.push(new sonos.Sonos(element.host));
            RED.log.info("ttsultimate: FOUND ADDITIONAL PLAYER " + element.host);
        }


        // 27/11/2019 Start the connection healty check
        node.oTimerSonosConnectionCheck = setTimeout(function () { node.CheckSonosConnection(); }, 5000);

        node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Initialized.' });


        // 20/03/2020 Join Coordinator queue
        // ######################################################
        node.groupSpeakers = () => {
            return new Promise(function (resolve, reject) {
                // 05/07/2021 Get the main coordinator player previous volume set by app
                node.SonosClient.getVolume().then((volume) => {
                    node.sonosCoordinatorPreviousVolumeSetByApp = volume; // New inferrer prop containing the current volume
                    //console.log("BANANA VOLUME GET ", node.sonosCoordinatorPreviousVolumeSetByApp);
                }).catch(err => {
                    node.sonosCoordinatorPreviousVolumeSetByApp = node.sSonosVolume;
                }).finally(() => {
                    if (node.oAdditionalSonosPlayers.length === 0) resolve(true);
                    // 30/03/2020 in the middle of coronavirus emergency. Group Speakers
                    // You don't have to worry about who is the coordinator.
                    for (let index = 0; index < node.oAdditionalSonosPlayers.length; index++) {
                        const element = node.oAdditionalSonosPlayers[index];
                        element.joinGroup(node.sonosCoordinatorGroupName).then(success => {
                            // 02/07/2021 Get the player's volume set by app, to be set again in ungroupspealers
                            element.getVolume().then((volume) => {
                                element.additionalPlayerPreviousVolumeSetByApp = volume; // New inferrer prop containing the current volume
                                //console.log("BANANA VOLUME GET ", element.additionalPlayerPreviousVolumeSetByApp);
                                // // 24/09/2020 Set Volume of each device in the group
                                // element.setVolume(node.sSonosVolume).then(success => {
                                // }).catch(err => { });
                            });

                        }).catch(err => {
                            RED.log.warn("ttsultimate: Error joining device " + err.message);
                        });
                    };
                    var b = false;
                    if (b === true) reject("fake");
                    setTimeout(() => {
                        resolve(true);
                    }, 2000);
                });
            });
        }

        // 20/03/2020 Ungroup Coordinator queue
        node.ungroupSpeakers = () => {
            return new Promise(function (resolve, reject) {
                // 05/07/2021, set the previous app volume for main coordinator player
                node.SonosClient.setVolume(node.sonosCoordinatorPreviousVolumeSetByApp).then(success => {
                    //console.log("BANANA COORDINATOR PREVIOUS VOLUME SET ", node.sonosCoordinatorPreviousVolumeSetByApp);
                }).catch(err => {
                    RED.log.warn('ttsultimate: Error set preious volume on main coordinator in ungroupSpeakers ' + err.message);
                });

                for (let index = 0; index < node.oAdditionalSonosPlayers.length; index++) {
                    const element = node.oAdditionalSonosPlayers[index];
                    element.leaveGroup().then(success => {
                        //RED.log.warn('Leaving the group is a ' + (success ? 'Success' : 'Failure'))
                    }).catch(err => {
                        // Dont care
                        RED.log.warn('ttsultimate: Error leaving group device ' + err.message);
                    }).finally(() => {
                        if (element.additionalPlayerPreviousVolumeSetByApp !== undefined) {
                            element.setVolume(element.additionalPlayerPreviousVolumeSetByApp).then(success => {
                                //console.log("BANANA ADDITIONAL PLAYER PREVIOUS VOLUME SET ", element.additionalPlayerPreviousVolumeSetByApp);
                            }).catch(err => {
                                RED.log.warn('ttsultimate: Error set preious volume on group device ' + err.message);
                            });
                        }
                    });
                }
                var b = false;
                if (b === true) reject(false); // fake rejection to avoid warning message of promise rejection error
                setTimeout(() => {
                    resolve(true);
                }, 2000);
            });
        }
        // ######################################################


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


        // 30/12/2020 we are at the end of this crazy 2020
        function getMusicQueue() {
            return new Promise(function (resolve, reject) {
                var oRet = null;
                node.SonosClient.currentTrack().then(track => {
                    oRet = track;// .queuePosition || 1; // Get the current track  in the queue.
                    node.SonosClient.getCurrentState().then(state => {
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

        // 30/12/2020 Supergiovane resume queue for radio, queue music, TV in , line in etc.
        async function resumeMusicQueue(_oTrack) {
            if (_oTrack !== null) {
                // Do some checks on the track.
                if (_oTrack.hasOwnProperty("duration") && _oTrack.duration === 0 || _oTrack.uri.startsWith("x-sonosprog-http")) {
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

                try {
                    await node.SonosClient.play(_oTrack.uri);
                } catch (error) {
                    return error;
                }
                try {
                    await node.SonosClient.seek(_oTrack.position);
                } catch (error) {
                    // Don't care
                }
            } else {
                if (_oTrack.trackType === "musicqueue") { // This indicates that is an audio file or stream station
                    try {
                        await node.SonosClient.selectQueue();
                    } catch (error) {
                        return error;
                    }
                    try {
                        await node.SonosClient.selectTrack(_oTrack.queuePosition);
                    } catch (error) {
                        return error;
                    }
                    try {
                        await node.SonosClient.seek(_oTrack.position);
                    } catch (error) {
                        // Don't care
                    }
                    try {
                        await node.SonosClient.play();
                    } catch (error) {
                        return error;
                    }
                } else if (_oTrack.trackType === "lineinput") {
                    // Line in, TV in, etc...
                    try {
                        await node.SonosClient.setAVTransportURI(_oTrack.uri);
                    } catch (error) {
                        return error;
                    }
                }
            }
            if (_oTrack.state !== "playing") {
                // 30/12/2020 Immedialtely stops the play
                try {
                    await node.SonosClient.pause();
                } catch (error) {

                }
                setTimeout(() => { return true; }, 5000); // Wait some seconds 
            } else {
                setTimeout(() => { return true; }, 5000); // Wait some seconds to the music to start playing    
            }
        };

        // Handle the queue
        async function HandleQueue() {
            node.bBusyPlayingQueue = true;
            node.server.whoIsUsingTheServer = node.id; // Signal to other ttsultimate node, that i'm using the Sonos device
            try {

                // Get the current music queue, if one
                var oCurTrack = null;
                try {
                    oCurTrack = await getMusicQueue();
                } catch (error) {
                    oCurTrack = null;
                }

                // 05/12/2020 Set "completed" to false and send it
                node.msg.completed = false;
                try {
                    await node.groupSpeakers(); // 20/03/2020 Group Speakers toghether    
                } catch (error) {
                    // Don't care.
                    node.setNodeStatus({ fill: "red", shape: "ring", text: "Error grouping speakers: " + error.message });
                    RED.log.error("ttsultimate: Error grouping speakers: " + error.message);
                }

                node.send([{ payload: node.msg.completed }, null]);


                while (node.tempMSGStorage.length > 0) {
                    node.currentMSGbeingSpoken = node.tempMSGStorage[0];// Advise the whole node of the currently spoken MSG
                    const msg = node.currentMSGbeingSpoken.payload.toString(); // Get the text to be spoken
                    node.tempMSGStorage.splice(0, 1); // Remove the first item in the array
                    var sFileToBePlayed = "";
                    node.setNodeStatus({ fill: "gray", shape: "ring", text: "Read " + msg });

                    // 04/12/2020 check what really is the file to be played
                    if (msg.toLowerCase().startsWith("http://") || msg.toLowerCase().startsWith("https://")) {
                        RED.log.info('ttsultimate: Leggi HTTP filename: ' + msg);
                        sFileToBePlayed = msg;
                    } else if (msg.indexOf("OwnFile_") !== -1) {
                        RED.log.info('ttsultimate: OwnFile .MP3, skip polly, filename: ' + msg);
                        sFileToBePlayed = path.join(node.userDir, "ttspermanentfiles", msg);
                    } else if (msg.indexOf("Hailing_") !== -1) {
                        RED.log.info('ttsultimate: Hailing .MP3, skip polly, filename: ' + msg);
                        sFileToBePlayed = path.join(node.userDir, "hailingpermanentfiles", msg);
                    } else {
                        sFileToBePlayed = getFilename(msg, node.voiceId, node.ssml, "mp3");
                        sFileToBePlayed = path.join(node.userDir, "ttsfiles", sFileToBePlayed);
                        // Check if cached
                        if (!fs.existsSync(sFileToBePlayed)) {
                            try {
                                // No file in cache. Download from tts service
                                var data;
                                if (node.server.ttsservice === "polly") {
                                    node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Downloading from Amazon...' });
                                    var params = {
                                        OutputFormat: "mp3",
                                        SampleRate: '22050',
                                        Text: msg,
                                        TextType: node.ssml ? 'ssml' : 'text',
                                        VoiceId: node.voiceId
                                    };
                                    data = await synthesizeSpeechPolly([node.server.polly, params]);
                                } else if (node.server.ttsservice === "googletts") {
                                    node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Downloading from Google TTS...' });
                                    // VoiceId is: name + "#" + languageCode + "#" + ssmlGender 
                                    const params = {
                                        voice: { name: node.voiceId.split("#")[0], languageCode: node.voiceId.split("#")[1], ssmlGender: node.voiceId.split("#")[2] },
                                        audioConfig: { audioEncoding: "MP3" },
                                    };
                                    params.input = node.ssml === "text" ? { text: msg } : { ssml: msg };
                                    data = await synthesizeSpeechGoogleTTS([node.server.googleTTS, params]);
                                } else if (node.server.ttsservice === "googletranslate") {
                                    node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Downloading from Google Translate...' });
                                    // VoiceId is: code 
                                    const params = {
                                        text: msg,
                                        voice: node.voiceId,
                                        slow: false // optional
                                    };
                                    data = await synthesizeSpeechGoogleTranslate(node.server.googleTranslateTTS, params);
                                }
                                // Save the downloaded file into the cache
                                fs.writeFileSync(sFileToBePlayed, data, function (error, result) {
                                    if (error) {
                                        RED.log.error("ttsultimate: node id: " + node.id + " Unable to save the file " + error.message);
                                        node.setNodeStatus({ fill: "red", shape: "ring", text: "Unable to save the file " + sFileToBePlayed + " " + error.message });
                                        throw (error);
                                    }
                                });
                            } catch (error) {
                                RED.log.error("ttsultimate: node id: " + node.id + " Error Downloading TTS: " + error.message + ". THE TTS SERVICE MAY BE DOWN.");
                                node.setNodeStatus({ fill: 'red', shape: 'ring', text: 'Error Downloading TTS:' + error.message });
                                sFileToBePlayed = "";
                            }
                        }
                        else {
                            node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Reading offline from cache' });
                        }
                    }

                    // Ready to play
                    if (sFileToBePlayed !== "") {

                        // Now i am ready to play the file
                        node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Play ' + msg });
                        // Play directly files starting with http://
                        if (!sFileToBePlayed.toLowerCase().startsWith("http://") && !sFileToBePlayed.toLowerCase().startsWith("https://")) {
                            sFileToBePlayed = node.sNoderedURL + "/tts/tts.mp3?f=" + encodeURIComponent(sFileToBePlayed);
                        }

                        // Set Volume
                        try {
                            let volTemp = 0
                            if (node.currentMSGbeingSpoken.hasOwnProperty("volume")) {
                                volTemp = node.currentMSGbeingSpoken.volume;
                            } else {
                                volTemp = node.sSonosVolume;
                            }
                            await node.SonosClient.setVolume(volTemp);
                            if (node.oAdditionalSonosPlayers.length > 0) {
                                // 05/07/2021 set the volume of additional coordinatores
                                for (let index = 0; index < node.oAdditionalSonosPlayers.length; index++) {
                                    const element = node.oAdditionalSonosPlayers[index];
                                    try {
                                        await element.setVolume(volTemp);
                                    } catch (error) {
                                        RED.log.error("ttsultimate: Handlequeue: Unable to set the volume on additional player " + error.message);
                                    }
                                };
                            };

                        } catch (error) {
                            RED.log.error("ttsultimate: Unable to set the volume for " + sFileToBePlayed);
                        }
                        try {

                            await node.SonosClient.setAVTransportURI(sFileToBePlayed);

                            // Wait for start playing
                            var state = "";
                            if (node.timerbTimeOutPlay !== null) clearTimeout(node.timerbTimeOutPlay);
                            node.bTimeOutPlay = false;
                            node.timerbTimeOutPlay = setTimeout(() => {
                                node.bTimeOutPlay = true;
                            }, 10000);
                            while (state !== "playing" && !node.bTimeOutPlay) {
                                try {
                                    state = await node.SonosClient.getCurrentState();
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
                            }, 60000);
                            while (state !== "stopped" && !node.bTimeOutPlay) {
                                try {
                                    state = await node.SonosClient.getCurrentState();
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
                            RED.log.error("ttsultimate: Error HandleQueue for " + sFileToBePlayed + " " + error.message);
                            node.setNodeStatus({ fill: 'red', shape: 'dot', text: 'Error ' + msg + " " + error.message });
                        }

                    }


                }; // End Loop

                // Ungroup speaker
                try {
                    await node.ungroupSpeakers();
                } catch (error) {
                    // Don't care.
                    node.setNodeStatus({ fill: "red", shape: "ring", text: "Error ungrouping speakers: " + error.message });
                }

                // Resume music
                try {
                    if (oCurTrack !== null) {
                        node.setNodeStatus({ fill: 'grey', shape: 'ring', text: "Resuming original queue..." });
                        await resumeMusicQueue(oCurTrack);
                        node.setNodeStatus({ fill: 'green', shape: 'ring', text: "Done resuming queue." });
                    }
                } catch (error) {
                    node.setNodeStatus({ fill: 'red', shape: 'ring', text: "Error resuming queue: " + error.message });
                }

                // Signal end playing
                setTimeout(() => {
                    node.msg.completed = true;
                    node.currentMSGbeingSpoken = {};
                    node.send([{ payload: node.msg.completed }, null]);
                    node.bBusyPlayingQueue = false
                    node.server.whoIsUsingTheServer = ""; // Signal to other ttsultimate node, that i'm not using the Sonos device anymore
                }, 1000)


            } catch (error) {
                // Should'nt be there
                RED.log.error("ttsultimate: BIG Error HandleQueue MAIN " + error.message);
                node.setNodeStatus({ fill: "grey", shape: "ring", text: "Error Handlequeue " + error.message });
                node.flushQueue();
            }

        }

        node.on('input', function (msg) {

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
                        const element = msg.setConfig.setPlayerGroupArray[index];
                        node.oAdditionalSonosPlayers.push(new sonos.Sonos(element));
                        RED.log.info("ttsultimate: new group player set by msg: " + element);
                    }
                };
            };
            // *********************************

            // In case of connection error, doesn't accept any message
            if (node.msg.connectionerror) {
                RED.log.warn("ttsultimate: Sonos is offline. The new msg coming from the flow will be rejected.");
                node.setNodeStatus({ fill: 'red', shape: 'ring', text: "Sonos is offline. The msg has been rejected." });
                return;
            }

            // 27/01/2021 Stop whatever in play.
            if (msg.hasOwnProperty("stop") && msg.stop === true) {
                node.flushQueue();
                node.SonosClient.stop().then(result => {

                }).catch(err => {
                    // Don't care

                })
                node.setNodeStatus({ fill: 'red', shape: 'ring', text: "Forced stop." });
                return;
            }

            if (!msg.hasOwnProperty("payload")) {
                notifyError(msg, 'msg.payload must be of type String');
                return;
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
                    node.SonosClient.stop().then(result => {
                        node.bTimeOutPlay = true;
                        node.currentMSGbeingSpoken = msg; // Set immediately, otherwise if comes new flow messages, currentMSGbeingSpoken is too old.
                    }).catch(err => {
                        // Don't care
                        node.bTimeOutPlay = true;
                        node.currentMSGbeingSpoken = msg;// Set immediately, otherwise if comes new flow messages, currentMSGbeingSpoken is too old.
                    })
                }

            } else {
                // If the queue is empty and if i can play the Haniling, add the hailing file first
                if (node.tempMSGStorage.length == 0 && hailingMSG !== null && !node.bBusyPlayingQueue) {
                    node.tempMSGStorage.push(hailingMSG);
                    node.setNodeStatus({ fill: 'green', shape: 'ring', text: 'Queued Hail' });
                }
            }
            // ########################


            // 30/01/2021 split the text if it's too long, otherwies i'll have issues with filename too long.
            const iLimitTTSFilenameLenght = 220;
            if (msg.payload.length >= iLimitTTSFilenameLenght) {
                let sTemp = "";
                let aSeps = [".", ",", ":", ";", "!", "?"];
                let sPayload = msg.payload.replace(/[\r\n]+/gm, "");
                for (let index = 0; index < sPayload.length; index++) {
                    const element = sPayload.substr(index, 1);
                    sTemp += element;
                    if (aSeps.indexOf(element) > -1 && sTemp.length > 20) {
                        const oMsg = RED.util.cloneMessage(msg);
                        oMsg.payload = sTemp;
                        node.tempMSGStorage.push(oMsg);
                        sTemp = "";
                    }
                    if (sTemp.length > iLimitTTSFilenameLenght && element === " ") {
                        // Split using space
                        const oMsg = RED.util.cloneMessage(msg);
                        oMsg.payload = sTemp;
                        node.tempMSGStorage.push(oMsg);
                        sTemp = "";
                    }
                }
                // Remaining
                const oMsg = RED.util.cloneMessage(msg);
                oMsg.payload = sTemp;
                node.tempMSGStorage.push(oMsg);

            } else {
                node.tempMSGStorage.push(msg);
            }


            // Starts main queue watching
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
            }, 1000);
        }

        node.on('close', function (done) {
            clearTimeout(node.oTimerSonosConnectionCheck);
            if (node.timerbTimeOutPlay !== null) clearTimeout(node.timerbTimeOutPlay);
            node.msg.completed = true;
            node.send([{ payload: node.msg.completed }, null]);
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


        function getFilename(text, _sVoice, isSSML, extension) {
            // Slug the text.
            var basename = slug(text);
            _sVoice = slug(_sVoice);

            var ssml_text = isSSML ? '_ssml' : '';

            // Filename format: "text_voice.mp3"
            var filename = util.format('%s_%s%s.%s', basename, _sVoice, ssml_text, extension);

            // If filename is too long, cut it and add hash
            if (filename.length > 250) {
                var hash = MD5(basename);

                // Filename format: "text_hash_voice.mp3"
                var ending = util.format('_%s_%s%s.%s', hash, _sVoice, ssml_text, extension);
                var beginning = basename.slice(0, 250 - ending.length);

                filename = beginning + ending;
            }

            return filename;
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
