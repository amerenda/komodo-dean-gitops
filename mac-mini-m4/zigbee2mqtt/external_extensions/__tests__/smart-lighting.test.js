'use strict';

// Mock external deps so the module loads without a real Z2M environment
jest.mock('fs', () => ({
    existsSync: jest.fn(() => false),
    readFileSync: jest.fn(() => { throw new Error('ENOENT'); }),
    writeFileSync: jest.fn(),
}));
jest.mock('mqtt', () => ({
    connect: jest.fn(() => ({
        on: jest.fn(),
        subscribe: jest.fn(),
        publish: jest.fn(),
        end: jest.fn(),
        connected: true,
    })),
}));

const SmartLighting = require('../smart-lighting');

// ── Minimal constructor mocks ────────────────────────────────────────────────

function makeInstance(configOverride) {
    const noop = () => {};
    const logger = { info: noop, warn: noop, error: noop, debug: noop };
    const eventBus = { onMQTTMessage: noop, removeListeners: noop };
    const settings = { get: () => ({ mqtt: { server: 'mqtt://localhost:1883' } }) };
    const sl = new SmartLighting(null, null, null, null, eventBus, null, null, null, settings, logger);
    sl.config = configOverride ?? null;
    sl.currentWindow = 'evening';
    return sl;
}

const BASE_CONFIG = {
    sl_enabled: true,
    house_mode: 'Home',
    rooms: {
        'Living Room': {
            lights: ['living_room_1'],
            smart_power_on: true,
            auto_transition: true,
            transition_secs: 0,
            motion_night: false,
            scenes: {
                morning: { brightness: 200, color_temp: 250 },
                day:     { brightness: 254, color_temp: 200 },
                evening: { brightness: 150, color_temp: 370 },
                night:   { brightness: 50,  color_temp: 454 },
            },
        },
        'Bedroom': {
            lights: ['bedroom_1', 'bedroom_2'],
            smart_power_on: true,
            auto_transition: true,
            transition_secs: 0,
            motion_night: true,
            scenes: {
                morning: { brightness: 180, color_temp: 280 },
                day:     { brightness: 220, color_temp: 220 },
                evening: { brightness: 100, color: { x: 0.37, y: 0.20 } },
                night:   { brightness: 30,  color_temp: 500 },
            },
        },
    },
};

// ── WINDOW_SCENE_ID mapping ──────────────────────────────────────────────────

describe('WINDOW_SCENE_ID', () => {
    const WINDOW_SCENE_ID = { morning: 1, day: 2, evening: 3, night: 4 };

    test('all four windows map to distinct IDs 1-4', () => {
        const ids = Object.values(WINDOW_SCENE_ID);
        expect(new Set(ids).size).toBe(4);
        expect(Math.min(...ids)).toBe(1);
        expect(Math.max(...ids)).toBe(4);
    });

    test('scene IDs match expected values', () => {
        expect(WINDOW_SCENE_ID.morning).toBe(1);
        expect(WINDOW_SCENE_ID.day).toBe(2);
        expect(WINDOW_SCENE_ID.evening).toBe(3);
        expect(WINDOW_SCENE_ID.night).toBe(4);
    });
});

// ── _buildDirectScenePayload ─────────────────────────────────────────────────

describe('_buildDirectScenePayload', () => {
    test('returns color_temp payload for CT scene', () => {
        const sl = makeInstance();
        const payload = sl._buildDirectScenePayload('evening', BASE_CONFIG.rooms['Living Room']);
        expect(payload).toMatchObject({ state: 'ON', brightness: 150, color_temp: 370 });
        expect(payload.color).toBeUndefined();
    });

    test('returns xy color payload for XY scene', () => {
        const sl = makeInstance();
        const payload = sl._buildDirectScenePayload('evening', BASE_CONFIG.rooms['Bedroom']);
        expect(payload).toMatchObject({ state: 'ON', brightness: 100, color: { x: 0.37, y: 0.20 } });
        expect(payload.color_temp).toBeUndefined();
    });

    test('returns brightness-only payload when no color info', () => {
        const sl = makeInstance();
        const roomConfig = {
            scenes: { morning: { brightness: 100 } },
            transition_secs: 0,
        };
        const payload = sl._buildDirectScenePayload('morning', roomConfig);
        expect(payload).toMatchObject({ state: 'ON', brightness: 100 });
        expect(payload.color).toBeUndefined();
        expect(payload.color_temp).toBeUndefined();
    });

    test('returns null for missing window', () => {
        const sl = makeInstance();
        const payload = sl._buildDirectScenePayload('evening', { scenes: {} });
        expect(payload).toBeNull();
    });

    test('includes transition when transition_secs > 0', () => {
        const sl = makeInstance();
        const roomConfig = {
            scenes: { morning: { brightness: 200, color_temp: 250 } },
            transition_secs: 30,
        };
        const payload = sl._buildDirectScenePayload('morning', roomConfig);
        expect(payload.transition).toBe(30);
    });

    test('omits transition when transition_secs is 0', () => {
        const sl = makeInstance();
        const payload = sl._buildDirectScenePayload('morning', BASE_CONFIG.rooms['Living Room']);
        expect(payload.transition).toBeUndefined();
    });
});

// ── scene_recall payloads (the flicker fix) ──────────────────────────────────

describe('_switchTurnRoomOn — uses scene_recall, not direct command', () => {
    test('sends scene_recall with correct scene ID for current window', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'evening';
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._switchTurnRoomOn('Living Room');

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('Living Room/set');
        expect(sent[0].payload).toEqual({ scene_recall: 3 }); // evening = 3
    });

    test('sends scene_recall ID 1 for morning window', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        // Override effective window to morning via config day_assignments + profiles
        // Simpler: spy on _getEffectiveWindow
        sl._getEffectiveWindow = () => 'morning';
        sl._switchTurnRoomOn('Bedroom');

        expect(sent[0].payload).toEqual({ scene_recall: 1 }); // morning = 1
    });

    test('does NOT send direct color/brightness command (no flicker)', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'night';
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._switchTurnRoomOn('Living Room');

        for (const { payload } of sent) {
            expect(payload).not.toHaveProperty('state', 'ON');
            expect(payload).not.toHaveProperty('brightness');
            expect(payload).not.toHaveProperty('color_temp');
        }
    });

    test('does nothing in Away mode', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.house_mode = 'Away';
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._switchTurnRoomOn('Living Room');

        expect(sent).toHaveLength(0);
    });

    test('skips room in Sleep mode when motion_night is off', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.house_mode = 'Sleep';
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        // Living Room has motion_night: false
        sl._switchTurnRoomOn('Living Room');
        expect(sent).toHaveLength(0);
    });

    test('activates room in Sleep mode when motion_night is on', () => {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.house_mode = 'Sleep';
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        // Bedroom has motion_night: true
        sl._switchTurnRoomOn('Bedroom');
        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toHaveProperty('scene_recall');
    });

    test('tracks last scene in _switchLastScene', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'day';
        sl._switchLastScene = {};
        sl._sendCommand = jest.fn();

        sl._switchTurnRoomOn('Living Room');

        expect(sl._switchLastScene['Living Room']).toBe('day');
    });
});

// ── Toggle Room regression — rapid repeated presses race the state echo ──────
//
// Real incident, 2026-07-18 21:19:58-21:20:00 (kitchen_s_1): a human pressed
// the switch 6 times in ~2 seconds while troubleshooting. Zigbee2MQTT log
// showed the sent commands as: scene_recall, OFF, OFF, OFF, scene_recall,
// scene_recall — three duplicate OFFs in a row instead of alternating, because
// _roomAnyOn() read _deviceStateCache, which only updates when the bulb echoes
// its new state back over Zigbee+MQTT (200ms-1s later). A second press inside
// that window sees the stale pre-command state and repeats the last command
// instead of flipping it. To the person at the switch this looks exactly like
// "the switch stopped responding" — it has nothing to do with HA or internet.
//
// Fix: _deviceStateCache[roomName] is now set optimistically the instant a
// command is sent, so a same-tick second press reads the intended state.

describe('Toggle Room — rapid repeated presses alternate instead of racing the echo', () => {
    function makeConfiguredInstance() {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.switches = {
            kitchen_s_1: { room_group: 'Kitchen', room_key: 'kitchen', b1_short: 'Default' },
        };
        config.rooms['Kitchen'] = {
            lights: ['kitchen_1', 'kitchen_2'],
            auto_transition: true,
            transition_secs: 0,
            motion_night: false,
            scenes: BASE_CONFIG.rooms['Living Room'].scenes,
        };
        const sl = makeInstance(config);
        sl.currentWindow = 'evening';
        sl._switchLastScene = {};
        // Room starts OFF, same as the real incident's first press.
        sl._deviceStateCache['Kitchen'] = 'OFF';
        return sl;
    }

    test('reproduces the 2026-07-18 incident: without the bulb echo, presses still alternate', () => {
        const sl = makeConfiguredInstance();
        const sentStates = []; // 'ON' | 'OFF' derived from each command sent

        // Note: _deviceStateCache is NOT updated here to simulate the bulb echo —
        // this is the worst case, where every press lands before any echo arrives,
        // exactly like the 6 presses in ~2 seconds from the real log.
        sl._sendCommand = (topic, payload) => {
            if (payload.state === 'OFF') sentStates.push('OFF');
            else if (typeof payload.scene_recall === 'number') sentStates.push('ON');
        };

        for (let i = 0; i < 6; i++) {
            sl._executeAction('Toggle Room', sl.config.switches['kitchen_s_1']);
        }

        // Must strictly alternate ON, OFF, ON, OFF, ON, OFF — never two of the
        // same state back-to-back, regardless of how fast the presses arrive.
        expect(sentStates).toEqual(['ON', 'OFF', 'ON', 'OFF', 'ON', 'OFF']);
    });

    test('optimistic cache write happens synchronously within the same press', () => {
        const sl = makeConfiguredInstance();
        sl._sendCommand = jest.fn();

        sl._executeAction('Toggle Room', sl.config.switches['kitchen_s_1']); // OFF → ON
        expect(sl._deviceStateCache['Kitchen']).toBe('ON');

        sl._executeAction('Toggle Room', sl.config.switches['kitchen_s_1']); // ON → OFF
        expect(sl._deviceStateCache['Kitchen']).toBe('OFF');
    });

    test('a late bulb echo confirming the latest command does not disturb the next press', () => {
        // Once presses stop, the real echo for the *last* command eventually
        // arrives on the room-level topic and should simply confirm the
        // optimistic value already there — not flip it.
        const sl = makeConfiguredInstance();
        const sentStates = [];
        sl._sendCommand = (topic, payload) => {
            if (payload.state === 'OFF') sentStates.push('OFF');
            else if (typeof payload.scene_recall === 'number') sentStates.push('ON');
        };

        sl._executeAction('Toggle Room', sl.config.switches['kitchen_s_1']); // → ON (optimistic)
        sl._deviceStateCache['Kitchen'] = 'ON'; // real echo confirms it, in-order
        sl._executeAction('Toggle Room', sl.config.switches['kitchen_s_1']); // → OFF (optimistic)

        expect(sentStates).toEqual(['ON', 'OFF']);
    });
});

// ── Toggle Room regression — the exact "off works, on doesn't" failure ────────
//
// When lights are OFF and the toggle action fires, _executeAction('Toggle Room')
// must call _switchTurnRoomOn, which must send a scene_recall integer (not an
// object). If the format is wrong, Z2M silently ignores the command and the
// light stays off. This is the regression from the first scene_recall attempt.

describe('Toggle Room — power-on path sends a plain-integer scene_recall', () => {
    function makeConfiguredInstance(houseMode = 'Home') {
        const config = JSON.parse(JSON.stringify(BASE_CONFIG));
        config.house_mode = houseMode;
        config.switches = {
            living_room_s_1: {
                room_group: 'Living Room',
                room_key: 'living_room',
                b1_short: 'Default',
                brightness_step_pct: 20,
                min_brightness_pct: 5,
            },
        };
        const sl = makeInstance(config);
        sl._switchLastScene = {};
        return sl;
    }

    test('toggle when room is OFF → scene_recall integer, not object', () => {
        const sl = makeConfiguredInstance();
        sl.currentWindow = 'evening';
        // Room is off
        sl._deviceStateCache['Living Room'] = 'OFF';
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._executeAction('Toggle Room', sl.config.switches['living_room_s_1']);

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('Living Room/set');
        // Must be a plain integer — object form { ID: N } is silently ignored by Z2M
        expect(typeof sent[0].payload.scene_recall).toBe('number');
        expect(sent[0].payload.scene_recall).toBe(3); // evening = 3
    });

    test('toggle when room is ON → state: OFF (no scene_recall)', () => {
        const sl = makeConfiguredInstance();
        sl._deviceStateCache['Living Room'] = 'ON';
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._executeAction('Toggle Room', sl.config.switches['living_room_s_1']);

        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toEqual({ state: 'OFF' });
        expect(sent[0].payload).not.toHaveProperty('scene_recall');
    });

    test('toggle off then on (full cycle) → OFF then scene_recall integer', () => {
        const sl = makeConfiguredInstance();
        sl.currentWindow = 'morning';
        sl._deviceStateCache['Living Room'] = 'ON';
        const sent = [];
        sl._sendCommand = (topic, payload) => {
            sent.push({ topic, payload });
            // Simulate state change
            if (payload.state === 'OFF') sl._deviceStateCache['Living Room'] = 'OFF';
            if (typeof payload.scene_recall === 'number') sl._deviceStateCache['Living Room'] = 'ON';
        };
        const switchConfig = sl.config.switches['living_room_s_1'];

        sl._executeAction('Toggle Room', switchConfig); // turn off
        sl._executeAction('Toggle Room', switchConfig); // turn on

        expect(sent[0].payload).toEqual({ state: 'OFF' });
        expect(typeof sent[1].payload.scene_recall).toBe('number');
        expect(sent[1].payload.scene_recall).toBe(1); // morning = 1
    });
});

// ── _cycleScenesForRoom — uses scene_recall ──────────────────────────────────

describe('_cycleScenesForRoom — uses scene_recall, not direct command', () => {
    test('sends scene_recall when cycling from current window', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'morning';
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._cycleScenesForRoom('Living Room');

        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toHaveProperty('scene_recall');
        expect(typeof sent[0].payload.scene_recall).toBe('number');
    });

    test('advances through windows in order: morning→day→evening→night→morning', () => {
        const WINDOWS = ['morning', 'day', 'evening', 'night'];
        const WINDOW_SCENE_ID = { morning: 1, day: 2, evening: 3, night: 4 };
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'morning';
        sl._switchLastScene = {};
        const ids = [];
        sl._sendCommand = (_, payload) => {
            if (typeof payload.scene_recall === 'number') ids.push(payload.scene_recall);
        };

        for (let i = 0; i < 5; i++) {
            sl._cycleScenesForRoom('Living Room');
        }

        // From no last scene → starts at currentWindow (morning=1), then cycles
        expect(ids[0]).toBe(WINDOW_SCENE_ID.morning);
        expect(ids[1]).toBe(WINDOW_SCENE_ID.day);
        expect(ids[2]).toBe(WINDOW_SCENE_ID.evening);
        expect(ids[3]).toBe(WINDOW_SCENE_ID.night);
        expect(ids[4]).toBe(WINDOW_SCENE_ID.morning); // wraps
    });

    test('does NOT send direct brightness command (no flicker during cycle)', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'evening';
        sl._switchLastScene = {};
        const sent = [];
        sl._sendCommand = (_, payload) => sent.push(payload);

        sl._cycleScenesForRoom('Living Room');

        for (const payload of sent) {
            expect(payload).not.toHaveProperty('brightness');
            expect(payload).not.toHaveProperty('state', 'ON');
        }
    });
});

// ── _recallSceneIfOn — keeps direct command for smooth window transitions ────

describe('_recallSceneIfOn — uses direct command (smooth transition support)', () => {
    test('sends direct brightness+color command (not scene_recall) when auto_transition on', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._deviceStateCache = { 'Living Room': 'ON' };
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        sl._recallSceneIfOn('Living Room', BASE_CONFIG.rooms['Living Room'], 'evening');

        expect(sent).toHaveLength(1);
        expect(sent[0].payload).toHaveProperty('state', 'ON');
        expect(sent[0].payload).toHaveProperty('brightness');
        expect(sent[0].payload).not.toHaveProperty('scene_recall');
    });

    test('skips when auto_transition is off', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._deviceStateCache = { 'Living Room': 'ON' };
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });
        const roomConfig = { ...BASE_CONFIG.rooms['Living Room'], auto_transition: false };

        sl._recallSceneIfOn('Living Room', roomConfig, 'evening');

        expect(sent).toHaveLength(0);
    });

    test('skips when room is off', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._deviceStateCache = { 'Living Room': 'OFF' };
        const sent = [];
        sl._sendCommand = (_, payload) => sent.push(payload);

        sl._recallSceneIfOn('Living Room', BASE_CONFIG.rooms['Living Room'], 'morning');

        expect(sent).toHaveLength(0);
    });
});

// ── _hashConfig ───────────────────────────────────────────────────────────────

describe('_hashConfig', () => {
    const sl = makeInstance();

    test('produces consistent hash for same config', () => {
        const config = { rooms: {}, house_mode: 'Home' };
        expect(sl._hashConfig(config)).toBe(sl._hashConfig(config));
    });

    test('produces different hash for different configs', () => {
        const a = { rooms: { 'Living Room': { brightness: 100 } } };
        const b = { rooms: { 'Living Room': { brightness: 200 } } };
        expect(sl._hashConfig(a)).not.toBe(sl._hashConfig(b));
    });

    test('hash is 12 chars', () => {
        expect(sl._hashConfig({})).toHaveLength(12);
    });
});

// ── _calculateCurrentWindow (with mocked time) ───────────────────────────────

describe('_calculateCurrentWindow', () => {
    const PROFILE = { morning: '07:00', day: '09:00', evening: '18:00', night: '22:00' };
    const CONFIG_WITH_PROFILE = {
        profiles: { weekday: PROFILE },
        day_assignments: {
            monday: 'weekday', tuesday: 'weekday', wednesday: 'weekday',
            thursday: 'weekday', friday: 'weekday', saturday: 'weekday', sunday: 'weekday',
        },
    };

    function slAtHour(h, m = 0) {
        const sl = makeInstance(CONFIG_WITH_PROFILE);
        const d = new Date(2026, 0, 5, h, m); // Monday 2026-01-05
        jest.spyOn(global, 'Date').mockImplementation(() => d);
        const result = sl._calculateCurrentWindow();
        jest.restoreAllMocks();
        return result;
    }

    test('before morning → night (previous day)', () => {
        expect(slAtHour(5, 0)).toBe('night');
    });

    test('at morning boundary', () => {
        expect(slAtHour(7, 0)).toBe('morning');
    });

    test('at day boundary', () => {
        expect(slAtHour(9, 0)).toBe('day');
    });

    test('mid-afternoon → day', () => {
        expect(slAtHour(14, 30)).toBe('day');
    });

    test('at evening boundary', () => {
        expect(slAtHour(18, 0)).toBe('evening');
    });

    test('at night boundary', () => {
        expect(slAtHour(22, 0)).toBe('night');
    });

    test('late night → night', () => {
        expect(slAtHour(23, 59)).toBe('night');
    });
});

// ── Startup scene push — ensures scene_recall turns lights on ─────────────────
//
// scene_recall only turns a light ON if the stored scene includes the OnOff
// attribute (state: 'ON' in the scene_add payload). The config hash reflects HA
// helper values — NOT code content. So after a code change that adds state: 'ON'
// to scene_add, the hash is unchanged and the old skip-if-hash-matches logic
// silently leaves bulbs with stale scenes that cannot turn lights on.
//
// Fix: _handleStartupPush() always calls _fullScenePush regardless of hash so
// every Z2M restart guarantees the bulbs have current scenes.

describe('Startup scene push — scene_recall correctness', () => {
    test('_fullScenePush includes state "ON" in every scene_add so recall turns light on', async () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'evening';
        sl._getEffectiveWindow = () => 'evening';
        sl._savePushedHash = jest.fn();
        sl._publishStatus = jest.fn();

        const commands = [];
        sl._sendCommandsStaggered = jest.fn(async (cmds) => { commands.push(...cmds); });

        await sl._fullScenePush();

        const sceneAdds = commands.filter(c => c.payload && c.payload.scene_add);
        expect(sceneAdds.length).toBeGreaterThan(0);
        for (const { payload } of sceneAdds) {
            expect(payload.scene_add).toHaveProperty('state', 'ON');
        }
    });

    test('_handleStartupPush always calls _fullScenePush even when config hash matches last push', () => {
        // Without this fix: if pushedHash === configHash, startup skips the push.
        // Bulbs keep stale scenes (no state: 'ON') and scene_recall never turns lights on.
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.configHash = 'fakehash';
        sl._loadPushedHash = () => 'fakehash'; // hash matches — old code: skip push
        sl._savePushedHash = jest.fn();
        sl._fullScenePush = jest.fn();

        sl._handleStartupPush(); // must exist and must call _fullScenePush unconditionally

        expect(sl._fullScenePush).toHaveBeenCalledTimes(1);
    });

    test('switch press after startup push sends scene_recall that will turn light on', () => {
        // Full chain: startup pushes scene_add (state: 'ON') → bulbs store scene →
        // switch press sends scene_recall integer → bulb turns on at correct scene.
        // If startup push is skipped, bulbs have old scenes and recall silently fails.
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl.currentWindow = 'evening';
        sl._switchLastScene = {};

        const pushCalls = [];
        sl._fullScenePush = jest.fn(() => pushCalls.push(true));

        // Startup push must happen before switch presses are accepted
        sl._handleStartupPush();
        expect(pushCalls).toHaveLength(1);

        // Now switch press must send scene_recall (not direct command — that flickers)
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });
        sl._switchTurnRoomOn('Living Room');

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('Living Room/set');
        // Plain integer — Z2M recalls the scene (with state: 'ON' stored by startup push)
        expect(typeof sent[0].payload.scene_recall).toBe('number');
        expect(sent[0].payload.scene_recall).toBe(3); // evening = 3
    });

    test('_handleStartupPush does nothing when no config is loaded', () => {
        const sl = makeInstance(null); // no config
        sl._fullScenePush = jest.fn();

        sl._handleStartupPush();

        expect(sl._fullScenePush).not.toHaveBeenCalled();
    });
});

// ── smart_power_on: _onDeviceAnnounce still uses direct command ──────────────

describe('_onDeviceAnnounce — direct command (individual bulb, not group)', () => {
    test('sends direct state+brightness+color_temp to individual bulb', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._smartPowerOnReadyAt = 0;
        sl.currentWindow = 'morning';
        const sent = [];
        sl._sendCommand = (topic, payload) => sent.push({ topic, payload });

        // Advance time past ready gate
        jest.useFakeTimers();
        sl._onDeviceAnnounce('living_room_1');
        jest.advanceTimersByTime(500);
        jest.useRealTimers();

        expect(sent).toHaveLength(1);
        expect(sent[0].topic).toBe('living_room_1/set');
        expect(sent[0].payload).toHaveProperty('state', 'ON');
        expect(sent[0].payload).toHaveProperty('brightness');
        // individual bulb announce must NOT use scene_recall (bulb just powered on)
        expect(sent[0].payload).not.toHaveProperty('scene_recall');
    });

    test('ignores announce within smartPowerOnReadyAt window', () => {
        const sl = makeInstance(JSON.parse(JSON.stringify(BASE_CONFIG)));
        sl._smartPowerOnReadyAt = Date.now() + 60000;
        const sent = [];
        sl._sendCommand = (_, payload) => sent.push(payload);

        sl._onDeviceAnnounce('living_room_1');

        expect(sent).toHaveLength(0);
    });
});
