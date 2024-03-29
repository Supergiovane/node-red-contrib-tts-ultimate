


module.exports = function (RED) {
    var formidable = import('formidable');
    var fs = require('fs');
    var path = require('path');

    function ownfileultimate(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.selectedFile = config.selectedFile || "";
        node.priority = config.priority !== undefined ? config.priority : false;

        this.on('input', function (msg) {
            if (!msg.hasOwnProperty("priority") && node.priority) msg.priority = node.priority;
            if (msg.hasOwnProperty("selectedFile")) {
                if (msg.hasOwnProperty("selectedFile")) msg.payload = "OwnFile_" + msg.selectedFile.replace(".mp3", "") + ".mp3";
                node.send(msg);
            } else {
                if (msg.payload !== undefined && msg.payload === true || msg.payload === false) {
                    msg.payload = node.selectedFile;
                    node.send(msg);
                }
            }
        });
    }
    RED.nodes.registerType("ownfileultimate", ownfileultimate);
};