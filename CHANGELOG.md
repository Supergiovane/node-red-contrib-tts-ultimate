![Sample Node](img/logo.png) 

[![Donate via PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=flat-square)](https://www.paypal.me/techtoday) 

<p>
<b>Version 1.0.8</b> December 2020<br/>
- FIS: fix EXDEV issue on some system, when uploading ownfiles or hailing files.<br/>
</p>
<p>
<b>Version 1.0.7</b> December 2020<br/>
- If you run node-red behind something like homeassistant, redmatic, etc.. and the user running node-red hasn't permission to write to the filesystem, a popup error will appear upon uploading of custom file.<br/>
- Removed some unwanted logs.<br/>
- NEW: now the previous queue/radio is automatic selected, even if not previously playing<br/>
</p>
<p>
<b>Version 1.0.5</b> 26 December 2020<br/>
- NEW: added google translate engine. With this, you don't even need credentials. It works immediately.<br/>
- Google translate engine accepts max 200 chars per row. Supergiovane makes you happy again. The node will automatically split single messages in many messages with lenght minor as 200 chars each.<br/>
</p>
<p>
<b>Version 1.0.4</b> 25 December 2020<br/>
- Added deprecation warning for old SonosPollyTTS users.<br/>
</p>
<p>
<b>Version 1.0.3</b> 24 December 2020<br/>
- NEW: Added output PIN to signal errors only.<br/>
- CHANGE: now the errore are sent to Output PIN 2, to better separate the messages.<br/>
- The setup process for newly created configuration nodes is yet more friendly.
</p>
<p>
<b>Version 1.0.2</b> 24 December 2020<br/>
- Cosmetic refinements.<br/>
- Update path from SonosPollyTTS added in the README.<br/>
</p>
<p>
<b>Version 1.0.0</b> 24 December 2020<br/>
- First release of TTS-Ultimate, based on SonosPollyTTS (now deprecated).<br/>
- NEW: support for both Amazon Polly and Google TTS.<br/>
</p>
<br/>
<br/>
<br/>

# CHANGELOG BELOW COMES FROM OLD SONOSPOLLYTTS NODE

>
> ***UPDATE PATH FROM SONOSPOLLYTTS TO TTS-ULTIMATE***
>
> Supergiovane takes care about your brain and your time.<br/>
> Install TTS-Ultimate. Both SonosPollyTTS and TTS-Ultimate can cohexist.<br/>
> Then just delete your old SonosPollyTTS nodes and replace it with TTS-Ultimate nodes.<br/>
> The cache will remain the same. Your own audio files and hailing files won't be touched. You'll find it again in TTS-Ultimate<br/>
> 

<br/>
<br/>


<p>
<b>Version 2.0.5</b> December 2020<br/>
- FIX: if you pass a numeric value as payload, the node thows an error in the status and the payload is not handled.</br>
- FIX: if you disable the Hailing, you could hear "zero" instead of not having Haliling at all.
</p>
<p>
<b>Version 2.0.4</b> December 2020<br/>
- NEW: multiple ttsultimate node coordinator. Now, if you use more than one ttsultimate node, the server will coordinate the play between all, without conflicts.<br/>
</p>
<p>
<b>Version 2.0.3</b> December 2020<br/>
- FIX: ttsultimate can remain stuck on "Busy handling queue.." if if fails grouping more than one speaker. Fixed.<br/>
</p>
<p>
<b>Version 2.0.2</b> December 2020<br/>
- FIX: if you hear "zero" instead of hailing, you need to re-select again the hailing in the config node. This is due to an old setting. Currently this has been work-arounded, so you should hear the hailing instead of "zero", but please select again the hailing, because this workaround is time limited.<br/>
- NEW: now, when sonos becames disconnected or the ethernet connection is down, the node won't accept any new messages until the reconnetion is re-established. The queue of messages is flushed as well.<br/>
- Stability improvements.<br/>
</p>
<p>
<b>Version 2.0.1</b> December 2020<br/>
- NEW: automatic resume of radio station. If the station support seeking, the node'll resume at exct time position.<br/>
</p>
<p>
<b>Version 2.0.0</b> December 2020<br/>
- NEW: Completely rewritten the code, to getting rid of very old implementations.<br/>
- Resume queued music now works correctly everytime.<br/>
- BREAKING CHANGE: Node v.10.0.0 or newer is needed.<br/>
</p>
<p>
<b>Version 1.1.39</b> December 2020<br/>
- NEW: resume music queue after TTS speech. Once finished playing the voice speak, the music queue restart at the exact position, at the exact track time.<br/>
- BUGFIX: fixing some issue when inbound msg to the node are very frequent. Should resume the music correctly.<br/>
</p>
<p>
<b>Version 1.1.37</b> December 2020<br/>
- NEW: resume music queue after TTS speech. Once finished playing the voice speak, the music queue restart at the exact position, at the exact track time.<br/>
</p>
<p>
<b>Version 1.1.36</b> November 2020<br/>
- Whenever node-red is restarted or you make a deploy while Sonos is playing music, the node won't stop Sonos players anymore.<br/>
- Speeded up the closing process.<br/>
</p>
<p>
<b>Version 1.1.35</b> October 2020<br/>
- HOTFIX: Fix possible polly voice discovery issues if running in docker or under homeassistant.<br/>
- Added a warning to restart node-red after each change in the config window.<br/>
</p>
<p>
<b>Version 1.1.34</b> October 2020<br/>
- HOTFIX: Fix possible sonos discovery issue<br/>
</p>
<p>
<b>Version 1.1.33</b> October 2020<br/>
- FIX: fixed problem preventing OwnFile node to accept files in non standard node-red installations (dockerized images, as homeassistant plugin etc..). Thanks @koburg for raising the issue.<br/>
- Now, whenever you upload a new file in Ownfile or new Hailing in ttsultimate node, the new file is autimatically selected.<br/>
</p>
<p>
<b>Version 1.1.32</b> October 2020<br/>
- Optimized the code to better handling HTTP calls for UI list.<br/>
- NEW: from now, the avaiable voice list is downloaded directly from AWS Polly website. Non more "forgotten" voices.<br/>
- Reordering of voices by language, to better find your preferred one.<br/>
</p>
<p>
<b>Version 1.1.31</b> October 2020<br/>
- FIX: fixed possible issue in saving/retrieving own audio files and own audio hailings, for node-red running in non standard way, like docker, home assistant plugin etc...<br/>
</p>
<p>
<b>Version 1.1.30</b> September 2020<br/>
- If you run node-red behind natted docker (for example kubertness) and you've added sonos devices to the group list, the devices belonging to the group doesn't accept volume setting. This has been fixed. Thanks @JorinL for raising the issue.<br/>
- NEW: Added more voices and removed old ones no more present in Polly.<br/>
</p>
<p>
<b>Version 1.1.28</b> September 2020<br/>
- Updated sonos API to 1.14.0<br/>
- Fixed an issue where if you power cycle your sonos and it comes up too fast, the node won't detect the disconnection and won't reset the link to sonos.<br/>
- Major code revision, to clean up old things.<br/>
</p>
<p>
<b>Version 1.1.27</b> August 2020<br/>
- Fixed an odd issue. Now "msg.nohailing=true" temporarly (and not permanently anymore) disables the hailing. If you send a new payload without msg.nohailing=true, the hailing will be heard again (that's the standard and intended behaviour.)<br/>
- Sometime the node remains in "Processing" state. Added a fix to that.
</p>
<p>
<b>Version 1.1.26</b> Juli 2020<br/>
- Stability improvement whenever internet connection is broken while downloading TTS audio from Amazon AWS service.<br/>
- Full support for SSML syntax (https://docs.aws.amazon.com/polly/latest/dg/supportedtags.html).<br/>
</p>
<p>
<b>Version 1.1.25</b> June 2020<br/>
- Update sonos api to 1.13.0<br/>
- Fix some minor glitches in new added nodes.<br/>
</p>
<p>
<b>Version 1.1.23</b> March 2020 - In the middle of Coronavirus emergency in Italy<br/>
- Help and README enhancement with new samples<br/>
- Fix some minor glitches in new added nodes.<br/>
</p>
<p>
<b>Version 1.1.22</b> March 2020 - In the middle of Coronavirus emergency in Italy<br/>
- Enhancement: Automatic discover for new node, now automatically adds the first avaiable player.<br/>
- Fix some minor glitches in new added nodes.<br/>
</p>
<p>
<b>Version 1.1.20</b> March 2020 - In the middle of Coronavirus emergency in Italy<br/>
- CAUTION: You may need to re-enter the AWS credentials.<br/>
- NEW: now the webserver config is in the config-node, so you can have multiple ttsultimate nodes without problem with duplicated webserver ports.<br/>
- FIX: Ownfile, fixed a problem in refreshing the file list upon upload of new files.<br/>
- FIX: ttsultimate, fixed a problem in refreshing the hailing list upon upload of new hailing files.<br/>
- Update help accordingly.<br/>
</p>
<p>
<b>Version 1.1.16</b> March 2020 - In the middle of Coronavirus emergency in Italy<br/>
- NEW: Automatic discovery added. No more IP addresses to remember.<br/>
- NEW: Grouping function. Now you can add more players to the play group.<br/>
</p>
<p>
<b>Version 1.1.15</b> March 2020<br/>
- NEW: you can now add your own custom Hailing file.<br/>
- NEW: you can now change the hailing with a msg.hailing property.<br/>
</p>
<p>
<b>Version 1.1.13</b><br/>
- Better handling of incoming msg.selectedFile property.<br/>
- Added Samples in the Readme<br/>
</p>
<p>
<b>Version 1.1.11</b><br/>
- NEW: Added DELETE ALL FILES, to allow you to delete all custom files at once.<br/>
- Added OwnFile samples audio and sample code in README<br/>
</p>
<p>
<b>Version 1.1.10</b><br/>
- Optimized UI for new OwnFile nodes<br/>
</p>
<p>
<b>Version 1.1.9</b><br/>
- NEW: You can now UPLOAD your own mp3 files and play it via the newly added OwnFile node.<br/>
- NEW: You can now DELETE your own mp3 files from the OwnFile node config page.<br/>
</p>
<p>
<b>Version 1.1.6</b><br/>
- NEW: You can now UPLOAD your own mp3 files and play it via the newly added OwnFile node.<br/>
</p>
<p>
<b>Version 1.1.5</b><br/>
- NEW: you can now select whether to purge the TTS cache file at start or to leave all TTS files untouched.<br/>
</p>
<p>
<b>Version 1.1.4</b><br/>
- Updated underlying sonos API to 1.12.6<br/>
</p>
<p>
<b>Version 1.1.3</b><br/>
- Added "msg.connectionerror" to the output messages: <b>true</b> when the node cannot connect to the Sonos device, <b>false</b> if the connection is restored.<br/>
</p>
<p>
<b>Version 1.1.2</b><br/>
- Bugfix preventing start.<br/>
</p>
<p>
<b>Version 1.1.1</b><br/>
- Now should work with grouped sonos devices as well.<br/>
- Upgraded the status below the node, to show the day and time of the last status update.<br/>
</p>
<p>
<b>Version 1.1.0</b><br/>
- Now support HTTPS installations-<br/>
- MAJOR CHANGE IN HANDLING COMMUNICATIONS BETWEEN NODE-RED AND SONOS. Due to added support for HTTPS installation, the node behaviour has been changed. The node will now create his own webserver, instead of using node-red webserver. This permits to overcome SSL certificate problems with Sonos. If your node-red run behind a firewall, REMEMBER TO FORMWARD the node webserver port (default port is 1980)<br/>
</p>
<p>
<b>Version 1.0.21</b><br/>
- Added handling of non standard nodered installations, having httpAdminRoot, httpNodeRoot or httpRoot altered by user. Thanks @ukmoose.<br/>
</p>
<p>
<b>Version 1.0.20</b><br/>
- Fixed an issue, where if you changed the node-red httpAdminRoot, the node won't play anything. Thanks @JorinL.<br/>
</p>
<p>
<b>Version 1.0.19</b><br/>
- Added 9 Voices, thanks to user kitazaki.<br/>
</p>
<p>
<b>Version 1.0.18</b><br/>
- Removed some dependencies to speed up all the things.<br/>
</p>
<p>
<b>Version 1.0.16</b><br/>
- Changed a little behaviour related to the initial volume setting, when node-red starts or a flow is deployed.<br/>
- Applied lodash package security patch.<br/>
</p>
<p>
<b>Version 1.0.15</b><br/>
- Added the ability to select the temp folder, suitable for node-red installed behind hass.io or other similar apps, in case the sonos device can't reach node-red behind those apps. Check that the user can write to the filesystem<br/>
</p>
<p>
<b>Version 1.0.14</b><br/>
- Fixed a possible problem causing an exception in a very slow PC<br/>
- Added the output link and therefore changed the default node group from "output" to "advanced"<br/>
- The node send a msg.completed message during playback. true = ended playing, false = is playing<br/>
- Update sonos dependency to >=1.10.0
</p>
<p>
<b>Version 1.0.12</b><br/>
- You can now temporarely stop playing the Hailing sound via node message <code>msg.nohailing="true";</code> or <code>msg.nohailing="1";</code><br/>
</p>
<b>Version 1.0.8</b><br/>
- Updated sonos node dependency to 1.9.0<br/>
- Changed some icons in the config page<br/>
- Trimmed white spaces in the setting's textboxes to avoid issue when someone put a space in the textboxes. Thanks @1to4<br/>
- Fixed an issue, where if you have more nodes with different settings, e.g. different Sonos IP address or Polly Voice, all nodes take the settings of the last node added.<br/>
</p>
<p>
<b>Version 1.0.7</b><br/>
- Added voice Vicky (German). Thanks @PBue for the suggestion.<br/>
</p>
<p>
<b>Version 1.0.6</b><br/>
- Bugfix due to the httpRoot.<br/>
</p>
<p>
<b>Version 1.0.5</b><br/>
- respect Node-RED httpRoot setting (this is necessary e.g. in environments where Node-RED runs behind a reverse proxy on a non-root path). Thanks @hobbyquaker.<br/>
</p>
<p>
<b>Version 1.0.4</b><br/>
- Little minor update<br/>
</p>
<p>
<b>Version 1.0.3</b><br/>
- Bugfix (Fixed bug where sometime setting the hailing to none, causes a problem)<br/>
</p>
<p>
<b>Version 1.0.2</b><br/>
- Added capability to set volume by passing a message msg.volume to the node<br/>
</p>
<p>
<b>Version 1.0.1</b><br/>
- Fixed very stupid mistake<br/>
</p>
<p>
<b>Version 1.0.0</b><br/>
- First public stable release<br/>
- Behavior changed: when Sonos is powered off or unreachable, the TTS texts will, now, not be queued anymore, otherwise when Sonos is powered on again, it plays all TTS texts at once.
</p>
<p>
<b>Version 0.0.25</b><br/>
- Added more hailing sounds<br/>
- If cannot create the temp dir (maybe for ACL), revert to the node dir.<br/>
- Aesthetics adjustments<br/>
</p>
<p>
<b>Version 0.0.24</b><br/>
- Bugfix: after 24 hours, the sonos event listener won't fires any event more.<br/>
</p>
<p>
<b>Version 0.0.23</b><br/>
- Bugfix: if the Sonos device is restarted, the node won't play TTS<br/>
- Bugfix: if the Sonos device was on LineIn, TVIn or so, the node won't play TTS<br/>
- Updated sonos API April 2018<br/>
- First stable beta release
<br/>
</p>
<p>
<b>Version 0.0.22</b><br/>
- Speed improvement<br/>
- Bugfix: if you manually change the volume via sonos App, the Node won't revert to the setted volume
<br/>
</p>
<p>
<b>Version 0.0.21</b><br/>
- Fix for too short text
<br/>
</p>
<p>
<b>Version 0.0.20</b><br/>
- Fixed handling long queues being stopped intermittently
<br/>
</p>
<p>
<b>Version 0.0.19</b><br/>
- Added direct play of files from url (http)
<br/>
</p>
<p>
<b>Version 0.0.15</b><br/>
- Polly download timeout bug fixes
<br/>
</p>
<p>
<b>Version 0.0.14</b><br/>
- Hailing bug fixes
<br/>
</p>
<p>
<b>Version 0.0.13</b><br/>
- Minor bug fixes
<br/>
</p>
<p>
<b>Version 0.0.11</b><br/>
- Hailing sound added. Before the first TTS message of the message queue, plays a file .mp3 to recall attention
<br/>
</p>
<p>
<b>Version 0.0.8</b><br/>
- Minor fixes
<br/>
</p>
<p>
<b>Version 0.0.6</b><br/>
- Stops music if a payload is received
<br/>
- Setting volume possible in the node configuration window
<br/>
- Better handling of the queue by using new sonos node apis.
<br/>
</p>
    
![Logo](https://raw.githubusercontent.com/Supergiovane/node-red-contrib-tts-ultimate/master/img/madeinitaly.png)