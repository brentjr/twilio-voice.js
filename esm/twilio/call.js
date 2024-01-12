/**
 * @packageDocumentation
 * @module Voice
 * @publicapi
 * @internal
 */
import { EventEmitter } from 'events';
import Backoff from './backoff';
import Device from './device';
import { GeneralErrors, getPreciseSignalingErrorByCode, InvalidArgumentError, InvalidStateError, MediaErrors, SignalingErrors, UserMediaErrors, } from './errors';
import Log from './log';
import { PeerConnection } from './rtc';
import { IceCandidate } from './rtc/icecandidate';
import { getPreferredCodecInfo } from './rtc/sdp';
import StatsMonitor from './statsMonitor';
import { isChrome } from './util';
import { generateVoiceEventSid } from './uuid';
import { RELEASE_VERSION } from './constants';
const BACKOFF_CONFIG = {
    factor: 1.1,
    jitter: 0.5,
    max: 30000,
    min: 1,
};
const DTMF_INTER_TONE_GAP = 70;
const DTMF_PAUSE_DURATION = 500;
const DTMF_TONE_DURATION = 160;
const METRICS_BATCH_SIZE = 10;
const METRICS_DELAY = 5000;
const MEDIA_DISCONNECT_ERROR = {
    disconnect: true,
    info: {
        code: 31003,
        message: 'Connection with Twilio was interrupted.',
        twilioError: new MediaErrors.ConnectionError(),
    },
};
const MULTIPLE_THRESHOLD_WARNING_NAMES = {
    // The stat `packetsLostFraction` is monitored by two separate thresholds,
    // `maxAverage` and `max`. Each threshold emits a different warning name.
    packetsLostFraction: {
        max: 'packet-loss',
        maxAverage: 'packets-lost-fraction',
    },
};
const WARNING_NAMES = {
    audioInputLevel: 'audio-input-level',
    audioOutputLevel: 'audio-output-level',
    bytesReceived: 'bytes-received',
    bytesSent: 'bytes-sent',
    jitter: 'jitter',
    mos: 'mos',
    rtt: 'rtt',
};
const WARNING_PREFIXES = {
    max: 'high-',
    maxAverage: 'high-',
    maxDuration: 'constant-',
    min: 'low-',
    minStandardDeviation: 'constant-',
};
/**
 * A {@link Call} represents a media and signaling connection to a TwiML application.
 * @publicapi
 */
class Call extends EventEmitter {
    /**
     * @constructor
     * @private
     * @param config - Mandatory configuration options
     * @param [options] - Optional settings
     */
    constructor(config, options) {
        super();
        /**
         * Call parameters received from Twilio for an incoming call.
         */
        this.parameters = {};
        /**
         * The number of times input volume has been the same consecutively.
         */
        this._inputVolumeStreak = 0;
        /**
         * Whether the call has been answered.
         */
        this._isAnswered = false;
        /**
         * Whether the call has been cancelled.
         */
        this._isCancelled = false;
        /**
         * Whether the call has been rejected
         */
        this._isRejected = false;
        /**
         * The most recent public input volume value. 0 -> 1 representing -100 to -30 dB.
         */
        this._latestInputVolume = 0;
        /**
         * The most recent public output volume value. 0 -> 1 representing -100 to -30 dB.
         */
        this._latestOutputVolume = 0;
        /**
         * An instance of Logger to use.
         */
        this._log = new Log('Call');
        /**
         * State of the {@link Call}'s media.
         */
        this._mediaStatus = Call.State.Pending;
        /**
         * A map of messages sent via sendMessage API using voiceEventSid as the key.
         * The message will be deleted once an 'ack' or an error is received from the server.
         */
        this._messages = new Map();
        /**
         * A batch of metrics samples to send to Insights. Gets cleared after
         * each send and appended to on each new sample.
         */
        this._metricsSamples = [];
        /**
         * Options passed to this {@link Call}.
         */
        this._options = {
            MediaHandler: PeerConnection,
            enableImprovedSignalingErrorPrecision: false,
            offerSdp: null,
            shouldPlayDisconnect: () => true,
            voiceEventSidGenerator: generateVoiceEventSid,
        };
        /**
         * The number of times output volume has been the same consecutively.
         */
        this._outputVolumeStreak = 0;
        /**
         * Whether the {@link Call} should send a hangup on disconnect.
         */
        this._shouldSendHangup = true;
        /**
         * State of the {@link Call}'s signaling.
         */
        this._signalingStatus = Call.State.Pending;
        /**
         * A Map of Sounds to play.
         */
        this._soundcache = new Map();
        /**
         * State of the {@link Call}.
         */
        this._status = Call.State.Pending;
        /**
         * Whether the {@link Call} has been connected. Used to determine if we are reconnected.
         */
        this._wasConnected = false;
        /**
         * String representation of {@link Call} instance.
         * @private
         */
        this.toString = () => '[Twilio.Call instance]';
        this._emitWarning = (groupPrefix, warningName, threshold, value, wasCleared, warningData) => {
            const groupSuffix = wasCleared ? '-cleared' : '-raised';
            const groupName = `${groupPrefix}warning${groupSuffix}`;
            // Ignore constant input if the Call is muted (Expected)
            if (warningName === 'constant-audio-input-level' && this.isMuted()) {
                return;
            }
            let level = wasCleared ? 'info' : 'warning';
            // Avoid throwing false positives as warnings until we refactor volume metrics
            if (warningName === 'constant-audio-output-level') {
                level = 'info';
            }
            const payloadData = { threshold };
            if (value) {
                if (value instanceof Array) {
                    payloadData.values = value.map((val) => {
                        if (typeof val === 'number') {
                            return Math.round(val * 100) / 100;
                        }
                        return value;
                    });
                }
                else {
                    payloadData.value = value;
                }
            }
            this._publisher.post(level, groupName, warningName, { data: payloadData }, this);
            if (warningName !== 'constant-audio-output-level') {
                const emitName = wasCleared ? 'warning-cleared' : 'warning';
                this._log.debug(`#${emitName}`, warningName);
                this.emit(emitName, warningName, warningData && !wasCleared ? warningData : null);
            }
        };
        /**
         * Called when the {@link Call} receives an ack from signaling
         * @param payload
         */
        this._onAck = (payload) => {
            const { acktype, callsid, voiceeventsid } = payload;
            if (this.parameters.CallSid !== callsid) {
                this._log.warn(`Received ack from a different callsid: ${callsid}`);
                return;
            }
            if (acktype === 'message') {
                this._onMessageSent(voiceeventsid);
            }
        };
        /**
         * Called when the {@link Call} is answered.
         * @param payload
         */
        this._onAnswer = (payload) => {
            if (typeof payload.reconnect === 'string') {
                this._signalingReconnectToken = payload.reconnect;
            }
            // answerOnBridge=false will send a 183 which we need to catch in _onRinging when
            // the enableRingingState flag is disabled. In that case, we will receive a 200 after
            // the callee accepts the call firing a second `accept` event if we don't
            // short circuit here.
            if (this._isAnswered && this._status !== Call.State.Reconnecting) {
                return;
            }
            this._setCallSid(payload);
            this._isAnswered = true;
            this._maybeTransitionToOpen();
        };
        /**
         * Called when the {@link Call} is cancelled.
         * @param payload
         */
        this._onCancel = (payload) => {
            // (rrowland) Is this check necessary? Verify, and if so move to pstream / VSP module.
            const callsid = payload.callsid;
            if (this.parameters.CallSid === callsid) {
                this._isCancelled = true;
                this._publisher.info('connection', 'cancel', null, this);
                this._cleanupEventListeners();
                this._mediaHandler.close();
                this._status = Call.State.Closed;
                this._log.debug('#cancel');
                this.emit('cancel');
                this._pstream.removeListener('cancel', this._onCancel);
            }
        };
        /**
         * Called when we receive a connected event from pstream.
         * Re-emits the event.
         */
        this._onConnected = () => {
            this._log.info('Received connected from pstream');
            if (this._signalingReconnectToken && this._mediaHandler.version) {
                this._pstream.reconnect(this._mediaHandler.version.getSDP(), this.parameters.CallSid, this._signalingReconnectToken);
            }
        };
        /**
         * Called when the {@link Call} is hung up.
         * @param payload
         */
        this._onHangup = (payload) => {
            if (this.status() === Call.State.Closed) {
                return;
            }
            /**
             *  see if callsid passed in message matches either callsid or outbound id
             *  call should always have either callsid or outbound id
             *  if no callsid passed hangup anyways
             */
            if (payload.callsid && (this.parameters.CallSid || this.outboundConnectionId)) {
                if (payload.callsid !== this.parameters.CallSid
                    && payload.callsid !== this.outboundConnectionId) {
                    return;
                }
            }
            else if (payload.callsid) {
                // hangup is for another call
                return;
            }
            this._log.info('Received HANGUP from gateway');
            if (payload.error) {
                const code = payload.error.code;
                const errorConstructor = getPreciseSignalingErrorByCode(this._options.enableImprovedSignalingErrorPrecision, code);
                const error = typeof errorConstructor !== 'undefined'
                    ? new errorConstructor(payload.error.message)
                    : new GeneralErrors.ConnectionError('Error sent from gateway in HANGUP');
                this._log.error('Received an error from the gateway:', error);
                this._log.debug('#error', error);
                this.emit('error', error);
            }
            this._shouldSendHangup = false;
            this._publisher.info('connection', 'disconnected-by-remote', null, this);
            this._disconnect(null, true);
            this._cleanupEventListeners();
        };
        /**
         * Called when there is a media failure.
         * Manages all media-related states and takes action base on the states
         * @param type - Type of media failure
         */
        this._onMediaFailure = (type) => {
            const { ConnectionDisconnected, ConnectionFailed, IceGatheringFailed, LowBytes, } = Call.MediaFailure;
            // These types signifies the end of a single ICE cycle
            const isEndOfIceCycle = type === ConnectionFailed || type === IceGatheringFailed;
            // All browsers except chrome doesn't update pc.iceConnectionState and pc.connectionState
            // after issuing an ICE Restart, which we use to determine if ICE Restart is complete.
            // Since we cannot detect if ICE Restart is complete, we will not retry.
            if (!isChrome(window, window.navigator) && type === ConnectionFailed) {
                return this._mediaHandler.onerror(MEDIA_DISCONNECT_ERROR);
            }
            // Ignore subsequent requests if ice restart is in progress
            if (this._mediaStatus === Call.State.Reconnecting) {
                // This is a retry. Previous ICE Restart failed
                if (isEndOfIceCycle) {
                    // We already exceeded max retry time.
                    if (Date.now() - this._mediaReconnectStartTime > BACKOFF_CONFIG.max) {
                        this._log.warn('Exceeded max ICE retries');
                        return this._mediaHandler.onerror(MEDIA_DISCONNECT_ERROR);
                    }
                    // Issue ICE restart with backoff
                    try {
                        this._mediaReconnectBackoff.backoff();
                    }
                    catch (error) {
                        // Catch and ignore 'Backoff in progress.' errors. If a backoff is
                        // ongoing and we try to start another one, there shouldn't be a
                        // problem.
                        if (!(error.message && error.message === 'Backoff in progress.')) {
                            throw error;
                        }
                    }
                }
                return;
            }
            const pc = this._mediaHandler.version.pc;
            const isIceDisconnected = pc && pc.iceConnectionState === 'disconnected';
            const hasLowBytesWarning = this._monitor.hasActiveWarning('bytesSent', 'min')
                || this._monitor.hasActiveWarning('bytesReceived', 'min');
            // Only certain conditions can trigger media reconnection
            if ((type === LowBytes && isIceDisconnected)
                || (type === ConnectionDisconnected && hasLowBytesWarning)
                || isEndOfIceCycle) {
                const mediaReconnectionError = new MediaErrors.ConnectionError('Media connection failed.');
                this._log.warn('ICE Connection disconnected.');
                this._publisher.warn('connection', 'error', mediaReconnectionError, this);
                this._publisher.info('connection', 'reconnecting', null, this);
                this._mediaReconnectStartTime = Date.now();
                this._status = Call.State.Reconnecting;
                this._mediaStatus = Call.State.Reconnecting;
                this._mediaReconnectBackoff.reset();
                this._mediaReconnectBackoff.backoff();
                this._log.debug('#reconnecting');
                this.emit('reconnecting', mediaReconnectionError);
            }
        };
        /**
         * Called when media call is restored
         */
        this._onMediaReconnected = () => {
            // Only trigger once.
            // This can trigger on pc.onIceConnectionChange and pc.onConnectionChange.
            if (this._mediaStatus !== Call.State.Reconnecting) {
                return;
            }
            this._log.info('ICE Connection reestablished.');
            this._mediaStatus = Call.State.Open;
            if (this._signalingStatus === Call.State.Open) {
                this._publisher.info('connection', 'reconnected', null, this);
                this._log.debug('#reconnected');
                this.emit('reconnected');
                this._status = Call.State.Open;
            }
        };
        /**
         * Raised when a Call receives a message from the backend.
         * @param payload - A record representing the payload of the message from the
         * Twilio backend.
         */
        this._onMessageReceived = (payload) => {
            const { callsid, content, contenttype, messagetype, voiceeventsid } = payload;
            if (this.parameters.CallSid !== callsid) {
                this._log.warn(`Received a message from a different callsid: ${callsid}`);
                return;
            }
            const data = {
                content,
                contentType: contenttype,
                messageType: messagetype,
                voiceEventSid: voiceeventsid,
            };
            this._log.debug('#messageReceived', JSON.stringify(data));
            this.emit('messageReceived', data);
        };
        /**
         * Raised when a Call receives an 'ack' with an 'acktype' of 'message.
         * This means that the message sent via sendMessage API has been received by the signaling server.
         * @param voiceEventSid
         */
        this._onMessageSent = (voiceEventSid) => {
            if (!this._messages.has(voiceEventSid)) {
                this._log.warn(`Received a messageSent with a voiceEventSid that doesn't exists: ${voiceEventSid}`);
                return;
            }
            const message = this._messages.get(voiceEventSid);
            this._messages.delete(voiceEventSid);
            this._log.debug('#messageSent', JSON.stringify(message));
            this.emit('messageSent', message);
        };
        /**
         * When we get a RINGING signal from PStream, update the {@link Call} status.
         * @param payload
         */
        this._onRinging = (payload) => {
            this._setCallSid(payload);
            // If we're not in 'connecting' or 'ringing' state, this event was received out of order.
            if (this._status !== Call.State.Connecting && this._status !== Call.State.Ringing) {
                return;
            }
            const hasEarlyMedia = !!payload.sdp;
            this._status = Call.State.Ringing;
            this._publisher.info('connection', 'outgoing-ringing', { hasEarlyMedia }, this);
            this._log.debug('#ringing');
            this.emit('ringing', hasEarlyMedia);
        };
        /**
         * Called each time StatsMonitor emits a sample.
         * Emits stats event and batches the call stats metrics and sends them to Insights.
         * @param sample
         */
        this._onRTCSample = (sample) => {
            const callMetrics = Object.assign(Object.assign({}, sample), { inputVolume: this._latestInputVolume, outputVolume: this._latestOutputVolume });
            this._codec = callMetrics.codecName;
            this._metricsSamples.push(callMetrics);
            if (this._metricsSamples.length >= METRICS_BATCH_SIZE) {
                this._publishMetrics();
            }
            this.emit('sample', sample);
        };
        /**
         * Called when an 'error' event is received from the signaling stream.
         */
        this._onSignalingError = (payload) => {
            const { callsid, voiceeventsid } = payload;
            if (this.parameters.CallSid !== callsid) {
                this._log.warn(`Received an error from a different callsid: ${callsid}`);
                return;
            }
            if (voiceeventsid && this._messages.has(voiceeventsid)) {
                // Do not emit an error here. Device is handling all signaling related errors.
                this._messages.delete(voiceeventsid);
                this._log.warn(`Received an error while sending a message.`, payload);
            }
        };
        /**
         * Called when signaling is restored
         */
        this._onSignalingReconnected = () => {
            if (this._signalingStatus !== Call.State.Reconnecting) {
                return;
            }
            this._log.info('Signaling Connection reestablished.');
            this._signalingStatus = Call.State.Open;
            if (this._mediaStatus === Call.State.Open) {
                this._publisher.info('connection', 'reconnected', null, this);
                this._log.debug('#reconnected');
                this.emit('reconnected');
                this._status = Call.State.Open;
            }
        };
        /**
         * Called when we receive a transportClose event from pstream.
         * Re-emits the event.
         */
        this._onTransportClose = () => {
            this._log.error('Received transportClose from pstream');
            this._log.debug('#transportClose');
            this.emit('transportClose');
            if (this._signalingReconnectToken) {
                this._status = Call.State.Reconnecting;
                this._signalingStatus = Call.State.Reconnecting;
                this._log.debug('#reconnecting');
                this.emit('reconnecting', new SignalingErrors.ConnectionDisconnected());
            }
            else {
                this._status = Call.State.Closed;
                this._signalingStatus = Call.State.Closed;
            }
        };
        /**
         * Re-emit an StatsMonitor warning as a {@link Call}.warning or .warning-cleared event.
         * @param warningData
         * @param wasCleared - Whether this is a -cleared or -raised event.
         */
        this._reemitWarning = (warningData, wasCleared) => {
            const groupPrefix = /^audio/.test(warningData.name) ?
                'audio-level-' : 'network-quality-';
            const warningPrefix = WARNING_PREFIXES[warningData.threshold.name];
            /**
             * NOTE: There are two "packet-loss" warnings: `high-packet-loss` and
             * `high-packets-lost-fraction`, so in this case we need to use a different
             * `WARNING_NAME` mapping.
             */
            let warningName;
            if (warningData.name in MULTIPLE_THRESHOLD_WARNING_NAMES) {
                warningName = MULTIPLE_THRESHOLD_WARNING_NAMES[warningData.name][warningData.threshold.name];
            }
            else if (warningData.name in WARNING_NAMES) {
                warningName = WARNING_NAMES[warningData.name];
            }
            const warning = warningPrefix + warningName;
            this._emitWarning(groupPrefix, warning, warningData.threshold.value, warningData.values || warningData.value, wasCleared, warningData);
        };
        /**
         * Re-emit an StatsMonitor warning-cleared as a .warning-cleared event.
         * @param warningData
         */
        this._reemitWarningCleared = (warningData) => {
            this._reemitWarning(warningData, true);
        };
        this._isUnifiedPlanDefault = config.isUnifiedPlanDefault;
        this._soundcache = config.soundcache;
        if (typeof config.onIgnore === 'function') {
            this._onIgnore = config.onIgnore;
        }
        const message = options && options.twimlParams || {};
        this.customParameters = new Map(Object.entries(message).map(([key, val]) => [key, String(val)]));
        Object.assign(this._options, options);
        if (this._options.callParameters) {
            this.parameters = this._options.callParameters;
        }
        if (this._options.reconnectToken) {
            this._signalingReconnectToken = this._options.reconnectToken;
        }
        this._voiceEventSidGenerator =
            this._options.voiceEventSidGenerator || generateVoiceEventSid;
        this._direction = this.parameters.CallSid ? Call.CallDirection.Incoming : Call.CallDirection.Outgoing;
        if (this._direction === Call.CallDirection.Incoming && this.parameters) {
            this.callerInfo = this.parameters.StirStatus
                ? { isVerified: this.parameters.StirStatus === 'TN-Validation-Passed-A' }
                : null;
        }
        else {
            this.callerInfo = null;
        }
        this._mediaReconnectBackoff = new Backoff(BACKOFF_CONFIG);
        this._mediaReconnectBackoff.on('ready', () => this._mediaHandler.iceRestart());
        // temporary call sid to be used for outgoing calls
        this.outboundConnectionId = generateTempCallSid();
        const publisher = this._publisher = config.publisher;
        if (this._direction === Call.CallDirection.Incoming) {
            publisher.info('connection', 'incoming', null, this);
        }
        else {
            publisher.info('connection', 'outgoing', { preflight: this._options.preflight }, this);
        }
        const monitor = this._monitor = new (this._options.StatsMonitor || StatsMonitor)();
        monitor.on('sample', this._onRTCSample);
        // First 20 seconds or so are choppy, so let's not bother with these warnings.
        monitor.disableWarnings();
        setTimeout(() => monitor.enableWarnings(), METRICS_DELAY);
        monitor.on('warning', (data, wasCleared) => {
            if (data.name === 'bytesSent' || data.name === 'bytesReceived') {
                this._onMediaFailure(Call.MediaFailure.LowBytes);
            }
            this._reemitWarning(data, wasCleared);
        });
        monitor.on('warning-cleared', (data) => {
            this._reemitWarningCleared(data);
        });
        this._mediaHandler = new (this._options.MediaHandler)(config.audioHelper, config.pstream, {
            RTCPeerConnection: this._options.RTCPeerConnection,
            codecPreferences: this._options.codecPreferences,
            dscp: this._options.dscp,
            forceAggressiveIceNomination: this._options.forceAggressiveIceNomination,
            isUnifiedPlan: this._isUnifiedPlanDefault,
            maxAverageBitrate: this._options.maxAverageBitrate,
            preflight: this._options.preflight,
        });
        this.on('volume', (inputVolume, outputVolume) => {
            this._inputVolumeStreak = this._checkVolume(inputVolume, this._inputVolumeStreak, this._latestInputVolume, 'input');
            this._outputVolumeStreak = this._checkVolume(outputVolume, this._outputVolumeStreak, this._latestOutputVolume, 'output');
            this._latestInputVolume = inputVolume;
            this._latestOutputVolume = outputVolume;
        });
        this._mediaHandler.onaudio = (remoteAudio) => {
            this._log.debug('#audio');
            this.emit('audio', remoteAudio);
        };
        this._mediaHandler.onvolume = (inputVolume, outputVolume, internalInputVolume, internalOutputVolume) => {
            // (rrowland) These values mock the 0 -> 32767 format used by legacy getStats. We should look into
            // migrating to a newer standard, either 0.0 -> linear or -127 to 0 in dB, matching the range
            // chosen below.
            monitor.addVolumes((internalInputVolume / 255) * 32767, (internalOutputVolume / 255) * 32767);
            // (rrowland) 0.0 -> 1.0 linear
            this.emit('volume', inputVolume, outputVolume);
        };
        this._mediaHandler.ondtlstransportstatechange = (state) => {
            const level = state === 'failed' ? 'error' : 'debug';
            this._publisher.post(level, 'dtls-transport-state', state, null, this);
        };
        this._mediaHandler.onpcconnectionstatechange = (state) => {
            let level = 'debug';
            const dtlsTransport = this._mediaHandler.getRTCDtlsTransport();
            if (state === 'failed') {
                level = dtlsTransport && dtlsTransport.state === 'failed' ? 'error' : 'warning';
            }
            this._publisher.post(level, 'pc-connection-state', state, null, this);
        };
        this._mediaHandler.onicecandidate = (candidate) => {
            const payload = new IceCandidate(candidate).toPayload();
            this._publisher.debug('ice-candidate', 'ice-candidate', payload, this);
        };
        this._mediaHandler.onselectedcandidatepairchange = (pair) => {
            const localCandidatePayload = new IceCandidate(pair.local).toPayload();
            const remoteCandidatePayload = new IceCandidate(pair.remote, true).toPayload();
            this._publisher.debug('ice-candidate', 'selected-ice-candidate-pair', {
                local_candidate: localCandidatePayload,
                remote_candidate: remoteCandidatePayload,
            }, this);
        };
        this._mediaHandler.oniceconnectionstatechange = (state) => {
            const level = state === 'failed' ? 'error' : 'debug';
            this._publisher.post(level, 'ice-connection-state', state, null, this);
        };
        this._mediaHandler.onicegatheringfailure = (type) => {
            this._publisher.warn('ice-gathering-state', type, null, this);
            this._onMediaFailure(Call.MediaFailure.IceGatheringFailed);
        };
        this._mediaHandler.onicegatheringstatechange = (state) => {
            this._publisher.debug('ice-gathering-state', state, null, this);
        };
        this._mediaHandler.onsignalingstatechange = (state) => {
            this._publisher.debug('signaling-state', state, null, this);
        };
        this._mediaHandler.ondisconnected = (msg) => {
            this._log.warn(msg);
            this._publisher.warn('network-quality-warning-raised', 'ice-connectivity-lost', {
                message: msg,
            }, this);
            this._log.debug('#warning', 'ice-connectivity-lost');
            this.emit('warning', 'ice-connectivity-lost');
            this._onMediaFailure(Call.MediaFailure.ConnectionDisconnected);
        };
        this._mediaHandler.onfailed = (msg) => {
            this._onMediaFailure(Call.MediaFailure.ConnectionFailed);
        };
        this._mediaHandler.onconnected = () => {
            // First time _mediaHandler is connected, but ICE Gathering issued an ICE restart and succeeded.
            if (this._status === Call.State.Reconnecting) {
                this._onMediaReconnected();
            }
        };
        this._mediaHandler.onreconnected = (msg) => {
            this._log.info(msg);
            this._publisher.info('network-quality-warning-cleared', 'ice-connectivity-lost', {
                message: msg,
            }, this);
            this._log.debug('#warning-cleared', 'ice-connectivity-lost');
            this.emit('warning-cleared', 'ice-connectivity-lost');
            this._onMediaReconnected();
        };
        this._mediaHandler.onerror = (e) => {
            if (e.disconnect === true) {
                this._disconnect(e.info && e.info.message);
            }
            const error = e.info.twilioError || new GeneralErrors.UnknownError(e.info.message);
            this._log.error('Received an error from MediaStream:', e);
            this._log.debug('#error', error);
            this.emit('error', error);
        };
        this._mediaHandler.onopen = () => {
            // NOTE(mroberts): While this may have been happening in previous
            // versions of Chrome, since Chrome 45 we have seen the
            // PeerConnection's onsignalingstatechange handler invoked multiple
            // times in the same signalingState 'stable'. When this happens, we
            // invoke this onopen function. If we invoke it twice without checking
            // for _status 'open', we'd accidentally close the PeerConnection.
            //
            // See <https://code.google.com/p/webrtc/issues/detail?id=4996>.
            if (this._status === Call.State.Open || this._status === Call.State.Reconnecting) {
                return;
            }
            else if (this._status === Call.State.Ringing || this._status === Call.State.Connecting) {
                this.mute(this._mediaHandler.isMuted);
                this._mediaStatus = Call.State.Open;
                this._maybeTransitionToOpen();
            }
            else {
                // call was probably canceled sometime before this
                this._mediaHandler.close();
            }
        };
        this._mediaHandler.onclose = () => {
            this._status = Call.State.Closed;
            if (this._options.shouldPlayDisconnect && this._options.shouldPlayDisconnect()
                // Don't play disconnect sound if this was from a cancel event. i.e. the call
                // was ignored or hung up even before it was answered.
                // Similarly, don't play disconnect sound if the call was rejected.
                && !this._isCancelled && !this._isRejected) {
                this._soundcache.get(Device.SoundName.Disconnect).play();
            }
            monitor.disable();
            this._publishMetrics();
            if (!this._isCancelled && !this._isRejected) {
                // tslint:disable no-console
                this._log.debug('#disconnect');
                this.emit('disconnect', this);
            }
        };
        this._pstream = config.pstream;
        this._pstream.on('ack', this._onAck);
        this._pstream.on('cancel', this._onCancel);
        this._pstream.on('error', this._onSignalingError);
        this._pstream.on('ringing', this._onRinging);
        this._pstream.on('transportClose', this._onTransportClose);
        this._pstream.on('connected', this._onConnected);
        this._pstream.on('message', this._onMessageReceived);
        this.on('error', error => {
            this._publisher.error('connection', 'error', {
                code: error.code, message: error.message,
            }, this);
            if (this._pstream && this._pstream.status === 'disconnected') {
                this._cleanupEventListeners();
            }
        });
        this.on('disconnect', () => {
            this._cleanupEventListeners();
        });
    }
    /**
     * Whether this {@link Call} is incoming or outgoing.
     */
    get direction() {
        return this._direction;
    }
    /**
     * Audio codec used for this {@link Call}. Expecting {@link Call.Codec} but
     * will copy whatever we get from RTC stats.
     */
    get codec() {
        return this._codec;
    }
    /**
     * Set the audio input tracks from a given stream.
     * @param stream
     * @private
     */
    _setInputTracksFromStream(stream) {
        return this._mediaHandler.setInputTracksFromStream(stream);
    }
    /**
     * Set the audio output sink IDs.
     * @param sinkIds
     * @private
     */
    _setSinkIds(sinkIds) {
        return this._mediaHandler._setSinkIds(sinkIds);
    }
    /**
     * Accept the incoming {@link Call}.
     * @param [options]
     */
    accept(options) {
        if (this._status !== Call.State.Pending) {
            return;
        }
        this._log.debug('.accept', options);
        options = options || {};
        const rtcConfiguration = options.rtcConfiguration || this._options.rtcConfiguration;
        const rtcConstraints = options.rtcConstraints || this._options.rtcConstraints || {};
        const audioConstraints = rtcConstraints.audio || { audio: true };
        this._status = Call.State.Connecting;
        const connect = () => {
            if (this._status !== Call.State.Connecting) {
                // call must have been canceled
                this._cleanupEventListeners();
                this._mediaHandler.close();
                return;
            }
            const onAnswer = (pc, reconnectToken) => {
                // Report that the call was answered, and directionality
                const eventName = this._direction === Call.CallDirection.Incoming
                    ? 'accepted-by-local'
                    : 'accepted-by-remote';
                this._publisher.info('connection', eventName, null, this);
                if (typeof reconnectToken === 'string') {
                    this._signalingReconnectToken = reconnectToken;
                }
                // Report the preferred codec and params as they appear in the SDP
                const { codecName, codecParams } = getPreferredCodecInfo(this._mediaHandler.version.getSDP());
                this._publisher.info('settings', 'codec', {
                    codec_params: codecParams,
                    selected_codec: codecName,
                }, this);
                // Enable RTC monitoring
                this._monitor.enable(pc);
            };
            const sinkIds = typeof this._options.getSinkIds === 'function' && this._options.getSinkIds();
            if (Array.isArray(sinkIds)) {
                this._mediaHandler._setSinkIds(sinkIds).catch(() => {
                    // (rrowland) We don't want this to throw to console since the customer
                    // can't control this. This will most commonly be rejected on browsers
                    // that don't support setting sink IDs.
                });
            }
            this._pstream.addListener('hangup', this._onHangup);
            if (this._direction === Call.CallDirection.Incoming) {
                this._isAnswered = true;
                this._pstream.on('answer', this._onAnswer);
                this._mediaHandler.answerIncomingCall(this.parameters.CallSid, this._options.offerSdp, rtcConstraints, rtcConfiguration, onAnswer);
            }
            else {
                const params = Array.from(this.customParameters.entries()).map(pair => `${encodeURIComponent(pair[0])}=${encodeURIComponent(pair[1])}`).join('&');
                this._pstream.on('answer', this._onAnswer);
                this._mediaHandler.makeOutgoingCall(this._pstream.token, params, this.outboundConnectionId, rtcConstraints, rtcConfiguration, onAnswer);
            }
        };
        if (this._options.beforeAccept) {
            this._options.beforeAccept(this);
        }
        const inputStream = typeof this._options.getInputStream === 'function' && this._options.getInputStream();
        const promise = inputStream
            ? this._mediaHandler.setInputTracksFromStream(inputStream)
            : this._mediaHandler.openDefaultDeviceWithConstraints(audioConstraints);
        promise.then(() => {
            this._publisher.info('get-user-media', 'succeeded', {
                data: { audioConstraints },
            }, this);
            if (this._options.onGetUserMedia) {
                this._options.onGetUserMedia();
            }
            connect();
        }, (error) => {
            let twilioError;
            if (error.code === 31208
                || ['PermissionDeniedError', 'NotAllowedError'].indexOf(error.name) !== -1) {
                twilioError = new UserMediaErrors.PermissionDeniedError();
                this._publisher.error('get-user-media', 'denied', {
                    data: {
                        audioConstraints,
                        error,
                    },
                }, this);
            }
            else {
                twilioError = new UserMediaErrors.AcquisitionFailedError();
                this._publisher.error('get-user-media', 'failed', {
                    data: {
                        audioConstraints,
                        error,
                    },
                }, this);
            }
            this._disconnect();
            this._log.debug('#error', error);
            this.emit('error', twilioError);
        });
    }
    /**
     * Disconnect from the {@link Call}.
     */
    disconnect() {
        this._log.debug('.disconnect');
        this._disconnect();
    }
    /**
     * Get the local MediaStream, if set.
     */
    getLocalStream() {
        return this._mediaHandler && this._mediaHandler.stream;
    }
    /**
     * Get the remote MediaStream, if set.
     */
    getRemoteStream() {
        return this._mediaHandler && this._mediaHandler._remoteStream;
    }
    /**
     * Ignore the incoming {@link Call}.
     */
    ignore() {
        if (this._status !== Call.State.Pending) {
            return;
        }
        this._log.debug('.ignore');
        this._status = Call.State.Closed;
        this._mediaHandler.ignore(this.parameters.CallSid);
        this._publisher.info('connection', 'ignored-by-local', null, this);
        if (this._onIgnore) {
            this._onIgnore();
        }
    }
    /**
     * Check whether call is muted
     */
    isMuted() {
        return this._mediaHandler.isMuted;
    }
    /**
     * Mute incoming audio.
     * @param shouldMute - Whether the incoming audio should be muted. Defaults to true.
     */
    mute(shouldMute = true) {
        this._log.debug('.mute', shouldMute);
        const wasMuted = this._mediaHandler.isMuted;
        this._mediaHandler.mute(shouldMute);
        const isMuted = this._mediaHandler.isMuted;
        if (wasMuted !== isMuted) {
            this._publisher.info('connection', isMuted ? 'muted' : 'unmuted', null, this);
            this._log.debug('#mute', isMuted);
            this.emit('mute', isMuted, this);
        }
    }
    /**
     * Post an event to Endpoint Analytics indicating that the end user
     *   has given call quality feedback. Called without a score, this
     *   will report that the customer declined to give feedback.
     * @param score - The end-user's rating of the call; an
     *   integer 1 through 5. Or undefined if the user declined to give
     *   feedback.
     * @param issue - The primary issue the end user
     *   experienced on the call. Can be: ['one-way-audio', 'choppy-audio',
     *   'dropped-call', 'audio-latency', 'noisy-call', 'echo']
     */
    postFeedback(score, issue) {
        if (typeof score === 'undefined' || score === null) {
            return this._postFeedbackDeclined();
        }
        if (!Object.values(Call.FeedbackScore).includes(score)) {
            throw new InvalidArgumentError(`Feedback score must be one of: ${Object.values(Call.FeedbackScore)}`);
        }
        if (typeof issue !== 'undefined' && issue !== null && !Object.values(Call.FeedbackIssue).includes(issue)) {
            throw new InvalidArgumentError(`Feedback issue must be one of: ${Object.values(Call.FeedbackIssue)}`);
        }
        return this._publisher.info('feedback', 'received', {
            issue_name: issue,
            quality_score: score,
        }, this, true);
    }
    /**
     * Reject the incoming {@link Call}.
     */
    reject() {
        if (this._status !== Call.State.Pending) {
            return;
        }
        this._log.debug('.reject');
        this._isRejected = true;
        this._pstream.reject(this.parameters.CallSid);
        this._mediaHandler.reject(this.parameters.CallSid);
        this._publisher.info('connection', 'rejected-by-local', null, this);
        this._cleanupEventListeners();
        this._mediaHandler.close();
        this._status = Call.State.Closed;
        this._log.debug('#reject');
        this.emit('reject');
    }
    /**
     * Send a string of digits.
     * @param digits
     */
    sendDigits(digits) {
        this._log.debug('.sendDigits', digits);
        if (digits.match(/[^0-9*#w]/)) {
            throw new InvalidArgumentError('Illegal character passed into sendDigits');
        }
        const customSounds = this._options.customSounds || {};
        const sequence = [];
        digits.split('').forEach((digit) => {
            let dtmf = (digit !== 'w') ? `dtmf${digit}` : '';
            if (dtmf === 'dtmf*') {
                dtmf = 'dtmfs';
            }
            if (dtmf === 'dtmf#') {
                dtmf = 'dtmfh';
            }
            sequence.push(dtmf);
        });
        const playNextDigit = () => {
            const digit = sequence.shift();
            if (digit) {
                if (this._options.dialtonePlayer && !customSounds[digit]) {
                    this._options.dialtonePlayer.play(digit);
                }
                else {
                    this._soundcache.get(digit).play();
                }
            }
            if (sequence.length) {
                setTimeout(() => playNextDigit(), 200);
            }
        };
        playNextDigit();
        const dtmfSender = this._mediaHandler.getOrCreateDTMFSender();
        function insertDTMF(dtmfs) {
            if (!dtmfs.length) {
                return;
            }
            const dtmf = dtmfs.shift();
            if (dtmf && dtmf.length) {
                dtmfSender.insertDTMF(dtmf, DTMF_TONE_DURATION, DTMF_INTER_TONE_GAP);
            }
            setTimeout(insertDTMF.bind(null, dtmfs), DTMF_PAUSE_DURATION);
        }
        if (dtmfSender) {
            if (!('canInsertDTMF' in dtmfSender) || dtmfSender.canInsertDTMF) {
                this._log.info('Sending digits using RTCDTMFSender');
                // NOTE(mroberts): We can't just map 'w' to ',' since
                // RTCDTMFSender's pause duration is 2 s and Twilio's is more
                // like 500 ms. Instead, we will fudge it with setTimeout.
                insertDTMF(digits.split('w'));
                return;
            }
            this._log.info('RTCDTMFSender cannot insert DTMF');
        }
        // send pstream message to send DTMF
        this._log.info('Sending digits over PStream');
        if (this._pstream !== null && this._pstream.status !== 'disconnected') {
            this._pstream.dtmf(this.parameters.CallSid, digits);
        }
        else {
            const error = new GeneralErrors.ConnectionError('Could not send DTMF: Signaling channel is disconnected');
            this._log.debug('#error', error);
            this.emit('error', error);
        }
    }
    /**
     * Send a message to Twilio. Your backend application can listen for these
     * messages to allow communication between your frontend and backend applications.
     * <br/><br/>This feature is currently in Beta.
     * @param message - The message object to send.
     * @returns A voice event sid that uniquely identifies the message that was sent.
     */
    sendMessage(message) {
        this._log.debug('.sendMessage', JSON.stringify(message));
        const { content, contentType, messageType } = message;
        if (typeof content === 'undefined' || content === null) {
            throw new InvalidArgumentError('`content` is empty');
        }
        if (typeof messageType !== 'string') {
            throw new InvalidArgumentError('`messageType` must be an enumeration value of `Call.MessageType` or ' +
                'a string.');
        }
        if (messageType.length === 0) {
            throw new InvalidArgumentError('`messageType` must be a non-empty string.');
        }
        if (this._pstream === null) {
            throw new InvalidStateError('Could not send CallMessage; Signaling channel is disconnected');
        }
        const callSid = this.parameters.CallSid;
        if (typeof this.parameters.CallSid === 'undefined') {
            throw new InvalidStateError('Could not send CallMessage; Call has no CallSid');
        }
        const voiceEventSid = this._voiceEventSidGenerator();
        this._messages.set(voiceEventSid, { content, contentType, messageType, voiceEventSid });
        this._pstream.sendMessage(callSid, content, contentType, messageType, voiceEventSid);
        return voiceEventSid;
    }
    /**
     * Get the current {@link Call} status.
     */
    status() {
        return this._status;
    }
    /**
     * Check the volume passed, emitting a warning if one way audio is detected or cleared.
     * @param currentVolume - The current volume for this direction
     * @param streakFieldName - The name of the field on the {@link Call} object that tracks how many times the
     *   current value has been repeated consecutively.
     * @param lastValueFieldName - The name of the field on the {@link Call} object that tracks the most recent
     *   volume for this direction
     * @param direction - The directionality of this audio track, either 'input' or 'output'
     * @returns The current streak; how many times in a row the same value has been polled.
     */
    _checkVolume(currentVolume, currentStreak, lastValue, direction) {
        const wasWarningRaised = currentStreak >= 10;
        let newStreak = 0;
        if (lastValue === currentVolume) {
            newStreak = currentStreak;
        }
        if (newStreak >= 10) {
            this._emitWarning('audio-level-', `constant-audio-${direction}-level`, 10, newStreak, false);
        }
        else if (wasWarningRaised) {
            this._emitWarning('audio-level-', `constant-audio-${direction}-level`, 10, newStreak, true);
        }
        return newStreak;
    }
    /**
     * Clean up event listeners.
     */
    _cleanupEventListeners() {
        const cleanup = () => {
            if (!this._pstream) {
                return;
            }
            this._pstream.removeListener('ack', this._onAck);
            this._pstream.removeListener('answer', this._onAnswer);
            this._pstream.removeListener('cancel', this._onCancel);
            this._pstream.removeListener('error', this._onSignalingError);
            this._pstream.removeListener('hangup', this._onHangup);
            this._pstream.removeListener('ringing', this._onRinging);
            this._pstream.removeListener('transportClose', this._onTransportClose);
            this._pstream.removeListener('connected', this._onConnected);
            this._pstream.removeListener('message', this._onMessageReceived);
        };
        // This is kind of a hack, but it lets us avoid rewriting more code.
        // Basically, there's a sequencing problem with the way PeerConnection raises
        // the
        //
        //   Cannot establish call. SDK is disconnected
        //
        // error in Call#accept. It calls PeerConnection#onerror, which emits
        // the error event on Call. An error handler on Call then calls
        // cleanupEventListeners, but then control returns to Call#accept. It's
        // at this point that we add a listener for the answer event that never gets
        // removed. setTimeout will allow us to rerun cleanup again, _after_
        // Call#accept returns.
        cleanup();
        setTimeout(cleanup, 0);
    }
    /**
     * Create the payload wrapper for a batch of metrics to be sent to Insights.
     */
    _createMetricPayload() {
        const payload = {
            call_sid: this.parameters.CallSid,
            dscp: !!this._options.dscp,
            sdk_version: RELEASE_VERSION,
        };
        if (this._options.gateway) {
            payload.gateway = this._options.gateway;
        }
        payload.direction = this._direction;
        return payload;
    }
    /**
     * Disconnect the {@link Call}.
     * @param message - A message explaining why the {@link Call} is being disconnected.
     * @param wasRemote - Whether the disconnect was triggered locally or remotely.
     */
    _disconnect(message, wasRemote) {
        message = typeof message === 'string' ? message : null;
        if (this._status !== Call.State.Open
            && this._status !== Call.State.Connecting
            && this._status !== Call.State.Reconnecting
            && this._status !== Call.State.Ringing) {
            return;
        }
        this._log.info('Disconnecting...');
        // send pstream hangup message
        if (this._pstream !== null && this._pstream.status !== 'disconnected' && this._shouldSendHangup) {
            const callsid = this.parameters.CallSid || this.outboundConnectionId;
            if (callsid) {
                this._pstream.hangup(callsid, message);
            }
        }
        this._cleanupEventListeners();
        this._mediaHandler.close();
        if (!wasRemote) {
            this._publisher.info('connection', 'disconnected-by-local', null, this);
        }
    }
    /**
     * Transition to {@link CallStatus.Open} if criteria is met.
     */
    _maybeTransitionToOpen() {
        const wasConnected = this._wasConnected;
        if (this._isAnswered) {
            this._onSignalingReconnected();
            this._signalingStatus = Call.State.Open;
            if (this._mediaHandler && this._mediaHandler.status === 'open') {
                this._status = Call.State.Open;
                if (!this._wasConnected) {
                    this._wasConnected = true;
                    this._log.debug('#accept');
                    this.emit('accept', this);
                }
            }
        }
    }
    /**
     * Post an event to Endpoint Analytics indicating that the end user
     *   has ignored a request for feedback.
     */
    _postFeedbackDeclined() {
        return this._publisher.info('feedback', 'received-none', null, this, true);
    }
    /**
     * Publish the current set of queued metrics samples to Insights.
     */
    _publishMetrics() {
        if (this._metricsSamples.length === 0) {
            return;
        }
        this._publisher.postMetrics('quality-metrics-samples', 'metrics-sample', this._metricsSamples.splice(0), this._createMetricPayload(), this).catch((e) => {
            this._log.warn('Unable to post metrics to Insights. Received error:', e);
        });
    }
    /**
     * Set the CallSid
     * @param payload
     */
    _setCallSid(payload) {
        const callSid = payload.callsid;
        if (!callSid) {
            return;
        }
        this.parameters.CallSid = callSid;
        this._mediaHandler.callSid = callSid;
    }
}
/**
 * String representation of the {@link Call} class.
 * @private
 */
Call.toString = () => '[Twilio.Call class]';
(function (Call) {
    /**
     * Possible states of the {@link Call}.
     */
    let State;
    (function (State) {
        State["Closed"] = "closed";
        State["Connecting"] = "connecting";
        State["Open"] = "open";
        State["Pending"] = "pending";
        State["Reconnecting"] = "reconnecting";
        State["Ringing"] = "ringing";
    })(State = Call.State || (Call.State = {}));
    /**
     * Different issues that may have been experienced during a call, that can be
     * reported to Twilio Insights via {@link Call}.postFeedback().
     */
    let FeedbackIssue;
    (function (FeedbackIssue) {
        FeedbackIssue["AudioLatency"] = "audio-latency";
        FeedbackIssue["ChoppyAudio"] = "choppy-audio";
        FeedbackIssue["DroppedCall"] = "dropped-call";
        FeedbackIssue["Echo"] = "echo";
        FeedbackIssue["NoisyCall"] = "noisy-call";
        FeedbackIssue["OneWayAudio"] = "one-way-audio";
    })(FeedbackIssue = Call.FeedbackIssue || (Call.FeedbackIssue = {}));
    /**
     * A rating of call quality experienced during a call, to be reported to Twilio Insights
     * via {@link Call}.postFeedback().
     */
    let FeedbackScore;
    (function (FeedbackScore) {
        FeedbackScore[FeedbackScore["One"] = 1] = "One";
        FeedbackScore[FeedbackScore["Two"] = 2] = "Two";
        FeedbackScore[FeedbackScore["Three"] = 3] = "Three";
        FeedbackScore[FeedbackScore["Four"] = 4] = "Four";
        FeedbackScore[FeedbackScore["Five"] = 5] = "Five";
    })(FeedbackScore = Call.FeedbackScore || (Call.FeedbackScore = {}));
    /**
     * The directionality of the {@link Call}, whether incoming or outgoing.
     */
    let CallDirection;
    (function (CallDirection) {
        CallDirection["Incoming"] = "INCOMING";
        CallDirection["Outgoing"] = "OUTGOING";
    })(CallDirection = Call.CallDirection || (Call.CallDirection = {}));
    /**
     * Valid audio codecs to use for the media connection.
     */
    let Codec;
    (function (Codec) {
        Codec["Opus"] = "opus";
        Codec["PCMU"] = "pcmu";
    })(Codec = Call.Codec || (Call.Codec = {}));
    /**
     * Possible ICE Gathering failures
     */
    let IceGatheringFailureReason;
    (function (IceGatheringFailureReason) {
        IceGatheringFailureReason["None"] = "none";
        IceGatheringFailureReason["Timeout"] = "timeout";
    })(IceGatheringFailureReason = Call.IceGatheringFailureReason || (Call.IceGatheringFailureReason = {}));
    /**
     * Possible media failures
     */
    let MediaFailure;
    (function (MediaFailure) {
        MediaFailure["ConnectionDisconnected"] = "ConnectionDisconnected";
        MediaFailure["ConnectionFailed"] = "ConnectionFailed";
        MediaFailure["IceGatheringFailed"] = "IceGatheringFailed";
        MediaFailure["LowBytes"] = "LowBytes";
    })(MediaFailure = Call.MediaFailure || (Call.MediaFailure = {}));
    /**
     * Known call message types.
     */
    let MessageType;
    (function (MessageType) {
        /**
         * Allows for any object types to be defined by the user.
         * When this value is used in the {@link Call.Message} object,
         * The {@link Call.Message.content} can be of any type as long as
         * it matches the MIME type defined in {@link Call.Message.contentType}.
         */
        MessageType["UserDefinedMessage"] = "user-defined-message";
    })(MessageType = Call.MessageType || (Call.MessageType = {}));
})(Call || (Call = {}));
function generateTempCallSid() {
    return 'TJSxxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        /* tslint:disable:no-bitwise */
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        /* tslint:enable:no-bitwise */
        return v.toString(16);
    });
}
export default Call;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiY2FsbC5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbIi4uLy4uL2xpYi90d2lsaW8vY2FsbC50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTs7Ozs7R0FLRztBQUNILE9BQU8sRUFBRSxZQUFZLEVBQUUsTUFBTSxRQUFRLENBQUM7QUFDdEMsT0FBTyxPQUFPLE1BQU0sV0FBVyxDQUFDO0FBQ2hDLE9BQU8sTUFBTSxNQUFNLFVBQVUsQ0FBQztBQUU5QixPQUFPLEVBQ0wsYUFBYSxFQUNiLDhCQUE4QixFQUM5QixvQkFBb0IsRUFDcEIsaUJBQWlCLEVBQ2pCLFdBQVcsRUFDWCxlQUFlLEVBRWYsZUFBZSxHQUNoQixNQUFNLFVBQVUsQ0FBQztBQUNsQixPQUFPLEdBQUcsTUFBTSxPQUFPLENBQUM7QUFDeEIsT0FBTyxFQUFFLGNBQWMsRUFBRSxNQUFNLE9BQU8sQ0FBQztBQUN2QyxPQUFPLEVBQUUsWUFBWSxFQUFtQixNQUFNLG9CQUFvQixDQUFDO0FBRW5FLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLFdBQVcsQ0FBQztBQUVsRCxPQUFPLFlBQVksTUFBTSxnQkFBZ0IsQ0FBQztBQUMxQyxPQUFPLEVBQUUsUUFBUSxFQUFFLE1BQU0sUUFBUSxDQUFDO0FBQ2xDLE9BQU8sRUFBRSxxQkFBcUIsRUFBRSxNQUFNLFFBQVEsQ0FBQztBQUUvQyxPQUFPLEVBQUUsZUFBZSxFQUFFLE1BQU0sYUFBYSxDQUFDO0FBd0I5QyxNQUFNLGNBQWMsR0FBRztJQUNyQixNQUFNLEVBQUUsR0FBRztJQUNYLE1BQU0sRUFBRSxHQUFHO0lBQ1gsR0FBRyxFQUFFLEtBQUs7SUFDVixHQUFHLEVBQUUsQ0FBQztDQUNQLENBQUM7QUFFRixNQUFNLG1CQUFtQixHQUFXLEVBQUUsQ0FBQztBQUN2QyxNQUFNLG1CQUFtQixHQUFXLEdBQUcsQ0FBQztBQUN4QyxNQUFNLGtCQUFrQixHQUFXLEdBQUcsQ0FBQztBQUV2QyxNQUFNLGtCQUFrQixHQUFXLEVBQUUsQ0FBQztBQUN0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