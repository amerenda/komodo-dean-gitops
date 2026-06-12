const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');

const CACHE_FILE = path.join(__dirname, 'sl-cache.json');
const PUSHED_HASH_FILE = path.join(__dirname, 'sl-pushed-hash.json');
const CONFIG_TOPIC = 'zigbee2mqtt/sl/config';
const SNAP_TOPIC = 'zigbee2mqtt/sl/snap';
const STATUS_TOPIC = 'zigbee2mqtt/sl/status';
const BASE_TOPIC = 'zigbee2mqtt';

// Zigbee scene IDs: morning=1, day=2, evening=3, night=4
const WINDOW_SCENE_ID = { morning: 1, day: 2, evening: 3, night: 4 };
const WINDOWS = ['morning', 'day', 'evening', 'night'];
const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

// Stagger delay between Zigbee commands (ms) to avoid flooding
const CMD_STAGGER = 200;

// Maps Zigbee action string → button config key in switchConfig
const ACTION_TO_BTN = {
    'on_press_release':  'b1_short',
    'on_hold':           'b1_long',
    'up_press_release':  'b2_short',
    'up_hold':           'b2_long',
    'down_press_release':'b3_short',
    'down_hold':         'b3_long',
    'off_press_release': 'b4_short',
    'off_hold':          'b4_long',
};

// Default action per button when selector is 'Default' or unset
const BTN_DEFAULTS = {
    b1_short: 'Toggle Room',
    b1_long:  'Power Off All',
    b2_short: 'Brightness Up',
    b2_long:  'Brightness Max',
    b3_short: 'Brightness Down',
    b3_long:  'Brightness Min',
    b4_short: 'Cycle Scenes',
    b4_long:  'Custom Scene',
};

// bedroom 'Custom Scene' — hardcoded SexySex colors
const SEXYSEX_SCENE = [
    { device: 'bedroom_1', cmd: { state: 'ON', brightness: 45, color: { x: 0.37, y: 0.20 }, transition: 1 } },
    { device: 'bedroom_2', cmd: { state: 'ON', brightness: 45, color: { x: 0.26, y: 0.11 }, transition: 1 } },
    { device: 'lamp_1',    cmd: { state: 'OFF' } },
];

class SmartLighting {
    constructor(zigbee, mqtt, state, publishEntityState, eventBus, enableDisableExtension, restartCallback, addExtension, settings, logger) {
        this.zigbee = zigbee;
        this.z2mMqtt = mqtt;
        this.state = state;
        this.eventBus = eventBus;
        this.settings = settings;
        this.logger = logger;
        this.config = null;
        this.configHash = null;
        this.lastSyncTime = null;
        this.currentWindow = null;
        this.checkInterval = null;
        this.cmdClient = null;
        /** @type {Record<string, 'ON'|'OFF'>} group/device state cache */
        this._deviceStateCache = Object.create(null);
        /** epoch ms before which device announces are ignored */
        this._smartPowerOnReadyAt = 0;
        /** last window applied per room via btn4 cycle */
        this._switchLastScene = Object.create(null);
    }

    async start() {
        this.logger.info('[SL] Smart Lighting extension starting');

        const mqttSettings = this.settings.get().mqtt;
        const brokerUrl = mqttSettings.server || 'mqtt://localhost:1883';
        this.cmdClient = mqtt.connect(brokerUrl, {
            clientId: 'z2m-smart-lighting-cmd',
            username: mqttSettings.user || undefined,
            password: mqttSettings.password || undefined,
        });

        this.logger.info(`[SL] Connecting cmdClient to ${brokerUrl}`);

        this.cmdClient.on('message', (topic, msg) => {
            // Bridge events: device announce
            if (topic === 'zigbee2mqtt/bridge/event') {
                try {
                    const ev = JSON.parse(msg.toString());
                    if (ev.type === 'device_announce') {
                        const fn = ev.data && ev.data.friendly_name;
                        if (fn) this._onDeviceAnnounce(fn);
                    }
                } catch { /* ignore */ }
                return;
            }

            const m = topic.match(/^zigbee2mqtt\/([^/]+)$/);
            if (!m) return;
            const deviceName = m[1];

            try {
                const parsed = JSON.parse(msg.toString());

                // Cache group/device ON/OFF state for _roomAnyOn() checks
                if (parsed.state === 'ON' || parsed.state === 'OFF') {
                    this._deviceStateCache[deviceName] = parsed.state;
                }

                // Handle switch button actions — no HA round-trip
                if (parsed.action && this.config && this.config.switches && this.config.switches[deviceName]) {
                    this._onSwitchAction(deviceName, this.config.switches[deviceName], parsed.action);
                }
            } catch { /* ignore non-JSON */ }
        });

        await new Promise((resolve, reject) => {
            this.cmdClient.on('connect', () => {
                this.logger.info('[SL] Command MQTT client connected');
                this.cmdClient.subscribe('zigbee2mqtt/+', err => {
                    if (err) this.logger.warn(`[SL] state-cache subscribe: ${err.message}`);
                    else this.logger.info('[SL] cmdClient subscribed for device/group state cache + switch actions');
                });
                this.cmdClient.subscribe('zigbee2mqtt/bridge/+', err => {
                    if (err) this.logger.warn(`[SL] bridge subscribe: ${err.message}`);
                    else this.logger.info('[SL] cmdClient subscribed to bridge events');
                });
                resolve();
            });
            this.cmdClient.on('error', (err) => {
                this.logger.error(`[SL] Command MQTT client error: ${err.message}`);
                reject(err);
            });
            setTimeout(() => reject(new Error('MQTT connect timeout')), 5000);
        });

        // Load cached config
        this.config = this._loadCache();
        if (this.config) {
            this.configHash = this._hashConfig(this.config);
            this.logger.info(`[SL] Loaded cached config from disk — hash=${this.configHash}`);
            this.currentWindow = this._calculateCurrentWindow();
            this.logger.info(`[SL] Current window: ${this.currentWindow}`);
        } else {
            this.logger.info('[SL] No cached config, waiting for HA');
        }

        await this.z2mMqtt.subscribe(CONFIG_TOPIC);
        this.logger.info(`[SL] Subscribed to ${CONFIG_TOPIC}`);

        await this.z2mMqtt.subscribe(SNAP_TOPIC);
        this.logger.info(`[SL] Subscribed to ${SNAP_TOPIC}`);

        this.eventBus.onMQTTMessage(this, this._onMQTTMessage.bind(this));

        // Ignore device announces during the first 60 s
        this._smartPowerOnReadyAt = Date.now() + 60000;

        this.checkInterval = setInterval(() => this._checkWindowTransition(), 30000);

        if (this.config && this.currentWindow) {
            const pushedHash = this._loadPushedHash();
            if (pushedHash === null) {
                this.logger.info(`[SL] Bootstrapping pushed hash (${this.configHash}) — scenes assumed current on bulbs`);
                this._savePushedHash(this.configHash);
            } else if (this.configHash !== pushedHash) {
                this.logger.info(`[SL] Config hash changed since last push (${pushedHash} → ${this.configHash}) — will push on next config update from HA`);
            } else {
                this.logger.info(`[SL] Scenes up to date on bulbs (hash=${this.configHash})`);
            }
        }

        this._publishStatus('started');
    }

    async stop() {
        this.logger.info('[SL] Smart Lighting extension stopping');
        if (this.checkInterval) clearInterval(this.checkInterval);
        if (this.cmdClient) this.cmdClient.end();
        this.checkInterval = null;
        this.cmdClient = null;
        this.eventBus.removeListeners(this);
    }

    // ── Send command via external MQTT client ────────────────

    _sendCommand(topic, payload) {
        const fullTopic = `${BASE_TOPIC}/${topic}`;
        const message = typeof payload === 'string' ? payload : JSON.stringify(payload);
        if (this.cmdClient && this.cmdClient.connected) {
            this.cmdClient.publish(fullTopic, message);
        } else {
            this.logger.warn(`[SL] CMD client not connected, dropping: ${fullTopic}`);
        }
    }

    async _sendCommandsStaggered(commands) {
        for (let i = 0; i < commands.length; i++) {
            this._sendCommand(commands[i].topic, commands[i].payload);
            if (i < commands.length - 1) {
                await new Promise(r => setTimeout(r, CMD_STAGGER));
            }
        }
    }

    // ── Config from HA ───────────────────────────────────────

    _onMQTTMessage(data) {
        if (data.topic === CONFIG_TOPIC) {
            try {
                const newConfig = JSON.parse(data.message.toString());
                this.config = newConfig;
                this.configHash = this._hashConfig(newConfig);
                this._saveCache(newConfig);
                this.logger.info(`[SL] Config received — hash=${this.configHash} rooms=[${Object.keys(newConfig.rooms || {}).join(', ')}]`);
                this.currentWindow = this._calculateCurrentWindow();
                const pushedHash = this._loadPushedHash();
                if (this.configHash !== pushedHash) {
                    this.logger.info(`[SL] Config changed (${pushedHash ?? 'never'} → ${this.configHash}) — pushing scenes to bulbs`);
                    this._fullScenePush();
                } else {
                    this.logger.info(`[SL] Config unchanged (hash=${this.configHash}) — skipping scene push`);
                }
                this._publishStatus('config_updated');
            } catch (e) {
                this.logger.error(`[SL] Failed to parse config: ${e.message}`);
            }
            return;
        }

        if (data.topic === SNAP_TOPIC) {
            this._handleSnap(data.message.toString());
        }
    }

    _handleSnap(messageStr) {
        let parsed;
        try {
            parsed = JSON.parse(messageStr);
        } catch (e) {
            this.logger.error(`[SL] snap parse: ${e.message}`);
            return;
        }
        const roomKey = parsed && parsed.room_key;
        const window = parsed && parsed.window;
        if (!roomKey || !window) {
            this.logger.warn(`[SL] snap missing room_key/window: ${messageStr}`);
            return;
        }
        if (!WINDOWS.includes(window)) {
            this.logger.info(`[SL] snap ignored: window=${window} not standard`);
            return;
        }
        if (window !== this.currentWindow) {
            this.logger.info(`[SL] snap ignored: window=${window} != currentWindow=${this.currentWindow}`);
            return;
        }

        const ROOM_KEY_TO_GROUP = {
            living_room: 'Living Room', bedroom: 'Bedroom', bathroom: 'Bathroom',
            kitchen: 'Kitchen', hallway: 'Hallway',
        };
        const displayName = ROOM_KEY_TO_GROUP[roomKey];
        if (!displayName) {
            this.logger.warn(`[SL] snap unknown room_key: ${roomKey}`);
            return;
        }
        const roomConfig = this.config && this.config.rooms ? this.config.rooms[displayName] : null;
        if (!roomConfig) {
            this.logger.warn(`[SL] snap no roomConfig for ${displayName}`);
            return;
        }
        this.logger.info(`[SL] snap edit-recall: ${displayName} (${window})`);
        this._recallSceneIfOn(displayName, roomConfig, window);
    }

    // ── Full scene push (config change) ─────────────────────
    // Stores ALL 4 scenes on every group so scene_recall works for any window.
    // Also updates hue_power_on_* on each bulb to the current-window scene values
    // so bulbs power on correctly even when the extension hasn't responded yet.
    // Does NOT scene_recall here (avoids visible snap-back after config push).

    async _fullScenePush() {
        if (!this.config || !this.config.rooms) return;

        this.logger.info(`[SL] Full scene push — storing all 4 scenes on all groups, current window: ${this.currentWindow}`);
        const commands = [];

        for (const [roomName, roomConfig] of Object.entries(this.config.rooms)) {
            if (!roomConfig.scenes) continue;

            for (const window of WINDOWS) {
                const scene = roomConfig.scenes[window];
                if (!scene) continue;

                const sceneAdd = {
                    ID: WINDOW_SCENE_ID[window],
                    name: window,
                    transition: 2,
                    brightness: scene.brightness,
                };
                if (scene.color) {
                    sceneAdd.color = scene.color;
                } else if (scene.color_temp !== undefined) {
                    sceneAdd.color_temp = scene.color_temp;
                }
                commands.push({ topic: `${roomName}/set`, payload: { scene_add: sceneAdd } });
            }

            // For smart_power_on rooms: boot LED-off so the extension can turn it on
            // at exactly the right scene — zero flash. Non-smart rooms boot directly
            // at scene values since the extension won't fire for them on announce.
            const effectiveWindow = this._getEffectiveWindow(roomName);
            const currentScene = roomConfig.scenes && roomConfig.scenes[effectiveWindow];
            const smartPowerOn = roomConfig.smart_power_on !== false;
            if (currentScene) {
                for (const light of (roomConfig.lights || [])) {
                    commands.push({
                        topic: `${light}/set`,
                        payload: smartPowerOn
                            ? { hue_power_on_behavior: 'off' }
                            : {
                                hue_power_on_behavior: 'on',
                                hue_power_on_brightness: currentScene.brightness,
                                hue_power_on_color_temperature: currentScene.color_temp || 370,
                              }
                    });
                }
            }
        }

        this.logger.info(`[SL] Sending ${commands.length} commands (staggered ${CMD_STAGGER}ms)`);
        await this._sendCommandsStaggered(commands);

        this.lastSyncTime = new Date().toISOString();
        this._savePushedHash(this.configHash);
        this._publishStatus('synced');
    }

    // ── Window transition ────────────────────────────────────

    _checkWindowTransition() {
        if (!this.config) return;
        const newWindow = this._calculateCurrentWindow();
        if (newWindow && newWindow !== this.currentWindow) {
            this.logger.info(`[SL] Window transition: ${this.currentWindow} → ${newWindow}`);
            this.currentWindow = newWindow;
            this._onWindowTransition(newWindow);
        }
    }

    async _onWindowTransition(window) {
        if (!this.config || !this.config.rooms) return;

        this.logger.info(`[SL] Window transition → ${window}`);

        for (const [roomName, roomConfig] of Object.entries(this.config.rooms)) {
            const effectiveWindow = this._getEffectiveWindow(roomName);
            this._recallSceneIfOn(roomName, roomConfig, effectiveWindow);
        }

        this._publishStatus(`window_${window}`);
    }

    _recallSceneIfOn(roomName, roomConfig, window) {
        if (roomConfig.auto_transition === false) {
            this.logger.info(`[SL] Recall skipped for ${roomName} (auto_transition off)`);
            return;
        }
        if (!this._roomAnyOn(roomName)) return;
        const payload = this._buildDirectScenePayload(window, roomConfig);
        if (!payload) return;
        const secs = payload.transition ?? 'default';
        this.logger.info(`[SL] Recalling ${window} scene on ${roomName} (lights on, transition=${secs})`);
        this._sendCommand(`${roomName}/set`, payload);
    }

    // ── Device announce (wall switch power-on) ───────────────

    _onDeviceAnnounce(friendlyName) {
        if (Date.now() < this._smartPowerOnReadyAt) return;
        if (!this.config || !this.config.rooms) return;
        if (this.config.sl_enabled === false) return;
        const hm = this.config.house_mode || 'Home';
        if (hm === 'Away') return;

        for (const [roomName, roomConfig] of Object.entries(this.config.rooms)) {
            if (!roomConfig.smart_power_on) continue;
            if (!(roomConfig.lights || []).includes(friendlyName)) continue;
            if (hm === 'Sleep' && !roomConfig.motion_night) {
                this.logger.info(`[SL] smart_power_on: ${friendlyName} skipped (Sleep, motion_night off)`);
                return;
            }
            const effectiveWindow = this._getEffectiveWindow(roomName);
            const scene = roomConfig.scenes && roomConfig.scenes[effectiveWindow];
            if (!scene) return;

            // hue_power_on_behavior is 'off' so the LED is dark until this fires.
            // transition:1 gives a clean 1 s fade-in — no flash, no pop.
            const cmd = { state: 'ON', brightness: scene.brightness, transition: 1 };
            if (scene.color) cmd.color = scene.color;
            else if (scene.color_temp !== undefined) cmd.color_temp = scene.color_temp;

            this.logger.info(`[SL] smart_power_on: ${friendlyName} announced → ${effectiveWindow} (${roomName})`);
            // 300 ms is enough for the Zigbee rejoin handshake; LED is dark the whole time.
            setTimeout(() => this._sendCommand(`${friendlyName}/set`, cmd), 300);
            return;
        }
    }

    // ── Button handling — replaces HA sl_switch_*.yaml automations ──

    _onSwitchAction(switchName, switchConfig, action) {
        if (!this.config) return;
        if (this.config.sl_enabled === false) return;

        const btnKey = ACTION_TO_BTN[action];
        if (!btnKey) {
            this.logger.debug(`[SL] switch ${switchName}: unhandled action ${action}`);
            return;
        }

        const configured = switchConfig[btnKey];
        const actionName = (!configured || configured === 'Default')
            ? BTN_DEFAULTS[btnKey]
            : configured;

        this.logger.info(`[SL] switch ${switchName}: ${action} → ${actionName} (room=${switchConfig.room_group})`);
        this._executeAction(actionName, switchConfig);
    }

    _executeAction(actionName, switchConfig) {
        const roomName = switchConfig.room_group;
        const brightStepPct = Number(switchConfig.brightness_step_pct) || 5;
        const minBrightPct = Number(switchConfig.min_brightness_pct) || 5;
        const brightStep = Math.round(brightStepPct / 100 * 254);
        const minBright = Math.max(1, Math.round(minBrightPct / 100 * 254));

        switch (actionName) {
            case 'Toggle Room':
                if (this._roomAnyOn(roomName)) {
                    this._sendCommand(`${roomName}/set`, { state: 'OFF' });
                    this._switchLastScene[roomName] = null;
                } else {
                    this._switchTurnRoomOn(roomName);
                }
                break;
            case 'Power Off Room':
                this._sendCommand(`${roomName}/set`, { state: 'OFF' });
                this._switchLastScene[roomName] = null;
                break;
            case 'Power Off All':
                this._allRoomsOff();
                break;
            case 'Brightness Up':
                this._sendCommand(`${roomName}/set`, { brightness_step: brightStep });
                break;
            case 'Brightness Max':
                this._sendCommand(`${roomName}/set`, { brightness: 254 });
                break;
            case 'Brightness Down':
                this._sendCommand(`${roomName}/set`, { brightness_step: -brightStep });
                break;
            case 'Brightness Min':
                this._sendCommand(`${roomName}/set`, { brightness: minBright });
                break;
            case 'Cycle Scenes':
                this._cycleScenesForRoom(roomName);
                break;
            case 'Custom Scene':
                this._customAction(switchConfig);
                break;
            case 'Multi-Room Scene':
                this._multiRoomOn(switchConfig);
                break;
            case 'Do Nothing':
                break;
            default:
                this.logger.warn(`[SL] unknown action name: ${actionName}`);
        }
    }

    _switchTurnRoomOn(roomName) {
        if (!this.config || !this.config.rooms) return;
        const hm = this.config.house_mode || 'Home';
        if (hm === 'Away') return;

        const roomConfig = this.config.rooms[roomName];
        if (!roomConfig) return;

        if (hm === 'Sleep' && !roomConfig.motion_night) return;

        const effectiveWindow = this._getEffectiveWindow(roomName);
        const payload = this._buildDirectScenePayload(effectiveWindow, roomConfig);
        if (!payload) return;

        this._sendCommand(`${roomName}/set`, payload);
        this._switchLastScene[roomName] = effectiveWindow;
    }

    _allRoomsOff() {
        if (!this.config || !this.config.rooms) return;
        for (const roomName of Object.keys(this.config.rooms)) {
            this._sendCommand(`${roomName}/set`, { state: 'OFF' });
            this._switchLastScene[roomName] = null;
        }
        this.logger.info('[SL] All rooms off');
    }

    _cycleScenesForRoom(roomName) {
        if (!this.config || !this.config.rooms) return;
        const roomConfig = this.config.rooms[roomName];
        if (!roomConfig) return;

        const last = this._switchLastScene[roomName];
        const current = this.currentWindow || 'morning';
        const targetWindow = (!last || !WINDOWS.includes(last))
            ? (WINDOWS.includes(current) ? current : 'morning')
            : WINDOWS[(WINDOWS.indexOf(last) + 1) % WINDOWS.length];

        const payload = this._buildDirectScenePayload(targetWindow, roomConfig);
        if (!payload) return;

        this._sendCommand(`${roomName}/set`, payload);
        this._switchLastScene[roomName] = targetWindow;
        this.logger.info(`[SL] cycle scene: ${roomName} → ${targetWindow}`);
    }

    _customAction(switchConfig) {
        // bedroom → SexySex scene
        if (switchConfig.room_key === 'bedroom') {
            this.logger.info('[SL] SexySex scene activated');
            for (const { device, cmd } of SEXYSEX_SCENE) {
                this._sendCommand(`${device}/set`, cmd);
            }
            return;
        }

        // Other rooms → toggle all rooms
        if (!this.config || !this.config.rooms) return;
        const anyOn = Object.keys(this.config.rooms).some(r => this._roomAnyOn(r));
        if (anyOn) {
            this._allRoomsOff();
        } else {
            for (const roomName of Object.keys(this.config.rooms)) {
                this._switchTurnRoomOn(roomName);
            }
        }
    }

    _multiRoomOn(switchConfig) {
        const groups = switchConfig.multi_room_groups || [];
        if (!groups.length) return;
        for (const roomName of groups) {
            this._switchTurnRoomOn(roomName);
        }
        this.logger.info(`[SL] multi-room on: [${groups.join(', ')}]`);
    }

    // ── Schedule calculation ─────────────────────────────────

    _calculateCurrentWindow() {
        if (!this.config || !this.config.profiles || !this.config.day_assignments) return null;
        const now = new Date();
        const dayName = DAY_NAMES[now.getDay()];
        const profileName = this.config.day_assignments[dayName] || 'weekday';
        const profile = this.config.profiles[profileName];
        if (!profile) return 'morning';
        const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (t >= profile.night) return 'night';
        if (t >= profile.evening) return 'evening';
        if (t >= profile.day) return 'day';
        if (t >= profile.morning) return 'morning';
        return 'night';
    }

    _getEffectiveWindow(roomName) {
        if (!this.config || !this.config.profiles || !this.config.day_assignments) return this.currentWindow;
        const now = new Date();
        const dayName = DAY_NAMES[now.getDay()];
        const profileName = this.config.day_assignments[dayName] || 'weekday';
        const profile = { ...this.config.profiles[profileName] };
        const roomConfig = this.config.rooms[roomName];
        if (roomConfig && roomConfig.overrides) {
            for (const [w, time] of Object.entries(roomConfig.overrides)) {
                profile[w] = time;
            }
        }
        const t = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        if (t >= profile.night) return 'night';
        if (t >= profile.evening) return 'evening';
        if (t >= profile.day) return 'day';
        if (t >= profile.morning) return 'morning';
        return 'night';
    }

    // ── Helpers ──────────────────────────────────────────────

    /** @returns {object | null} */
    _buildDirectScenePayload(windowKey, roomConfig) {
        const scene = roomConfig.scenes && roomConfig.scenes[windowKey];
        if (!scene) return null;
        const cmd = { state: 'ON', brightness: scene.brightness };
        if (scene.color) cmd.color = scene.color;
        else if (scene.color_temp !== undefined) cmd.color_temp = scene.color_temp;
        const secs = Number(roomConfig.transition_secs) > 0 ? Number(roomConfig.transition_secs) : 0;
        if (secs > 0) cmd.transition = secs;
        return cmd;
    }

    _roomAnyOn(roomDisplayName) {
        if (this._deviceStateCache[roomDisplayName] !== undefined) {
            return this._deviceStateCache[roomDisplayName] === 'ON';
        }
        const roomConfig = this.config && this.config.rooms ? this.config.rooms[roomDisplayName] : null;
        if (!roomConfig) return false;
        return (roomConfig.lights || []).some(l => this._deviceStateCache[l] === 'ON');
    }

    _loadCache() {
        try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
        catch { return null; }
    }

    _saveCache(config) {
        try { fs.writeFileSync(CACHE_FILE, JSON.stringify(config, null, 2)); }
        catch (e) { this.logger.error(`[SL] Failed to save cache: ${e.message}`); }
    }

    _hashConfig(config) {
        return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').substring(0, 12);
    }

    _loadPushedHash() {
        try { return JSON.parse(fs.readFileSync(PUSHED_HASH_FILE, 'utf8')).hash || null; }
        catch { return null; }
    }

    _savePushedHash(hash) {
        try { fs.writeFileSync(PUSHED_HASH_FILE, JSON.stringify({ hash, pushedAt: new Date().toISOString() })); }
        catch (e) { this.logger.error(`[SL] Failed to save pushed hash: ${e.message}`); }
    }

    _publishStatus(status) {
        const payload = JSON.stringify({
            status,
            current_window: this.currentWindow,
            has_config: !!this.config,
            config_hash: this.configHash,
            last_sync: this.lastSyncTime,
            timestamp: new Date().toISOString(),
        });
        if (this.cmdClient && this.cmdClient.connected) {
            this.cmdClient.publish(STATUS_TOPIC, payload, { retain: true });
        }
    }
}

module.exports = SmartLighting;
