


module.exports = function (RED) {
    var formidable = require('formidable');
    var fs = require('fs');
    var path = require('path');

    function ownfile(config) {
        RED.nodes.createNode(this, config);
        var node = this;
        node.selectedFile = config.selectedFile || "";
       
        this.on('input', function (msg) {
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
    RED.nodes.registerType("ownfile", ownfile);
};