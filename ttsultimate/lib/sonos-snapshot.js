// Snapshot and restore of what a Sonos player was doing before an announcement.
//
// The snapshot reads the real transport source (GetMediaInfo CurrentURI + metadata) instead of
// guessing it from the current track, the same approach used by SoCo and node-sonos-http-api:
//   - music queue (x-rincon-queue:)        -> restore the queue, track number, position and play mode
//   - group member (x-rincon:<coordinator>) -> rejoin the coordinator (it plays on its own)
//   - anything else (radio, TV, line-in, single URLs) -> set the same URI and metadata again
// Playback restarts only if the player was playing.
// Spotify Connect / AirPlay sessions (x-sonos-vli:) belong to the phone app and can't be restored.

const SOURCE = {
    NONE: "none",
    QUEUE: "queue",
    GROUP_MEMBER: "groupmember",
    REMOTE_SESSION: "remotesession",
    ANNOUNCEMENT: "announcement",
    URI: "uri"
};

function sourceOf(uri) {
    if (!uri) return SOURCE.NONE;
    if (uri.startsWith("x-rincon-queue:")) return SOURCE.QUEUE;
    if (uri.startsWith("x-rincon:")) return SOURCE.GROUP_MEMBER;
    if (uri.startsWith("x-sonos-vli:")) return SOURCE.REMOTE_SESSION;
    // A TTS-Ultimate announcement still loaded on the player: nothing to give back.
    if (uri.indexOf("/tts/tts.mp3?f=") !== -1) return SOURCE.ANNOUNCEMENT;
    return SOURCE.URI;
}

function isValidRelTime(relTime) {
    return typeof relTime === "string" && /^\d+:\d{2}:\d{2}$/.test(relTime) && relTime !== "0:00:00";
}

async function takeSnapshot(sonos) {
    const media = await sonos._avTransport("GetMediaInfo", { InstanceID: 0 });
    const uri = typeof media.CurrentURI === "string" ? media.CurrentURI : "";
    const snapshot = {
        uri,
        metadata: typeof media.CurrentURIMetaData === "string" ? media.CurrentURIMetaData : "",
        source: sourceOf(uri),
        state: await sonos.getCurrentState()
    };
    if (snapshot.source === SOURCE.QUEUE) {
        const position = await sonos._avTransport("GetPositionInfo", { InstanceID: 0 });
        snapshot.track = parseInt(position.Track, 10) || 0;
        snapshot.relTime = position.RelTime;
        try {
            const settings = await sonos._avTransport("GetTransportSettings", { InstanceID: 0 });
            snapshot.playMode = settings.PlayMode;
        } catch (error) { /* play mode is a nice to have */ }
    }
    return snapshot;
}

function wasPlaying(snapshot) {
    return snapshot.state === "playing" || snapshot.state === "transitioning";
}

// Returns a short description of what was restored. Throws if the source can't be restored.
async function restoreSnapshot(sonos, snapshot, options) {
    const wait = (options && options.wait) || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const stepDelayMs = options && options.stepDelayMs !== undefined ? options.stepDelayMs : 500;
    if (!snapshot) return "nothing to resume";

    switch (snapshot.source) {
        case SOURCE.NONE:
        case SOURCE.ANNOUNCEMENT:
            return "nothing to resume";
        case SOURCE.REMOTE_SESSION:
            return "Spotify Connect / AirPlay sessions can't be resumed";
        case SOURCE.GROUP_MEMBER:
            await sonos.setAVTransportURI({ uri: snapshot.uri, metadata: snapshot.metadata, onlySetUri: true });
            return "group rejoined";
        case SOURCE.QUEUE: {
            await sonos.setAVTransportURI({ uri: snapshot.uri, metadata: snapshot.metadata, onlySetUri: true });
            if (snapshot.playMode) {
                try { await sonos._avTransport("SetPlayMode", { InstanceID: 0, NewPlayMode: snapshot.playMode }); } catch (error) { }
            }
            if (snapshot.track > 0) {
                await wait(stepDelayMs);
                await sonos.selectTrack(snapshot.track);
            }
            if (isValidRelTime(snapshot.relTime)) {
                await wait(stepDelayMs);
                // Not every track can seek (e.g. a radio station saved in the queue): keep going without it.
                try { await sonos._avTransport("Seek", { InstanceID: 0, Unit: "REL_TIME", Target: snapshot.relTime }); } catch (error) { }
            }
            if (wasPlaying(snapshot)) {
                await wait(stepDelayMs);
                await sonos.play();
                return "queue resumed";
            }
            return "queue restored (paused)";
        }
        default:
            await sonos.setAVTransportURI({ uri: snapshot.uri, metadata: snapshot.metadata, onlySetUri: true });
            if (wasPlaying(snapshot)) {
                await wait(stepDelayMs);
                await sonos.play();
                return "source resumed";
            }
            return "source restored (paused)";
    }
}

module.exports = { SOURCE, sourceOf, takeSnapshot, restoreSnapshot };
